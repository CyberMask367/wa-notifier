const express = require('express');
const router = express.Router();
const db = require('../db');
const wa = require('../whatsapp');
const { applyTemplate, logMessage } = require('../scheduler');
const { applyConditions } = require('../conditions');

function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj || {})) {
    const flat = prefix ? `${prefix}.${key}` : key;
    const underscore = prefix ? `${prefix}_${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenObject(val, flat));
      Object.assign(result, flattenObject(val, underscore));
    } else {
      result[flat] = String(val ?? '');
      result[underscore] = String(val ?? '');
      if (!prefix) result[key] = String(val ?? '');
    }
  }
  return result;
}

router.post('/:slug', async (req, res) => {
  const { slug } = req.params;

  const rule = db.prepare('SELECT * FROM webhook_rules WHERE slug = ? AND active = 1').get(slug);
  if (!rule) {
    return res.status(404).json({ error: `No active webhook found for slug "${slug}"` });
  }

  const vars = {
    ...flattenObject(req.body),
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
    timestamp: new Date().toISOString(),
    slug,
  };

  // Apply conditions
  const baseRecipients = JSON.parse(rule.recipients || '[]');
  const { recipients, template_id, custom_message, matched } = applyConditions(rule, vars, baseRecipients);

  console.log(`[Webhook:${slug}] Conditions matched: ${matched.length}, recipients: ${recipients.length}`);

  if (!recipients.length) {
    return res.json({ success: false, error: 'No recipients — add base recipients or matching conditions' });
  }

  // Build message
  let message = custom_message || '';
  if (template_id) {
    const tpl = db.prepare('SELECT body FROM templates WHERE id = ?').get(template_id);
    if (tpl) message = applyTemplate(tpl.body, vars);
  } else if (message) {
    message = applyTemplate(message, vars);
  }

  if (!message) {
    return res.status(400).json({ error: 'No message or template configured' });
  }

  // Send
  const imageUrl = req.body.image || req.body.image_url || req.body.poster;
  const opts = imageUrl
    ? { url: imageUrl, fileName: 'poster.jpg', caption: message }
    : message;

  const results = await wa.sendToRecipients(recipients, opts);

  for (const r of results) {
    logMessage(r.recipient, message, `webhook:${slug}`, r.status, r.error);
  }

  db.prepare('UPDATE webhook_rules SET last_triggered = CURRENT_TIMESTAMP, trigger_count = trigger_count + 1 WHERE id = ?').run(rule.id);

  res.json({ success: true, slug, recipients: recipients.length, conditions_matched: matched.length, results });
});

module.exports = router;
