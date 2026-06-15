'use strict';

/**
 * lib/ecobee.js
 *
 * Ecobee API integration — OAuth + device data + thermostat telemetry.
 *
 * Flow:
 *   1. User clicks "Connect Ecobee" in app
 *   2. We redirect to Ecobee OAuth with our API key
 *   3. User approves, Ecobee redirects back with auth_code
 *   4. We exchange auth_code for access + refresh tokens
 *   5. We store tokens in iot_oauth_tokens
 *   6. We poll for device data + fault events on a schedule
 *
 * Docs: https://www.ecobee.com/home/developer/api/introduction/index.shtml
 */

const https        = require('https');
const supabase     = require('./supabase');
const { interpretFault } = require('./iot-fault-interpreter');

const ECOBEE_API_BASE  = 'https://api.ecobee.com';
const API_KEY          = process.env.ECOBEE_API_KEY;  // Set after Dean registers

// ── OAuth URLs ─────────────────────────────────────────────────────────────

/**
 * Step 1: Generate the authorization URL to send the user to.
 * @param {string} scope - 'smartRead' for read-only, 'smartWrite' for full control
 */
function getAuthUrl(scope = 'smartRead') {
  if (!API_KEY) throw new Error('ECOBEE_API_KEY not configured');
  const params = new URLSearchParams({
    response_type: 'ecobeePin',
    client_id:     API_KEY,
    scope,
  });
  return `${ECOBEE_API_BASE}/authorize?${params}`;
}

/**
 * Step 2: Exchange PIN/auth code for tokens.
 * Returns { access_token, refresh_token, expires_in }
 */
async function exchangeAuthCode(authCode) {
  const body = new URLSearchParams({
    grant_type: 'ecobeePin',
    code:        authCode,
    client_id:   API_KEY,
  });

  return _post('/token', body.toString(), 'application/x-www-form-urlencoded');
}

/**
 * Step 3: Refresh an expired access token.
 */
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     API_KEY,
  });

  return _post('/token', body.toString(), 'application/x-www-form-urlencoded');
}

// ── Token management ───────────────────────────────────────────────────────

/**
 * Get a valid access token for a user, refreshing if needed.
 */
async function getValidToken(userId) {
  const { data: tokenRow, error } = await supabase
    .from('iot_oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('platform', 'ecobee')
    .single();

  if (error || !tokenRow) throw new Error('No Ecobee token for user ' + userId);

  // Refresh if expiring in < 5 minutes
  const expiresAt = new Date(tokenRow.expires_at).getTime();
  const now       = Date.now();

  if (expiresAt - now < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(tokenRow.refresh_token);
    const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

    await supabase
      .from('iot_oauth_tokens')
      .update({
        access_token:  refreshed.access_token,
        refresh_token: refreshed.refresh_token || tokenRow.refresh_token,
        expires_at:    newExpiry,
        updated_at:    new Date().toISOString(),
      })
      .eq('id', tokenRow.id);

    return refreshed.access_token;
  }

  return tokenRow.access_token;
}

// ── Device data ────────────────────────────────────────────────────────────

/**
 * Fetch all thermostats for a user.
 * Returns array of thermostat objects with runtime + alert data.
 */
async function getThermostats(userId) {
  const token = await getValidToken(userId);

  const selection = JSON.stringify({
    selectionType:           'registered',
    selectionMatch:          '',
    includeAlerts:           true,
    includeRuntime:          true,
    includeSensors:          true,
    includeEquipmentStatus:  true,
    includeSettings:         true,
  });

  const result = await _get(
    `/1/thermostat?format=json&body=${encodeURIComponent(JSON.stringify({ selection: JSON.parse(selection) }))}`,
    token
  );

  return result.thermostatList || [];
}

/**
 * Sync devices + telemetry for a user into Supabase.
 */
async function syncUserDevices(userId) {
  const thermostats = await getThermostats(userId);
  const synced = [];

  for (const t of thermostats) {
    // Upsert device record
    const { data: device, error: devErr } = await supabase
      .from('iot_devices')
      .upsert({
        user_id:      userId,
        platform:     'ecobee',
        external_id:  t.identifier,
        device_type:  'thermostat',
        display_name: t.name,
        manufacturer: 'Ecobee',
        model:        t.modelNumber,
        connected:    true,
        last_seen_at: new Date().toISOString(),
        meta: {
          brand:    t.brand,
          features: t.features,
        },
      }, { onConflict: 'platform,external_id' })
      .select('id')
      .single();

    if (devErr) {
      console.error('[ecobee] device upsert error:', devErr.message);
      continue;
    }

    // Store telemetry snapshot
    const runtime  = t.runtime || {};
    const settings = t.settings || {};

    await supabase.from('iot_telemetry').insert({
      device_id:   device.id,
      recorded_at: new Date().toISOString(),
      data: {
        actual_temp_f:       runtime.actualTemperature / 10,
        actual_humidity:     runtime.actualHumidity,
        desired_heat_f:      runtime.desiredHeat / 10,
        desired_cool_f:      runtime.desiredCool / 10,
        hvac_mode:           settings.hvacMode,
        equipment_status:    t.equipmentStatus,
        connected_sensors:   (t.remoteSensors || []).length,
      },
    });

    // Process any active alerts
    const alerts = t.alerts || [];
    for (const alert of alerts) {
      await processAlert(device.id, alert, 'Ecobee', t.modelNumber);
    }

    synced.push({ deviceId: device.id, name: t.name, alerts: alerts.length });
  }

  return synced;
}

/**
 * Process a device alert — interpret with AI and store in iot_fault_events.
 */
async function processAlert(deviceId, alert, manufacturer, model) {
  // Skip if we've already logged this exact alert
  const { data: existing } = await supabase
    .from('iot_fault_events')
    .select('id')
    .eq('device_id', deviceId)
    .eq('fault_code', String(alert.alertType || alert.code || 'UNKNOWN'))
    .eq('resolved', false)
    .limit(1);

  if (existing && existing.length > 0) return; // already logged

  const faultCode = String(alert.alertType || alert.code || 'UNKNOWN');

  // AI interpretation
  const interpretation = await interpretFault({
    faultCode,
    rawDescription: alert.text || alert.message || '',
    platform:       'ecobee',
    deviceType:     'thermostat',
    manufacturer,
    model,
  });

  await supabase.from('iot_fault_events').insert({
    device_id:       deviceId,
    fault_code:      faultCode,
    raw_description: alert.text || alert.message || '',
    severity:        interpretation.severity,
    ai_diagnosis:    interpretation.diagnosis,
    ai_steps:        interpretation.steps.join('\n'),
    occurred_at:     new Date().toISOString(),
  });
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function _get(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.ecobee.com',
      path,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json;charset=UTF-8',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON from Ecobee: ' + data.substring(0, 100))); }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function _post(path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body);
    const options = {
      hostname: 'api.ecobee.com',
      path,
      method:   'POST',
      headers: {
        'Content-Type':   contentType,
        'Content-Length': bodyBuf.length,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON from Ecobee: ' + data.substring(0, 100))); }
      });
    });

    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

module.exports = {
  getAuthUrl,
  exchangeAuthCode,
  refreshAccessToken,
  getValidToken,
  getThermostats,
  syncUserDevices,
  processAlert,
};
