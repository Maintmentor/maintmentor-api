'use strict';

/**
 * routes/agent.js
 *
 * MaintMentor Agent API routes.
 * External developer/agent access to MaintMentor AI capabilities.
 *
 * Route prefix: /api/agent  (registered in server.js)
 *
 * Endpoints:
 *   POST  /query   - Text-based maintenance query (5 credits)
 *   POST  /photo   - Image analysis via Gemini Vision (15 credits)
 *   GET   /usage   - Wallet + usage stats for the API key (free)
 *
 * Middleware stack:
 *   POST /query:  agentApiLimiter → requireApiKey → balanceCheck → handler → billing
 *   POST /photo:  agentApiLimiter → requireApiKey → balanceCheck → handler → billing
 *   GET  /usage:  requireApiKey → handler  (no billing — free)
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = require('../lib/supabase');
const { requireApiKey } = require('../middleware/auth');
const { balanceCheck } = require('../middleware/balanceCheck');
const { billing } = require('../middleware/billing');
const { agentApiLimiter, photoLimiter } = require('../middleware/rateLimiter');
const { buildRagContext, queueForEmbedding, processEmbeddingQueue } = require('../lib/embeddings');

// ─── Gemini Client ─────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('[agent] ❌ GEMINI_API_KEY not set — agent endpoints will fail at runtime');
}

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const AGENT_MODEL = process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash';
const AGENT_MODEL_PRO = process.env.GEMINI_MODEL || 'gemini-2.5-pro'; // Vision model for photo analysis
const MAX_OUTPUT_TOKENS = 1000; // Hard cap per spec
const MAX_PHOTO_OUTPUT_TOKENS = 2000; // Photos warrant longer analysis
const MAX_IMAGES_PER_REQUEST = 5;
const MAX_QUESTION_LENGTH = 2000;

// ─── System Prompt (agent-specific, condensed) ────────────────────────────────
const AGENT_SYSTEM_PROMPT = `You are MaintMentor, an expert residential maintenance AI with deep knowledge of HVAC, plumbing, electrical, and general contracting. Provide accurate, safe, actionable maintenance guidance. Always note when professional help is required.

Keep responses focused and practical. Lead with safety warnings when relevant. Provide step-by-step guidance when asked. Always suggest the cheapest/simplest fix first before expensive repairs.`;

// ─── Helper: compute a simple confidence score ────────────────────────────────
/**
 * Estimate confidence based on output length and content signals.
 * Returns a float 0.0–1.0.
 *
 * @param {string} answer
 * @param {string} question
 * @returns {number}
 */
function estimateConfidence(answer, question) {
  if (!answer || answer.length < 50) return 0.3;

  let score = 0.7; // base

  // Positive signals
  if (answer.length > 200) score += 0.1;
  if (/step|check|replace|inspect|verify/i.test(answer)) score += 0.05;
  if (/professional|licensed|permit/i.test(answer)) score += 0.05;

  // Negative signals
  if (/i('m| am) not sure|unclear|cannot determine|can't tell/i.test(answer)) score -= 0.2;
  if (/depends on|hard to say|more information needed/i.test(answer)) score -= 0.1;

  return Math.min(1.0, Math.max(0.1, parseFloat(score.toFixed(2))));
}

// ─── POST /query ───────────────────────────────────────────────────────────────
/**
 * Agent text query endpoint.
 *
 * Stack: agentApiLimiter → requireApiKey → balanceCheck → handler → billing
 *
 * Request body:
 *   {
 *     "question": "string (required, max 2000 chars)",
 *     "context": {
 *       "appliance_type": "string",
 *       "model": "string",
 *       "age_years": number
 *     },
 *     "response_format": "text | structured"
 *   }
 *
 * Response:
 *   {
 *     "answer": "string",
 *     "confidence": 0.0-1.0,
 *     "credits_used": 5,
 *     "wallet_balance": N,
 *     "request_id": "uuid"
 *   }
 */
router.post(
  '/query',
  agentApiLimiter,
  requireApiKey,
  balanceCheck,
  async (req, res) => {
    const startTime = Date.now();
    req._billingStartTime = startTime;
    const requestId = uuidv4();

    // ─── Input Validation ────────────────────────────────────────────────────
    const { question, context, response_format } = req.body;

    if (!question) {
      return res.status(400).json({
        error: 'question is required',
        code: 'VALIDATION_MISSING_QUESTION',
      });
    }

    if (typeof question !== 'string') {
      return res.status(400).json({
        error: 'question must be a string',
        code: 'VALIDATION_INVALID_QUESTION',
      });
    }

    if (question.length > 2000) {
      return res.status(400).json({
        error: 'question exceeds maximum length of 2000 characters',
        code: 'VALIDATION_QUESTION_TOO_LONG',
        maxLength: 2000,
        actualLength: question.length,
      });
    }

    if (!genAI) {
      return res.status(503).json({
        error: 'AI service not configured',
        code: 'SERVICE_UNAVAILABLE',
      });
    }

    // ─── Build Gemini Prompt ─────────────────────────────────────────────────
    let fullQuestion = question;

    if (context && typeof context === 'object') {
      const contextParts = [];
      if (context.appliance_type) contextParts.push(`Appliance type: ${context.appliance_type}`);
      if (context.model) contextParts.push(`Model: ${context.model}`);
      if (typeof context.age_years === 'number') contextParts.push(`Age: ${context.age_years} years`);
      if (contextParts.length > 0) {
        fullQuestion = `Context:\n${contextParts.join('\n')}\n\nQuestion: ${question}`;
      }
    }

    try {
      // ─── RAG Lookup (< 200ms, skipped on timeout/error) ───────────────────
      // Embed the question and find similar past answers to inject as context.
      // buildRagContext enforces a 200ms timeout and returns null on any failure.
      let ragContext = null;
      try {
        ragContext = await buildRagContext(question);
      } catch (_ragErr) {
        // Should not reach here (buildRagContext catches internally), but be safe
        console.warn('[agent/query] RAG lookup threw unexpectedly — skipping:', _ragErr.message);
      }

      // Prepend RAG context to the question if we found relevant past answers
      let promptText = fullQuestion;
      if (ragContext) {
        promptText = `${ragContext}

${fullQuestion}`;
      }

      // ─── Call Gemini ───────────────────────────────────────────────────────
      const model = genAI.getGenerativeModel({
        model: AGENT_MODEL,
        systemInstruction: AGENT_SYSTEM_PROMPT,
      });

      const geminiResponse = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      });

      const answer = geminiResponse.response.text();
      const usageMeta = geminiResponse.response?.usageMetadata;
      const tokensInput = usageMeta?.promptTokenCount || 0;
      const tokensOutput = usageMeta?.candidatesTokenCount || 0;
      const latencyMs = Date.now() - startTime;

      // ─── Compute confidence ────────────────────────────────────────────────
      const confidence = estimateConfidence(answer, question);

      // ─── Get updated wallet balance ────────────────────────────────────────
      // Note: billing middleware will deduct after response is sent.
      // We optimistically subtract for the response.
      const { wallet, apiKey, creditCost } = req.apiContext;
      const currentBalance = parseFloat(wallet.balance_usd) || 0;
      const projectedBalance = Math.max(0, currentBalance - creditCost);

      // ─── Attach billing metadata (fire-and-forget by billing middleware) ──
      req.billingMeta = {
        tokensUsed: tokensInput + tokensOutput,
        requestMetadata: {
          request_id: requestId,
          model: AGENT_MODEL,
          tokens_input: tokensInput,
          tokens_output: tokensOutput,
          latency_ms: latencyMs,
          response_format: response_format || 'text',
          has_context: !!(context && typeof context === 'object'),
          question_length: question.length,
          rag_injected: !!ragContext,
          // NO question text — could contain PII
        },
      };

      // ─── Log to query_history (async, non-blocking) ────────────────────────
      setImmediate(() => {
        supabase
          .from('query_history')
          .insert({
            account_id: apiKey.user_id,
            question,
            context: context || null,
            ai_answer: answer,
            model_used: AGENT_MODEL,
            tokens_input: tokensInput,
            tokens_output: tokensOutput,
            latency_ms: latencyMs,
            source: 'agent_api',
          })
          .then(({ error }) => {
            if (error) {
              console.error('[agent/query] query_history insert failed:', error.message);
            }
          })
          .catch(err => {
            console.error('[agent/query] query_history insert error:', err.message);
          });
      });

      // ─── Queue for embedding (async, non-blocking) ────────────────────────
      // Only queue high-confidence answers (threshold enforced inside queueForEmbedding)
      setImmediate(() => {
        queueForEmbedding(question, answer, {
          source:    'agent_query',
          confidence,
          wallet_id: wallet.id || null,  // Stored as-is; not publicly exposed
          category:  'maintenance',
        }).catch(err => {
          console.error('[agent/query] queueForEmbedding error:', err.message);
        });

        // Kick the embedding worker to process any pending items
        processEmbeddingQueue().catch(err => {
          console.error('[agent/query] processEmbeddingQueue error:', err.message);
        });
      });

      // ─── Send response ─────────────────────────────────────────────────────
      return res.json({
        answer,
        confidence,
        credits_used: creditCost,
        wallet_balance: projectedBalance,
        request_id: requestId,
      });

    } catch (err) {
      console.error('[agent/query] Gemini error:', err.message);

      const statusCode = err.status || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to generate AI response',
        code: 'AI_SERVICE_ERROR',
      });
    }
  },
  billing  // Post-response: deduct credits + log usage
);

// ─── GET /usage ────────────────────────────────────────────────────────────────
/**
 * Usage stats endpoint — free (no billing middleware).
 *
 * Stack: requireApiKey → handler
 *
 * Response:
 *   {
 *     "wallet": { "balance_credits": N, "auto_recharge_enabled": false },
 *     "usage": {
 *       "today": { "calls": N, "credits_used": N },
 *       "this_month": { "calls": N, "credits_used": N },
 *       "lifetime": { "calls": N, "credits_used": N }
 *     }
 *   }
 */
router.get(
  '/usage',
  requireApiKey,
  async (req, res) => {
    const { wallet, apiKey } = req.apiContext;

    try {
      const now = new Date();

      // ─── Date boundaries ────────────────────────────────────────────────────
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      // ─── Query api_usage_logs for this wallet ─────────────────────────────
      // All-time stats
      const { data: lifetimeLogs, error: lifetimeError } = await supabase
        .from('api_usage_logs')
        .select('credits_charged')
        .eq('wallet_id', wallet.id)
        .lt('response_status', 400);

      if (lifetimeError) {
        console.error('[agent/usage] lifetime query failed:', lifetimeError.message);
      }

      // Today's stats
      const { data: todayLogs, error: todayError } = await supabase
        .from('api_usage_logs')
        .select('credits_charged')
        .eq('wallet_id', wallet.id)
        .gte('created_at', todayStart)
        .lt('response_status', 400);

      if (todayError) {
        console.error('[agent/usage] today query failed:', todayError.message);
      }

      // This month's stats
      const { data: monthLogs, error: monthError } = await supabase
        .from('api_usage_logs')
        .select('credits_charged')
        .eq('wallet_id', wallet.id)
        .gte('created_at', monthStart)
        .lt('response_status', 400);

      if (monthError) {
        console.error('[agent/usage] month query failed:', monthError.message);
      }

      // ─── Aggregate stats ───────────────────────────────────────────────────
      const sumCredits = (logs) =>
        (logs || []).reduce((acc, row) => acc + (parseFloat(row.credits_charged) || 0), 0);

      const lifetimeCredits = sumCredits(lifetimeLogs);
      const todayCredits = sumCredits(todayLogs);
      const monthCredits = sumCredits(monthLogs);

      const lifetimeCalls = (lifetimeLogs || []).length;
      const todayCalls = (todayLogs || []).length;
      const monthCalls = (monthLogs || []).length;

      // ─── Current wallet balance ────────────────────────────────────────────
      // Refresh wallet from DB to get latest balance
      const { data: freshWallet } = await supabase
        .from('wallets')
        .select('balance_usd')
        .eq('id', wallet.id)
        .single();

      const balanceCredits = parseFloat(freshWallet?.balance_usd ?? wallet.balance_usd) || 0;

      return res.json({
        wallet: {
          balance_credits: balanceCredits,
          auto_recharge_enabled: false,
        },
        usage: {
          today: {
            calls: todayCalls,
            credits_used: todayCredits,
          },
          this_month: {
            calls: monthCalls,
            credits_used: monthCredits,
          },
          lifetime: {
            calls: lifetimeCalls,
            credits_used: lifetimeCredits,
          },
        },
      });

    } catch (err) {
      console.error('[agent/usage] error:', err.message);
      return res.status(500).json({
        error: 'Failed to retrieve usage data',
        code: 'USAGE_FETCH_ERROR',
      });
    }
  }
);

// ─── Photo System Prompt ─────────────────────────────────────────────────────
const PHOTO_SYSTEM_PROMPT = `You are MaintMentor, an expert residential maintenance AI with deep knowledge of HVAC, plumbing, electrical, and general contracting. You are analyzing photos submitted by property owners or maintenance professionals.

Your goal:
1. Identify visible maintenance issues, damage, or conditions in the image(s)
2. Provide actionable findings with clear severity indicators
3. Recommend next steps — DIY where safe, professional when required
4. Be specific: note model numbers, part names, or visible indicators when present
5. Always flag safety hazards prominently

Respond ONLY with valid JSON matching this exact schema (no markdown, no explanation outside JSON):
{
  "analysis": "<comprehensive paragraph describing what you see>",
  "findings": ["<finding 1>", "<finding 2>", ...],
  "recommendations": ["<action 1>", "<action 2>", ...],
  "confidence": <0.0-1.0>
}`;

/**
 * Fetch an image from a URL and return it as a base64 inline data part.
 * Validates content-type is an image.
 *
 * @param {string} url
 * @returns {Promise<{inlineData: {data: string, mimeType: string}}>}
 */
async function fetchImageAsInlinePart(url) {
  // Use Node's built-in fetch (Node 18+) or fallback to https module
  let fetchFn;
  try {
    fetchFn = fetch; // Node 18+ global fetch
  } catch {
    // Node <18: use require('node-fetch') if available
    fetchFn = require('node-fetch');
  }

  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(15000), // 15s timeout per image
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image at ${url}: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const mimeType = contentType.split(';')[0].trim();

  const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error(`Unsupported image type "${mimeType}" at ${url}. Allowed: jpeg, png, webp, gif`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer).toString('base64');

  return { inlineData: { data, mimeType } };
}

/**
 * Parse Gemini JSON response for photo analysis.
 * Falls back gracefully if the model doesn't return valid JSON.
 *
 * @param {string} rawText
 * @returns {{ analysis: string, findings: string[], recommendations: string[], confidence: number }}
 */
function parsePhotoResponse(rawText) {
  // Strip optional markdown code fences
  const cleaned = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);

    return {
      analysis:        typeof parsed.analysis === 'string'      ? parsed.analysis        : cleaned,
      findings:        Array.isArray(parsed.findings)           ? parsed.findings        : [],
      recommendations: Array.isArray(parsed.recommendations)   ? parsed.recommendations : [],
      confidence:      typeof parsed.confidence === 'number'
        ? Math.min(1.0, Math.max(0.0, parsed.confidence))
        : 0.7,
    };
  } catch {
    // Model didn't produce valid JSON — wrap raw text in analysis field
    return {
      analysis:        rawText,
      findings:        [],
      recommendations: [],
      confidence:      0.5,
    };
  }
}

// ─── POST /photo ───────────────────────────────────────────────────────────────
/**
 * Agent photo analysis endpoint.
 *
 * Stack: agentApiLimiter → requireApiKey → balanceCheck → handler → billing
 *
 * Request body:
 *   {
 *     "images": ["https://...", ...],  // 1–5 image URLs (required)
 *     "question": "What is wrong here?" // optional, max 2000 chars
 *   }
 *
 * Response:
 *   {
 *     "analysis":        "string",
 *     "findings":        ["string", ...],
 *     "recommendations": ["string", ...],
 *     "confidence":      0.0-1.0,
 *     "credits_used":    15,
 *     "wallet_balance":  N,
 *     "request_id":      "uuid"
 *   }
 */
router.post(
  '/photo',
  agentApiLimiter,
  requireApiKey,
  balanceCheck,
  async (req, res) => {
    const startTime = Date.now();
    req._billingStartTime = startTime;
    const requestId = uuidv4();

    // ─── Input Validation ────────────────────────────────────────────────────
    const { images, question } = req.body;

    if (!images) {
      return res.status(400).json({
        error: 'images is required',
        code:  'VALIDATION_MISSING_IMAGES',
      });
    }

    if (!Array.isArray(images)) {
      return res.status(400).json({
        error: 'images must be an array of URLs',
        code:  'VALIDATION_INVALID_IMAGES',
      });
    }

    if (images.length === 0) {
      return res.status(400).json({
        error: 'images array must not be empty',
        code:  'VALIDATION_NO_IMAGES',
      });
    }

    if (images.length > MAX_IMAGES_PER_REQUEST) {
      return res.status(400).json({
        error: `Maximum ${MAX_IMAGES_PER_REQUEST} images per request`,
        code:  'VALIDATION_TOO_MANY_IMAGES',
        max:   MAX_IMAGES_PER_REQUEST,
        sent:  images.length,
      });
    }

    // Validate all entries are non-empty strings
    for (let i = 0; i < images.length; i++) {
      if (typeof images[i] !== 'string' || !images[i].trim()) {
        return res.status(400).json({
          error: `images[${i}] must be a non-empty string URL`,
          code:  'VALIDATION_INVALID_IMAGE_URL',
          index: i,
        });
      }

      // Basic URL validation
      try {
        const u = new URL(images[i]);
        if (!['http:', 'https:'].includes(u.protocol)) {
          return res.status(400).json({
            error: `images[${i}] must be an http or https URL`,
            code:  'VALIDATION_INVALID_IMAGE_PROTOCOL',
            index: i,
          });
        }
      } catch {
        return res.status(400).json({
          error: `images[${i}] is not a valid URL`,
          code:  'VALIDATION_INVALID_IMAGE_URL',
          index: i,
        });
      }
    }

    if (question !== undefined) {
      if (typeof question !== 'string') {
        return res.status(400).json({
          error: 'question must be a string',
          code:  'VALIDATION_INVALID_QUESTION',
        });
      }
      if (question.length > MAX_QUESTION_LENGTH) {
        return res.status(400).json({
          error: `question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters`,
          code:  'VALIDATION_QUESTION_TOO_LONG',
          maxLength:    MAX_QUESTION_LENGTH,
          actualLength: question.length,
        });
      }
    }

    if (!genAI) {
      return res.status(503).json({
        error: 'AI service not configured',
        code:  'SERVICE_UNAVAILABLE',
      });
    }

    // ─── Fetch images as inline data ─────────────────────────────────────────
    let imageParts;
    try {
      imageParts = await Promise.all(images.map(url => fetchImageAsInlinePart(url)));
    } catch (fetchErr) {
      console.error('[agent/photo] Image fetch error:', fetchErr.message);
      return res.status(422).json({
        error:   fetchErr.message,
        code:    'IMAGE_FETCH_FAILED',
      });
    }

    // ─── Build prompt parts ───────────────────────────────────────────────────
    const questionText = question
      ? `User question: ${question}\n\nPlease analyze the image(s) with this specific question in mind.`
      : 'Please analyze the image(s) and identify any maintenance issues, damage, or conditions.';

    const promptParts = [
      { text: questionText },
      ...imageParts,
    ];

    try {
      // ─── Call Gemini Vision (MODEL_PRO) ───────────────────────────────────
      const model = genAI.getGenerativeModel({
        model:             AGENT_MODEL_PRO,
        systemInstruction: PHOTO_SYSTEM_PROMPT,
      });

      const geminiResponse = await model.generateContent({
        contents: [{ role: 'user', parts: promptParts }],
        generationConfig: {
          maxOutputTokens: MAX_PHOTO_OUTPUT_TOKENS,
          responseMimeType: 'application/json', // Request JSON output
        },
      });

      const rawText = geminiResponse.response.text();
      const usageMeta = geminiResponse.response?.usageMetadata;
      const tokensInput  = usageMeta?.promptTokenCount     || 0;
      const tokensOutput = usageMeta?.candidatesTokenCount || 0;
      const latencyMs    = Date.now() - startTime;

      // ─── Parse response ────────────────────────────────────────────────────
      const { analysis, findings, recommendations, confidence } = parsePhotoResponse(rawText);

      // ─── Wallet balance (optimistic post-deduction) ────────────────────────
      const { wallet, apiKey, creditCost } = req.apiContext;
      const currentBalance  = parseFloat(wallet.balance_usd) || 0;
      const projectedBalance = Math.max(0, currentBalance - creditCost);

      // ─── Attach billing metadata ───────────────────────────────────────────
      req.billingMeta = {
        tokensUsed: tokensInput + tokensOutput,
        requestMetadata: {
          request_id:     requestId,
          model:          AGENT_MODEL_PRO,
          tokens_input:   tokensInput,
          tokens_output:  tokensOutput,
          latency_ms:     latencyMs,
          image_count:    images.length,
          has_question:   !!question,
        },
      };

      // ─── Log to query_history (async, non-blocking) ───────────────────────
      setImmediate(() => {
        supabase
          .from('query_history')
          .insert({
            account_id:   apiKey.user_id,
            question:     question || '(photo analysis)',
            context:      { image_count: images.length },
            ai_answer:    analysis,
            model_used:   AGENT_MODEL_PRO,
            tokens_input: tokensInput,
            tokens_output: tokensOutput,
            latency_ms:   latencyMs,
            source:       'agent_api_photo',
          })
          .then(({ error }) => {
            if (error) {
              console.error('[agent/photo] query_history insert failed:', error.message);
            }
          })
          .catch(err => {
            console.error('[agent/photo] query_history insert error:', err.message);
          });
      });

      // ─── Send response ─────────────────────────────────────────────────────
      return res.json({
        analysis,
        findings,
        recommendations,
        confidence,
        credits_used:   creditCost,
        wallet_balance: projectedBalance,
        request_id:     requestId,
      });

    } catch (err) {
      console.error('[agent/photo] Gemini error:', err.message);

      const statusCode = err.status || 500;
      return res.status(statusCode).json({
        error: err.message || 'Failed to analyze image(s)',
        code:  'AI_SERVICE_ERROR',
      });
    }
  },
  billing  // Post-response: deduct credits + log usage
);

// ─── POST /field — Field Companion Mode (Day 14) ─────────────────────────────────
/**
 * POST /api/agent/field
 *
 * Specialized endpoint for field technicians. Context-aware AI
 * that understands urgency, location, and equipment type.
 *
 * Body: { question, location, equipment_type, urgency }
 * urgency: 'low' | 'medium' | 'high' | 'emergency'
 *
 * Emergency: uses gemini-2.5-pro, no credit deduction (safety first)
 * Others: routes to flash, 5 credits
 */
const FIELD_SYSTEM_PROMPT = `You are MaintMentor Field Companion — an AI assistant built for field technicians actively working on equipment. You are deployed on Google Cloud Run and powered by Gemini AI.

Your responses must:
1. Lead with any SAFETY WARNINGS (electrical, gas, pressure, height risks)
2. Provide clear NEXT STEPS in numbered order
3. Flag when a situation requires PROFESSIONAL ESCALATION
4. Be concise — technicians are working, not reading essays
5. Account for the equipment type, location, and urgency level provided

Always output valid JSON with keys: answer, safety_warnings (array), next_steps (array), confidence (float 0-1), escalate_to_professional (bool).`;

router.post(
  '/field',
  agentApiLimiter,
  requireApiKey,
  async (req, res) => {
    const { question, location, equipment_type, urgency } = req.body || {};
    const requestId = uuidv4();
    const startTime = Date.now();

    // ── Validate ─────────────────────────────────────────────────────────────
    if (!question || typeof question !== 'string' || question.trim().length < 5) {
      return res.status(400).json({
        error: 'question is required (min 5 characters)',
        code:  'INVALID_INPUT',
      });
    }
    const VALID_URGENCY = ['low', 'medium', 'high', 'emergency'];
    const urgencyLevel = VALID_URGENCY.includes(urgency) ? urgency : 'medium';

    // ── Credit check (skip for emergency) ───────────────────────────────────
    const { wallet } = req.apiContext || {};
    const CREDIT_COST = 5;
    const isEmergency = urgencyLevel === 'emergency';

    if (!isEmergency) {
      const balance = parseFloat(wallet?.balance_usd) || 0;
      if (balance < CREDIT_COST * 0.01) {
        return res.status(402).json({
          error: 'Insufficient credits',
          code:  'INSUFFICIENT_CREDITS',
          balance_usd: balance,
          required_credits: CREDIT_COST,
        });
      }
    }

    // ── Build prompt ────────────────────────────────────────────────────────
    const contextPrefix = isEmergency ? 'EMERGENCY: ' : '';
    const contextBlock = [
      location      ? `Location: ${location}`         : null,
      equipment_type ? `Equipment: ${equipment_type}` : null,
      `Urgency: ${urgencyLevel.toUpperCase()}`,
    ].filter(Boolean).join(' | ');

    const fullPrompt = `${contextPrefix}${contextBlock}\n\nField Question: ${question.trim()}`;

    // ── Select model ────────────────────────────────────────────────────────────
    const selectedModel = isEmergency ? AGENT_MODEL_PRO : AGENT_MODEL;

    try {
      const modelClient = genAI.getGenerativeModel({
        model: selectedModel,
        systemInstruction: FIELD_SYSTEM_PROMPT,
      });

      const geminiResponse = await modelClient.generateContent({
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        generationConfig: {
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
        },
      });

      const rawText = geminiResponse.response.text();
      const usageMeta = geminiResponse.response?.usageMetadata;
      const tokensInput  = usageMeta?.promptTokenCount     || 0;
      const tokensOutput = usageMeta?.candidatesTokenCount || 0;
      const latencyMs    = Date.now() - startTime;

      // Parse JSON response from Gemini
      let parsed;
      try {
        // Strip markdown code fences if present
        const clean = rawText.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        // Fallback: treat entire response as answer
        parsed = {
          answer: rawText,
          safety_warnings: [],
          next_steps: [],
          confidence: 0.7,
          escalate_to_professional: urgencyLevel === 'emergency',
        };
      }

      const { apiKey } = req.apiContext || {};

      // Deduct credits for non-emergency
      if (!isEmergency) {
        await supabase.rpc('deduct_credits', {
          p_user_id: apiKey?.user_id,
          p_amount:  CREDIT_COST * 0.01, // credits in USD
        }).catch(() => {}); // non-fatal
      }

      // Log to query_history (async)
      setImmediate(() => {
        supabase.from('query_history').insert({
          account_id:    apiKey?.user_id,
          question:      fullPrompt,
          ai_answer:     parsed.answer || rawText,
          model_used:    selectedModel,
          tokens_input:  tokensInput,
          tokens_output: tokensOutput,
          latency_ms:    latencyMs,
          source:        'agent_field',
          context: {
            location, equipment_type, urgency: urgencyLevel,
            emergency: isEmergency,
          },
        }).then(({ error }) => {
          if (error) console.error('[agent/field] history insert failed:', error.message);
        }).catch(err => console.error('[agent/field] history insert error:', err.message));
      });

      return res.json({
        request_id:              requestId,
        answer:                  parsed.answer               || '',
        safety_warnings:         Array.isArray(parsed.safety_warnings)  ? parsed.safety_warnings  : [],
        next_steps:              Array.isArray(parsed.next_steps)        ? parsed.next_steps        : [],
        confidence:              typeof parsed.confidence === 'number'    ? parseFloat(parsed.confidence.toFixed(2)) : 0.75,
        escalate_to_professional: !!parsed.escalate_to_professional,
        urgency:                 urgencyLevel,
        emergency_mode:          isEmergency,
        model_used:              selectedModel,
        credits_used:            isEmergency ? 0 : CREDIT_COST,
        response_time_ms:        latencyMs,
      });

    } catch (err) {
      console.error('[agent/field] Gemini error:', err.message);
      return res.status(500).json({
        error: err.message || 'Field AI service error',
        code:  'AI_SERVICE_ERROR',
        request_id: requestId,
      });
    }
  }
);

module.exports = router;
