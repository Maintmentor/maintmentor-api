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

Remember: You're not just answering questions — you're **teaching**. And a good teacher says "check the filter first" before "replace the compressor."

---

## Diagnostic Loop — Follow This Every Time

Every maintenance conversation moves through five phases. Know which phase you're in and act accordingly.

### PHASE 1 — INTAKE
*Trigger: First message about a new problem.*

- Assess what you already know from the message.
- If you have enough to diagnose, skip straight to DIAGNOSE.
- If you're missing something critical (appliance type, symptom details, what changed recently), ask **1–2 targeted questions only** — never more.
- Don't ask for info you don't need. Don't ask questions you can answer yourself with a reasonable assumption.
- Keep intake fast. Users want help, not an interview.

### PHASE 2 — DIAGNOSE
*Trigger: You have enough information to form a theory.*

- State your most likely diagnosis clearly and confidently.
- Lead with the **cheapest, simplest, most common cause first** — always.
- Give 2–3 possible causes ranked by likelihood and cost.
- If you have a model number, reference it directly.

### PHASE 3 — GUIDE
*Trigger: Diagnosis is established, user is ready to act.*

- Walk through the fix step by step. Numbered. In order. Simplest first.
- Include: difficulty, time estimate, tools, parts with costs.
- Be specific — not "check the filter" but "locate the filter at the bottom of the air handler, slide it out, hold it up to light — if you can't see light through it, replace it."
- Warn about the one or two mistakes people commonly make on this exact repair.

### PHASE 4 — VERIFY
*Trigger: You've given a fix or completed a step.*

- **Always close with a verification question.** Every single time.
- Keep it simple: "Give that a try and let me know what happens" or "Does that clear it up?"
- Never leave a user hanging after advice. The loop closes when the problem is confirmed solved.

### PHASE 5 — ESCALATE
*Trigger: User reports the fix didn't work.*

- Acknowledge what they tried. "OK, so we've ruled out [X]."
- Move to the **next most likely cause** — never repeat a fix that didn't work.
- Get more specific with each escalation. Narrow the possibilities.
- If after 2–3 escalations the issue isn't resolved, honestly assess: is this now a professional job? Say so clearly and explain why.

---

## Loop Rules

1. **Never skip VERIFY.** Every fix response ends with a check-in question.
2. **Never repeat dead advice.** If a fix didn't work, acknowledge it and move on.
3. **Read the conversation history.** You know what's been tried. Use it.
4. **One theory at a time.** Don't dump every possibility at once — lead with the most likely, verify, then escalate if needed.
5. **Match the phase to the user's message.** A user who says "that didn't work" is in ESCALATE. A user who says "how do I fix my AC" is in INTAKE/DIAGNOSE. Read the room.

---

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

// ─── Diagnostic Loop: Phase Detector ──────────────────────────────────────────
// Reads conversation history and determines which loop phase we're in.
// Returns a context string injected before each Gemini call.
function detectLoopPhase(history, currentQuestion) {
  const q = currentQuestion.toLowerCase();
  const turnCount = history.length; // number of prior messages (each = one role entry)

  // Signals user is reporting a failed fix → ESCALATE
  const escalateSignals = [
    /didn'?t work/i, /still (not|broken|happening|the same)/i,
    /that (didn'?t|didn't) (fix|help|work|solve)/i,
    /no (change|difference|luck)/i, /same (problem|issue|thing)/i,
    /tried that/i, /already (tried|did|checked|replaced)/i,
    /it'?s still/i, /nothing (changed|helped|worked)/i,
  ];

  // Signals user is confirming it worked → close the loop
  const resolvedSignals = [
    /that (worked|fixed|solved|did it)/i, /it'?s (working|fixed|good now)/i,
    /problem (solved|gone|fixed)/i, /all (good|set|working)/i,
    /thanks? (that|it)/i, /perfect/i, /great( that)?/i,
  ];

  // Signals user is ready to act on a guide
  const guideSignals = [
    /how (do|can|should) (i|we)/i, /what (do|should) (i|we)/i,
    /step/i, /walk me through/i, /show me/i, /instructions/i,
    /how to fix/i, /how to replace/i, /how to install/i,
  ];

  if (resolvedSignals.some(p => p.test(q))) {
    return {
      phase: 'RESOLVED',
      context: 'The user is indicating the issue is resolved. Confirm it warmly, offer one quick maintenance tip to prevent recurrence, and let them know you are here if anything else comes up. Keep it brief.'
    };
  }

  if (escalateSignals.some(p => p.test(q))) {
    // Extract what was tried from prior AI turns
    const priorAdvice = history
      .filter(m => m.role === 'assistant')
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join(' ');
    return {
      phase: 'ESCALATE',
      context: `The previous fix did not resolve the issue. We are now in ESCALATE phase.\n` +
               `Rules:\n` +
               `- Acknowledge what was tried: "OK, so we have ruled that out."\n` +
               `- Do NOT repeat advice already given.\n` +
               `- Move to the next most likely cause, more specific than before.\n` +
               `- If this is the 3rd+ failed attempt, honestly assess whether a professional is now required.\n` +
               `- End with a VERIFY question about the new fix.`
    };
  }

  if (turnCount === 0) {
    return {
      phase: 'INTAKE',
      context: `This is the first message. We are in INTAKE phase.\n` +
               `Rules:\n` +
               `- Assess whether you have enough info to diagnose.\n` +
               `- If yes, go straight to DIAGNOSE — skip asking questions.\n` +
               `- If critical info is missing, ask 1-2 targeted questions only.\n` +
               `- Never ask more than 2 questions at once.`
    };
  }

  if (guideSignals.some(p => p.test(q)) || turnCount >= 2) {
    return {
      phase: 'GUIDE',
      context: `The user is ready for step-by-step guidance or we have enough context. We are in GUIDE phase.\n` +
               `Rules:\n` +
               `- Give numbered steps, difficulty rating, time estimate, tools, and parts with costs.\n` +
               `- Start with the simplest/cheapest check.\n` +
               `- End with a VERIFY question: ask if that solved it.`
    };
  }

  // Default: diagnose
  return {
    phase: 'DIAGNOSE',
    context: `We have some context. We are in DIAGNOSE phase.\n` +
             `Rules:\n` +
             `- State the most likely diagnosis clearly.\n` +
             `- Lead with cheapest/simplest/most common cause.\n` +
             `- Give 2-3 possible causes ranked by likelihood and cost.\n` +
             `- End with a VERIFY question or offer to walk through the fix step by step.`
  };
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

// ─── Version Endpoint ────────────────────────────────────────────────────────
app.get('/api/version', (req, res) => {
  res.json({
    version: '1.0.0',
    build: 'day16',
    environment: process.env.NODE_ENV || 'production'
  });
});

// ─── Stripe health check cache (avoid rate-limiting on every health poll) ─────
let _stripeCheckCache = null; // { status, latency_ms, error, cachedAt }
const STRIPE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

  // ── 2. Stripe API reachability (cached 5 min to avoid rate limits) ──────
  if (_stripeCheckCache && (Date.now() - _stripeCheckCache.cachedAt) < STRIPE_CACHE_TTL_MS) {
    // Use cached result — strip the internal cachedAt field
    const { cachedAt: _c, ...cached } = _stripeCheckCache;
    checks.stripe = cached;
  } else {
    try {
      const stripeLib = require('./lib/stripe');
      const t0 = Date.now();
      await Promise.race([
        stripeLib.stripe.balance.retrieve(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
      checks.stripe = { status: 'ok', latency_ms: Date.now() - t0 };
    } catch (e) {
      const isTimeout  = e.message === 'timeout';
      const isRateLimit = e.type === 'StripeRateLimitError' || (e.message || '').toLowerCase().includes('rate limit');
      checks.stripe = isRateLimit
        ? { status: 'ok', note: 'rate-limited (API reachable)' }
        : {
            status: isTimeout ? 'degraded' : 'down',
            error:  isTimeout ? 'Request timed out' : 'API unreachable',
          };
    }
    _stripeCheckCache = { ...(checks.stripe), cachedAt: Date.now() };
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

  // ── 4. Cloud Run reachability ───────────────────────────────────
  // Skip when running ON Cloud Run (K_SERVICE is set) — no point pinging ourselves externally.
  // Only the DigitalOcean server does this outbound reachability check.
  const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL || 'https://maintmentor-api-878722550029.us-east1.run.app';
  if (process.env.K_SERVICE) {
    // Running on Cloud Run — self-check is always ok (we're already serving this request)
    checks.cloudrun = { status: 'ok', note: 'self (skipped external ping)', url: CLOUD_RUN_URL };
  } else {
    try {
      const https = require('https');
      const t0 = Date.now();
      await Promise.race([
        new Promise((resolve, reject) => {
          const url = new URL(CLOUD_RUN_URL + '/api/health');
          const opts = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'GET',
            timeout: 9000,  // allow up to 9s for Cloud Run cold start
          };
          const req3 = https.request(opts, (resp) => {
            resp.resume(); // drain
            resolve(resp.statusCode);
          });
          req3.on('error', reject);
          req3.on('timeout', () => { req3.destroy(); reject(new Error('timeout')); });
          req3.end();
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
      ]);
      checks.cloudrun = { status: 'ok', latency_ms: Date.now() - t0, url: CLOUD_RUN_URL };
    } catch (e) {
      // Cloud Run errors do NOT fail health — log only
      console.warn('[health] Cloud Run check failed (non-fatal):', e.message);
      checks.cloudrun = { status: 'degraded', error: e.message, url: CLOUD_RUN_URL };
    }
  }

  // ── Overall status ──────────────────────────────────────────────
  // Cloud Run is excluded from overall status calculation (advisory only)
  const { cloudrun: _cloudrun, ...coreChecks } = checks;
  const statuses = Object.values(coreChecks).map((c) => c.status);
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

// ─── Admin Stats Endpoint (Day 12) ────────────────────────────────────────────
// Requires X-Admin-Token header matching process.env.ADMIN_TOKEN
app.get('/api/admin/stats', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    return res.status(401).json({ success: false, error: 'Unauthorized — valid X-Admin-Token required' });
  }

  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { createClient } = require('@supabase/supabase-js');
    const adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 1. Total users
    const { count: totalUsers } = await adminClient
      .from('profiles')
      .select('*', { count: 'exact', head: true });

    // 2. Total revenue (sum of credit purchase amounts)
    const { data: revData } = await adminClient
      .from('wallet_transactions')
      .select('amount')
      .eq('type', 'credit');
    const totalRevenue = (revData || []).reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

    // 3. Total queries
    const { count: totalQueries } = await adminClient
      .from('query_history')
      .select('*', { count: 'exact', head: true });

    // 4. Total photo analyses (endpoint contains 'photo')
    const { count: totalPhotos } = await adminClient
      .from('api_usage_logs')
      .select('*', { count: 'exact', head: true })
      .ilike('endpoint', '%photo%');

    // 5. Active users last 7 days (from query_history)
    const { data: activeData } = await adminClient
      .from('query_history')
      .select('account_id')
      .gte('created_at', since7d);
    const activeUsers = new Set((activeData || []).map(r => r.account_id)).size;

    // 6. Top 5 users by query count
    const { data: topData } = await adminClient
      .from('query_history')
      .select('account_id')
      .limit(10000);
    const countMap = {};
    (topData || []).forEach(r => { countMap[r.account_id] = (countMap[r.account_id] || 0) + 1; });
    const topUsers = Object.entries(countMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([userId, count]) => ({ userId, queryCount: count }));

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      stats: {
        totalUsers:    totalUsers    || 0,
        totalRevenue:  parseFloat(totalRevenue.toFixed(2)),
        totalQueries:  totalQueries  || 0,
        totalPhotos:   totalPhotos   || 0,
        activeUsers7d: activeUsers,
        topUsersByQueries: topUsers,
      },
    });
  } catch (err) {
    console.error('[admin/stats] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// ─── XPRIZE Demo Endpoint (Day 14) — No Auth, Public ───────────────────────────
// Designed for XPRIZE judges to see live AI in action
app.get('/api/demo', async (req, res) => {
  const startTime = Date.now();
  const DEMO_QUESTION = 'What should I check first if my HVAC isn\'t cooling?';
  const demoModel = MODEL_FLASH; // fast, responsive

  try {
    // 1. Run Gemini query
    const model = genAI.getGenerativeModel({
      model: demoModel,
      systemInstruction: 'You are MaintMentor, an expert residential maintenance AI. Provide clear, practical maintenance guidance. Keep answers to 3-5 key steps. Always lead with the simplest check first.',
    });
    const result = await model.generateContent(DEMO_QUESTION);
    const answer = result.response.text();
    const latencyMs = Date.now() - startTime;

    // 2. Gather platform stats
    const supabase = require('./lib/supabase');
    const [tracksResult, lessonsResult, usersResult] = await Promise.allSettled([
      supabase.from('certification_tracks').select('id', { count: 'exact', head: true }),
      supabase.from('certification_lessons').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
    ]);

    // Compute simple confidence
    let confidence = 0.85;
    if (answer.length > 300) confidence = 0.92;
    if (/not sure|unclear/i.test(answer)) confidence = 0.70;

    return res.json({
      success: true,
      demo: {
        question:      DEMO_QUESTION,
        answer,
        confidence:    parseFloat(confidence.toFixed(2)),
        response_time_ms: latencyMs,
        model_used:    demoModel,
        engine:        'Google Gemini',
      },
      platform: {
        total_tracks:  tracksResult.status === 'fulfilled' ? (tracksResult.value.count || 0) : 0,
        total_lessons: lessonsResult.status === 'fulfilled' ? (lessonsResult.value.count || 0) : 0,
        total_users:   usersResult.status === 'fulfilled' ? (usersResult.value.count || 0) : 0,
        powered_by:    'Google Cloud Run + Gemini AI',
        cloud_project: 'steel-bridge-474518-n2',
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[demo] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Demo unavailable — ' + err.message });
  }
});

// ─── XPRIZE Metrics Endpoint (Day 14) — Admin Token Required ─────────────────
const _serverLaunchTime = new Date('2026-05-26T00:00:00Z'); // Day 1 launch date
app.get('/api/xprize/metrics', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    return res.status(401).json({ success: false, error: 'Unauthorized — valid X-Admin-Token required' });
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const daysSinceLaunch = Math.floor((Date.now() - _serverLaunchTime.getTime()) / (1000 * 60 * 60 * 24));

    // Parallel queries
    const [
      totalUsersRes, activeUsersRes, revenueRes,
      totalQueriesRes, certsRes, payingRes,
    ] = await Promise.allSettled([
      adminClient.from('profiles').select('*', { count: 'exact', head: true }),
      adminClient.from('query_history').select('account_id').gte('created_at', since7d),
      adminClient.from('wallet_transactions').select('amount').eq('type', 'credit'),
      adminClient.from('query_history').select('*', { count: 'exact', head: true }),
      adminClient.from('user_certifications').select('*', { count: 'exact', head: true }),
      adminClient.from('wallet_transactions').select('account_id').eq('type', 'credit').limit(10000),
    ]);

    const totalUsers   = totalUsersRes.status   === 'fulfilled' ? (totalUsersRes.value.count   || 0) : 0;
    const activeSet    = activeUsersRes.status  === 'fulfilled' ? new Set((activeUsersRes.value.data || []).map(r => r.account_id)) : new Set();
    const revData      = revenueRes.status       === 'fulfilled' ? (revenueRes.value.data || [])     : [];
    const totalRevenue = revData.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const totalQueries = totalQueriesRes.status  === 'fulfilled' ? (totalQueriesRes.value.count || 0) : 0;
    const certsIssued  = certsRes.status         === 'fulfilled' ? (certsRes.value.count        || 0) : 0;
    const payingUsers  = payingRes.status         === 'fulfilled'
      ? new Set((payingRes.value.data || []).map(r => r.account_id)).size : 0;

    return res.json({
      success: true,
      xprize_metrics: {
        days_since_launch:        daysSinceLaunch,
        launch_date:              _serverLaunchTime.toISOString().split('T')[0],
        xprize_deadline:          '2026-08-17',
        days_until_deadline:      Math.floor((new Date('2026-08-17').getTime() - Date.now()) / (1000*60*60*24)),
        users: {
          total:   totalUsers,
          active_7d: activeSet.size,
          paying:  payingUsers,
        },
        revenue: {
          total_usd:  parseFloat(totalRevenue.toFixed(2)),
          target_usd: 9500,
          progress_pct: parseFloat(((totalRevenue / 9500) * 100).toFixed(1)),
        },
        ai: {
          total_queries_served: totalQueries,
          gemini_api_calls:     totalQueries,          // 1:1 mapping
          cloudrun_invocations: Math.ceil(totalQueries * 1.1), // approx (includes health checks)
          model_pro:            MODEL_PRO,
          model_flash:          MODEL_FLASH,
          cloud_project:        'steel-bridge-474518-n2',
          cloud_region:         'us-east1',
        },
        certifications: {
          issued: certsIssued,
        },
        user_targets: {
          min: 250,
          max: 400,
          current: totalUsers,
          progress_pct: parseFloat(((totalUsers / 250) * 100).toFixed(1)),
        },
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[xprize/metrics] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Public Status Page (Day 12) ──────────────────────────────────────────────
const _serverStartTime = Date.now();
app.get('/api/status', async (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - _serverStartTime) / 1000);
  let dbStatus = 'ok';
  try {
    const statusDb = require('./lib/supabase');
    const { error } = await statusDb
      .from('profiles')
      .select('id')
      .limit(1);
    if (error) dbStatus = 'degraded';
  } catch (_) {
    dbStatus = 'down';
  }
  return res.json({
    status:    dbStatus === 'ok' ? 'operational' : 'degraded',
    uptime:    `${uptimeSeconds}s`,
    version:   '1.0.0',
    endpoints: {
      api: 'ok',
      db:  dbStatus,
    },
  });
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

// ─── Smart Property Memory: fetch user's recent repair topics ───────────────
async function getUserPropertyMemory(userId) {
  if (!userId) return '';
  try {
    const { data, error } = await chatDb
      .from('chat_messages')
      .select('content, category, created_at')
      .eq('user_id', userId)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !data || data.length === 0) return '';

    // Deduplicate + summarize the last ~10 unique topics
    const seen = new Set();
    const topics = [];
    for (const msg of data) {
      const short = msg.content.slice(0, 120).replace(/\n/g, ' ');
      if (!seen.has(short)) {
        seen.add(short);
        const date = new Date(msg.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        topics.push(`- ${date}: "${short}${msg.content.length > 120 ? '...' : ''}"`)
        if (topics.length >= 10) break;
      }
    }

    if (topics.length === 0) return '';

    return `[PROPERTY MEMORY — INTERNAL CONTEXT — DO NOT SHOW USER]
This user has previously asked about these maintenance issues. Use this to give personalized, contextual answers (e.g. "Last time you mentioned..."). Do NOT recite this list to the user.
${topics.join('\n')}
[END PROPERTY MEMORY]

`;
  } catch (e) {
    console.warn('[property-memory] Failed to load:', e.message);
    return '';
  }
}

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
  const { question, conversationId, userId, images, sessionToken, fingerprint, guided, guidedStep } = req.body;

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
  const rateLimitCheck = await checkDailyLimits(userId, hasPhotos, ipAddress);
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

    // ─── LOOP ENGINEERING: Detect diagnostic phase ────────────────────────
    const loopPhase = detectLoopPhase(history, question);
    console.log(`[loop] Phase: ${loopPhase.phase}`);

    // Inject phase context + property memory prepended to the user message (invisible to user)
    const phaseInjection = `[DIAGNOSTIC LOOP — INTERNAL CONTEXT — DO NOT SHOW USER]\nCurrent phase: ${loopPhase.phase}\n${loopPhase.context}\n[END INTERNAL CONTEXT]\n\n`;
    const propertyMemory = await getUserPropertyMemory(userId);

    // Guided mode injection — Mack gives one step at a time
    const guidedInjection = guided
      ? `[GUIDED MODE — INTERNAL CONTEXT — DO NOT SHOW USER]
The user has activated "Solve it with me" step-by-step mode. Current step number: ${(guidedStep || 0) + 1}.
Rules:
- Give EXACTLY ONE clear action step. Number it ("Step ${(guidedStep || 0) + 1}:").
- Keep it to 2-4 sentences max.
- End with a brief check: "Done that? Let me know and I'll give you the next step."
- If the user says they're stuck, diagnose that specific step before moving on.
- Do NOT give multiple steps at once.
[END GUIDED MODE]

`
      : '';

    const userPartsWithPhase = [
      { text: propertyMemory + guidedInjection + phaseInjection },
      ...userParts,
    ];

    // ─── MODEL SELECTION: Route to Flash or Pro ──────────────────────────
    const modelChoice = selectModel(question, hasPhotos, history.length);
    const selectedModel = modelChoice.model;

    console.log(`[${new Date().toISOString()}] Sending ${geminiHistory.length + 1} messages (${geminiHistory.length} history + 1 new) → ${selectedModel} (${modelChoice.reason}) [loop:${loopPhase.phase}]`);

    const geminiModel = genAI.getGenerativeModel({
      model: selectedModel,
      systemInstruction: SYSTEM_PROMPT,
    });

    const chat = geminiModel.startChat({
      history: geminiHistory,
      generationConfig: { maxOutputTokens: 4096 },
    });

    const geminiResponse = await chat.sendMessage(userPartsWithPhase);
    const answer = geminiResponse.response.text();

    // Store in Anthropic-compatible format for backward compat
    const content = [{ type: 'text', text: question }];
    addToConversation(conversationId, content, answer);

    const category = detectCategory(question, answer);
    const duration = Date.now() - startTime;

    // ─── Log query for team analytics + data flywheel (non-blocking) ──────
    // Gemini usage metadata (needed for token counts below)
    const usageMeta = geminiResponse.response?.usageMetadata;
    logQuery({
      userId,
      queryType: hasPhotos ? 'photo' : 'chat',
      category,
      questionPreview: question,
      // ── Data flywheel: full Q&A capture ──
      fullQuestion:  question,
      aiAnswer:      answer,
      modelUsed:     selectedModel,
      tokensInput:   usageMeta?.promptTokenCount     || 0,
      tokensOutput:  usageMeta?.candidatesTokenCount || 0,
      latencyMs:     duration,
      source:        'consumer_app',
      accountId:     userId,
      hasPhoto:      hasPhotos || false,
    }).catch(() => {});

    // ─── CONTROL 5: Record API spend ──────────────────────────────────────
    // (usageMeta already captured above)
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

// ─── Property / Unit / Asset / IoT / QR Routes ─────────────────────────────────
{
  const propertiesRouter = require('./routes/properties');
  app.use('/api/properties', propertiesRouter);
  console.log('   Routes: /api/properties (IoT / QR) registered ✅');
}

// ─── A2A Protocol (Agent2Agent) ───────────────────────────────────────────────
// Agent Card: GET /.well-known/agent.json
// A2A endpoint: POST /a2a  (JSON-RPC 2.0)
{
  const CLOUD_RUN_BASE = process.env.CLOUD_RUN_URL || 'https://maintmentor-api-878722550029.us-east1.run.app';
  const agentCard = {
    name: 'MaintMentor',
    description: 'Expert residential maintenance AI — HVAC, plumbing, electrical, and general contracting. Powered by Google Gemini on Cloud Run.',
    url: `${CLOUD_RUN_BASE}/a2a`,
    iconUrl: 'https://maintmentor.ai/icons/maintmentor-logo.png',
    version: '1.0.0',
    documentationUrl: 'https://maintmentor.ai/developer',
    provider: { organization: 'MaintMentor.ai', url: 'https://maintmentor.ai' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: { schemes: ['bearer'], credentials: 'Obtain an API key at https://maintmentor.ai/developer' },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'maintenance-query',
        name: 'Maintenance Query',
        description: 'Answer text-based residential maintenance questions across all trades: HVAC, plumbing, electrical, appliances, and general contracting.',
        tags: ['maintenance', 'HVAC', 'plumbing', 'electrical', 'DIY', 'repair'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        examples: ['Why is my AC not blowing cold air?', 'How do I fix a running toilet?'],
      },
      {
        id: 'maintenance-photo',
        name: 'Maintenance Photo Analysis',
        description: 'Analyze photos of equipment or damage to identify maintenance issues and recommended repairs.',
        tags: ['photo', 'visual-inspection', 'damage-assessment', 'maintenance'],
        inputModes: ['text/plain', 'image/jpeg', 'image/png', 'image/webp'],
        outputModes: ['text/plain'],
        examples: ['What is wrong with this HVAC unit? [image]'],
      },
      {
        id: 'maintenance-field',
        name: 'Field Companion',
        description: 'Real-time guidance for field technicians with urgency handling. Emergency queries are always free.',
        tags: ['field-technician', 'emergency', 'safety', 'step-by-step'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        examples: ['Gas smell near water heater, urgency: emergency'],
      },
    ],
  };

  // Serve Agent Card at /.well-known/agent.json
  app.get('/.well-known/agent.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(agentCard);
  });
  console.log('   Routes: /.well-known/agent.json (A2A Agent Card) registered ✅');

  // Register A2A JSON-RPC 2.0 endpoint
  const a2aRouter = require('./routes/a2a');
  app.use('/a2a', a2aRouter);
  console.log('   Routes: /a2a (A2A Protocol endpoint) registered ✅');
}

// ─── Certifications & Learning Platform (Day 13) ──────────────────────────────
{
  const certificationsRouter = require('./routes/certifications');
  app.use('/api/certifications', certificationsRouter);
  console.log('   Routes: /api/certifications registered ✅');
}

// ─── Assessments (Guest Quiz / Candidate Screening) ────────────────────────────
{
  const assessmentsRouter = require('./routes/assessments');
  app.use('/api/assessments', assessmentsRouter);
  console.log('   Routes: /api/assessments registered ✅');
}

// ─── Referrals Routes (Day 15) ───────────────────────────────────────────────
{
  const referralsRouter = require('./routes/referrals');
  app.use('/api/referrals', referralsRouter);
  console.log('   Routes: /api/referrals registered ✅');
}

// ─── /api/teams — Day 15 thin wrappers over team-manager ──────────────────────
// team-manager already registers /api/team/* routes; these REST aliases
// provide the canonical Day 15 contract.
{
  const { requireJWT } = require('./middleware/auth');

  // POST /api/teams — create a team (owner = JWT user)
  app.post('/api/teams', requireJWT, (req, res) => {
    // Proxy to team-manager handler — inject userId from JWT
    req.body = req.body || {};
    req.body.userId = req.user.id;
    // Re-use team-manager logic via internal call to supabase
    const supabase = require('./lib/supabase');
    const name  = req.body.name;
    const email = req.body.email || req.user.email;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    // Fire create-org logic inline
    (async () => {
      try {
        const crypto = require('crypto');
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60)
          + '-' + crypto.randomBytes(3).toString('hex');
        const { data: org, error } = await supabase.from('organizations').insert({
          name, slug,
          billing_email: email || null,
          plan_type: 'team',
          subscription_status: 'trialing',
          seat_count: 1,
          trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          created_by: req.user.id,
        }).select().single();
        if (error) return res.status(500).json({ success: false, error: error.message });
        // Add owner as admin
        await supabase.from('organization_members').insert({
          org_id: org.id, user_id: req.user.id, role: 'owner',
          status: 'active', invited_email: email || null, invited_by: req.user.id,
          joined_at: new Date().toISOString(),
        });
        await supabase.from('profiles').update({ org_id: org.id, org_role: 'admin' }).eq('id', req.user.id);
        res.status(201).json({ success: true, team: org });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    })();
  });

  // POST /api/teams/:id/invite — invite a member by email
  app.post('/api/teams/:id/invite', requireJWT, (req, res) => {
    req.body = { ...(req.body || {}), orgId: req.params.id };
    // Proxy to existing /api/team/invite-member handler
    req.url = '/api/team/invite-member';
    // Just call the supabase logic directly
    const supabase = require('./lib/supabase');
    const { email } = req.body;
    const orgId = req.params.id;
    const userId = req.user.id;
    if (!email) return res.status(400).json({ success: false, error: 'email is required' });
    (async () => {
      try {
        const crypto = require('crypto');
        const token = crypto.randomBytes(32).toString('hex');
        const { data: member, error: me } = await supabase.from('organization_members').insert({
          org_id: orgId, role: 'member', status: 'invited',
          invited_email: email.toLowerCase(), invited_by: userId,
        }).select().single();
        if (me) return res.status(500).json({ success: false, error: me.message });
        await supabase.from('organization_invites').insert({
          org_id: orgId, member_id: member.id, token,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
        const inviteLink = `${process.env.APP_URL || 'https://maintmentor.ai'}/invite/${token}`;
        res.status(201).json({ success: true, invite_link: inviteLink, member_id: member.id });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    })();
  });

  // GET /api/teams/:id/members
  app.get('/api/teams/:id/members', requireJWT, async (req, res) => {
    const supabase = require('./lib/supabase');
    try {
      const { data: members, error } = await supabase
        .from('organization_members')
        .select('id, user_id, role, status, invited_email, joined_at')
        .eq('org_id', req.params.id)
        .in('status', ['active', 'invited']);
      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true, members: members || [] });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/teams/:id/members/:userId
  app.delete('/api/teams/:id/members/:userId', requireJWT, async (req, res) => {
    const supabase = require('./lib/supabase');
    try {
      const { error } = await supabase
        .from('organization_members')
        .update({ status: 'disabled', disabled_at: new Date().toISOString() })
        .eq('org_id', req.params.id)
        .eq('user_id', req.params.userId);
      if (error) return res.status(500).json({ success: false, error: error.message });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('   Routes: /api/teams (Day 15 REST aliases) registered ✅');
}

// ─── Start Server ──────────────────────────────────────────────────────────────
// IoT Routes
{
  const iotRouter = require('./routes/iot');
  app.use('/api/iot', iotRouter);
  console.log('   Routes: /api/iot registered');
}

// ─── Streaming Chat Endpoint ────────────────────────────────────────────────
app.post('/api/chat/stream', async (req, res) => {
  const { question, conversationId, userId, sessionToken, fingerprint } = req.body;
  const ipAddress = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing question' });
  }

  // Rate limit check
  const rateLimitCheck = await checkDailyLimits(userId, false, ipAddress);
  if (!rateLimitCheck.allowed) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'error', error: rateLimitCheck.reason })}\n\n`);
    return res.end();
  }

  // Topic check
  const topicCheck = checkTopic(question);
  if (!topicCheck.onTopic) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'chunk', text: topicCheck.deflectionMessage })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', answer: topicCheck.deflectionMessage })}\n\n`);
    return res.end();
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  try {
    const modelChoice = selectModel(question, false, 0);
    const streamModel = genAI.getGenerativeModel({
      model: modelChoice.model,
      systemInstruction: SYSTEM_PROMPT,
    });

    const history = await getConversationHistory(conversationId);
    const geminiHistory = [];
    for (const msg of history) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      geminiHistory.push({ role, parts: [{ text: typeof msg.content === 'string' ? msg.content : String(msg.content) }] });
    }

    const chat = streamModel.startChat({
      history: geminiHistory,
      generationConfig: { maxOutputTokens: 2048 },
    });

    const streamResult = await chat.sendMessageStream(question);
    let fullText = '';

    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
      }
    }

    // Generate a short voice summary — what Mack actually speaks
    // Full text stays on screen; voice = key steps only (~30 seconds)
    let voiceSummary = '';
    try {
      const summaryModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const summaryResult = await summaryModel.generateContent(
        `You are Mack, a maintenance expert. A user asked: "${question}"\n\n` +
        `Your full answer was: ${fullText}\n\n` +
        `Now give a complete voice response covering all the key steps — max 150 words. ` +
        `Skip any preamble like "Hey there" or "Great question". ` +
        `Cover every important step the user needs. Conversational tone, no bullet lists, just natural speech.`
      );
      voiceSummary = summaryResult.response.text().trim();
    } catch (e) {
      // fallback: first 300 chars of the answer
      voiceSummary = fullText.replace(/[#*`\[\]]/g, '').replace(/\n/g, ' ').slice(0, 900).trim();
    }

    res.write(`data: ${JSON.stringify({ type: 'done', answer: fullText, voiceSummary })}\n\n`);
    res.end();

    // Non-blocking: increment usage, save to DB
    if (userId) incrementDailyQuery(userId).catch(() => {});
    else if (ipAddress) {
      // guest usage already incremented in checkGuestLimit
    }
    addToConversation(conversationId || 'anon', [{ type: 'text', text: question }], fullText);

  } catch (err) {
    console.error('[stream] error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Stream failed — please try again' })}\n\n`);
    res.end();
  }
});

// ─── Mack's Voice: Google Cloud TTS ─────────────────────────────────────────
const { GoogleAuth } = require('google-auth-library');
const ttsAuth = new GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '/root/.gcloud-sa-key.json',
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });

  try {
    // Strip markdown before sending to TTS
    const clean = text
      .replace(/#{1,6}\s/g, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s*[-*+]\s/gm, '')
      .replace(/^\s*\d+\.\s/gm, '')
      .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 1500); // ~150 words of speech

    // Use Gemini TTS with Mack's voice (Algieba)
    const ttsPayload = {
      contents: [{ parts: [{ text: clean }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Algieba' }
          }
        }
      }
    };

    const ttsResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsPayload),
      }
    );

    const ttsData = await ttsResp.json();
    const parts = ttsData?.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.startsWith('audio/'));

    if (!audioPart) {
      console.error('[tts] no audio from Gemini:', JSON.stringify(ttsData).slice(0, 300));
      return res.status(500).json({ error: 'TTS failed' });
    }

    // Convert raw PCM (L16 24kHz) to MP3 via ffmpeg
    const { execSync } = require('child_process');
    const pcmBuf = Buffer.from(audioPart.inlineData.data, 'base64');
    const tmpPcm = `/tmp/tts_${Date.now()}.pcm`;
    const tmpMp3 = tmpPcm.replace('.pcm', '.mp3');
    require('fs').writeFileSync(tmpPcm, pcmBuf);
    execSync(`ffmpeg -f s16le -ar 24000 -ac 1 -i ${tmpPcm} -acodec libmp3lame -q:a 2 ${tmpMp3} -y`, { stdio: 'pipe' });
    const mp3B64 = require('fs').readFileSync(tmpMp3).toString('base64');
    require('fs').unlinkSync(tmpPcm);
    require('fs').unlinkSync(tmpMp3);

    res.json({ audio: mp3B64 }); // base64 MP3 — same response shape as before
  } catch (err) {
    console.error('[tts] error:', err.message);
    res.status(500).json({ error: 'TTS error' });
  }
});

// ─── TTS Streaming Endpoint (returns MP3 directly — iOS-friendly) ─────────────
app.get('/api/tts-stream', async (req, res) => {
  const text = req.query.text;
  if (!text || typeof text !== 'string' || text.trim() === 'warmup') {
    // Return a tiny silent MP3 for warmup calls
    const { execSync } = require('child_process');
    const tmpSilent = `/tmp/silence_${Date.now()}.mp3`;
    try {
      execSync(`ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t 0.1 -acodec libmp3lame ${tmpSilent} -y`, { stdio: 'pipe' });
      const silentBuf = require('fs').readFileSync(tmpSilent);
      require('fs').unlinkSync(tmpSilent);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(silentBuf);
    } catch (e) {
      return res.status(500).json({ error: 'silence failed' });
    }
  }

  try {
    const clean = text.replace(/[#*`\[\]]/g, '').replace(/\n/g, ' ').trim().slice(0, 1500);

    const ttsPayload = {
      contents: [{ parts: [{ text: clean }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Algieba' } } }
      }
    };

    const ttsResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ttsPayload) }
    );

    const ttsData = await ttsResp.json();
    const parts = ttsData?.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.startsWith('audio/'));
    if (!audioPart) return res.status(500).json({ error: 'no audio' });

    const { execSync } = require('child_process');
    const fs = require('fs');
    const pcmBuf = Buffer.from(audioPart.inlineData.data, 'base64');
    const tmpPcm = `/tmp/tts_${Date.now()}.pcm`;
    const tmpMp3 = tmpPcm.replace('.pcm', '.mp3');
    fs.writeFileSync(tmpPcm, pcmBuf);
    execSync(`ffmpeg -f s16le -ar 24000 -ac 1 -i ${tmpPcm} -acodec libmp3lame -q:a 2 ${tmpMp3} -y`, { stdio: 'pipe' });
    const mp3Buf = fs.readFileSync(tmpMp3);
    fs.unlinkSync(tmpPcm);
    fs.unlinkSync(tmpMp3);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', mp3Buf.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(mp3Buf);

  } catch (err) {
    console.error('[tts-stream] error:', err.message);
    res.status(500).json({ error: 'TTS stream error' });
  }
});

// ─── Shared Reports ──────────────────────────────────────────────────────────

/**
 * POST /api/share-report
 * Store a report and return a shareable URL.
 * Body: { report: MaintenanceReport }
 * Returns: { token, url }
 */
app.post('/api/share-report', async (req, res) => {
  try {
    const { report } = req.body;
    if (!report || typeof report !== 'object') {
      return res.status(400).json({ error: 'report object required' });
    }

    // Generate a random token (32 hex chars)
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    const sb = require('./lib/supabase');
    const { error } = await sb
      .from('shared_reports')
      .insert({
        token,
        report_data: report,
        expires_at: expiresAt,
      });

    if (error) throw new Error(error.message);

    const APP_URL = process.env.APP_URL || 'https://maintmentor.ai';
    const url = `${APP_URL}/report/${token}`;

    console.log(`[share-report] Created shared report token=${token}`);
    res.json({ token, url });
  } catch (err) {
    console.error('[share-report] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/share-report/:token
 * Retrieve a shared report by token.
 * Returns: { report: MaintenanceReport }
 */
app.get('/api/share-report/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'token required' });

    const sb = require('./lib/supabase');
    const { data, error } = await sb
      .from('shared_reports')
      .select('report_data, expires_at, view_count')
      .eq('token', token)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Check expiry
    if (new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Report has expired' });
    }

    // Increment view count (fire-and-forget)
    sb.from('shared_reports')
      .update({ view_count: (data.view_count || 0) + 1 })
      .eq('token', token)
      .then(() => {})
      .catch(() => {});

    res.json({ report: data.report_data });
  } catch (err) {
    console.error('[share-report] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const HOST = process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1'; // Cloud Run needs 0.0.0.0

// ─── Gemini Live WebSocket Proxy ───────────────────────────────────────────
const http  = require('http');
const { WebSocketServer, WebSocket: WS } = require('ws');
const LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-latest';
const LIVE_URL   = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const LIVE_SETUP = JSON.stringify({
  setup: {
    model: LIVE_MODEL,
    generation_config: {
      // Native audio model only supports AUDIO output
      response_modalities: ['AUDIO'],
      speech_config: {
        voice_config: { prebuilt_voice_config: { voice_name: 'Puck' } }
      }
    },
    // Get text transcript alongside audio
    output_audio_transcription: {},
    // PTT mode: disable automatic VAD — user controls turn via clientContent.turnComplete
    realtime_input_config: {
      automatic_activity_detection: { disabled: true }
    },
    system_instruction: {
      parts: [{ text:
        'You are MaintMentor, a voice-first AI field companion for maintenance technicians. ' +
        'Answer questions about HVAC, electrical, plumbing, and general residential maintenance. ' +
        'Keep answers short and practical — 2 to 3 sentences max. The tech is in the field.'
      }]
    }
  }
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (clientWs) => {
  console.log('[live] client connected');
  const geminiWs = new WS(LIVE_URL);
  let setupComplete = false;

  geminiWs.on('open', () => {
    console.log('[live] gemini WS open, sending setup');
    geminiWs.send(LIVE_SETUP);
    // ⚠️  Do NOT send 'ready' here — wait for Gemini's setupComplete first
  });

  // Gemini → Client
  geminiWs.on('message', (data) => {
    if (clientWs.readyState !== WS.OPEN) return;
    // Forward raw message
    clientWs.send(data);
    // Also send our custom 'ready' signal once (and only once) after setupComplete
    if (!setupComplete) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.setupComplete !== undefined) {
          setupComplete = true;
          console.log('[live] setupComplete — session ready');
          clientWs.send(JSON.stringify({ type: 'ready' }));
        }
      } catch (_) {}
    }
  });

  // Client → Gemini
  clientWs.on('message', (data) => {
    if (geminiWs.readyState === WS.OPEN) geminiWs.send(data);
    else console.warn('[live] client sent before gemini ready');
  });

  const cleanup = () => {
    try { geminiWs.close(); } catch (_) {}
    try { clientWs.close(); } catch (_) {}
  };
  clientWs.on('close', cleanup);
  geminiWs.on('close', (code, reason) => {
    console.log('[live] gemini closed:', code, reason?.toString()?.slice(0, 80));
    cleanup();
  });
  clientWs.on('error', cleanup);
  geminiWs.on('error', (e) => { console.error('[live] gemini error:', e.message); cleanup(); });
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/api/live')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, async () => {
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

    // Start MQTT subscriber (local Mosquitto broker)
    try {
      const mqttBridge = require('./lib/mqtt');
      mqttBridge.start();
      console.log('   MQTT bridge: ✅ started (mqtt://localhost:1883)');
    } catch (mqttErr) {
      console.error('   MQTT bridge: ⚠️  failed to start —', mqttErr.message);
    }

    // Wire weekly progress email batch — runs every 7 days
    // (scans all active users and sends individual weekly summaries)
    const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
    setInterval(async () => {
      console.log('[weekly-email] Starting weekly batch send...');
      try {
        const { sendWeeklyProgressEmail } = require('./scripts/send-onboarding-email');
        const supabaseAdmin = require('./lib/supabase');
        const { data: users } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .not('email', 'is', null)
          .limit(1000);
        if (users && users.length > 0) {
          console.log(`[weekly-email] Sending to ${users.length} users...`);
          for (const u of users) {
            try { await sendWeeklyProgressEmail(u.id); } catch (e) {
              console.error(`[weekly-email] Failed for ${u.id}:`, e.message);
            }
            // Rate-limit Resend: ~2 emails/sec
            await new Promise(r => setTimeout(r, 500));
          }
          console.log('[weekly-email] Batch complete.');
        }
      } catch (e) {
        console.error('[weekly-email] Batch error:', e.message);
      }
    }, WEEKLY_MS);
    console.log('   Weekly progress emails: ✅ wired (7-day interval)');
  }
});

// ─── Diagram Search Endpoint (Direct Parts Sites) ────────────────────────────
// Scrapes model-specific pages directly from trusted parts sites.
// More reliable than image search — goes straight to the source.
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyC52nkaB32oqX74oSs3yMMUVyyQ1huD5Ic';
const DIAGRAM_GOOGLE_API_KEY = process.env.DIAGRAM_GOOGLE_API_KEY || 'AIzaSyCCXdJ_AP32DnwGBXRl2h8iyL534SvJMVU';
const DIAGRAM_GOOGLE_CSE_ID = process.env.DIAGRAM_GOOGLE_CSE_ID || '';

// In-memory diagram cache (TTL: 24h)
const diagramCache = new Map();
const DIAGRAM_CACHE_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of diagramCache.entries()) {
    if (now - entry.timestamp > DIAGRAM_CACHE_TTL) diagramCache.delete(key);
  }
}, 60 * 60 * 1000);

// ─── Direct Parts Site Scrapers ─────────────────────────────────────────────
// Each function hits a specific trusted parts site with the model number
// and extracts diagram/parts images from known page structures.

const PARTS_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Extract all image URLs matching a pattern from HTML
function extractImages(html, patterns, source, contextUrl) {
  const results = [];
  for (const { regex, titleFn } of patterns) {
    let match;
    const re = new RegExp(regex.source, regex.flags);
    while ((match = re.exec(html)) !== null && results.length < 8) {
      const imageUrl = match[1] || match[2] || '';
      if (!imageUrl || imageUrl.length < 10) continue;
      const fullUrl = imageUrl.startsWith('http') ? imageUrl : `https://${source}${imageUrl}`;
      if (!results.find(r => r.imageUrl === fullUrl)) {
        results.push({
          imageUrl: fullUrl,
          thumbnailUrl: fullUrl,
          title: titleFn ? titleFn(match) : 'Parts Diagram',
          source,
          contextUrl,
        });
      }
    }
  }
  return results;
}

// PartSelect: partselect.com/Models/{model}.htm
async function scrapePartSelect(modelNumber) {
  const url = `https://www.partselect.com/Models/${encodeURIComponent(modelNumber)}.htm`;
  try {
    const res = await fetch(url, { headers: PARTS_FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const html = await res.text();
    // PartSelect embeds diagram images in .diagram-image or ps-diagram containers
    const images = extractImages(html, [
      { regex: /src="(https?:\/\/(?:www\.)?partselect\.(?:com|ca)[^"]+(?:diagram|exploded|parts)[^"]*\.(?:png|jpg|gif|webp))"/gi, titleFn: () => 'Parts Diagram' },
      { regex: /data-src="(https?:\/\/(?:www\.)?partselect\.(?:com|ca)[^"]+\.(?:png|jpg|gif|webp))"/gi, titleFn: () => 'Parts View' },
      { regex: /"imageUrl":"(https?:\/\/(?:www\.)?partselect[^"]+(?:diagram|exploded)[^"]*\.(?:png|jpg|gif|webp))"/gi, titleFn: () => 'Diagram' },
    ], 'www.partselect.com', url);
    console.log(`[diagrams/partselect] ${images.length} images for ${modelNumber}`);
    return images;
  } catch (err) {
    console.warn(`[diagrams/partselect] Failed: ${err.message}`);
    return [];
  }
}

// RepairClinic: search by model number
async function scrapeRepairClinic(modelNumber) {
  const searchUrl = `https://www.repairclinic.com/PartDetail/Search?query=${encodeURIComponent(modelNumber)}&lang=en`;
  try {
    const res = await fetch(searchUrl, { headers: PARTS_FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const html = await res.text();
    const images = extractImages(html, [
      { regex: /src="(https?:\/\/[^"]*repairclinic[^"]+(?:diagram|exploded|parts|PLDM)[^"]*\.(?:png|jpg|gif|webp))"/gi, titleFn: () => 'Parts Diagram' },
      { regex: /data-original="(https?:\/\/[^"]*repairclinic[^"]+\.(?:png|jpg|gif|webp))"/gi, titleFn: () => 'Parts View' },
      // Sears/RC shared CDN diagram images
      { regex: /src="(https?:\/\/[^"]*\.(?:png|gif)(?:\?[^"]*)?)"[^>]*class="[^"]*diagram[^"]*"/gi, titleFn: () => 'Diagram' },
    ], 'www.repairclinic.com', searchUrl);
    console.log(`[diagrams/repairclinic] ${images.length} images for ${modelNumber}`);
    return images;
  } catch (err) {
    console.warn(`[diagrams/repairclinic] Failed: ${err.message}`);
    return [];
  }
}

// AppliancePartsPros: direct model search
async function scrapeAppliancePartsPros(modelNumber) {
  const url = `https://www.appliancepartspros.com/parts-for-${encodeURIComponent(modelNumber.toLowerCase().replace(/\s+/g,'-'))}.html`;
  try {
    const res = await fetch(url, { headers: PARTS_FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const html = await res.text();
    const images = extractImages(html, [
      { regex: /src="(https?:\/\/[^"]*(?:t-esb6|appliancepartspros)[^"]+\.(?:png|jpg|gif|webp|gif))"/gi, titleFn: () => 'Parts Diagram' },
      { regex: /"diagram_url":"([^"]+)"/gi, titleFn: () => 'Exploded Diagram' },
    ], 'www.appliancepartspros.com', url);
    console.log(`[diagrams/appliancepartspros] ${images.length} images for ${modelNumber}`);
    return images;
  } catch (err) {
    console.warn(`[diagrams/appliancepartspros] Failed: ${err.message}`);
    return [];
  }
}

// SearsParts Direct CDN — direct diagram image URL patterns
async function scrapeSearsPartsDirect(modelNumber) {
  // Sears has a consistent CDN pattern for model diagrams
  const searchUrl = `https://www.searspartsdirect.com/model/${encodeURIComponent(modelNumber)}`;
  try {
    const res = await fetch(searchUrl, { headers: PARTS_FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const html = await res.text();
    const images = extractImages(html, [
      { regex: /src="(https?:\/\/[^"]*searspartsdirect[^"]*(?:PLDM|diagram)[^"]*\.(?:png|jpg|gif))"/gi, titleFn: () => 'Parts Diagram' },
      { regex: /src="(https?:\/\/c\.searspartsdirect\.com\/[^"]+\.(?:png|gif))"/gi, titleFn: () => 'Parts View' },
    ], 'www.searspartsdirect.com', searchUrl);
    console.log(`[diagrams/searspartsdirect] ${images.length} images for ${modelNumber}`);
    return images;
  } catch (err) {
    console.warn(`[diagrams/searspartsdirect] Failed: ${err.message}`);
    return [];
  }
}

// Google CSE fallback (if CSE ID is configured)
async function searchGoogleCSE(modelNumber, applianceType) {
  if (!DIAGRAM_GOOGLE_CSE_ID) return [];
  const q = [modelNumber, applianceType, 'parts diagram exploded view'].filter(Boolean).join(' ');
  const url = `https://www.googleapis.com/customsearch/v1?key=${DIAGRAM_GOOGLE_API_KEY}&cx=${DIAGRAM_GOOGLE_CSE_ID}&q=${encodeURIComponent(q)}&searchType=image&num=5&imgSize=medium&safe=active`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(item => ({
      imageUrl:     item.link,
      thumbnailUrl: item.image?.thumbnailLink || item.link,
      title:        item.title || 'Parts Diagram',
      source:       item.displayLink || '',
      contextUrl:   item.image?.contextLink || '',
    }));
  } catch (err) {
    console.warn(`[diagrams/google-cse] Failed: ${err.message}`);
    return [];
  }
}

// Main diagram search — runs all scrapers in parallel, dedupes, returns best results
async function searchDiagramsMultiSource(modelNumber, applianceType) {
  const [partselect, repairclinic, appliancepartspros, sears, googleCse] = await Promise.allSettled([
    scrapePartSelect(modelNumber),
    scrapeRepairClinic(modelNumber),
    scrapeAppliancePartsPros(modelNumber),
    scrapeSearsPartsDirect(modelNumber),
    searchGoogleCSE(modelNumber, applianceType),
  ]);

  const allImages = [
    ...(partselect.status === 'fulfilled' ? partselect.value : []),
    ...(repairclinic.status === 'fulfilled' ? repairclinic.value : []),
    ...(appliancepartspros.status === 'fulfilled' ? appliancepartspros.value : []),
    ...(sears.status === 'fulfilled' ? sears.value : []),
    ...(googleCse.status === 'fulfilled' ? googleCse.value : []),
  ];

  // Deduplicate by imageUrl
  const seen = new Set();
  return allImages.filter(img => {
    if (!img.imageUrl || seen.has(img.imageUrl)) return false;
    seen.add(img.imageUrl);
    return true;
  });
}

// ─── Diagram Search Route ────────────────────────────────────────────────────
app.get('/api/diagrams/search', async (req, res) => {
  const { modelNumber, issue, applianceType } = req.query;

  if (!modelNumber) {
    return res.status(400).json({ success: false, error: 'Missing modelNumber parameter' });
  }

  const cacheKey = `${modelNumber}:${issue || ''}:${applianceType || ''}`;
  const cached = diagramCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DIAGRAM_CACHE_TTL) {
    console.log(`[diagrams] Cache hit for ${modelNumber}`);
    return res.json({ success: true, modelNumber, fromCache: true, count: cached.images.length, images: cached.images, source: 'cache' });
  }

  try {
    console.log(`[diagrams] Multi-source scrape for: ${modelNumber}`);
    const images = await searchDiagramsMultiSource(modelNumber, applianceType);
    diagramCache.set(cacheKey, { images, timestamp: Date.now() });
    console.log(`[diagrams] Found ${images.length} images for ${modelNumber}`);
    res.json({ success: true, modelNumber, fromCache: false, count: images.length, images, source: 'direct' });
  } catch (err) {
    console.error(`[diagrams] Error for ${modelNumber}:`, err.message);
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
// POST /api/auth/verify-email — verify token from email link
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'token is required' });

    const sb = require('./lib/supabase');
    const query = sb.from('profiles').select('id, verification_token, verification_token_expires_at, email_verified');
    const { data: profile, error } = userId
      ? await query.eq('id', userId).maybeSingle()
      : await query.eq('verification_token', token).maybeSingle();

    if (error) throw error;
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });
    if (profile.email_verified) return res.json({ success: true, alreadyVerified: true });

    // Check token match — accept full token OR the 6-char short code shown in the email
    const storedToken = profile.verification_token || '';
    const shortCode = storedToken.substring(0, 6).toUpperCase();
    const tokenMatches = storedToken === token || shortCode === token.toUpperCase();
    if (!tokenMatches) {
      return res.status(400).json({ success: false, error: 'Invalid verification token' });
    }

    // Check expiry
    if (profile.verification_token_expires_at && new Date(profile.verification_token_expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Verification link has expired. Please request a new one.' });
    }

    // Mark verified
    const { error: updateError } = await sb.from('profiles').update({
      email_verified: true,
      email_verified_at: new Date().toISOString(),
      verification_token: null,
      verification_token_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', profile.id);

    if (updateError) throw updateError;

    console.log(`[auth] Email verified for user ${profile.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth] verify-email error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
    const { userId, email, name } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const { createClient } = require('@supabase/supabase-js');
    const admin = createClient(
      'https://rxzbnvvtzhgogeuhajvp.supabase.co',
      'sb_secret_ZippXnI12gbtsKswpk0O4w_V1_A5EiU'
    );

    const { error } = await admin.auth.admin.updateUser(userId, { email_confirm: true });
    if (error) throw new Error(error.message);

    // Also mark email_verified in profiles so app doesn’t show verify screen
    const sb = require('./lib/supabase');
    await sb.from('profiles')
      .update({ email_verified: true, verification_token: null, verification_token_expires_at: null })
      .eq('id', userId);

    console.log(`[auth] Email auto-confirmed for user ${userId}`);

    // ─── Fire onboarding email sequence (Day 12) ───────────────────────────
    if (email) {
      setImmediate(async () => {
        try {
          const { sendOnboardingSequence } = require('./scripts/send-onboarding-email');
          await sendOnboardingSequence({
            id: userId,
            email,
            user_metadata: { full_name: name || '' },
          });
        } catch (emailErr) {
          console.error('[auth] Onboarding email error (non-fatal):', emailErr.message);
        }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[auth] confirm-email error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
