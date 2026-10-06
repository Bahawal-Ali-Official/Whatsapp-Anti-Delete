import { Boom } from '@hapi/boom';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    getContentType
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrTerminal from 'qrcode-terminal';

const logger = pino({ level: 'silent' });

const MAX_STORE_SIZE = 5000;
const MESSAGE_TTL_MS = 2 * 60 * 60 * 1000;
const MEDIA_RETRY_ATTEMPTS = 3;
const MEDIA_RETRY_DELAY_MS = 2000;
const OWNER_JID = '923294675295@s.whatsapp.net';

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
        this.store.set(id, { message, timestamp: Date.now() });
    }

    get(id) {
        const entry = this.store.get(id);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.store.delete(id);
            return null;
        }
        return entry.message;
    }

    has(id) {
        return this.get(id) !== null;
    }

    delete(id) {
        this.store.delete(id);
    }

    cleanup() {
        const now = Date.now();
        for (const [id, entry] of this.store) {
            if (now - entry.timestamp > this.ttlMs) {
                this.store.delete(id);
            }
        }
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
            if (i < attempts - 1) await sleep(MEDIA_RETRY_DELAY_MS);
        }
    }
    return null;
}

function extractTextContent(message) {
    if (!message) return null;
    return message.conversation
        || message.extendedTextMessage?.text
        || message.buttonsResponseMessage?.selectedDisplayText
        || message.listResponseMessage?.title
        || message.templateButtonReplyMessage?.selectedDisplayText
        || null;
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

async function processSingleDeletedMessage(sock, deletedMsg) {
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
        console.error(`Failed to process deleted message: ${e.message}`);
    }
}

async function processSingleEditedMessage(sock, editEventMessage, originalContent, newText) {
    try {
        const remoteJid = editEventMessage.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const senderName = editEventMessage.pushName || 'Unknown User';
        const location = isGroup ? await getGroupName(sock, remoteJid) : 'Personal Chat';
        const originalDisplay = originalContent || "_(Original message not found in bot's memory)_";
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
        console.error(`Failed to process edited message: ${e.message}`);
    }
}

async function handleDotCommand(sock, message) {
    const quotedCtx = message.message.extendedTextMessage?.contextInfo;
    if (!quotedCtx?.quotedMessage) return false;

    const textContent = message.message.extendedTextMessage?.text;
    if (textContent !== '.') return false;

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
        console.error(`Error in dot command: ${e.message}`);
    }

    return true;
}

async function handleViewOnce(sock, message, type) {
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
        console.error(`Error handling ViewOnce: ${e.message}`);
    }
}

function handleEditedMessage(sock, message) {
    const proto = message.message?.protocolMessage;
    if (!proto?.editedMessage) return false;

    const originalMsgId = proto.key?.id;
    if (!originalMsgId) return false;

    const originalMsg = messageStore.get(originalMsgId);
    const newText = extractTextContent(proto.editedMessage) || proto.editedMessage?.conversation;

    if (newText) {
        const originalContent = originalMsg ? extractTextContent(originalMsg.message) : null;
        processSingleEditedMessage(sock, message, originalContent, newText);

        if (originalMsg) {
            if (!originalMsg.message) originalMsg.message = {};
            originalMsg.message.conversation = newText;
            messageStore.set(originalMsgId, originalMsg);
        }
    }

    return true;
}

async function processMessage(sock, message) {
    if (!message.message || message.key.fromMe) return;

    const type = getContentType(message.message);

    if (type === 'protocolMessage') {
        handleEditedMessage(sock, message);
        return;
    }

    if (await handleDotCommand(sock, message)) return;

    if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2' || type === 'viewOnceMessageV2Extension') {
        await handleViewOnce(sock, message, type);
    }

    const id = message.key.id;
    if (!messageStore.has(id)) {
        messageStore.set(id, message);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger,
        auth: state,
        printQRInTerminal: false,
        shouldIgnoreJid: jid => typeof jid === 'string' && jid.includes('@broadcast'),
        getMessage: async (key) => {
            const stored = messageStore.get(key.id);
            if (stored) return stored.message;
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

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output?.statusCode
                : null;

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Connection closed. Reconnecting...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log('Logged out. Delete auth_info_baileys folder and restart.');
            }
        } else if (connection === 'open') {
            console.log('Bot is online ✅');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        for (const message of m.messages) {
            try {
                await processMessage(sock, message);
            } catch (e) {
                console.error(`Error processing message: ${e.message}`);
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            try {
                if (update.message === null) {
                    const deletedMsg = messageStore.get(key.id);
                    if (deletedMsg) {
                        await processSingleDeletedMessage(sock, deletedMsg);
                        messageStore.delete(key.id);
                    }
                }
            } catch (e) {
                console.error(`Error processing deleted message: ${e.message}`);
            }
        }
    });

    return sock;
}

startBot().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
