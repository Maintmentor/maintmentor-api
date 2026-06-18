'use strict';

/**
 * routes/a2a.js
 *
 * MaintMentor Agent2Agent (A2A) Protocol Implementation
 * Spec: https://a2a-protocol.org
 *
 * Implements JSON-RPC 2.0 over HTTP POST at /a2a
 *
 * Supported methods:
 *   tasks/send    — Submit a task synchronously (returns completed task)
 *   tasks/get     — Get task status by ID
 *   tasks/cancel  — Cancel a pending/working task
 *
 * Supported skills (mapped to existing agent endpoints):
 *   maintenance-query   → /api/agent/query  (text questions, 5 credits)
 *   maintenance-photo   → /api/agent/photo  (image analysis, 15 credits)
 *   maintenance-field   → /api/agent/field  (field companion, 5 credits)
 *
 * Auth: Bearer token (same API key format as /api/agent routes)
 *
 * Route prefix: /a2a  (registered in server.js)
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = require('../lib/supabase');
const { requireApiKey } = require('../middleware/auth');
const { balanceCheck } = require('../middleware/balanceCheck');
const { billing } = require('../middleware/billing');
const { buildRagContext } = require('../lib/embeddings');
const { buildManualContext } = require('../lib/manuals');

// ─── Gemini Client ────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const MODEL_FLASH = process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash';
const MODEL_PRO   = process.env.GEMINI_MODEL       || 'gemini-2.5-pro';

// ─── In-memory Task Store (TTL: 2h) ──────────────────────────────────────────
const taskStore = new Map();
const TASK_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, task] of taskStore.entries()) {
    if (now - task._createdAt > TASK_TTL_MS) taskStore.delete(id);
  }
}, 30 * 60 * 1000);

// ─── JSON-RPC 2.0 Error Codes ─────────────────────────────────────────────────
const JSONRPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: 'Parse error' },
  INVALID_REQUEST:  { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS:   { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR:   { code: -32603, message: 'Internal error' },
  // A2A-specific
  TASK_NOT_FOUND:   { code: -32001, message: 'Task not found' },
  TASK_NOT_CANCELABLE: { code: -32002, message: 'Task is not in a cancelable state' },
  INSUFFICIENT_CREDITS: { code: -32003, message: 'Insufficient credits' },
  UNAUTHORIZED:     { code: -32004, message: 'Unauthorized — provide a valid Bearer API key' },
};

function rpcError(id, error, data) {
  const resp = {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { ...error },
  };
  if (data !== undefined) resp.error.data = data;
  return resp;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// ─── Task State Machine ────────────────────────────────────────────────────────
// States: submitted → working → completed | failed | canceled
function makeTask(taskId, message, skillId, contextId) {
  return {
    id: taskId,
    contextId: contextId || uuidv4(),
    status: {
      state: 'submitted',
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [message],
    metadata: { skillId },
    _createdAt: Date.now(),
  };
}

function setTaskWorking(task) {
  task.status = { state: 'working', timestamp: new Date().toISOString() };
}

function setTaskCompleted(task, answerText, metadata = {}) {
  task.status = { state: 'completed', timestamp: new Date().toISOString() };
  task.artifacts = [
    {
      artifactId: uuidv4(),
      name: 'answer',
      parts: [{ kind: 'text', text: answerText }],
      metadata,
    },
  ];
}

function setTaskFailed(task, message) {
  task.status = {
    state: 'failed',
    timestamp: new Date().toISOString(),
    message: { role: 'agent', parts: [{ kind: 'text', text: message }] },
  };
}

// ─── Extract text + image parts from A2A message ─────────────────────────────
function extractMessageParts(message) {
  const parts = message?.parts || [];
  const texts = [];
  const imageUrls = [];

  for (const part of parts) {
    if (part.kind === 'text' || part.type === 'text') {
      texts.push(part.text || '');
    } else if (
      (part.kind === 'file' || part.type === 'file') &&
      (part.file?.mimeType || part.mimeType || '').startsWith('image/')
    ) {
      const url = part.file?.uri || part.uri || part.url;
      if (url) imageUrls.push(url);
    }
  }
  return { text: texts.join('\n').trim(), imageUrls };
}

// ─── Core: Run a maintenance query via Gemini ─────────────────────────────────
const AGENT_SYSTEM_PROMPT = `You are MaintMentor, an expert residential maintenance AI with deep knowledge of HVAC, plumbing, electrical, and general contracting. Provide accurate, safe, actionable maintenance guidance. Always note when professional help is required.

Keep responses focused and practical. Lead with safety warnings when relevant. Provide step-by-step guidance when asked. Always suggest the cheapest/simplest fix first before expensive repairs.`;

async function runMaintenanceQuery(question, context = {}, loopContext = {}) {
  if (!genAI) throw new Error('AI service not configured');

  let ragContext = null;
  let manualContext = null;

  try { ragContext = await buildRagContext(question); } catch (_) { /* non-fatal */ }
  try { manualContext = await buildManualContext(question); } catch (_) { /* non-fatal */ }

  const contextBlocks = [ragContext, manualContext].filter(Boolean);
  let promptText = question;

  if (context.appliance_type || context.model || context.age_years) {
    const parts = [];
    if (context.appliance_type) parts.push(`Appliance: ${context.appliance_type}`);
    if (context.model)          parts.push(`Model: ${context.model}`);
    if (context.age_years)      parts.push(`Age: ${context.age_years} years`);
    promptText = `Context: ${parts.join(' | ')}\n\nQuestion: ${question}`;
  }

  if (contextBlocks.length > 0) {
    promptText = `${contextBlocks.join('\n\n')}\n\n${promptText}`;
  }

  const model = genAI.getGenerativeModel({ model: MODEL_FLASH, systemInstruction: AGENT_SYSTEM_PROMPT });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { maxOutputTokens: 1000 },
  });
  return {
    answer: result.response.text(),
    usage:  result.response.usageMetadata || {},
    model:  MODEL_FLASH,
  };
}

// ─── Core: Run field companion query ─────────────────────────────────────────
const FIELD_SYSTEM_PROMPT = `You are MaintMentor Field Companion — an AI assistant for field technicians. Lead with safety warnings. Give numbered next steps. Flag professional escalation when needed. Be concise.`;

async function runFieldQuery(question, location, equipment_type, urgency) {
  if (!genAI) throw new Error('AI service not configured');

  const isEmergency = urgency === 'emergency';
  const selectedModel = isEmergency ? MODEL_PRO : MODEL_FLASH;
  const contextBlock = [
    location       ? `Location: ${location}`       : null,
    equipment_type ? `Equipment: ${equipment_type}` : null,
    `Urgency: ${(urgency || 'medium').toUpperCase()}`,
  ].filter(Boolean).join(' | ');

  const fullPrompt = `${isEmergency ? 'EMERGENCY: ' : ''}${contextBlock}\n\nField Question: ${question}`;

  const model = genAI.getGenerativeModel({ model: selectedModel, systemInstruction: FIELD_SYSTEM_PROMPT });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
    generationConfig: { maxOutputTokens: 1200 },
  });
  return {
    answer: result.response.text(),
    usage:  result.response.usageMetadata || {},
    model:  selectedModel,
  };
}

// ─── Core: Run photo analysis ─────────────────────────────────────────────────
const PHOTO_SYSTEM_PROMPT = `You are MaintMentor, an expert residential maintenance AI. Analyze photos for maintenance issues. Be specific, practical, and safety-aware. Respond in plain text with clear findings and recommendations.`;

async function runPhotoAnalysis(imageUrls, question) {
  if (!genAI) throw new Error('AI service not configured');

  async function fetchImage(url) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    const mimeType = ct.split(';')[0].trim();
    const buf = Buffer.from(await resp.arrayBuffer());
    return { inlineData: { data: buf.toString('base64'), mimeType } };
  }

  const imageParts = await Promise.all(imageUrls.map(fetchImage));
  const questionText = question
    ? `User question: ${question}\n\nAnalyze the image(s) with this in mind.`
    : 'Identify maintenance issues, damage, or conditions in the image(s).';

  const model = genAI.getGenerativeModel({ model: MODEL_PRO, systemInstruction: PHOTO_SYSTEM_PROMPT });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: questionText }, ...imageParts] }],
    generationConfig: { maxOutputTokens: 2000 },
  });
  return {
    answer: result.response.text(),
    usage:  result.response.usageMetadata || {},
    model:  MODEL_PRO,
  };
}

// ─── Credit costs ─────────────────────────────────────────────────────────────
const CREDIT_COSTS = {
  'maintenance-query': 5,
  'maintenance-field': 5,
  'maintenance-photo': 15,
};

// ─── Auth + balance helper (without Express middleware chain) ─────────────────
const { hashApiKey, validateKeyFormat } = require('../lib/apiKeys');

async function resolveApiKey(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const rawKey = authHeader.slice(7).trim();

  if (!validateKeyFormat(rawKey)) return null;

  const keyHash = hashApiKey(rawKey);

  const { data: apiKey, error } = await supabase
    .from('api_keys')
    .select('id, user_id, is_active, label, key_prefix')
    .eq('key_hash', keyHash)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !apiKey) return null;

  const { data: wallet } = await supabase
    .from('wallets')
    .select('id, balance_credits, user_id, lifetime_credits, lifetime_spent')
    .eq('user_id', apiKey.user_id)
    .maybeSingle();

  if (!wallet) return null;

  return { apiKey: { id: apiKey.id, user_id: apiKey.user_id, prefix: apiKey.key_prefix, label: apiKey.label }, wallet };
}

async function deductCredits(wallet, apiKey, credits) {
  const { error } = await supabase
    .from('wallets')
    .update({ balance_credits: wallet.balance_credits - credits })
    .eq('id', wallet.id);
  if (error) throw new Error('Failed to deduct credits: ' + error.message);
}

// ─── Method: tasks/send ───────────────────────────────────────────────────────
async function handleTasksSend(params, authContext, rpcId) {
  const { id: taskId, message, metadata = {}, contextId } = params;

  if (!taskId)   return rpcError(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, 'params.id is required');
  if (!message)  return rpcError(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, 'params.message is required');

  const { text, imageUrls } = extractMessageParts(message);
  if (!text && imageUrls.length === 0) {
    return rpcError(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, 'message must contain at least one text or image part');
  }

  // Determine skill from metadata or infer from content
  let skillId = metadata.skill || (imageUrls.length > 0 ? 'maintenance-photo' : 'maintenance-query');
  if (metadata.field || metadata.urgency) skillId = 'maintenance-field';

  const creditCost = CREDIT_COSTS[skillId] || 5;

  // Check balance
  if (authContext) {
    const { wallet } = authContext;
    const balance = parseFloat(wallet?.balance_credits || 0);
    const isEmergency = (metadata.urgency === 'emergency');
    if (!isEmergency && balance < creditCost) {
      return rpcError(rpcId, JSONRPC_ERRORS.INSUFFICIENT_CREDITS, {
        balance_credits: balance,
        required_credits: creditCost,
      });
    }
  }

  // Create task
  const task = makeTask(taskId, message, skillId, contextId);
  taskStore.set(taskId, task);
  setTaskWorking(task);

  try {
    let result;

    if (skillId === 'maintenance-photo') {
      result = await runPhotoAnalysis(imageUrls, text);
    } else if (skillId === 'maintenance-field') {
      const { location, equipment_type, urgency } = metadata;
      result = await runFieldQuery(text, location, equipment_type, urgency || 'medium');
    } else {
      const { context: appCtx, loop_context } = metadata;
      result = await runMaintenanceQuery(text, appCtx || {}, loop_context || {});
    }

    const artifactMeta = {
      model_used:  result.model,
      credits_used: creditCost,
      skill_id:    skillId,
      tokens_input:  result.usage.promptTokenCount     || 0,
      tokens_output: result.usage.candidatesTokenCount || 0,
    };
    setTaskCompleted(task, result.answer, artifactMeta);

    // Deduct credits (non-blocking, best-effort)
    if (authContext && metadata.urgency !== 'emergency') {
      deductCredits(authContext.wallet, authContext.apiKey, creditCost)
        .catch(e => console.error('[a2a] credit deduction failed:', e.message));
    }

    // Log query (non-blocking)
    if (authContext) {
      setImmediate(() => {
        supabase.from('query_history').insert({
          account_id:     authContext.apiKey.user_id,
          question:       text || '(photo)',
          ai_answer:      result.answer,
          model_used:     result.model,
          tokens_input:   result.usage.promptTokenCount     || 0,
          tokens_output:  result.usage.candidatesTokenCount || 0,
          source:         'a2a_protocol',
          trade_category: 'General',
        }).then(({ error }) => {
          if (error) console.error('[a2a] query_history insert failed:', error.message);
        });
      });
    }

  } catch (err) {
    console.error('[a2a] task execution error:', err.message);
    setTaskFailed(task, err.message || 'Task execution failed');
  }

  // Return the completed (or failed) task — synchronous response
  const { _createdAt: _c, ...publicTask } = task;
  return rpcResult(rpcId, publicTask);
}

// ─── Method: tasks/get ────────────────────────────────────────────────────────
function handleTasksGet(params, rpcId) {
  const { id: taskId } = params || {};
  if (!taskId) return rpcError(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, 'params.id is required');

  const task = taskStore.get(taskId);
  if (!task) return rpcError(rpcId, JSONRPC_ERRORS.TASK_NOT_FOUND);

  const { _createdAt: _c, ...publicTask } = task;
  return rpcResult(rpcId, publicTask);
}

// ─── Method: tasks/cancel ─────────────────────────────────────────────────────
function handleTasksCancel(params, rpcId) {
  const { id: taskId } = params || {};
  if (!taskId) return rpcError(rpcId, JSONRPC_ERRORS.INVALID_PARAMS, 'params.id is required');

  const task = taskStore.get(taskId);
  if (!task) return rpcError(rpcId, JSONRPC_ERRORS.TASK_NOT_FOUND);

  if (!['submitted', 'working'].includes(task.status.state)) {
    return rpcError(rpcId, JSONRPC_ERRORS.TASK_NOT_CANCELABLE, `Task is in state: ${task.status.state}`);
  }

  task.status = { state: 'canceled', timestamp: new Date().toISOString() };
  const { _createdAt: _c, ...publicTask } = task;
  return rpcResult(rpcId, publicTask);
}

// ─── POST /a2a — Main JSON-RPC 2.0 handler ───────────────────────────────────
router.post('/', async (req, res) => {
  // ── 1. Auth (optional — some methods may be public; credits enforce access) ─
  let authContext = null;
  try {
    authContext = await resolveApiKey(req.headers['authorization']);
  } catch (authErr) {
    console.warn('[a2a] Auth lookup failed (non-fatal):', authErr.message);
  }

  // ── 2. Parse JSON-RPC request ─────────────────────────────────────────────
  const body = req.body;

  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return res.status(400).json(rpcError(body?.id ?? null, JSONRPC_ERRORS.INVALID_REQUEST));
  }

  const { id: rpcId, method, params } = body;

  console.log(`[a2a] ${method} — auth: ${authContext ? 'ok' : 'anon'} | task: ${params?.id || 'n/a'}`);

  // ── 3. Route methods ──────────────────────────────────────────────────────
  try {
    let response;

    switch (method) {
      case 'tasks/send':
        // tasks/send requires auth (credits needed)
        if (!authContext) {
          return res.status(401).json(rpcError(rpcId, JSONRPC_ERRORS.UNAUTHORIZED));
        }
        response = await handleTasksSend(params || {}, authContext, rpcId);
        break;

      case 'tasks/get':
        response = handleTasksGet(params, rpcId);
        break;

      case 'tasks/cancel':
        response = handleTasksCancel(params, rpcId);
        break;

      default:
        response = rpcError(rpcId, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }

    return res.json(response);

  } catch (err) {
    console.error('[a2a] Unhandled error:', err.message);
    return res.status(500).json(rpcError(rpcId, JSONRPC_ERRORS.INTERNAL_ERROR, err.message));
  }
});

// ─── GET /a2a — Friendly info for browsers hitting the endpoint ───────────────
router.get('/', (req, res) => {
  res.json({
    name: 'MaintMentor A2A Endpoint',
    protocol: 'Agent2Agent (A2A) v1',
    spec: 'https://a2a-protocol.org',
    method: 'POST',
    content_type: 'application/json',
    json_rpc: '2.0',
    agent_card: '/.well-known/agent.json',
    supported_methods: ['tasks/send', 'tasks/get', 'tasks/cancel'],
    skills: ['maintenance-query', 'maintenance-photo', 'maintenance-field'],
    auth: 'Bearer <api-key> — obtain at https://maintmentor.ai/developer',
  });
});

module.exports = router;
