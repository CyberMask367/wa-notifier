const express = require('express');
const router = express.Router();
const db = require('../db');
const wa = require('../whatsapp');
const { applyTemplate, logMessage } = require('../scheduler');

// Jellyfin sends POST to /webhook/jellyfin
// The Jellyfin webhook plugin sends a FLAT payload (all fields at top level, not nested)
function extractVars(body) {
  // Debug: log raw body so users can see what Jellyfin actually sends
  console.log('[Jellyfin] Raw payload:', JSON.stringify(body, null, 2));

  // Season/episode numbers - Jellyfin provides pre-formatted zero-padded versions
  const seasonNum = body.SeasonNumber ?? body.Item?.ParentIndexNumber;
  const episodeNum = body.EpisodeNumber ?? body.Item?.IndexNumber;

  const season = seasonNum != null ? `S${String(seasonNum).padStart(2, '0')}` : '';
  const episode = episodeNum != null ? `E${String(episodeNum).padStart(2, '0')}` : '';

  // Title: for episodes use the episode name, for everything else use Name
  const title = body.Name || body.Item?.Name || body.ItemName || 'Unknown';

  // Series name
  const series = body.SeriesName || body.Item?.SeriesName || '';

  const vars = {
    event:   body.NotificationType || body.Event || 'unknown',
    user:    body.NotificationUsername || body.User?.Name || 'Unknown',
    title,
    series,
    season,
    episode,
    type:    body.ItemType || body.Item?.Type || '',
    year:    body.Year ?? body.Item?.ProductionYear ?? '',
    server:  body.ServerName || body.Server?.ServerName || 'Jellyfin',
    device:  body.DeviceName || body.ClientName || '',
    overview: body.Overview || body.Item?.Overview || '',
    time:    new Date().toLocaleTimeString(),
    date:    new Date().toLocaleDateString(),
  };

  // episode_title: "Series S01E02" for episodes, plain title otherwise
  vars.episode_title = series
    ? `${series} ${season}${episode}`.trim()
    : title;

  return vars;
}

// Normalize event names from different Jellyfin notification plugins
function normalizeEvent(body) {
  // Jellyfin webhook plugin uses NotificationType
  // Older Jellyfin uses Event
  return (body.NotificationType || body.Event || '').toLowerCase().replace(/[\s.]/g, '_');
}

// Debug endpoint — POST /webhook/jellyfin/debug to see raw payload + parsed vars
router.post('/debug', (req, res) => {
  const vars = extractVars(req.body);
  const event = normalizeEvent(req.body);
  res.json({ event, vars, raw: req.body });
});

router.post('/', async (req, res) => {
  // Optional secret validation
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'jellyfin_secret'").get();
  if (setting?.value) {
    const secret = req.headers['x-jellyfin-secret'] || req.query.secret;
    if (secret !== setting.value) {
      return res.status(401).json({ error: 'Invalid secret' });
    }
  }

  const event = normalizeEvent(req.body);
  const vars = extractVars(req.body);

  console.log(`[Jellyfin] Event: ${event}`, JSON.stringify(vars));

  // Find matching active rules
  // Match exact event OR wildcard "*"
  const rules = db.prepare(`
    SELECT * FROM jellyfin_rules 
    WHERE active = 1 AND (event_type = ? OR event_type = '*')
  `).all(event);

  if (rules.length === 0) {
    return res.json({ matched: 0, event });
  }

  for (const rule of rules) {
    let message = rule.custom_message;

    if (!message && rule.template_id) {
      const tpl = db.prepare('SELECT body FROM templates WHERE id = ?').get(rule.template_id);
      if (tpl) message = applyTemplate(tpl.body, vars);
    } else if (message) {
      message = applyTemplate(message, vars);
    }

    if (!message) continue;

    const recipients = JSON.parse(rule.recipients || '[]');
    const results = await wa.sendToRecipients(recipients, message);

    for (const r of results) {
      logMessage(r.recipient, message, `jellyfin:${event}`, r.status, r.error);
    }
  }

  res.json({ matched: rules.length, event });
});

module.exports = router;
