const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'notifier.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    number TEXT NOT NULL UNIQUE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    jid TEXT NOT NULL UNIQUE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    template_id INTEGER,
    recipients TEXT NOT NULL,
    custom_message TEXT,
    active INTEGER DEFAULT 1,
    last_run DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    recipients TEXT NOT NULL,
    frequency TEXT NOT NULL,
    time_of_day TEXT NOT NULL,
    days_of_week TEXT,
    active INTEGER DEFAULT 1,
    last_sent DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webhook_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    recipients TEXT NOT NULL,
    template_id INTEGER,
    custom_message TEXT,
    active INTEGER DEFAULT 1,
    last_triggered DATETIME,
    trigger_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS jellyfin_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    recipients TEXT NOT NULL,
    template_id INTEGER,
    custom_message TEXT,
    active INTEGER DEFAULT 1,
    last_triggered DATETIME,
    trigger_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS message_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const defaults = {
  api_key: 'change-me-' + Math.random().toString(36).slice(2),
};
for (const [key, value] of Object.entries(defaults)) {
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

module.exports = db;

// Migrations
try { db.exec('ALTER TABLE webhook_rules ADD COLUMN conditions TEXT DEFAULT "[]"'); } catch {}
try { db.exec('ALTER TABLE jellyfin_rules ADD COLUMN conditions TEXT DEFAULT "[]"'); } catch {}
