const cron = require('node-cron');
const db = require('./db');
const wa = require('./whatsapp');

const activeTasks = new Map();

function applyTemplate(template, vars = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function logMessage(recipient, message, source, status, error = null) {
  db.prepare(`
    INSERT INTO message_logs (recipient, message, source, status, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(recipient, message, source, status, error);
}

async function runSchedule(schedule) {
  let message = schedule.custom_message || '';
  if (!message && schedule.template_id) {
    const tpl = db.prepare('SELECT body FROM templates WHERE id = ?').get(schedule.template_id);
    if (tpl) message = applyTemplate(tpl.body, { time: new Date().toLocaleTimeString(), date: new Date().toLocaleDateString(), name: schedule.name });
  }
  if (!message) return;

  const recipients = JSON.parse(schedule.recipients || '[]');
  const results = await wa.sendToRecipients(recipients, message);

  for (const r of results) {
    logMessage(r.recipient, message, `schedule:${schedule.name}`, r.status, r.error);
  }

  db.prepare('UPDATE schedules SET last_run = CURRENT_TIMESTAMP WHERE id = ?').run(schedule.id);
}

async function runReminder(reminder) {
  const recipients = JSON.parse(reminder.recipients || '[]');
  const results = await wa.sendToRecipients(recipients, reminder.message);

  for (const r of results) {
    logMessage(r.recipient, reminder.message, `reminder:${reminder.name}`, r.status, r.error);
  }

  db.prepare('UPDATE reminders SET last_sent = CURRENT_TIMESTAMP WHERE id = ?').run(reminder.id);
}

function reminderToCron(reminder) {
  const [hour, minute] = reminder.time_of_day.split(':');
  const freq = reminder.frequency;

  if (freq === 'daily') return `${minute} ${hour} * * *`;
  if (freq === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (freq === 'weekends') return `${minute} ${hour} * * 0,6`;
  if (freq === 'weekly') {
    const days = JSON.parse(reminder.days_of_week || '[1]').join(',');
    return `${minute} ${hour} * * ${days}`;
  }
  if (freq === 'hourly') return `0 * * * *`;
  return `${minute} ${hour} * * *`;
}

function loadAll() {
  // Clear existing
  for (const [, task] of activeTasks) task.stop();
  activeTasks.clear();

  // Load schedules
  const schedules = db.prepare('SELECT * FROM schedules WHERE active = 1').all();
  for (const s of schedules) {
    if (!cron.validate(s.cron_expr)) continue;
    const task = cron.schedule(s.cron_expr, () => runSchedule(s), { scheduled: true });
    activeTasks.set(`schedule_${s.id}`, task);
    console.log(`[CRON] Loaded schedule: ${s.name} (${s.cron_expr})`);
  }

  // Load reminders
  const reminders = db.prepare('SELECT * FROM reminders WHERE active = 1').all();
  for (const r of reminders) {
    const expr = reminderToCron(r);
    if (!cron.validate(expr)) continue;
    const task = cron.schedule(expr, () => runReminder(r), { scheduled: true });
    activeTasks.set(`reminder_${r.id}`, task);
    console.log(`[CRON] Loaded reminder: ${r.name} (${expr})`);
  }
}

function reload() {
  loadAll();
}

module.exports = { loadAll, reload, applyTemplate, logMessage };
