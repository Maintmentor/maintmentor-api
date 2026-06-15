'use strict';

/**
 * routes/iot.js
 *
 * IoT device integration endpoints.
 *
 * Routes:
 *   GET  /api/iot/connect/ecobee          — Get Ecobee OAuth URL
 *   POST /api/iot/connect/ecobee/callback — Exchange auth code for tokens
 *   GET  /api/iot/devices                 — List user's connected devices
 *   GET  /api/iot/devices/:id/telemetry   — Recent telemetry for a device
 *   GET  /api/iot/devices/:id/faults      — Fault events for a device
 *   POST /api/iot/sync                    — Manual sync trigger
 *   POST /api/iot/webhook/ecobee          — Ecobee event push webhook
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const ecobee   = require('../lib/ecobee');
const { interpretFault } = require('../lib/iot-fault-interpreter');
const { requireApiKey }  = require('../middleware/auth');

// ── GET /api/iot/connect/ecobee ───────────────────────────────────────────
// Returns the URL to redirect the user to for Ecobee OAuth
router.get('/connect/ecobee', requireApiKey, (req, res) => {
  try {
    const authUrl = ecobee.getAuthUrl('smartRead');
    res.json({ auth_url: authUrl, platform: 'ecobee' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// ── POST /api/iot/connect/ecobee/callback ─────────────────────────────────
// Exchange the auth code for tokens and store them
router.post('/connect/ecobee/callback', requireApiKey, async (req, res) => {
  const { auth_code } = req.body;
  const userId = req.apiContext?.apiKey?.user_id;

  if (!auth_code) return res.status(400).json({ error: 'auth_code required' });
  if (!userId)    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const tokens  = await ecobee.exchangeAuthCode(auth_code);
    const expiry  = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

    await supabase.from('iot_oauth_tokens').upsert({
      user_id:       userId,
      platform:      'ecobee',
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    expiry,
      scope:         tokens.scope || 'smartRead',
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'user_id,platform' });

    // Immediately sync devices
    const synced = await ecobee.syncUserDevices(userId);

    res.json({
      success:      true,
      platform:     'ecobee',
      devices_found: synced.length,
      devices:      synced,
    });
  } catch (err) {
    console.error('[iot/ecobee/callback]', err.message);
    res.status(500).json({ error: 'Connection failed: ' + err.message });
  }
});

// ── GET /api/iot/devices ──────────────────────────────────────────────────
router.get('/devices', requireApiKey, async (req, res) => {
  const userId = req.apiContext?.apiKey?.user_id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('iot_devices')
    .select(`
      id, platform, device_type, display_name, manufacturer, model,
      location, connected, last_seen_at,
      iot_fault_events!left ( id, severity, fault_code, ai_diagnosis, resolved, occurred_at )
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Summarize open faults per device
  const devices = (data || []).map(d => {
    const openFaults = (d.iot_fault_events || []).filter(f => !f.resolved);
    return {
      ...d,
      open_fault_count: openFaults.length,
      critical_fault: openFaults.some(f => f.severity === 'critical'),
      iot_fault_events: undefined, // strip from response
    };
  });

  res.json({ devices, count: devices.length });
});

// ── GET /api/iot/devices/:id/telemetry ────────────────────────────────────
router.get('/devices/:id/telemetry', requireApiKey, async (req, res) => {
  const userId   = req.apiContext?.apiKey?.user_id;
  const deviceId = req.params.id;
  const hours    = parseInt(req.query.hours) || 24;

  // Verify ownership
  const { data: device } = await supabase
    .from('iot_devices')
    .select('id')
    .eq('id', deviceId)
    .eq('user_id', userId)
    .single();

  if (!device) return res.status(404).json({ error: 'Device not found' });

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const { data, error } = await supabase
    .from('iot_telemetry')
    .select('recorded_at, data')
    .eq('device_id', deviceId)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: false })
    .limit(288); // max 5-min intervals over 24h

  if (error) return res.status(500).json({ error: error.message });
  res.json({ device_id: deviceId, hours, readings: data || [] });
});

// ── GET /api/iot/devices/:id/faults ──────────────────────────────────────
router.get('/devices/:id/faults', requireApiKey, async (req, res) => {
  const userId   = req.apiContext?.apiKey?.user_id;
  const deviceId = req.params.id;
  const resolved = req.query.resolved === 'true';

  const { data: device } = await supabase
    .from('iot_devices')
    .select('id')
    .eq('id', deviceId)
    .eq('user_id', userId)
    .single();

  if (!device) return res.status(404).json({ error: 'Device not found' });

  let query = supabase
    .from('iot_fault_events')
    .select('*')
    .eq('device_id', deviceId)
    .order('occurred_at', { ascending: false })
    .limit(50);

  if (!resolved) query = query.eq('resolved', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ device_id: deviceId, faults: data || [] });
});

// ── POST /api/iot/sync ────────────────────────────────────────────────────
// Manually trigger a device data sync for the authenticated user
router.post('/sync', requireApiKey, async (req, res) => {
  const userId = req.apiContext?.apiKey?.user_id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const results = {};

    // Check which platforms the user has connected
    const { data: tokens } = await supabase
      .from('iot_oauth_tokens')
      .select('platform')
      .eq('user_id', userId);

    const platforms = (tokens || []).map(t => t.platform);

    if (platforms.includes('ecobee')) {
      results.ecobee = await ecobee.syncUserDevices(userId);
    }

    res.json({
      success:    true,
      synced_at:  new Date().toISOString(),
      platforms:  Object.keys(results),
      results,
    });
  } catch (err) {
    console.error('[iot/sync]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/iot/webhook/ecobee ──────────────────────────────────────────
// Ecobee pushes events here when device status changes
router.post('/webhook/ecobee', async (req, res) => {
  // Ecobee expects a fast 200 response
  res.sendStatus(200);

  // Process async
  setImmediate(async () => {
    try {
      const { ecobeeType, thermostatId } = req.body;
      if (!ecobeeType || !thermostatId) return;

      // Find which user owns this device
      const { data: device } = await supabase
        .from('iot_devices')
        .select('id, user_id, manufacturer, model')
        .eq('platform', 'ecobee')
        .eq('external_id', String(thermostatId))
        .single();

      if (!device) return;

      // Re-sync this user's devices to pick up the change
      await ecobee.syncUserDevices(device.user_id);

    } catch (err) {
      console.error('[iot/webhook/ecobee]', err.message);
    }
  });
});

// ── POST /api/iot/diagnose ────────────────────────────────────────────────
// Ad-hoc fault code diagnosis (no device required — just a code and context)
router.post('/diagnose', requireApiKey, async (req, res) => {
  const { fault_code, description, device_type, manufacturer, model } = req.body;

  if (!fault_code) return res.status(400).json({ error: 'fault_code required' });

  try {
    const result = await interpretFault({
      faultCode:      fault_code,
      rawDescription: description || '',
      platform:       'manual',
      deviceType:     device_type || 'hvac',
      manufacturer:   manufacturer || '',
      model:          model || '',
    });

    res.json({ fault_code, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
