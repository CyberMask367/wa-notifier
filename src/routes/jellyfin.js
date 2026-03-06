const express = require('express');
const router = express.Router();
const db = require('../db');
const wa = require('../whatsapp');
const { applyTemplate, logMessage } = require('../scheduler');

// Debug endpoint
router.post('/debug', (req, res) => {
  res.json({ headers: req.headers, body: req.body, raw_keys: Object.keys(req.body) });
});

// POST /jellyfin
router.post('/', async (req, res) => {
  // Handle cases where Jellyfin sends text/plain or unknown content-type
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  if (!body || !Object.keys(body).length) {
    console.log('[Jellyfin] Empty body — headers:', JSON.stringify(req.headers));
    return res.json({ error: 'empty body', headers: req.headers });
  }

  const rawEvent   = body.NotificationType || body.notification_type || '';
  const itemType   = body.ItemType || body.item_type || '';

  // Build a list of event keys to try matching against, most specific first:
  // 1. "PlaybackStart:Episode"  (type + itemType)
  // 2. "PlaybackStart"          (type only)
  // 3. "playback_start:episode" (normalized)
  // 4. "playback_start"         (normalized, no itemType)
  // 5. "*"                      (wildcard)
  const compound         = itemType ? `${rawEvent}:${itemType}` : rawEvent;
  const compoundNorm     = itemType ? `${rawEvent.toLowerCase()}:${itemType.toLowerCase()}` : rawEvent.toLowerCase();
  const eventNorm        = rawEvent.toLowerCase().replace(/\s+/g, '_');
  const compoundNorm2    = itemType ? `${eventNorm}:${itemType.toLowerCase()}` : eventNorm;

  console.log(`[Jellyfin] NotificationType="${rawEvent}" ItemType="${itemType}" → compound="${compound}"`);

  // Build vars — lowercase + original case
  const lowercased = {};
  for (const [k, v] of Object.entries(body)) lowercased[k.toLowerCase()] = v;

  const serverUrl = body.ServerUrl || body.serverurl || '';
  const itemId    = body.ItemId    || body.itemid    || '';
  const serverId  = body.ServerId  || body.serverid  || '';

  const vars = {
    ...lowercased,
    ...body,
    poster_url: serverUrl && itemId ? `${serverUrl}/Items/${itemId}/Images/Primary` : '',
    item_url:   serverUrl && itemId && serverId ? `${serverUrl}/web/index.html#!/details?id=${itemId}&serverId=${serverId}` : '',
    event: eventNorm,
    item_type: itemType,
  };

  console.log('[Jellyfin] Vars keys:', Object.keys(body));

  // Find ALL matching rules, trying compound first then fallback
  // A rule matches if its event_type equals any of our keys, or is *
  const allRules = db.prepare(`SELECT * FROM jellyfin_rules WHERE active = 1`).all();

  const matchedRules = allRules.filter(r => {
    const et = r.event_type;
    if (et === '*') return true;
    // Exact compound match (e.g. "PlaybackStart:Episode")
    if (et === compound) return true;
    // Exact raw match (e.g. "PlaybackStart")
    if (et === rawEvent) return true;
    // Normalized matches
    if (et === eventNorm) return true;
    if (et === compoundNorm) return true;
    if (et === compoundNorm2) return true;
    return false;
  });

  // If we have compound-specific rules, prefer them over generic ones
  // (so PlaybackStart:Episode fires instead of PlaybackStart when itemType matches)
  const compoundRules = matchedRules.filter(r =>
    r.event_type.includes(':') && r.event_type !== '*'
  );
  const genericRules = matchedRules.filter(r =>
    !r.event_type.includes(':') && r.event_type !== '*'
  );
  const wildcardRules = matchedRules.filter(r => r.event_type === '*');

  // Use compound rules if any exist, otherwise fall back to generic, then wildcard
  let rulesToFire;
  if (compoundRules.length) {
    rulesToFire = [...compoundRules, ...wildcardRules];
  } else if (genericRules.length) {
    rulesToFire = [...genericRules, ...wildcardRules];
  } else {
    rulesToFire = wildcardRules;
  }

  if (!rulesToFire.length) {
    return res.json({ matched: 0, event: compound, message: 'No active rules for this event' });
  }

  for (const rule of rulesToFire) {
    let message = rule.custom_message || '';

    if (rule.template_id) {
      const tpl = db.prepare('SELECT body FROM templates WHERE id = ?').get(rule.template_id);
      if (tpl) message = applyTemplate(tpl.body, vars);
    } else if (message) {
      message = applyTemplate(message, vars);
    }

    if (!message) continue;

    const recipients = JSON.parse(rule.recipients || '[]');

    const opts = vars.poster_url
      ? { url: vars.poster_url, fileName: 'poster.jpg', caption: message }
      : message;

    const results = await wa.sendToRecipients(recipients, opts);

    for (const r of results) {
      console.log(`[Jellyfin] Send to ${r.recipient}: ${r.status}${r.error ? ' — ' + r.error : ''}${r.note ? ' ('+r.note+')' : ''}`);
      logMessage(r.recipient, message, `jellyfin:${compound}`, r.status, r.error);
    }

    db.prepare('UPDATE jellyfin_rules SET last_triggered = CURRENT_TIMESTAMP, trigger_count = trigger_count + 1 WHERE id = ?').run(rule.id);
  }

  res.json({ matched: rulesToFire.length, event: compound });
});

module.exports = router;
