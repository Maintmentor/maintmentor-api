'use strict';

/**
 * lib/iot-fault-interpreter.js
 *
 * AI-powered fault code interpreter for IoT connected appliances.
 * When a device fires a fault/error event, this module:
 *   1. Looks up the fault code against our manual knowledge base (FTS)
 *   2. Asks Gemini Flash to interpret it in plain English
 *   3. Returns severity, diagnosis, and step-by-step action plan
 *
 * Used by routes/iot.js when processing incoming webhook events.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { searchManuals }      = require('./manuals');

const MODEL = process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash';

let _genAI = null;
function getModel() {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genAI.getGenerativeModel({ model: MODEL });
}

// ── Known fault code prefixes by manufacturer ──────────────────────────────
const MANUFACTURER_HINTS = {
  ecobee:      'Ecobee smart thermostat',
  nest:        'Google Nest thermostat',
  carrier:     'Carrier HVAC system',
  lennox:      'Lennox HVAC system',
  trane:       'Trane HVAC system',
  rheem:       'Rheem water heater or HVAC',
  aosmith:     'AO Smith water heater',
  samsung:     'Samsung appliance',
  lg:          'LG appliance',
  ge:          'GE appliance',
};

// ── Severity classification ────────────────────────────────────────────────
function classifySeverity(faultCode, rawDescription = '') {
  const combined = `${faultCode} ${rawDescription}`.toLowerCase();

  if (/carbon.monoxide|gas.leak|fire|smoke|explosion|electr[ic]/.test(combined)) {
    return 'critical';
  }
  if (/fail|error|fault|broken|no.heat|no.cool|compressor|refrigerant|leak/.test(combined)) {
    return 'warning';
  }
  return 'info';
}

// ── Main interpreter ───────────────────────────────────────────────────────
/**
 * Interpret a fault code from a connected device.
 *
 * @param {object} params
 * @param {string} params.faultCode        - Raw fault code from device (e.g. "E1", "178", "IFC")
 * @param {string} params.rawDescription   - Manufacturer description if available
 * @param {string} params.platform         - 'ecobee' | 'nest' | 'smartthings' etc.
 * @param {string} params.deviceType       - 'thermostat' | 'hvac' | 'water_heater' etc.
 * @param {string} [params.manufacturer]   - Device manufacturer if known
 * @param {string} [params.model]          - Device model if known
 * @returns {Promise<{severity, diagnosis, steps, confidence}>}
 */
async function interpretFault(params) {
  const {
    faultCode,
    rawDescription = '',
    platform,
    deviceType,
    manufacturer,
    model,
  } = params;

  const severity = classifySeverity(faultCode, rawDescription);

  // Search manuals for this fault code first
  const searchQuery = [faultCode, rawDescription, manufacturer, model, deviceType]
    .filter(Boolean).join(' ');

  let manualContext = '';
  try {
    const manualResults = await searchManuals(searchQuery, { limit: 3 });
    if (manualResults && manualResults.length > 0) {
      manualContext = '\n\nRelevant manual excerpts:\n' +
        manualResults.map(r => `[${r.title}]: ${r.content}`).join('\n\n');
    }
  } catch (_) { /* non-fatal */ }

  const mfrLabel = manufacturer
    ? `${manufacturer} ${model || ''}`.trim()
    : MANUFACTURER_HINTS[platform] || `${platform} device`;

  const prompt = `You are a master HVAC and appliance technician with 30 years of field experience.

A connected ${deviceType} (${mfrLabel}) has reported fault code: "${faultCode}"
${rawDescription ? `Manufacturer description: "${rawDescription}"` : ''}
${manualContext}

Respond in this exact JSON format (no other text):
{
  "diagnosis": "Plain English explanation of what this fault means (2-3 sentences max)",
  "urgency": "immediate | today | this_week | monitor",
  "steps": [
    "Step 1: ...",
    "Step 2: ...",
    "Step 3: ..."
  ],
  "diy_safe": true,
  "pro_required": false,
  "confidence": 0.85
}

Rules:
- diagnosis must be plain language a homeowner understands
- steps must be specific and actionable (3-5 steps)
- if gas, electrical, or refrigerant is involved: pro_required = true
- confidence: 0.0-1.0 based on how well you know this specific code`;

  try {
    const model = getModel();
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.3,
        responseMimeType: 'application/json',
      },
    });

    const raw = result.response.text().trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const parsed = JSON.parse(raw);

    return {
      severity,
      diagnosis:    parsed.diagnosis    || 'Unable to interpret this fault code.',
      urgency:      parsed.urgency      || 'monitor',
      steps:        Array.isArray(parsed.steps) ? parsed.steps : [],
      diy_safe:     parsed.diy_safe     ?? true,
      pro_required: parsed.pro_required ?? false,
      confidence:   parsed.confidence   || 0.5,
    };
  } catch (err) {
    console.error('[iot-fault-interpreter] AI error:', err.message);
    return {
      severity,
      diagnosis:    `Fault code ${faultCode} detected on your ${deviceType}. Unable to auto-diagnose — please check your device manual or contact a technician.`,
      urgency:      severity === 'critical' ? 'immediate' : 'today',
      steps:        ['Check your device manual for fault code ' + faultCode, 'Contact a licensed technician if issue persists'],
      diy_safe:     false,
      pro_required: true,
      confidence:   0.0,
    };
  }
}

module.exports = { interpretFault, classifySeverity };
