const express = require('express');
const path = require('path');
const wa = require('./whatsapp');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ strict: false }));
app.use(express.urlencoded({ extended: true }));
// Catch Jellyfin sending text/plain or unknown content-type
app.use((req, res, next) => {
  if (req.is('text/*') || (!req.headers['content-type'] && req.method === 'POST')) {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { req.body = JSON.parse(data); } catch { req.body = { raw: data }; }
      next();
    });
  } else next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', require('./routes/api'));
app.use('/webhook', require('./routes/webhook'));
app.use('/jellyfin', require('./routes/jellyfin'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  console.log('[App] Starting WhatsApp Notifier...');
  await wa.connect();
  scheduler.loadAll();
  app.listen(PORT, () => {
    console.log(`[App] Web UI available at http://localhost:${PORT}`);
  });
}

main().catch(console.error);
