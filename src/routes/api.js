const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const db = require('../db');
const wa = require('../whatsapp');
const scheduler = require('../scheduler');

// Temp upload dir for file sends
const UPLOAD_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : '/data/uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 64 * 1024 * 1024 } }); // 64MB max

// ── Auth middleware ───────────────────────────────────────────────────────────
function apiKeyAuth(req, res, next) {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('api_key');
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!setting || key !== setting.value) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ status: wa.getStatus(), qr: wa.getQR() });
});

router.post('/logout', (req, res) => {
  wa.logout();
  res.json({ success: true });
});

// ── Send text (JSON) ──────────────────────────────────────────────────────────
router.post('/send', apiKeyAuth, async (req, res) => {
  const { to, message, template, vars, url, filename, caption } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to"' });
  if (!message && !template && !url) return res.status(400).json({ error: 'Provide message, template, or url' });

  const recipients = Array.isArray(to) ? to : [to];

  let opts;
  if (url) {
    opts = { url, fileName: filename || path.basename(url), caption: caption || message || '' };
  } else {
    let text = message;
    if (!text && template) {
      const tpl = db.prepare('SELECT body FROM templates WHERE name = ?').get(template);
      if (!tpl) return res.status(404).json({ error: `Template "${template}" not found` });
      text = scheduler.applyTemplate(tpl.body, vars || {});
    }
    opts = text;
  }

  const results = await wa.sendToRecipients(recipients, opts);
  for (const r of results) {
    const logMsg = typeof opts === 'string' ? opts : `[file] ${url || ''}`;
    scheduler.logMessage(r.recipient, logMsg, 'api', r.status, r.error);
  }

  res.json({ results });
});

// ── Send file (multipart upload) ──────────────────────────────────────────────
router.post('/send-file', apiKeyAuth, upload.single('file'), async (req, res) => {
  const { to, caption } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to"' });
  if (!req.file) return res.status(400).json({ error: 'Missing file' });

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return res.status(400).json({ error: 'No recipients' });

  const opts = {
    filePath: req.file.path,
    fileName: req.file.originalname,
    caption: caption || '',
  };

  const results = await wa.sendToRecipients(recipients, opts);

  // Clean up temp file after sending
  setTimeout(() => fs.unlink(req.file.path, () => {}), 10000);

  for (const r of results) {
    scheduler.logMessage(r.recipient, `[file] ${req.file.originalname}`, 'api', r.status, r.error);
  }

  res.json({ results });
});

// ── Contacts ──────────────────────────────────────────────────────────────────
router.get('/contacts', (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts ORDER BY name').all());
});

router.post('/contacts', (req, res) => {
  const { name, number, notes } = req.body;
  if (!name || !number) return res.status(400).json({ error: 'name and number required' });
  const clean = number.replace(/\D/g, '');
  try {
    const r = db.prepare('INSERT INTO contacts (name, number, notes) VALUES (?, ?, ?)').run(name, clean, notes || '');
    res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid));
  } catch { res.status(400).json({ error: 'Number already exists' }); }
});

router.put('/contacts/:id', (req, res) => {
  const { name, number, notes } = req.body;
  const clean = number?.replace(/\D/g, '');
  db.prepare('UPDATE contacts SET name = COALESCE(?, name), number = COALESCE(?, number), notes = COALESCE(?, notes) WHERE id = ?')
    .run(name, clean, notes, req.params.id);
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id));
});

router.delete('/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Groups ────────────────────────────────────────────────────────────────────
router.get('/groups', (req, res) => {
  res.json(db.prepare('SELECT * FROM groups ORDER BY name').all());
});

router.post('/groups', (req, res) => {
  const { name, jid, notes } = req.body;
  if (!name || !jid) return res.status(400).json({ error: 'name and jid required' });
  try {
    const r = db.prepare('INSERT INTO groups (name, jid, notes) VALUES (?, ?, ?)').run(name, jid, notes || '');
    res.json(db.prepare('SELECT * FROM groups WHERE id = ?').get(r.lastInsertRowid));
  } catch { res.status(400).json({ error: 'JID already exists' }); }
});

router.delete('/groups/:id', (req, res) => {
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Templates ─────────────────────────────────────────────────────────────────
router.get('/templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM templates ORDER BY name').all());
});

router.post('/templates', (req, res) => {
  const { name, body, description } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'name and body required' });
  try {
    const r = db.prepare('INSERT INTO templates (name, body, description) VALUES (?, ?, ?)').run(name, body, description || '');
    res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(r.lastInsertRowid));
  } catch { res.status(400).json({ error: 'Template name already exists' }); }
});

router.put('/templates/:id', (req, res) => {
  const { name, body, description } = req.body;
  db.prepare('UPDATE templates SET name = COALESCE(?, name), body = COALESCE(?, body), description = COALESCE(?, description), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(name, body, description, req.params.id);
  res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id));
});

router.delete('/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Schedules ─────────────────────────────────────────────────────────────────
router.get('/schedules', (req, res) => {
  res.json(db.prepare('SELECT * FROM schedules ORDER BY name').all());
});

router.post('/schedules', (req, res) => {
  const { name, cron_expr, template_id, recipients, custom_message } = req.body;
  if (!name || !cron_expr || !recipients) return res.status(400).json({ error: 'name, cron_expr, recipients required' });
  const r = db.prepare('INSERT INTO schedules (name, cron_expr, template_id, recipients, custom_message) VALUES (?, ?, ?, ?, ?)')
    .run(name, cron_expr, template_id || null, JSON.stringify(recipients), custom_message || '');
  scheduler.reload();
  res.json(db.prepare('SELECT * FROM schedules WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/schedules/:id', (req, res) => {
  const { name, cron_expr, template_id, recipients, custom_message, active } = req.body;
  db.prepare(`UPDATE schedules SET
    name = COALESCE(?, name), cron_expr = COALESCE(?, cron_expr),
    template_id = COALESCE(?, template_id), recipients = COALESCE(?, recipients),
    custom_message = COALESCE(?, custom_message), active = COALESCE(?, active)
    WHERE id = ?`).run(name, cron_expr, template_id, recipients ? JSON.stringify(recipients) : null, custom_message, active, req.params.id);
  scheduler.reload();
  res.json(db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id));
});

router.delete('/schedules/:id', (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  scheduler.reload();
  res.json({ success: true });
});

// ── Reminders ─────────────────────────────────────────────────────────────────
router.get('/reminders', (req, res) => {
  res.json(db.prepare('SELECT * FROM reminders ORDER BY name').all());
});

router.post('/reminders', (req, res) => {
  const { name, message, recipients, frequency, time_of_day, days_of_week } = req.body;
  if (!name || !message || !recipients || !frequency || !time_of_day) {
    return res.status(400).json({ error: 'name, message, recipients, frequency, time_of_day required' });
  }
  const r = db.prepare('INSERT INTO reminders (name, message, recipients, frequency, time_of_day, days_of_week) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, message, JSON.stringify(recipients), frequency, time_of_day, JSON.stringify(days_of_week || []));
  scheduler.reload();
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/reminders/:id', (req, res) => {
  const { name, message, recipients, frequency, time_of_day, days_of_week, active } = req.body;
  db.prepare(`UPDATE reminders SET
    name = COALESCE(?, name), message = COALESCE(?, message),
    recipients = COALESCE(?, recipients), frequency = COALESCE(?, frequency),
    time_of_day = COALESCE(?, time_of_day), days_of_week = COALESCE(?, days_of_week),
    active = COALESCE(?, active) WHERE id = ?`)
    .run(name, message, recipients ? JSON.stringify(recipients) : null, frequency, time_of_day, days_of_week ? JSON.stringify(days_of_week) : null, active, req.params.id);
  scheduler.reload();
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id));
});

router.delete('/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(req.params.id);
  scheduler.reload();
  res.json({ success: true });
});

// ── Webhook Rules ─────────────────────────────────────────────────────────────
router.get('/webhook-rules', (req, res) => {
  res.json(db.prepare('SELECT * FROM webhook_rules ORDER BY name').all());
});

router.post('/webhook-rules', (req, res) => {
  const { name, slug, recipients, template_id, custom_message } = req.body;
  if (!name || !slug || !recipients) return res.status(400).json({ error: 'name, slug, recipients required' });
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  try {
    const r = db.prepare('INSERT INTO webhook_rules (name, slug, recipients, template_id, custom_message) VALUES (?, ?, ?, ?, ?)')
      .run(name, cleanSlug, JSON.stringify(recipients), template_id || null, custom_message || '');
    res.json(db.prepare('SELECT * FROM webhook_rules WHERE id = ?').get(r.lastInsertRowid));
  } catch { res.status(400).json({ error: 'Slug already exists' }); }
});

router.put('/webhook-rules/:id', (req, res) => {
  const { name, slug, recipients, template_id, custom_message, active } = req.body;
  const cleanSlug = slug ? slug.toLowerCase().replace(/[^a-z0-9-_]/g, '-') : null;
  db.prepare(`UPDATE webhook_rules SET
    name = COALESCE(?, name), slug = COALESCE(?, slug),
    recipients = COALESCE(?, recipients), template_id = COALESCE(?, template_id),
    custom_message = COALESCE(?, custom_message), active = COALESCE(?, active)
    WHERE id = ?`)
    .run(name, cleanSlug, recipients ? JSON.stringify(recipients) : null, template_id, custom_message, active, req.params.id);
  res.json(db.prepare('SELECT * FROM webhook_rules WHERE id = ?').get(req.params.id));
});

router.delete('/webhook-rules/:id', (req, res) => {
  db.prepare('DELETE FROM webhook_rules WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Logs ──────────────────────────────────────────────────────────────────────
router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const logs = db.prepare('SELECT * FROM message_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM message_logs').get().count;
  res.json({ logs, total });
});

router.delete('/logs', (req, res) => {
  db.prepare('DELETE FROM message_logs').run();
  res.json({ success: true });
});

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  res.json(s);
});

router.put('/settings', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  }
  res.json({ success: true });
});

module.exports = router;
