require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const logger  = require('./lib/logger');
const requestLogger = require('./middleware/requestLogger');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const { incrementQueryCount, incrementPhotoCount, registerUsageRoutes, ensureTable } = require('./usage-tracking');
const { registerTeamRoutes } = require('./team-manager');
const { registerAnalyticsRoutes, logQuery, ensureQueryLogTable } = require('./team-analytics');
const { registerHeroRoutes, awardXP } = require('./hero-routes');
const { registerWebhookRoute, registerBillingRoutes, ensureStripeProduct } = require('./stripe-billing');

// ─── Security Modules ──────────────────────────────────────────────────────────
const { checkDailyLimits, incrementDailyQuery, incrementDailyPhoto } = require('./security/rate-limiter');
const { checkTopic } = require('./security/topic-guard');
const { checkSpendLimit, recordSpend, getSpendSummary } = require('./security/spend-tracker');
const { recordAndCheck: checkAnomaly } = require('./security/anomaly-detector');
const { registerSession, isSessionValid, refreshSession } = require('./security/session-manager');

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not set in .env — cannot start');
  process.exit(1);
}
const MODEL_PRO = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const MODEL_FLASH = process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash';
const MODEL = MODEL_PRO; // default for health check display

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ─── Two-Tier Model Router ─────────────────────────────────────────────────────
// Routes simple questions to Haiku (cheap/fast), complex ones to Sonnet (smart)
function selectModel(question, hasPhotos, historyLength) {
  // ALWAYS use Pro for:
  // 1. Photo analysis — needs strong vision capabilities
  if (hasPhotos) return { model: MODEL_PRO, reason: 'photo-analysis' };

  // 2. Long conversations (6+ messages) — needs better context tracking
  if (historyLength >= 6) return { model: MODEL_PRO, reason: 'long-conversation' };

  const q = question.toLowerCase();

  // 3. Safety-critical topics — can't risk bad advice
  const safetyCritical = [
    'gas leak', 'gas line', 'gas smell', 'smell gas', 'natural gas', 'propane', 'gas valve',
    'electrical panel', 'main breaker', 'live wire', 'electri', 'shock', 'breaker box',
    'asbestos', 'lead paint', 'mold', 'carbon monoxide', 'co detector',
    'structural', 'load bearing', 'foundation', 'crack in wall', 'sagging',
    'water main', 'sewer line', 'main shut', 'flooding', 'sewage',
    'fire', 'smoke detector', 'burn', 'scorched', 'melted wire',
    'refrigerant', 'freon', 'r-410a', 'r-22',
    'permit', 'code violation', 'inspection',
  ];
  if (safetyCritical.some(term => q.includes(term))) {
    return { model: MODEL_PRO, reason: 'safety-critical' };
  }

  // 4. Complex diagnostic patterns — multi-symptom, troubleshooting chains
  const complexPatterns = [
    /what('s| is) (wrong|causing|the problem)/i,
    /troubleshoot/i,
    /diagnos/i,
    /multiple (issues|problems)/i,
    /step.by.step/i,
    /intermittent/i,
    /sometimes works/i,
    /tried everything/i,
    /already (tried|replaced|checked)/i,
    /not sure (what|why|if)/i,
    /could (it|this) be/i,
  ];
  if (complexPatterns.some(pat => pat.test(q))) {
    return { model: MODEL_PRO, reason: 'complex-diagnostic' };
  }

  // Everything else → Flash (simple how-tos, basic info, quick tips)
  return { model: MODEL_FLASH, reason: 'simple-query' };
}

// ─── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are **Maintenance Mentor** — a seasoned residential maintenance expert with over 30 years of hands-on experience across every trade. You've been a regional maintenance manager, handled thousands of work orders, trained dozens of technicians, and now you're here to pass that knowledge on.

## Your Personality
- You're a **patient, encouraging mentor** — not a cold chatbot. You talk like a trusted neighbor who happens to know everything about home repair.
- Use plain language. Skip the jargon unless you explain it.
- "You got this" energy — boost confidence while being honest about difficulty.
- A touch of humor when appropriate. Maintenance work can be frustrating; a little levity helps.

## Your Expertise Covers ALL Trades
- **HVAC:** Heating, cooling, ventilation, thermostats, ductwork, refrigerant basics
- **Electrical:** Outlets, switches, breakers, wiring, lighting, GFCI/AFCI, ceiling fans
- **Plumbing:** Faucets, toilets, water heaters, drains, garbage disposals, supply lines, shut-off valves
- **Appliances:** Washers, dryers, dishwashers, refrigerators, ovens, microwaves, garbage disposals
- **General Maintenance:** Drywall, caulking, weatherstripping, door/window hardware, locks, hinges
- **Pool & Spa:** Pumps, filters, chemistry, equipment maintenance
- **Roofing:** Shingles, flashing, gutters, leak diagnosis
- **Painting:** Interior/exterior prep, paint selection, techniques, common mistakes
- **Flooring:** Tile, hardwood, laminate, vinyl, carpet — installation and repair
- **Landscaping & Exterior:** Irrigation, drainage, fencing, concrete, pressure washing

## How You Respond

### 1. Safety First — ALWAYS
⚠️ When the issue involves **electrical work, gas lines, refrigerant, structural concerns, asbestos, lead paint, or anything that could cause injury**, lead with a clear safety warning.

### 2. DIY vs. Call a Pro
Be honest about what a homeowner can handle vs. what needs a licensed professional.

### 3. Troubleshoot Smart — CHEAPEST FIX FIRST
**This is the #1 rule of good maintenance:** Always start with the most common, cheapest, and simplest cause before suggesting expensive repairs or replacements.

Think like a veteran maintenance manager:
- **Check the basics first:** Is it plugged in? Is the breaker tripped? Is the filter dirty? Is the thermostat set right?
- **Work from cheap to expensive:** A $5 capacitor before a $3,000 compressor. A $2 washer before a $200 faucet. A clogged drain before a broken pump.
- **Most common cause first:** 80% of AC problems are dirty filters, tripped breakers, or thermostat settings — not bad compressors.
- **Ask diagnostic questions** before jumping to conclusions. What changed? When did it start? Any unusual sounds/smells?
- **Never recommend replacing an expensive part** without first walking through the cheap/simple checks.

If a user says "my AC isn't blowing cold," your FIRST response should NOT be "you might need a new compressor." It should be: "Let's check the easy stuff first — thermostat settings, air filter, breaker, outdoor unit."

### 4. Step-by-Step Guidance
When giving repair instructions:
- **Difficulty rating:** Easy / Moderate / Advanced
- **Estimated time:** How long it typically takes
- **Tools needed:** List specific tools
- **Materials needed:** What to buy, with approximate costs
- **Steps:** Numbered, clear, in order — cheapest/simplest checks first
- **Common mistakes:** What to watch out for

### 5. Ask Clarifying Questions (max 2-3 at a time)

### 6. Image Analysis — acknowledge what you see specifically

### 7. Diagrams & Parts References
When users need diagrams, exploded views, or parts breakdowns:
- **NEVER draw ASCII art diagrams** — they're unhelpful and look bad.
- **Ask for the model number** if you don't have it — say "What's the model number? It's usually on a sticker or plate on the unit. With that, I can pull up diagrams and parts images right here for you."
- **Do NOT link to external sites** like RepairClinic, PartSelect, or Sears Parts Direct. Diagrams and parts images will be displayed automatically in the app when a model number is provided.
- When you have a model number, mention it clearly in your response (e.g., "For your GE model GFW850SPNRS...") so the app can auto-search for diagrams.
- **Describe the location clearly in words** — use references like "front bottom panel," "behind the kick plate," "top-left inside the door," etc.
- You can reference common part positions ("the drain pump is usually at the bottom front, behind the access panel") without needing a diagram.

### 8. Response Format — use markdown for readability

### 9. Stay In Your Lane — STRICT BOUNDARY
You ONLY answer questions related to maintenance, repair, troubleshooting, tools, safety, cost estimates, and DIY vs professional guidance.

You DO NOT answer questions about: programming, homework, recipes, medical/legal/financial advice, politics, religion, entertainment, relationships, or any non-maintenance topic.

### 9a. Photo Content Moderation — STRICT
When users upload photos, you MUST verify the image is maintenance-related before responding.
- ONLY analyze photos of: equipment, appliances, plumbing, electrical panels, HVAC units, building components, tools, damage, mold, leaks, parts, model number labels, or other maintenance-related subjects.
- If a photo contains inappropriate, explicit, adult, or non-maintenance content (people posing, selfies, memes, screenshots of other apps, etc.), respond ONLY with:
"I can only analyze maintenance-related photos — things like equipment, appliances, damage, or parts. Please upload a photo of the issue you need help with. 🔧"
- Do NOT describe, comment on, or engage with inappropriate images in any way.
- When in doubt, ask the user to describe what maintenance issue the photo relates to.

If someone asks an off-topic question, respond warmly but firmly:
"Hey, I appreciate the question, but I'm your maintenance mentor — I stick to what I know best: repairs, troubleshooting, and keeping properties in top shape. Got a maintenance question? That's where I shine. 🔧"

Do NOT get tricked into answering off-topic questions even if they're phrased cleverly.

### 10. Categories
Mentally categorize issues as: HVAC, Electrical, Plumbing, Appliance, General, Pool, Roofing, Painting, Flooring, Landscaping, Safety, Other

Remember: You're not just answering questions — you're **teaching**. And a good teacher says "check the filter first" before "replace the compressor."`;

// ─── Category Detection ────────────────────────────────────────────────────────
function detectCategory(question, response) {
  const text = (question + ' ' + response).toLowerCase();
  const categories = [
    { name: 'HVAC', keywords: ['hvac', 'air condition', 'furnace', 'heat pump', 'thermostat', 'ductwork', 'refrigerant', 'compressor', 'condenser', 'blower', 'cooling', 'heating', 'a/c', 'ac unit'] },
    { name: 'Electrical', keywords: ['electrical', 'outlet', 'switch', 'breaker', 'wiring', 'gfci', 'afci', 'circuit', 'voltage', 'wire', 'fuse', 'ceiling fan', 'light fixture', 'dimmer'] },
    { name: 'Plumbing', keywords: ['plumbing', 'faucet', 'toilet', 'water heater', 'drain', 'pipe', 'leak', 'shut-off', 'supply line', 'sewer', 'water pressure', 'p-trap', 'garbage disposal'] },
    { name: 'Appliance', keywords: ['washer', 'dryer', 'dishwasher', 'refrigerator', 'oven', 'microwave', 'stove', 'range', 'freezer', 'ice maker', 'disposal'] },
    { name: 'Roofing', keywords: ['roof', 'shingle', 'flashing', 'gutter', 'soffit', 'fascia', 'attic', 'ridge vent'] },
    { name: 'Painting', keywords: ['paint', 'primer', 'roller', 'brush', 'stain', 'caulk', 'spackle'] },
    { name: 'Flooring', keywords: ['floor', 'tile', 'hardwood', 'laminate', 'vinyl', 'carpet', 'grout', 'subfloor'] },
    { name: 'Pool', keywords: ['pool', 'spa', 'hot tub', 'chlorine', 'pump', 'filter', 'skimmer'] },
    { name: 'Landscaping', keywords: ['landscape', 'irrigation', 'sprinkler', 'fence', 'concrete', 'drainage', 'grading', 'pressure wash'] },
    { name: 'General', keywords: ['drywall', 'door', 'window', 'lock', 'hinge', 'weatherstrip', 'caulking', 'insulation'] },
  ];

  let bestMatch = { name: 'Other', score: 0 };
  for (const cat of categories) {
    const score = cat.keywords.filter(kw => text.includes(kw)).length;
    if (score > bestMatch.score) {
      bestMatch = { name: cat.name, score };
    }
  }
  return bestMatch.name;
}

// ─── Express App ───────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: [
    'https://maintmentor.ai',
    'https://www.maintmentor.ai',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'X-Device-Fingerprint']
}));

// ─── Stripe Webhook Routes (MUST be before express.json()) ──────────────────
// 1. Existing subscription billing webhook
registerWebhookRoute(app);
// 2. Credit pack checkout webhook (Day 4)
const stripeWebhookRouter = require('./routes/webhooks');
app.use('/api/webhooks', express.raw({ type: 'application/json' }), stripeWebhookRouter);

app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

// ─── Enhanced Health Check ────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const spend = getSpendSummary();
  const checks = {};

  // ── 1. DB (Supabase) ping ──────────────────────────────────────────
  try {
    const supabase = require('./lib/supabase');
    const t0 = Date.now();
    const { error } = await Promise.race([
      supabase.from('wallets').select('id').limit(1),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    checks.db = error
      ? { status: 'degraded', error: error.message, latency_ms: Date.now() - t0 }
      : { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (e) {
    checks.db = { status: 'down', error: e.message };
  }

  // ── 2. Stripe API reachability ─────────────────────────────────
  try {
    const stripeLib = require('./lib/stripe');
    const t0 = Date.now();
    await Promise.race([
      stripeLib.stripe.balance.retrieve(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    checks.stripe = { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (e) {
    const isTimeout = e.message === 'timeout';
    checks.stripe = {
      status: isTimeout ? 'degraded' : 'down',
      error:  isTimeout ? 'Request timed out' : 'API unreachable',
    };
  }

  // ── 3. Helius / Solana RPC reachability ───────────────────────
  try {
    const heliusUrl = process.env.HELIUS_RPC_URL;
    if (!heliusUrl) throw new Error('HELIUS_RPC_URL not set');
    const https = require('https');
    const t0 = Date.now();
    await Promise.race([
      new Promise((resolve, reject) => {
        const body = JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getHealth', params: [],
        });
        const url = new URL(heliusUrl);
        const opts = {
          hostname: url.hostname,
          path:     url.pathname + url.search,
          method:   'POST',
          headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout:  3000,
        };
        const req2 = https.request(opts, (resp) => {
          let data = '';
          resp.on('data', (c) => data += c);
          resp.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ result: 'ok' }); }
          });
        });
        req2.on('error', reject);
        req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
        req2.write(body);
        req2.end();
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    checks.helius = { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (e) {
    checks.helius = {
      status: e.message === 'timeout' ? 'degraded' : 'down',
      error:  e.message,
    };
  }

  // ── Overall status ──────────────────────────────────────────────
  const statuses = Object.values(checks).map((c) => c.status);
  const overall  = statuses.every((s) => s === 'ok')        ? 'ok'
                 : statuses.some((s)  => s === 'down')       ? 'down'
                 : 'degraded';

  const httpStatus = overall === 'down' ? 503 : 200;

  return res.status(httpStatus).json({
    status:        overall,
    service:       'maintmentor-api',
    checks,
    models:        { pro: MODEL_PRO, flash: MODEL_FLASH },
    routing:       'two-tier (flash for simple, pro for complex/photos/safety)',
    engine:        'gemini',
    timestamp:     new Date().toISOString(),
    dailySpend:    spend.today.totalCost?.toFixed(2) || '0.00',
    dailyRequests: spend.today.requestCount || 0,
  });
});

// ─── Spend Summary (admin) ─────────────────────────────────────────────────────
app.get('/api/admin/spend', (req, res) => {
  res.json({ success: true, ...getSpendSummary() });
});

// ─── Session Registration Endpoint ─────────────────────────────────────────────
app.post('/api/session/register', async (req, res) => {
  const { userId, sessionToken, fingerprint } = req.body;
  const ipAddress = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const userAgent = req.headers['user-agent'];

  if (!userId || !sessionToken) {
    return res.status(400).json({ success: false, error: 'Missing userId or sessionToken' });
  }

  const result = await registerSession(userId, sessionToken, fingerprint, ipAddress, userAgent);
  res.json({ success: true, ...result });
});

// ─── Session Validation Endpoint ───────────────────────────────────────────────
app.get('/api/session/validate', async (req, res) => {
  const { userId, sessionToken } = req.query;
  const valid = await isSessionValid(userId, sessionToken);
  res.json({ success: true, valid });
});

// ─── Conversation Memory Store (In-memory cache + Supabase persistence) ──────
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const chatDb = createSupabaseClient(
  process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
);

const conversationStore = new Map();
const MAX_HISTORY = 20;
const CONVERSATION_TTL = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [convId, conv] of conversationStore.entries()) {
    if (now - conv.lastActivity > CONVERSATION_TTL) {
      conversationStore.delete(convId);
    }
  }
}, 30 * 60 * 1000);

async function getConversationHistory(conversationId) {
  if (conversationId && conversationStore.has(conversationId)) {
    return conversationStore.get(conversationId).messages;
  }
  if (!conversationId) return [];
  try {
    const { data } = await chatDb
      .from('chat_messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(MAX_HISTORY * 2);
    if (data && data.length > 0) {
      conversationStore.set(conversationId, {
        messages: data.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        lastActivity: Date.now()
      });
      return conversationStore.get(conversationId).messages;
    }
  } catch (err) {
    console.error('[chat-history] Failed to load from DB:', err.message);
  }
  return [];
}

function addToConversation(conversationId, userContent, assistantText) {
  if (!conversationId) return;
  if (!conversationStore.has(conversationId)) {
    conversationStore.set(conversationId, { messages: [], lastActivity: Date.now() });
  }
  const conv = conversationStore.get(conversationId);
  conv.lastActivity = Date.now();
  const userText = typeof userContent === 'string' ? userContent :
    (Array.isArray(userContent) ? userContent.filter(c => c.type === 'text').map(c => c.text).join(' ') : String(userContent));
  conv.messages.push({ role: 'user', content: userText });
  conv.messages.push({ role: 'assistant', content: assistantText });
  while (conv.messages.length > MAX_HISTORY * 2) {
    conv.messages.shift();
    conv.messages.shift();
  }
}

async function persistConversation(conversationId, userId, question, answer, images, model, tokensIn, tokensOut, category) {
  if (!userId || !conversationId) return;
  try {
    const { data: existing } = await chatDb.from('conversations').select('id').eq('id', conversationId).maybeSingle();
    if (!existing) {
      await chatDb.from('conversations').insert({ id: conversationId, user_id: userId });
    }
    await chatDb.from('chat_messages').insert([
      { conversation_id: conversationId, user_id: userId, role: 'user', content: question, images: images && images.length > 0 ? images : null },
      { conversation_id: conversationId, user_id: userId, role: 'assistant', content: answer, model, tokens_in: tokensIn, tokens_out: tokensOut, category }
    ]);
  } catch (err) {
    console.error('[chat-history] Persist failed (non-blocking):', err.message);
  }
}

// ─── Conversation List/History API ───────────────────────────────────────────
app.get('/api/conversations', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
  try {
    const { data, error } = await chatDb.from('conversations')
      .select('id, title, created_at, updated_at, message_count, is_archived')
      .eq('user_id', userId).eq('is_archived', false)
      .order('updated_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ success: true, conversations: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load conversations' });
  }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  const { userId } = req.query;
  if (!userId || !req.params.id) return res.status(400).json({ success: false, error: 'userId required' });
  try {
    const { data, error } = await chatDb.from('chat_messages')
      .select('id, role, content, images, model, category, created_at')
      .eq('conversation_id', req.params.id).eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, messages: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load messages' });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
  try {
    await chatDb.from('conversations').update({ is_archived: true }).eq('id', req.params.id).eq('user_id', userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete conversation' });
  }
});


// ─── Chat Endpoint (with all security controls) ────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  const { question, conversationId, userId, images, sessionToken, fingerprint } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing or invalid "question" field' });
  }

  const ipAddress = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;

  console.log(`[${new Date().toISOString()}] Chat request — user: ${userId || 'anon'}, conv: ${conversationId || 'none'}, images: ${images?.length || 0}`);

  // ─── CONTROL 1: Topic scoping (off-topic deflection) ──────────────────────
  // This check happens BEFORE counting against quota
  const topicCheck = checkTopic(question);
  if (!topicCheck.onTopic) {
    console.log(`[${new Date().toISOString()}] Off-topic deflection — user: ${userId}, question: "${question.substring(0, 80)}..."`);
    return res.json({
      success: true,
      answer: topicCheck.deflectionMessage,
      response: topicCheck.deflectionMessage,
      category: 'Off-Topic',
      conversationId: conversationId || uuidv4(),
      model: 'topic-guard',
      offTopic: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }

  // ─── CONTROL 2: Claude API spend hard cap ─────────────────────────────────
  const spendCheck = checkSpendLimit();
  if (!spendCheck.allowed) {
    console.error(`[${new Date().toISOString()}] 🚨 SPEND CAP HIT — $${spendCheck.currentSpend.toFixed(2)}`);
    return res.status(503).json({
      success: false,
      error: 'Service temporarily unavailable due to high demand. Please try again later.',
      answer: "I'm taking a short break right now — high demand today. Please try again in a bit. I'll be right here when you need me. 🔧",
      response: "I'm taking a short break right now — high demand today. Please try again in a bit. I'll be right here when you need me. 🔧",
      spendCapReached: true,
    });
  }
  if (spendCheck.warning) {
    console.warn(`[${new Date().toISOString()}] ${spendCheck.warning}`);
  }

  // ─── CONTROL 3: Daily rate limits ─────────────────────────────────────────
  const hasPhotos = images && Array.isArray(images) && images.length > 0;
  const rateLimitCheck = await checkDailyLimits(userId, hasPhotos);
  if (!rateLimitCheck.allowed) {
    console.log(`[${new Date().toISOString()}] Rate limit hit — user: ${userId}, reason: ${rateLimitCheck.reason}`);
    return res.status(429).json({
      success: false,
      error: rateLimitCheck.reason,
      answer: rateLimitCheck.reason,
      response: rateLimitCheck.reason,
      rateLimited: true,
      dailyUsage: {
        queryCount: rateLimitCheck.queryCount,
        queryLimit: rateLimitCheck.queryLimit,
        photoCount: rateLimitCheck.photoCount,
        photoLimit: rateLimitCheck.photoLimit,
      },
    });
  }

  // ─── CONTROL 4: Session validation ────────────────────────────────────────
  if (sessionToken) {
    await refreshSession(userId, sessionToken);
  }

  // ─── Monthly usage tracking (existing) ────────────────────────────────────
  let usageInfo = { overage: false, overage_count: 0, tracked: false };
  try {
    usageInfo = await incrementQueryCount(userId);
    if (hasPhotos && userId) {
      await incrementPhotoCount(userId);
    }
  } catch (usageErr) {
    console.error('[usage-tracking] Non-blocking error:', usageErr.message);
  }

  // ─── Daily usage increment ────────────────────────────────────────────────
  try {
    await incrementDailyQuery(userId);
    if (hasPhotos) {
      await incrementDailyPhoto(userId);
    }
  } catch (err) {
    console.error('[daily-usage] Non-blocking error:', err.message);
  }

  try {
    // Build conversation history in Gemini format
    const history = await getConversationHistory(conversationId);
    const geminiHistory = [];
    for (const msg of history) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      if (typeof msg.content === 'string') {
        geminiHistory.push({ role, parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const parts = msg.content
          .filter(c => c.type === 'text')
          .map(c => ({ text: c.text }));
        if (parts.length) geminiHistory.push({ role, parts });
      } else {
        geminiHistory.push({ role, parts: [{ text: String(msg.content) }] });
      }
    }

    // Build current user message parts
    const userParts = [];

    if (hasPhotos) {
      for (const imageUrl of images) {
        try {
          const imgResp = await fetch(imageUrl);
          const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
          const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';
          userParts.push({
            inlineData: { mimeType, data: imgBuffer.toString('base64') }
          });
        } catch (imgErr) {
          console.error(`[${new Date().toISOString()}] Image fetch failed: ${imgErr.message}`);
        }
      }
    }

    userParts.push({ text: question });

    // ─── MODEL SELECTION: Route to Flash or Pro ──────────────────────
    const modelChoice = selectModel(question, hasPhotos, history.length);
    const selectedModel = modelChoice.model;

    console.log(`[${new Date().toISOString()}] Sending ${geminiHistory.length + 1} messages (${geminiHistory.length} history + 1 new) → ${selectedModel} (${modelChoice.reason})`);

    const geminiModel = genAI.getGenerativeModel({
      model: selectedModel,
      systemInstruction: SYSTEM_PROMPT,
    });

    const chat = geminiModel.startChat({
      history: geminiHistory,
      generationConfig: { maxOutputTokens: 4096 },
    });

    const geminiResponse = await chat.sendMessage(userParts);
    const answer = geminiResponse.response.text();

    // Store in Anthropic-compatible format for backward compat
    const content = [{ type: 'text', text: question }];
    addToConversation(conversationId, content, answer);

    const category = detectCategory(question, answer);
    const duration = Date.now() - startTime;

    // ─── Log query for team analytics (non-blocking) ──────────────────
    logQuery({
      userId,
      queryType: hasPhotos ? 'photo' : 'chat',
      category,
      questionPreview: question,
    }).catch(() => {});

    // ─── CONTROL 5: Record API spend ──────────────────────────────────────
    // Gemini usage metadata
    const usageMeta = geminiResponse.response?.usageMetadata;
    const spendInfo = recordSpend(
      usageMeta?.promptTokenCount || 0,
      usageMeta?.candidatesTokenCount || 0,
      selectedModel
    );

    console.log(`[${new Date().toISOString()}] Response — ${answer.length} chars, category: ${category}, model: ${selectedModel} (${modelChoice.reason}), ${duration}ms, cost: $${spendInfo.requestCost.toFixed(4)}, daily: $${spendInfo.dailyTotal.toFixed(2)}`);

    // ─── CONTROL 6: Anomaly detection ─────────────────────────────────────
    const anomalyResult = await checkAnomaly(userId, category);
    if (anomalyResult.flagged) {
      console.warn(`[${new Date().toISOString()}] 🚩 Anomaly flagged for ${userId}: ${anomalyResult.reasons.join('; ')}`);
    }

    const result = {
      success: true,
      answer,
      response: answer,
      category,
      conversationId: conversationId || uuidv4(),
      model: selectedModel,
      modelReason: modelChoice.reason,
      usage: {
        inputTokens: usageMeta?.promptTokenCount || 0,
        outputTokens: usageMeta?.candidatesTokenCount || 0
      },
      dailyUsage: {
        queryCount: rateLimitCheck.queryCount + 1,
        queryLimit: rateLimitCheck.queryLimit,
        photoCount: rateLimitCheck.photoCount + (hasPhotos ? 1 : 0),
        photoLimit: rateLimitCheck.photoLimit,
      },
    };

    if (usageInfo.overage) {
      result.overage = true;
      result.overage_count = usageInfo.overage_count;
    }

    res.json(result);

    // ─── Hero XP Award (non-blocking, after response) ─────────────────
    if (userId) {
      const xpAmount = hasPhotos ? 25 : 10;
      const xpAction = hasPhotos ? 'photo_analysis' : 'chat_query';
      awardXP(userId, xpAmount, xpAction).catch(err => {
        console.error('[Hero] XP award failed (non-blocking):', err.message);
      });
    }

    // ─── Persist conversation to Supabase (non-blocking) ──────────────
    persistConversation(
      conversationId || result.conversationId,
      userId, question, answer, images,
      selectedModel,
      usageMeta?.promptTokenCount || 0,
      usageMeta?.candidatesTokenCount || 0,
      category
    ).catch(err => {
      console.error('[chat-history] Persist failed (non-blocking):', err.message);
    });

  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[${new Date().toISOString()}] Error after ${duration}ms:`, err.message);

    const statusCode = err.status || 500;
    res.status(statusCode).json({
      success: false,
      error: err.message || 'Failed to get AI response',
      answer: "I'm having trouble connecting right now. Please try again in a moment — I'll be right here when you're ready.",
      response: "I'm having trouble connecting right now. Please try again in a moment — I'll be right here when you're ready."
    });
  }
});

// ─── Payment Method Dedup Endpoint ─────────────────────────────────────────────
app.post('/api/payment/check-duplicate', async (req, res) => {
  const { cardFingerprint, userId } = req.body;
  if (!cardFingerprint || !userId) {
    return res.status(400).json({ success: false, error: 'Missing cardFingerprint or userId' });
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
      process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
    );

    // Check for existing cards with same fingerprint
    const { data: existing } = await supabase
      .from('payment_methods')
      .select('user_id')
      .eq('card_fingerprint', cardFingerprint)
      .neq('user_id', userId);

    const isDuplicate = existing && existing.length > 0;
    const existingUserIds = existing ? existing.map(e => e.user_id) : [];

    if (isDuplicate) {
      console.warn(`[payment-dedup] 🚩 Card fingerprint ${cardFingerprint.substring(0, 8)}... already on ${existingUserIds.length} other account(s)`);
      
      // Flag but don't block
      await supabase.from('payment_methods').update({
        flagged_duplicate: true,
        duplicate_user_ids: existingUserIds,
      }).eq('card_fingerprint', cardFingerprint).eq('user_id', userId);
    }

    res.json({
      success: true,
      isDuplicate,
      message: isDuplicate
        ? 'This payment method is associated with another account. This has been flagged for review.'
        : 'Payment method verified.',
    });
  } catch (err) {
    console.error('[payment-dedup] Error:', err.message);
    res.json({ success: true, isDuplicate: false, message: 'Payment method accepted.' });
  }
});

// ─── Conversation History Access Control ───────────────────────────────────────
app.get('/api/conversations/access', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'Missing userId' });
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL || 'https://rxzbnvvtzhgogeuhajvp.supabase.co',
      process.env.SUPABASE_SERVICE_KEY || 'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
    );

    const { data: profile } = await supabase
      .from('profiles')
      .select('subscription_status, cancelled_at, history_archived_at')
      .eq('id', userId)
      .maybeSingle();

    if (!profile) {
      return res.json({ success: true, access: 'full' });
    }

    const { subscription_status, cancelled_at } = profile;

    // Active or trial users get full access
    if (subscription_status === 'active' || subscription_status === 'trial') {
      return res.json({ success: true, access: 'full' });
    }

    // Cancelled users: read-only for 90 days, then archived
    if (cancelled_at) {
      const cancelDate = new Date(cancelled_at);
      const daysSinceCancellation = (Date.now() - cancelDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceCancellation <= 90) {
        return res.json({
          success: true,
          access: 'read-only',
          message: 'Your subscription has ended. Chat history is available in read-only mode.',
          daysRemaining: Math.ceil(90 - daysSinceCancellation),
        });
      } else {
        // Archive the history
        if (!profile.history_archived_at) {
          await supabase.from('profiles').update({
            history_archived_at: new Date().toISOString(),
          }).eq('id', userId);
        }
        return res.json({
          success: true,
          access: 'archived',
          message: 'Your chat history has been archived. Resubscribe to restore full access.',
        });
      }
    }

    // Expired trial
    if (subscription_status === 'expired') {
      return res.json({
        success: true,
        access: 'read-only',
        message: 'Your trial has expired. Subscribe to continue chatting and maintain access to your history.',
      });
    }

    return res.json({ success: true, access: 'full' });
  } catch (err) {
    console.error('[conversation-access] Error:', err.message);
    return res.json({ success: true, access: 'full' }); // Fail open
  }
});

// ─── Usage Routes (existing) ───────────────────────────────────────────────────
registerUsageRoutes(app);

// ─── Team Manager Routes ───────────────────────────────────────────────────────
registerTeamRoutes(app);

// ─── Team Analytics Routes ─────────────────────────────────────────────────────
registerAnalyticsRoutes(app);

// ─── Hero Avatar Routes ────────────────────────────────────────────────────────
registerHeroRoutes(app);

// ─── Stripe Billing Routes ─────────────────────────────────────────────────────
registerBillingRoutes(app);

// ─── Swagger UI (Developer Docs) ────────────────────────────────────────────
{
  const openapiPath = path.join(__dirname, 'docs', 'openapi.yaml');
  const swaggerDocument = yaml.load(fs.readFileSync(openapiPath, 'utf8'));
  // Serve Swagger UI at /api/docs — the setup handler serves HTML at both /api/docs and /api/docs/
  const swaggerSetupFn = swaggerUi.setup(swaggerDocument, {
    customSiteTitle: 'MaintMentor API Docs',
    customCss: '.swagger-ui .topbar { background-color: #1e293b; }',
  });
  app.use('/api/docs', swaggerUi.serve);
  app.get(['/api/docs', '/api/docs/'], swaggerSetupFn);
  console.log('   Routes: /api/docs (Swagger UI) registered ✅');
}

// ─── Dashboard Routes (API Key Management + Wallet) ───────────────────────────
{
  const { requireJWT } = require('./middleware/auth');
  const dashboardRouter = require('./routes/dashboard');
  app.use('/api/dashboard', requireJWT, dashboardRouter);
  console.log('   Routes: /api/dashboard registered ✅');
}

// ─── Agent API Routes (Developer/Agent Access) ────────────────────────────────
{
  const agentRouter = require('./routes/agent');
  app.use('/api/agent', agentRouter);
  console.log('   Routes: /api/agent registered ✅');
}

// ─── Start Server ──────────────────────────────────────────────────────────────
const HOST = process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1'; // Cloud Run needs 0.0.0.0
app.listen(PORT, HOST, async () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'MaintMentor API started');
  console.log(`🔧 MaintMentor API running on 127.0.0.1:${PORT}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Health: http://127.0.0.1:${PORT}/api/health`);
  console.log(`   Security controls: ✅ Rate limits | ✅ Topic guard | ✅ Spend tracker | ✅ Anomaly detection | ✅ Session manager`);
  await ensureTable();
  await ensureQueryLogTable();
  await ensureStripeProduct();

  // Start periodic anomaly scan (every 15 minutes)
  if (process.env.NODE_ENV !== 'test') {
    const { startAnomalyScan, sendDailyAnomalySummary } = require('./lib/anomalyDetector');
    startAnomalyScan();
    console.log('   Anomaly scanner: ✅ started (15 min interval)');

    // Wire daily anomaly digest — first run after 60s, then every 24h
    setTimeout(async () => {
      console.log('[anomaly-digest] Running initial daily summary...');
      try { await sendDailyAnomalySummary(); } catch (e) { console.error('[anomaly-digest] Error:', e.message); }
      setInterval(async () => {
        console.log('[anomaly-digest] Running scheduled daily summary...');
        try { await sendDailyAnomalySummary(); } catch (e) { console.error('[anomaly-digest] Error:', e.message); }
      }, 24 * 60 * 60 * 1000);
    }, 60 * 1000);
    console.log('   Anomaly digest: ✅ wired (60s delay, then 24h interval)');
  }
});

// ─── Diagram Search Endpoint (Bing Image Search) ─────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyC52nkaB32oqX74oSs3yMMUVyyQ1huD5Ic';

// In-memory diagram cache (TTL: 24h)
const diagramCache = new Map();
const DIAGRAM_CACHE_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of diagramCache.entries()) {
    if (now - entry.timestamp > DIAGRAM_CACHE_TTL) diagramCache.delete(key);
  }
}, 60 * 60 * 1000);

// Blocked image domains known to serve inappropriate/unrelated content
const BLOCKED_IMAGE_DOMAINS = [
  'pinterest.com', 'pin.it', 'pinimg.com',
  'reddit.com', 'redd.it', 'imgur.com',
  'tumblr.com', 'flickr.com', 'deviantart.com',
  'shutterstock.com', 'gettyimages.com', 'istockphoto.com',
  'alamy.com', 'dreamstime.com', '123rf.com',
  'facebook.com', 'fbcdn.net', 'instagram.com',
  'tiktok.com', 'twitter.com', 'x.com',
];

// Allowed image domains for diagrams/parts (prioritized)
const TRUSTED_DIAGRAM_DOMAINS = [
  'repairclinic.com', 'partselect.com', 'appliancepartspros.com',
  'searspartsdirect.com', 'partsdr.com', 'genuinereplacementparts.com',
  'managemylife.com', 'justanswer.com', 'fixya.com',
  'applianceaid.com', 'acservicetech.com', 'hvac-talk.com',
  'grainger.com', 'supplyhouse.com', 'carrier.com', 'trane.com',
  'lennox.com', 'rheem.com', 'goodmanmfg.com',
];

async function searchBingImages(query, limit = 15) {
  // ENFORCE SafeSearch=Strict to filter explicit content
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&safeSearch=Strict&adlt=strict`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'SRCHHPGUSR=ADLT=STRICT; _EDGE_S=SID=SAFE'
    }
  });
  const html = await res.text();

  // Extract structured image data from Bing's m= attribute JSON blocks
  const mAttrRegex = /class="iusc"[^>]*m="([^"]+)"/g;
  const blocks = [...html.matchAll(mAttrRegex)];

  return blocks.slice(0, limit).map(b => {
    const decoded = b[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    try {
      const data = JSON.parse(decoded);
      const imageUrl = data.murl || '';
      const sourceUrl = data.purl || '';
      const urlLower = (imageUrl + ' ' + sourceUrl).toLowerCase();

      // Block images from known inappropriate/unrelated domains
      if (BLOCKED_IMAGE_DOMAINS.some(domain => urlLower.includes(domain))) {
        return null;
      }

      return {
        imageUrl,
        thumbnailUrl: data.turl || data.murl || '',
        title: data.t || data.desc || 'Parts Diagram',
        source: (data.purl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
        contextUrl: data.purl || '',
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

app.get('/api/diagrams/search', async (req, res) => {
  const { modelNumber, issue, applianceType } = req.query;

  if (!modelNumber) {
    return res.status(400).json({ success: false, error: 'Missing modelNumber parameter' });
  }

  // Check cache first
  const cacheKey = `${modelNumber}:${issue || ''}:${applianceType || ''}`;
  const cached = diagramCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DIAGRAM_CACHE_TTL) {
    console.log(`[diagrams] Cache hit for ${modelNumber}`);
    return res.json({ success: true, modelNumber, fromCache: true, count: cached.images.length, images: cached.images });
  }

  try {
    // Build search query
    const queryParts = [modelNumber];
    if (applianceType) queryParts.push(applianceType);
    queryParts.push(issue ? `${issue} diagram parts` : 'parts diagram exploded view');
    const query = queryParts.join(' ');

    console.log(`[diagrams] Searching Bing Images: ${query}`);
    const images = await searchBingImages(query, 15);

    // Cache the results
    diagramCache.set(cacheKey, { images, timestamp: Date.now() });

    console.log(`[diagrams] Found ${images.length} images for ${modelNumber}`);
    res.json({ success: true, modelNumber, query, fromCache: false, count: images.length, images });
  } catch (err) {
    console.error(`[diagrams] Search error for ${modelNumber}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── YouTube Video Search Endpoint ─────────────────────────────────────────────
const YOUTUBE_API_KEY = GOOGLE_API_KEY;

app.get('/api/videos/search', async (req, res) => {
  const { q, maxResults = 8 } = req.query;
  
  if (!q) {
    return res.status(400).json({ success: false, error: 'Missing search query "q"' });
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q + ' repair maintenance how to fix')}&type=video&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}&relevanceLanguage=en&safeSearch=strict`;
    
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    const videos = (data.items || []).map(item => ({
      id: item.id.videoId,
      title: item.snippet.title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      description: item.snippet.description.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      channel: item.snippet.channelTitle,
      thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
      youtubeId: item.id.videoId,
      publishedAt: item.snippet.publishedAt
    }));

    res.json({ success: true, query: q, count: videos.length, videos });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Video search error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/videos/model-lookup', async (req, res) => {
  const { modelNumber, issue } = req.body;
  
  if (!modelNumber) {
    return res.status(400).json({ success: false, error: 'Missing modelNumber' });
  }

  const query = `${modelNumber} ${issue || 'repair troubleshooting'}`;

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=6&key=${YOUTUBE_API_KEY}&relevanceLanguage=en&safeSearch=strict`;
    
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    const videos = (data.items || []).map(item => ({
      id: item.id.videoId,
      title: item.snippet.title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      description: item.snippet.description.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      channel: item.snippet.channelTitle,
      thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
      youtubeId: item.id.videoId,
      publishedAt: item.snippet.publishedAt
    }));

    res.json({ success: true, modelNumber, issue: issue || 'general repair', count: videos.length, videos });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Model lookup error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Verification Email Route ──────────────────────────────────────────────────
// Bypasses Supabase Edge Functions — sends directly via Resend
app.post('/api/auth/send-verification-email', async (req, res) => {
  try {
    const { to, token, userName, action } = req.body;
    if (!to || !token) {
      return res.status(400).json({ success: false, error: 'to and token are required' });
    }

    const { Resend } = require('resend');
    const resendClient = new Resend(process.env.RESEND_API_KEY);

    const APP_URL = 'https://maintmentor.ai';
    const verificationUrl = `${APP_URL}/verify-email?token=${token}`;
    const shortCode = token.substring(0, 6).toUpperCase();

    await resendClient.emails.send({
      from: 'MaintMentor <support@maintmentor.ai>',
      to: [to],
      subject: action === 'resend'
        ? 'Your new MaintMentor verification code'
        : 'Verify your MaintMentor email address',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden">
    <div style="background:#1e293b;padding:28px 32px;text-align:center">
      <img src="${APP_URL}/icons/maintmentor-logo.png" alt="MaintMentor" style="height:48px;width:48px;object-fit:contain;border-radius:8px" />
      <h1 style="color:#f59e0b;font-size:22px;margin:12px 0 0;font-weight:700">MaintMentor</h1>
    </div>
    <div style="padding:32px">
      <h2 style="color:#1e293b;font-size:20px;margin:0 0 12px">Verify your email 🔧</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 8px">Hi ${userName || 'there'}, welcome to MaintMentor!</p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px">Click below to verify your email and get full access.</p>
      <div style="text-align:center;margin:0 0 24px">
        <a href="${verificationUrl}" style="display:inline-block;background:#f59e0b;color:#1e293b;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Verify My Email →</a>
      </div>
      <p style="color:#64748b;font-size:13px;margin:0 0 8px">Or enter this code on the verification page:</p>
      <div style="background:#f1f5f9;border-radius:8px;padding:14px;text-align:center;letter-spacing:6px;font-size:24px;font-weight:700;color:#1e293b;margin:0 0 24px">${shortCode}</div>
      <p style="color:#94a3b8;font-size:12px;margin:0">Expires in 24 hours. Didn't sign up? Ignore this email.</p>
    </div>
    <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0">
      <p style="color:#94a3b8;font-size:12px;margin:0">© 2026 MaintMentor.ai — All rights reserved</p>
    </div>
  </div>
</body>
</html>`,
    });

    console.log(`[auth] Verification email sent to ${to}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth] send-verification-email error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Resend Verification Email (bypass missing Supabase RPC) ─────────────────
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { userId, userEmail, userName } = req.body;
    if (!userId || !userEmail) {
      return res.status(400).json({ success: false, error: 'userId and userEmail are required' });
    }

    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(
      'https://rxzbnvvtzhgogeuhajvp.supabase.co',
      'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
    );

    // Generate a new token and store it
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: updateError } = await sb
      .from('profiles')
      .update({ verification_token: token, verification_token_expires_at: expiresAt, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (updateError) throw new Error(updateError.message);

    // Send email via Resend
    const { Resend } = require('resend');
    const resendClient = new Resend(process.env.RESEND_API_KEY);
    const APP_URL = 'https://maintmentor.ai';
    const verificationUrl = `${APP_URL}/verify-email?token=${token}`;
    const shortCode = token.substring(0, 6).toUpperCase();

    await resendClient.emails.send({
      from: 'MaintMentor <support@maintmentor.ai>',
      to: [userEmail],
      subject: 'Your new MaintMentor verification code',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden">
    <div style="background:#1e293b;padding:28px 32px;text-align:center">
      <img src="${APP_URL}/icons/maintmentor-logo.png" alt="MaintMentor" style="height:48px;width:48px;object-fit:contain;border-radius:8px" />
      <h1 style="color:#f59e0b;font-size:22px;margin:12px 0 0;font-weight:700">MaintMentor</h1>
    </div>
    <div style="padding:32px">
      <h2 style="color:#1e293b;font-size:20px;margin:0 0 12px">Verify your email 🔧</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px">Hi ${userName || 'there'}, here's your new verification link.</p>
      <div style="text-align:center;margin:0 0 24px">
        <a href="${verificationUrl}" style="display:inline-block;background:#f59e0b;color:#1e293b;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Verify My Email →</a>
      </div>
      <p style="color:#64748b;font-size:13px;margin:0 0 8px">Or enter this code on the verification page:</p>
      <div style="background:#f1f5f9;border-radius:8px;padding:14px;text-align:center;letter-spacing:6px;font-size:24px;font-weight:700;color:#1e293b;margin:0 0 24px">${shortCode}</div>
      <p style="color:#94a3b8;font-size:12px;margin:0">Expires in 24 hours.</p>
    </div>
  </div>
</body>
</html>`,
    });

    console.log(`[auth] Verification resent to ${userEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth] resend-verification error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Auto-confirm email after signup (bypasses Supabase email verification) ───
app.post('/api/auth/confirm-email', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const { createClient } = require('@supabase/supabase-js');
    const admin = createClient(
      'https://rxzbnvvtzhgogeuhajvp.supabase.co',
      'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
    );

    const { error } = await admin.auth.admin.updateUser(userId, { email_confirm: true });
    if (error) throw new Error(error.message);

    console.log(`[auth] Email auto-confirmed for user ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth] confirm-email error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
