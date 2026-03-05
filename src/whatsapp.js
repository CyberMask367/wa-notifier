const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = process.env.SESSION_DIR || '/data/session';
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

let sock = null;
let connectionStatus = 'disconnected';
let qrDataUrl = null;
let reconnectTimer = null;

const logger = pino({ level: 'silent' });

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger,
    browser: ['WhatsApp Notifier', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      connectionStatus = 'qr';
      qrDataUrl = await QRCode.toDataURL(qr);
      console.log('[WA] QR code ready - open the web UI to scan');
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrDataUrl = null;
      console.log('[WA] Connected!');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      connectionStatus = loggedOut ? 'logged_out' : 'disconnected';
      qrDataUrl = null;
      sock = null;

      if (loggedOut) {
        console.log('[WA] Logged out. Please re-authenticate via the web UI.');
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(SESSION_DIR, { recursive: true });
      } else {
        console.log(`[WA] Connection closed (code ${code}), reconnecting in 5s...`);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5000);
      }
    }
  });

  return sock;
}

// Detect MIME type from file extension
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
    '.txt': 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

function getMediaType(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

// Send a single message (text, image, video, audio, or document)
// opts: { text, filePath, fileName, caption, url }
async function sendMessage(to, opts) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp not connected');
  }

  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

  // Plain text
  if (typeof opts === 'string') {
    await sock.sendMessage(jid, { text: opts });
    return;
  }

  // File from disk path
  if (opts.filePath) {
    const mime = getMimeType(opts.fileName || opts.filePath);
    const mediaType = getMediaType(mime);
    const data = fs.readFileSync(opts.filePath);

    if (mediaType === 'image') {
      await sock.sendMessage(jid, { image: data, caption: opts.caption || '', mimetype: mime });
    } else if (mediaType === 'video') {
      await sock.sendMessage(jid, { video: data, caption: opts.caption || '', mimetype: mime });
    } else if (mediaType === 'audio') {
      await sock.sendMessage(jid, { audio: data, mimetype: mime, ptt: false });
    } else {
      await sock.sendMessage(jid, {
        document: data,
        mimetype: mime,
        fileName: opts.fileName || path.basename(opts.filePath),
        caption: opts.caption || '',
      });
    }
    return;
  }

  // File from URL
  if (opts.url) {
    const mime = getMimeType(opts.fileName || opts.url);
    const mediaType = getMediaType(mime);

    if (mediaType === 'image') {
      await sock.sendMessage(jid, { image: { url: opts.url }, caption: opts.caption || '' });
    } else if (mediaType === 'video') {
      await sock.sendMessage(jid, { video: { url: opts.url }, caption: opts.caption || '' });
    } else if (mediaType === 'audio') {
      await sock.sendMessage(jid, { audio: { url: opts.url }, mimetype: mime });
    } else {
      await sock.sendMessage(jid, {
        document: { url: opts.url },
        mimetype: mime,
        fileName: opts.fileName || path.basename(opts.url),
        caption: opts.caption || '',
      });
    }
    return;
  }

  // Plain text fallback
  if (opts.text) {
    await sock.sendMessage(jid, { text: opts.text });
  }
}

async function sendToRecipients(recipients, opts) {
  const results = [];
  for (const r of recipients) {
    try {
      await sendMessage(r, opts);
      results.push({ recipient: r, status: 'sent' });
    } catch (err) {
      results.push({ recipient: r, status: 'failed', error: err.message });
    }
  }
  return results;
}

function getStatus() { return connectionStatus; }
function getQR() { return qrDataUrl; }

function logout() {
  if (sock) { sock.logout().catch(() => {}); sock = null; }
  connectionStatus = 'disconnected';
  qrDataUrl = null;
}

module.exports = { connect, sendMessage, sendToRecipients, getStatus, getQR, logout };
