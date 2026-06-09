require('dotenv').config();
const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    delay,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    initAuthCreds,
    BufferJSON,
    proto,
} = require('@whiskeysockets/baileys');
const { PrismaClient } = require('@prisma/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

// ---- HARDCODED CONFIGURATION -------------------------------------------------------
const DATABASE_URL = 'postgresql://postgres.vcbhlgkrdpapygzdjpmu:P4y-wLJUyXGwrLy@aws-0-eu-west-3.pooler.supabase.com:5432/postgres?sslmode=require';
const GEMINI_API_KEY = 'AIzaSyAespp0kFP6KvT3d0Z9E0lrtjOxzjht_H4';
const GATEWAY_AUTH_TOKEN = 'gw_token_Kenya_2025_secure_xyz789';
const PERSONAL_NUMBER = '254746973459'; // Kenya format: +254 746973459

// Override process.env for Prisma
process.env.DATABASE_URL = DATABASE_URL;

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const app = express();
app.use(express.json({ limit: '1mb' }));

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

let sock;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;

console.log('[CONFIG] WhatsApp Gateway initialized with hardcoded credentials');
console.log(`[CONFIG] Personal Number: ${PERSONAL_NUMBER}`);
console.log(`[CONFIG] Database: Connected to Supabase pooler`);
console.log(`[CONFIG] AI Engine: Gemini 1.5 Flash`);

// ---- Prisma-backed Baileys auth state -------------------------------------
async function usePrismaAuthState() {
    const readData = async (id) => {
        try {
            const res = await prisma.session.findUnique({ where: { id } });
            return res ? JSON.parse(res.data, BufferJSON.reviver) : null;
        } catch (err) {
            console.error(`[AUTH DB READ ERROR] id=${id}`, err);
            return null;
        }
    };

    const writeData = async (id, data) => {
        try {
            const str = JSON.stringify(data, BufferJSON.replacer);
            await prisma.session.upsert({
                where: { id },
                update: { data: str },
                create: { id, data: str },
            });
        } catch (err) {
            console.error(`[AUTH DB WRITE ERROR] id=${id}`, err);
        }
    };

    const removeData = async (id) => {
        try {
            await prisma.session.delete({ where: { id } });
        } catch (_) { /* ignore missing */ }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore({
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const key = `${type}-${id}`;
                            tasks.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            }, logger),
        },
        saveCreds: () => writeData('creds', creds),
        clearAll: async () => {
            try { await prisma.session.deleteMany({}); }
            catch (err) { console.error('[AUTH CLEAR ERROR]', err); }
        },
    };
}

// ---- WhatsApp connection engine ------------------------------------------
async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    try {
        const { state, saveCreds, clearAll } = await usePrismaAuthState();
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: state,
            logger,
            browser: ['Linux', 'Chrome', '120.0.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(PERSONAL_NUMBER);
                    console.log(`\x1b[32m[GATEWAY]\x1b[0m Pairing Code: ${code}`);
                } catch (err) {
                    console.error('[GATEWAY] Failed to generate pairing code. Check PERSONAL_NUMBER format.', err);
                }
            }, 6000);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                reconnectAttempts = 0;
                console.log('[GATEWAY] WhatsApp connection established.');
                return;
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode
                    : undefined;
                const loggedOut = statusCode === DisconnectReason.loggedOut;

                console.log(`[GATEWAY] Connection closed. status=${statusCode} reason=${lastDisconnect?.error?.message}`);

                if (loggedOut) {
                    console.warn('[GATEWAY] Session logged out — clearing stored credentials.');
                    await clearAll();
                }

                isConnecting = false;
                const backoff = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** reconnectAttempts);
                reconnectAttempts += 1;
                console.log(`[GATEWAY] Reconnecting in ${backoff}ms (attempt ${reconnectAttempts})`);
                setTimeout(connectToWhatsApp, backoff);
            }
        });

        sock.ev.on('messages.upsert', handleIncomingMessage);
    } catch (err) {
        console.error('[GATEWAY] Failed to initialize socket:', err);
        isConnecting = false;
        const backoff = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** reconnectAttempts);
        reconnectAttempts += 1;
        setTimeout(connectToWhatsApp, backoff);
        return;
    }

    isConnecting = false;
}

async function handleIncomingMessage({ messages, type }) {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;
    if (msg.key.remoteJid.includes('@g.us') || msg.key.remoteJid === 'status@broadcast') return;

    const remoteJid = msg.key.remoteJid;
    const phoneNumber = remoteJid.split('@')[0];
    const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || msg.message.videoMessage?.caption;
    if (!text) return;

    const lastChat = await prisma.supportChat.findFirst({
        where: { phone_number: phoneNumber },
        orderBy: { timestamp: 'desc' },
    });
    const currentStatus = lastChat ? lastChat.status : 'BOT_HANDLED';

    await prisma.supportChat.create({
        data: { phone_number: phoneNumber, message_body: text, sender: 'USER', status: currentStatus },
    });

    if (currentStatus === 'HUMAN_REQUIRED') {
        console.log(`[GATEWAY] Human takeover active for ${phoneNumber} — bot bypassed.`);
        return;
    }

    try {
        await sock.sendPresenceUpdate('composing', remoteJid);
        await delay(2000 + Math.floor(Math.random() * 2000));
        await sock.sendPresenceUpdate('paused', remoteJid);
    } catch (err) {
        console.error('[PRESENCE ERROR]', err);
    }

    const systemPrompt = `You are the official AI Support Agent for our secure financial investment platform. Be polite, professional, and concise. We offer investment packages scaling from hours...`;

    try {
        const model = genAI.getGenerativeModel({
            model: 'gemini-1.5-flash',
            systemInstruction: systemPrompt,
        });
        const result = await model.generateContent(text);
        const aiResponse = result.response.text();

        await sock.sendMessage(remoteJid, { text: aiResponse });
        await prisma.supportChat.create({
            data: { phone_number: phoneNumber, message_body: aiResponse, sender: 'AI', status: 'BOT_HANDLED' },
        });
    } catch (err) {
        console.error('[AI PROCESSING ERROR]', err);
        try {
            await sock.sendMessage(remoteJid, {
                text: 'Sorry, our assistant is temporarily unavailable. A human agent will follow up shortly.',
            });
        } catch (_) { /* ignore */ }
    }
}

// ---- HTTP API -------------------------------------------------------------
function requireAuth(req, res, next) {
    const token = req.headers['x-gateway-auth'];
    if (!token || token !== GATEWAY_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: invalid or missing X-Gateway-Auth token' });
    }
    next();
}

app.post('/api/send-message', requireAuth, async (req, res) => {
    const { phoneNumber, message } = req.body || {};
    if (!phoneNumber || !message) {
        return res.status(400).json({ error: 'phoneNumber and message are required' });
    }
    if (!sock || !sock.user) {
        return res.status(503).json({ error: 'WhatsApp gateway not ready yet' });
    }

    try {
        const cleanNumber = String(phoneNumber).replace(/\D/g, '');
        if (!cleanNumber) return res.status(400).json({ error: 'Invalid phoneNumber' });
        const jid = `${cleanNumber}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(message) });
        res.json({ success: true });
    } catch (error) {
        console.error('[SEND ERROR]', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

app.post('/api/chats/:phone/status', requireAuth, async (req, res) => {
    const { phone } = req.params;
    const { status } = req.body || {};
    const allowed = ['BOT_HANDLED', 'HUMAN_REQUIRED', 'RESOLVED'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    try {
        await prisma.supportChat.create({
            data: { phone_number: phone, message_body: `[status change → ${status}]`, sender: 'ADMIN', status },
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[STATUS ERROR]', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        whatsapp: sock?.user ? 'connected' : 'disconnected',
        uptime: process.uptime(),
    });
});

// ---- Boot & graceful shutdown --------------------------------------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`[SERVER] Gateway API listening on :${PORT}`);
    connectToWhatsApp();
});

async function shutdown(signal) {
    console.log(`[SERVER] Received ${signal}, shutting down...`);
    server.close(() => console.log('[SERVER] HTTP closed.'));
    try { await prisma.$disconnect(); } catch (_) {}
    try { sock?.end(undefined); } catch (_) {}
    setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
