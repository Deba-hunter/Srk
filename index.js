const express = require('express');
const fs = require('fs');
const path = require('path');
const formidable = require('formidable');
const qrcode = require('qrcode');
const moment = require('moment-timezone');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const sessionFolder = path.join(__dirname, 'session');

if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder);

app.use(express.json());
app.use(express.static('public'));

let globalSocket = null;
let qrData = null;
let isReady = false;
let isLooping = false;
let currentLoop = null;
let messageLogs = [];
let lastMessages = {
  receivers: [],
  lines: [],
  delaySec: 2
};

let sendMessages = async () => {};

async function startSocket() {
  if (globalSocket) return;

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Aadi Server', 'Chrome', '1.0'],
    getMessage: async () => ({ conversation: "hello" })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      qrData = qr;
      isReady = false;
    }

    if (connection === 'open') {
      isReady = true;
      qrData = null;
      console.log('✅ WhatsApp Connected!');
      if (isLooping && currentLoop === null) {
        console.log('🔁 Reconnected — restarting message loop...');
        currentLoop = sendMessages();
      }
    }

    if (connection === 'close') {
      isReady = false;
      qrData = null;
      globalSocket = null;

      const reasonCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('⚠️ Disconnected. Code:', reasonCode);

      if (reasonCode !== DisconnectReason.loggedOut) {
        console.log('🔁 Attempting reconnect...');
        setTimeout(startSocket, 3000);
      } else {
        console.log('🔒 Logged out. Resetting session...');
        try {
          fs.rmSync(sessionFolder, { recursive: true, force: true });
          fs.mkdirSync(sessionFolder);
        } catch (err) {
          console.error('❌ Session reset failed:', err);
        }
        setTimeout(startSocket, 2000);
      }
    }
  });

  globalSocket = sock;
}

startSocket();

// ✅ Get QR API
app.get('/api/qr', async (req, res) => {
  if (isReady) return res.json({ message: '✅ Already authenticated!' });
  if (!qrData) return res.json({ message: '⏳ QR not ready yet.' });
  const qrImage = await qrcode.toDataURL(qrData);
  res.json({ qr: qrImage });
});

// ✅ Start Message Loop
app.post('/api/start', (req, res) => {
  if (isLooping) {
    return res.status(400).json({ error: '⚠️ Already running. Stop first.' });
  }

  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: 'Form error' });

    const name = (fields.name || '').toString().trim();
    const delaySec = parseInt(fields.delay) || 2;
    const rawReceivers = (fields.receiver || '').toString().trim();

    if (!rawReceivers) return res.status(400).json({ error: '❌ Receivers required' });
    if (!files.file) return res.status(400).json({ error: '❌ Message file required' });

    const receivers = rawReceivers
      .split(',')
      .map(r => r.trim())
      .filter(r => /^\d{10,15}$/.test(r) || r.endsWith('@g.us'))
      .map(r => r.endsWith('@g.us') ? r : r + '@s.whatsapp.net');

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    const filePath = file.filepath || file.path;
    const lines = fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map(line => `${name} ${line.replace(/{name}/gi, '')}`.trim())
      .filter(Boolean);

    if (receivers.length === 0 || lines.length === 0) {
      return res.status(400).json({ error: '❌ No valid receivers or messages.' });
    }

    const sock = globalSocket;
    if (!sock || !isReady) return res.status(400).json({ error: '❌ WhatsApp not connected' });

    messageLogs = [];
    isLooping = true;
    lastMessages = { receivers, lines, delaySec };

    sendMessages = async () => {
      try {
        while (isLooping) {
          for (const line of lastMessages.lines) {
            for (const jid of lastMessages.receivers) {
              if (!isLooping) break;
              try {
                await globalSocket.sendMessage(jid, { text: line });
                const time = moment().tz("Asia/Kolkata").format("hh:mm:ss A");
                messageLogs.push(`[${time}] ✅ Sent to ${jid}: ${line}`);
              } catch (err) {
                const time = moment().tz("Asia/Kolkata").format("hh:mm:ss A");
                messageLogs.push(`[${time}] ❌ Failed to ${jid}: ${line}`);
              }
              await new Promise(resolve => setTimeout(resolve, lastMessages.delaySec * 1000));
            }
          }
        }
      } catch (e) {
        const time = moment().tz("Asia/Kolkata").format("hh:mm:ss A");
        messageLogs.push(`[${time}] 💥 Loop crashed: ${e.message}`);
        isLooping = false;
        currentLoop = null;
      }
    };

    currentLoop = sendMessages();
    res.json({ message: `✅ Started sending to ${receivers.length} receiver(s)` });
  });
});

// ✅ Stop Loop
app.post('/api/stop', (req, res) => {
  isLooping = false;
  currentLoop = null;
  const time = moment().tz("Asia/Kolkata").format("hh:mm:ss A");
  messageLogs.push(`[${time}] 🛑 Stopped by user`);
  setTimeout(() => { messageLogs = []; }, 2000);
  res.json({ message: '🛑 Stopped' });
});

// ✅ Logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: messageLogs });
});

// ✅ Status
app.get('/api/status', (req, res) => {
  res.json({
    isConnected: isReady,
    isLooping,
    logCount: messageLogs.length
  });
});

// ✅ Clear logs
app.post('/api/clear-logs', (req, res) => {
  messageLogs = [];
  res.json({ message: '🧹 Logs cleared' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
