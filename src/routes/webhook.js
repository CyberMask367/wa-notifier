const express = require('express');
const router = express.Router();
const db = require('../db');
const wa = require('../whatsapp');
const { applyTemplate, logMessage } = require('../scheduler');

// Flatten a nested object into dot-notation keys for template vars
// e.g. { a: { b: 1 } } → { 'a.b': 1, a_b: 1 }
function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj || {})) {
    const flat = prefix ? `${prefix}.${key}` : key;
    const underscore = prefix ? `${prefix}_${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenObject(val, flat));
      // also underscore version
      const sub = flattenObject(val, underscore);
      Object.assign(result, sub);
    } else {
      result[flat] = String(val ?? '');
      result[underscore] = String(val ?? '');
      // Also set the short key at root level if no prefix collision
      if (!prefix && !(key in result)) result[key] = String(val ?? '');
      if (!prefix) result[key] = String(val ?? '');
    }
  }
  return result;
}

// POST /webhook/:slug
router.post('/:slug', async (req, res) => {
  const { slug } = req.params;

  const rule = db.prepare('SELECT * FROM webhook_rules WHERE slug = ? AND active = 1').get(slug);
  if (!rule) {
    return res.status(404).json({ error: `No active webhook found for slug "${slug}"` });
  }

  // Build template vars from the entire JSON body (flattened)
  const vars = {
    ...flattenObject(req.body),
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
    timestamp: new Date().toISOString(),
    slug,
  };

  let message = rule.custom_message || '';
  if (rule.template_id) {
    const tpl = db.prepare('SELECT body FROM templates WHERE id = ?').get(rule.template_id);
    if (tpl) message = applyTemplate(tpl.body, vars);
  } else if (message) {
    message = applyTemplate(message, vars);
  }

  if (!message) {
    return res.status(400).json({ error: 'Webhook rule has no message or template configured' });
  }

  const recipients = JSON.parse(rule.recipients || '[]');

  // If the payload has an image URL, send it as a photo with the message as caption
  const imageUrl = req.body.image || req.body.image_url || req.body.poster;
  const opts = imageUrl
    ? { url: imageUrl, fileName: 'poster.jpg', caption: message }
    : message;

  const results = await wa.sendToRecipients(recipients, opts);

  for (const r of results) {
    logMessage(r.recipient, message, `webhook:${slug}`, r.status, r.error);
  }

  // Update trigger stats
  db.prepare('UPDATE webhook_rules SET last_triggered = CURRENT_TIMESTAMP, trigger_count = trigger_count + 1 WHERE id = ?').run(rule.id);

  res.json({ success: true, slug, matched: recipients.length, results });
});

module.exports = router;
