const express = require('express');
const path = require('path');
const wa = require('./whatsapp');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', require('./routes/api'));
app.use('/webhook', require('./routes/webhook'));

// Catch-all for SPA
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
