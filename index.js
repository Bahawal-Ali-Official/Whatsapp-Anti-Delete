import { Boom } from '@hapi/boom';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrTerminal from 'qrcode-terminal';

const logger = pino({ level: 'silent' });
const msgRetryCounterCache = new Map();

const originalConsoleError = console.error;
console.error = (...args) => {
    const msg = args[0]?.toString() || '';
    if (msg.includes('Failed to decrypt') || msg.includes('Bad MAC') || msg.includes('session_cipher')) return;
    originalConsoleError.apply(console, args);
};

const MAX_STORE_SIZE = 2000;
const MESSAGE_TTL_MS = 2 * 60 * 60 * 1000;
const MEDIA_RETRY_ATTEMPTS = 3;
const MEDIA_RETRY_DELAY_MS = 2000;
const OWNER_JID = '923294675295@s.whatsapp.net';

function extractTextContent(message) {
    if (!message) return null;
    return message.conversation
        || message.extendedTextMessage?.text
        || message.buttonsResponseMessage?.selectedDisplayText
        || message.listResponseMessage?.title
        || message.templateButtonReplyMessage?.selectedDisplayText
        || null;
}

class MessageStore {
    constructor(maxSize, ttlMs) {
        this.store = new Map();
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }

    set(id, message) {
        if (this.store.size >= this.maxSize) {
            const oldestKey = this.store.keys().next().value;
            this.store.delete(oldestKey);
        }
        const text = extractTextContent(message.message);
        this.store.set(id, {
            originalMessage: message,
            messageData: JSON.parse(JSON.stringify(message.message || {})),
            text: text,
            timestamp: Date.now()
        });
        console.log(`[DEBUG] Cached message ID: ${id}`);
    }

    getEntry(id) {
        const entry = this.store.get(id);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.store.delete(id);
            return null;
        }
        return entry;
    }

    updateText(id, newText, newMessageData) {
        const entry = this.getEntry(id);
        if (entry) {
            entry.text = newText;
            if (newMessageData) {
                entry.messageData = JSON.parse(JSON.stringify(newMessageData));
            }
            console.log(`[DEBUG] Updated cache for ID: ${id}`);
        }
    }

    has(id) {
        return this.getEntry(id) !== null;
    }

    delete(id) {
        this.store.delete(id);
        console.log(`[DEBUG] Deleted from cache ID: ${id}`);
    }

    cleanup() {
        const now = Date.now();
        let count = 0;
        for (const [id, entry] of this.store) {
            if (now - entry.timestamp > this.ttlMs) {
                this.store.delete(id);
                count++;
            }
        }
        if (count > 0) console.log(`[DEBUG] Cleaned up ${count} expired messages from cache`);
    }
}

const messageStore = new MessageStore(MAX_STORE_SIZE, MESSAGE_TTL_MS);
setInterval(() => messageStore.cleanup(), 15 * 60 * 1000);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadMediaWithRetry(msg, attempts) {
    for (let i = 0; i < attempts; i++) {
        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            if (buffer && buffer.length > 0) return buffer;
        } catch (e) {
            console.log(`[DEBUG] Media download attempt ${i + 1} failed: ${e.message}`);
            if (i < attempts - 1) await sleep(MEDIA_RETRY_DELAY_MS);
        }
    }
    return null;
}

function buildMediaMessage(msgContent, buffer) {
    if (!msgContent || !buffer) return null;

    if (msgContent.imageMessage) return { image: buffer, caption: "Deleted Image" };
    if (msgContent.videoMessage) return { video: buffer, caption: "Deleted Video" };
    if (msgContent.audioMessage) return { audio: buffer, mimetype: msgContent.audioMessage.mimetype || 'audio/mp4', ptt: msgContent.audioMessage.ptt || false };
    if (msgContent.stickerMessage) return { sticker: buffer };
    if (msgContent.documentMessage) return { document: buffer, mimetype: msgContent.documentMessage.mimetype, fileName: msgContent.documentMessage.fileName || "Deleted Document" };

    const viewOnce = msgContent.viewOnceMessage?.message || msgContent.viewOnceMessageV2?.message || msgContent.viewOnceMessageV2Extension?.message;
    if (viewOnce) {
        if (viewOnce.imageMessage) return { image: buffer, caption: "Deleted ViewOnce Image" };
        if (viewOnce.videoMessage) return { video: buffer, caption: "Deleted ViewOnce Video" };
        if (viewOnce.audioMessage) return { audio: buffer, mimetype: viewOnce.audioMessage.mimetype || 'audio/mp4' };
    }

    return null;
}

async function getGroupName(sock, jid) {
    try {
        const meta = await sock.groupMetadata(jid);
        return `Group "${meta.subject}"`;
    } catch (e) {
        return "Unknown Group";
    }
}

async function handleDeleted(sock, deletedMsg) {
    console.log(`[DEBUG] Executing handleDeleted for ID: ${deletedMsg.key.id}`);
    try {
        const remoteJid = deletedMsg.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const senderName = deletedMsg.pushName || 'Unknown User';
        const location = isGroup ? await getGroupName(sock, remoteJid) : 'Personal Chat';
        const textContent = extractTextContent(deletedMsg.message);
        const displayContent = textContent || "_(Media or Non-text message)_";
        const timeStr = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });

        const notification =
            `*🗑️ Message Deleted 🗑️*\n\n` +
            `*👤 User:* ${senderName}\n` +
            `*📍 Location:* ${location}\n` +
            `*⏰ Time:* ${timeStr}\n` +
            `*📜 Deleted Message:*\n${displayContent}`;

        await sock.sendMessage(OWNER_JID, { text: notification });

        const buffer = await downloadMediaWithRetry(deletedMsg, MEDIA_RETRY_ATTEMPTS);
        if (buffer) {
            const mediaMsg = buildMediaMessage(deletedMsg.message, buffer);
            if (mediaMsg) await sock.sendMessage(OWNER_JID, mediaMsg);
        }
    } catch (e) {
        console.error(`[ERROR] in handleDeleted: ${e.message}`);
    }
}

async function handleEdited(sock, eventMsg, origContent, newText) {
    console.log(`[DEBUG] Executing handleEdited for ID: ${eventMsg.key.id}`);
    try {
        const remoteJid = eventMsg.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const senderName = eventMsg.pushName || 'Unknown User';
        const location = isGroup ? await getGroupName(sock, remoteJid) : 'Personal Chat';
        const originalDisplay = origContent || "_(Original message not found in cache)_";
        const timeStr = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });

        const notification =
            `*✏️ Message Edited ✏️*\n\n` +
            `*👤 User:* ${senderName}\n` +
            `*📍 Location:* ${location}\n` +
            `*⏰ Time:* ${timeStr}\n\n` +
            `*--- Original Message ---*\n${originalDisplay}\n\n` +
            `*--- Edited Message ---*\n${newText}`;

        await sock.sendMessage(OWNER_JID, { text: notification });
    } catch (e) {
        console.error(`[ERROR] in handleEdited: ${e.message}`);
    }
}

async function handleDotCommand(sock, message) {
    const quotedCtx = message.message.extendedTextMessage?.contextInfo;
    if (!quotedCtx?.quotedMessage) return false;

    const textContent = message.message.extendedTextMessage?.text;
    if (textContent !== '.') return false;

    console.log(`[DEBUG] Executing dot command`);
    try {
        const quotedMsg = quotedCtx.quotedMessage;
        const stanzaId = quotedCtx.stanzaId;
        const participant = quotedCtx.participant;
        const msgType = getContentType(quotedMsg);
        let finalMsg = null;

        const reconstructedMsg = {
            key: {
                remoteJid: message.key.remoteJid,
                id: stanzaId,
                fromMe: false,
                participant: participant
            },
            message: quotedMsg
        };

        if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2' || msgType === 'viewOnceMessageV2Extension') {
            const viewOnceContent = quotedMsg[msgType]?.message;
            if (viewOnceContent) {
                const innerType = getContentType(viewOnceContent);
                const buffer = await downloadMediaWithRetry(reconstructedMsg, MEDIA_RETRY_ATTEMPTS);
                if (buffer) {
                    if (innerType === 'imageMessage') finalMsg = { image: buffer, caption: "Saved ViewOnce Image via (.)" };
                    else if (innerType === 'videoMessage') finalMsg = { video: buffer, caption: "Saved ViewOnce Video via (.)" };
                    else if (innerType === 'audioMessage') finalMsg = { audio: buffer, mimetype: 'audio/mp4' };
                }
            }
        } else {
            const buffer = await downloadMediaWithRetry(reconstructedMsg, MEDIA_RETRY_ATTEMPTS);
            if (buffer) {
                if (msgType === 'imageMessage') finalMsg = { image: buffer, caption: "Saved Image via (.)" };
                else if (msgType === 'videoMessage') finalMsg = { video: buffer, caption: "Saved Video via (.)" };
                else if (msgType === 'audioMessage') finalMsg = { audio: buffer, mimetype: 'audio/mp4' };
                else if (msgType === 'stickerMessage') finalMsg = { sticker: buffer };
                else if (msgType === 'documentMessage') finalMsg = { document: buffer, mimetype: quotedMsg.documentMessage.mimetype, fileName: quotedMsg.documentMessage.fileName || "Saved Doc" };
            }
            if (!finalMsg) {
                const txt = extractTextContent(quotedMsg);
                if (txt) finalMsg = { text: `*Saved Text via (.):*\n\n${txt}` };
            }
        }

        if (finalMsg) await sock.sendMessage(OWNER_JID, finalMsg);
    } catch (e) {
        console.error(`[ERROR] in dot command: ${e.message}`);
    }

    return true;
}

async function handleViewOnce(sock, message, type) {
    console.log(`[DEBUG] Executing ViewOnce detector for ID: ${message.key.id}`);
    try {
        const senderName = message.pushName || 'Unknown User';
        const remoteJid = message.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const location = isGroup ? await getGroupName(sock, remoteJid) : 'Personal Chat';
        const viewOnceContent = message.message[type]?.message;
        if (!viewOnceContent) return;

        const innerType = getContentType(viewOnceContent);
        const buffer = await downloadMediaWithRetry(message, MEDIA_RETRY_ATTEMPTS);
        if (!buffer) return;

        const timeStr = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
        const caption = `*🔒 ViewOnce Detected*\nFrom: ${senderName}\nLocation: ${location}\nTime: ${timeStr}`;

        if (innerType === 'imageMessage') {
            await sock.sendMessage(OWNER_JID, { image: buffer, caption });
        } else if (innerType === 'videoMessage') {
            await sock.sendMessage(OWNER_JID, { video: buffer, caption });
        } else if (innerType === 'audioMessage') {
            await sock.sendMessage(OWNER_JID, { audio: buffer, mimetype: 'audio/mp4' });
            await sock.sendMessage(OWNER_JID, { text: caption });
        }
    } catch (e) {
        console.error(`[ERROR] handling ViewOnce: ${e.message}`);
    }
}

async function processMessage(sock, msg) {
    if (!msg.message || msg.key.fromMe) return;

    const type = getContentType(msg.message);
    console.log(`[DEBUG] New message upsert received | ID: ${msg.key.id} | Type: ${type}`);

    const proto = msg.message.protocolMessage;
    if (proto) {
        console.log(`[DEBUG] ProtocolMessage detected | Inner Type: ${proto.type}`);
        
        if (proto.type === 0 || proto.type === 'REVOKE') {
            const deletedId = proto.key?.id;
            console.log(`[DEBUG] REVOKE detected for ID: ${deletedId}`);
            if (deletedId) {
                const entry = messageStore.getEntry(deletedId);
                if (entry && entry.originalMessage) {
                    messageStore.delete(deletedId);
                    await handleDeleted(sock, entry.originalMessage);
                } else {
                    console.log(`[DEBUG] REVOKE failed: Original message not found in cache for ID: ${deletedId}`);
                }
            }
            return;
        }

        if (proto.editedMessage) {
            const origId = proto.key?.id;
            if (!origId) return;

            const origEntry = messageStore.getEntry(origId);
            const newText = proto.editedMessage.conversation || extractTextContent(proto.editedMessage);
            
            if (newText) {
                const origText = origEntry ? origEntry.text : null;
                console.log(`[DEBUG] Edit detected via ProtocolMessage for ID: ${origId}`);
                await handleEdited(sock, msg, origText, newText);
                messageStore.updateText(origId, newText, proto.editedMessage);
            }
            return;
        }
    }

    if (type === 'editedMessage') {
        const editProto = msg.message.editedMessage?.message?.protocolMessage;
        if (!editProto) return;

        const origId = editProto.key?.id;
        const newText = editProto.editedMessage?.conversation || editProto.editedMessage?.extendedTextMessage?.text;

        if (origId && newText) {
            const origEntry = messageStore.getEntry(origId);
            const origText = origEntry ? origEntry.text : null;
            console.log(`[DEBUG] Edit detected via top-level editedMessage for ID: ${origId}`);
            await handleEdited(sock, msg, origText, newText);
            messageStore.updateText(origId, newText, editProto.editedMessage);
        }
        return;
    }

    if (await handleDotCommand(sock, msg)) return;

    if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2' || type === 'viewOnceMessageV2Extension') {
        await handleViewOnce(sock, msg, type);
    }

    const id = msg.key.id;
    if (!messageStore.has(id)) {
        messageStore.set(id, msg);
    }
}

let reconnectDelay = 2000;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        msgRetryCounterCache,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        shouldIgnoreJid: jid => typeof jid === 'string' && jid.includes('@broadcast'),
        getMessage: async (key) => {
            const entry = messageStore.getEntry(key.id);
            if (entry) return entry.messageData;
            return undefined;
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- Scan this QR Code in WhatsApp ---\n');
            qrTerminal.generate(qr, { small: true });
            console.log('\n--- Waiting for scan... ---\n');
        }

        if (connection === 'open') {
            reconnectDelay = 2000;
            console.log('Bot is online ✅');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output?.statusCode
                : null;

            console.log(`[DEBUG] Connection closed. StatusCode: ${statusCode}`);

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
                setTimeout(() => startBot(), reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, 30000);
            } else {
                console.log('Logged out. Delete auth_info_baileys folder and restart.');
                process.exit(1);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        const tasks = m.messages.map(async (msg) => {
            try {
                await processMessage(sock, msg);
            } catch (e) {
                console.error(`[ERROR] processing message in upsert: ${e.message}`);
            }
        });
        
        await Promise.allSettled(tasks);
    });

    sock.ev.on('messages.update', async (updates) => {
        const tasks = updates.map(async ({ key, update }) => {
            try {
                if (update.message === null) {
                    console.log(`[DEBUG] messages.update received null message (deletion) for ID: ${key.id}`);
                    const entry = messageStore.getEntry(key.id);
                    if (entry && entry.originalMessage) {
                        messageStore.delete(key.id);
                        await handleDeleted(sock, entry.originalMessage);
                    } else {
                        console.log(`[DEBUG] Deletion missed: Message ID ${key.id} not in cache`);
                    }
                } else if (update.message) {
                    console.log(`[DEBUG] messages.update received modified message for ID: ${key.id}`);
                    const entry = messageStore.getEntry(key.id);
                    if (entry) {
                        const originalText = entry.text;
                        const newText = extractTextContent(update.message);
                        
                        if (newText && originalText && originalText !== newText) {
                            console.log(`[DEBUG] Edit detected via messages.update for ID: ${key.id}`);
                            await handleEdited(sock, entry.originalMessage, originalText, newText);
                            messageStore.updateText(key.id, newText, update.message);
                        }
                    }
                }
            } catch (e) {
                console.error(`[ERROR] processing message update: ${e.message}`);
            }
        });

        await Promise.allSettled(tasks);
    });

    return sock;
}

process.on('unhandledRejection', err => console.error('[ERROR] Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('[ERROR] Uncaught exception:', err));

startBot().catch(err => {
    console.error(`[FATAL ERROR] ${err.message}`);
    process.exit(1);
});
