'use strict';

/**
 * routes/properties.js
 *
 * Property / Unit / Asset management + QR code generation
 * IoT session resolution (QR scan → full context)
 *
 * Route prefix: /api/properties  (registered in server.js)
 *
 * Endpoints:
 *   POST   /                          — Create property
 *   GET    /                          — List properties for owner
 *   GET    /:id                       — Get property + units + assets
 *   POST   /:id/units                 — Add unit to property
 *   POST   /:id/units/:uid/assets     — Add asset to unit
 *   GET    /assets/:qr/scan           — QR scan → resolve full context (PUBLIC)
 *   POST   /assets/:id/iot            — IoT device posts telemetry
 *   GET    /:id/qr                    — Generate QR sheet for all assets
 */

const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireJWT } = require('../middleware/auth');
const supabase = require('../lib/supabase');

// ─── QR Code generation (pure SVG, no npm deps) ─────────────────────────────
// Generates a simple QR-like data URL pointing to our scan endpoint.
// In production you'd use a real QR library; for now we return the scan URL
// and a scannable redirect link that the frontend renders as QR.
function buildScanUrl(qrToken) {
  const base = process.env.CLOUD_RUN_URL || 'https://maintmentor-api-878722550029.us-east1.run.app';
  return `${base}/api/properties/assets/${qrToken}/scan`;
}

function buildAppDeepLink(qrToken) {
  return `https://maintmentor.ai/scan/${qrToken}`;
}

// ─── POST / — Create property ────────────────────────────────────────────────
router.post('/', requireJWT, async (req, res) => {
  const { name, address, city, state, zip, lat, lng, property_type, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { data, error } = await supabase
    .from('properties')
    .insert({
      owner_id:      req.user.id,
      name,
      address,
      city,
      state:         state || 'FL',
      zip,
      lat,
      lng,
      property_type: property_type || 'residential',
      notes,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ success: true, property: data });
});

// ─── GET / — List properties for owner ──────────────────────────────────────
router.get('/', requireJWT, async (req, res) => {
  const { data, error } = await supabase
    .from('properties')
    .select('*, units(count)')
    .eq('owner_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, properties: data || [] });
});

// ─── GET /:id — Get property + units + assets ────────────────────────────────
router.get('/:id', requireJWT, async (req, res) => {
  const { id } = req.params;

  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('*')
    .eq('id', id)
    .single();

  if (propErr || !property) return res.status(404).json({ error: 'Property not found' });

  // Check access: owner or user_property_access
  const isOwner = property.owner_id === req.user.id;
  if (!isOwner) {
    const { data: access } = await supabase
      .from('user_property_access')
      .select('role')
      .eq('user_id', req.user.id)
      .eq('property_id', id)
      .maybeSingle();
    if (!access) return res.status(403).json({ error: 'Access denied' });
  }

  const { data: units } = await supabase
    .from('units')
    .select('*, assets(*)')
    .eq('property_id', id)
    .order('unit_number');

  return res.json({
    success: true,
    property: { ...property, units: units || [] },
  });
});

// ─── POST /:id/units — Add unit ──────────────────────────────────────────────
router.post('/:id/units', requireJWT, async (req, res) => {
  const { id: property_id } = req.params;
  const { unit_number, floor, sqft, bedrooms, bathrooms, tenant_name, tenant_phone, tenant_email, notes } = req.body;

  if (!unit_number) return res.status(400).json({ error: 'unit_number is required' });

  // Verify ownership
  const { data: prop } = await supabase
    .from('properties')
    .select('id, owner_id')
    .eq('id', property_id)
    .single();
  if (!prop || prop.owner_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('units')
    .insert({ property_id, unit_number, floor, sqft, bedrooms, bathrooms, tenant_name, tenant_phone, tenant_email, notes })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // If tenant phone provided, add to phone_unit_map
  if (tenant_phone) {
    await supabase.from('phone_unit_map').upsert({
      phone:       tenant_phone,
      unit_id:     data.id,
      property_id,
      label:       'Tenant',
    }, { onConflict: 'phone' });
  }

  return res.status(201).json({ success: true, unit: data });
});

// ─── POST /:id/units/:uid/assets — Add asset ────────────────────────────────
router.post('/:id/units/:uid/assets', requireJWT, async (req, res) => {
  const { id: property_id, uid: unit_id } = req.params;
  const {
    name, asset_type, make, model, serial_number,
    install_date, warranty_expiry, location_desc,
    iot_enabled, iot_device_id, iot_protocol, iot_endpoint,
    last_service_date, next_service_date, service_interval_days, notes,
  } = req.body;

  if (!name || !asset_type) return res.status(400).json({ error: 'name and asset_type are required' });

  // Verify property ownership
  const { data: prop } = await supabase.from('properties').select('owner_id').eq('id', property_id).single();
  if (!prop || prop.owner_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('assets')
    .insert({
      property_id,
      unit_id,
      name,
      asset_type,
      make,
      model,
      serial_number,
      install_date,
      warranty_expiry,
      location_desc,
      iot_enabled:    iot_enabled  || false,
      iot_device_id:  iot_device_id || null,
      iot_protocol:   iot_protocol  || 'mqtt',
      iot_endpoint:   iot_endpoint  || null,
      last_service_date,
      next_service_date,
      service_interval_days: service_interval_days || 180,
      notes,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const scanUrl   = buildScanUrl(data.qr_token);
  const deepLink  = buildAppDeepLink(data.qr_token);

  return res.status(201).json({
    success: true,
    asset: data,
    qr: { token: data.qr_token, scan_url: scanUrl, deep_link: deepLink },
  });
});

// ─── GET /assets/:qr/scan — QR Scan Resolution (PUBLIC) ─────────────────────
// Called when a tech scans a QR code on an appliance.
// Returns full context: property + unit + asset + IoT status + AI prompt hint.
// No auth required — the QR token IS the credential.
router.get('/assets/:qr/scan', async (req, res) => {
  const { qr } = req.params;

  const { data: asset, error } = await supabase
    .from('assets')
    .select(`
      *,
      units (
        id, unit_number, floor, sqft, bedrooms, bathrooms,
        tenant_name, tenant_phone,
        properties (
          id, name, address, city, state, zip, lat, lng, property_type
        )
      )
    `)
    .eq('qr_token', qr)
    .single();

  if (error || !asset) {
    return res.status(404).json({ error: 'Asset not found — invalid or expired QR code' });
  }

  // Fetch recent IoT events (last 5)
  const { data: recentEvents } = await supabase
    .from('iot_events')
    .select('event_type, severity, payload, ai_diagnosis, created_at')
    .eq('asset_id', asset.id)
    .order('created_at', { ascending: false })
    .limit(5);

  const unit     = asset.units || {};
  const property = unit.properties || {};

  // Build AI context hint for the app to pre-populate chat
  const aiContextHint = [
    asset.make && `${asset.make} ${asset.model || ''}`.trim(),
    asset.asset_type,
    property.name && `at ${property.name}`,
    unit.unit_number && `Unit ${unit.unit_number}`,
    asset.install_date && `installed ${asset.install_date}`,
    asset.serial_number && `S/N: ${asset.serial_number}`,
  ].filter(Boolean).join(', ');

  const activeAlerts = (recentEvents || []).filter(e => e.severity === 'critical' || e.severity === 'emergency');

  return res.json({
    success: true,
    scanned_at: new Date().toISOString(),
    asset: {
      id:              asset.id,
      name:            asset.name,
      asset_type:      asset.asset_type,
      make:            asset.make,
      model:           asset.model,
      serial_number:   asset.serial_number,
      install_date:    asset.install_date,
      warranty_expiry: asset.warranty_expiry,
      location_desc:   asset.location_desc,
      iot_enabled:     asset.iot_enabled,
      iot_last_seen:   asset.iot_last_seen,
      iot_last_status: asset.iot_last_status,
      last_service_date: asset.last_service_date,
      next_service_date: asset.next_service_date,
    },
    unit: {
      id:          unit.id,
      unit_number: unit.unit_number,
      floor:       unit.floor,
    },
    property: {
      id:            property.id,
      name:          property.name,
      address:       property.address,
      city:          property.city,
      state:         property.state,
    },
    iot: {
      enabled:        asset.iot_enabled,
      last_seen:      asset.iot_last_seen,
      recent_events:  recentEvents || [],
      active_alerts:  activeAlerts,
      has_active_alert: activeAlerts.length > 0,
    },
    ai_context: {
      hint: aiContextHint,
      suggested_prompt: activeAlerts.length > 0
        ? `ALERT: ${activeAlerts[0].payload?.message || 'Active alert detected'}. Asset: ${aiContextHint}`
        : `I'm looking at a ${aiContextHint}. Can you help me assess its current status?`,
      skill_id: 'maintenance-field',
    },
  });
});

// ─── POST /assets/:id/iot — IoT device telemetry ingestion ──────────────────
// Called by IoT devices/MQTT bridge to post telemetry.
// Auth: device_secret header OR iot_device_id match.
router.post('/assets/:id/iot', async (req, res) => {
  const { id: asset_id } = req.params;
  const { event_type, severity, payload, device_id } = req.body;

  if (!payload) return res.status(400).json({ error: 'payload is required' });

  // Fetch asset + property context
  const { data: asset, error } = await supabase
    .from('assets')
    .select('id, property_id, unit_id, name, asset_type, iot_device_id, iot_enabled')
    .eq('id', asset_id)
    .single();

  if (error || !asset) return res.status(404).json({ error: 'Asset not found' });
  if (!asset.iot_enabled) return res.status(403).json({ error: 'IoT not enabled for this asset' });

  // Optional device ID check
  if (device_id && asset.iot_device_id && device_id !== asset.iot_device_id) {
    return res.status(401).json({ error: 'Device ID mismatch' });
  }

  const eventSeverity = severity || 'info';
  const eventType     = event_type || 'telemetry';

  // Log IoT event
  const { data: event, error: eventErr } = await supabase
    .from('iot_events')
    .insert({
      asset_id,
      property_id: asset.property_id,
      unit_id:     asset.unit_id,
      event_type:  eventType,
      severity:    eventSeverity,
      payload,
    })
    .select()
    .single();

  if (eventErr) {
    console.error('[iot] event insert failed:', eventErr.message);
    return res.status(500).json({ error: 'Failed to log event' });
  }

  // Update asset iot_last_seen + iot_last_status
  await supabase
    .from('assets')
    .update({
      iot_last_seen:   new Date().toISOString(),
      iot_last_status: payload,
    })
    .eq('id', asset_id);

  // For critical/emergency events, trigger AI diagnosis via A2A
  let aiDiagnosis = null;
  if (eventSeverity === 'critical' || eventSeverity === 'emergency') {
    try {
      const question = payload.message
        || `${asset.name} (${asset.asset_type}) reporting: ${JSON.stringify(payload)}`;

      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash',
        systemInstruction: 'You are MaintMentor. An IoT appliance has reported an alert. Give a concise diagnosis and immediate action steps. Lead with safety warnings if relevant.',
      });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: 600 },
      });
      aiDiagnosis = result.response.text();

      // Store diagnosis in event
      await supabase
        .from('iot_events')
        .update({ ai_diagnosis: aiDiagnosis })
        .eq('id', event.id);
    } catch (aiErr) {
      console.error('[iot] AI diagnosis failed:', aiErr.message);
    }
  }

  return res.json({
    success:      true,
    event_id:     event.id,
    severity:     eventSeverity,
    ai_diagnosis: aiDiagnosis,
    logged_at:    event.created_at,
  });
});

// ─── GET /:id/qr — Generate QR data sheet for all assets ────────────────────
router.get('/:id/qr', requireJWT, async (req, res) => {
  const { id: property_id } = req.params;

  const { data: prop } = await supabase
    .from('properties')
    .select('owner_id, name')
    .eq('id', property_id)
    .single();

  if (!prop || prop.owner_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const { data: assets } = await supabase
    .from('assets')
    .select('id, name, asset_type, make, model, qr_token, unit_id, units(unit_number)')
    .eq('property_id', property_id);

  const qrSheet = (assets || []).map(a => ({
    asset_id:   a.id,
    asset_name: a.name,
    asset_type: a.asset_type,
    make:       a.make,
    model:      a.model,
    unit:       a.units?.unit_number || 'Common Area',
    qr_token:   a.qr_token,
    scan_url:   buildScanUrl(a.qr_token),
    deep_link:  buildAppDeepLink(a.qr_token),
    label:      `${prop.name} — ${a.units?.unit_number || 'Common'} — ${a.name}`,
  }));

  return res.json({
    success: true,
    property: prop.name,
    asset_count: qrSheet.length,
    qr_codes: qrSheet,
    instructions: 'Print each qr_token as a QR code. The scan_url is what the QR should encode. Scanning opens the app directly to the asset context.',
  });
});

module.exports = router;
