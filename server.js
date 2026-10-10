const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const IRC = require('irc-framework');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const IRC_HOST = process.env.IRC_HOST || 'irc.libera.chat';
const IRC_PORT = parseInt(process.env.IRC_PORT || '6697');
const IRC_TLS = (process.env.IRC_TLS || 'true') === 'true';
const PUBLIC_CHANNEL = process.env.PUBLIC_CHANNEL || '#lobby-luau-xyz';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';

const messages = [];
let nextId = 0;

function pushMessage(msg) {
    messages.push(msg);
    if (messages.length > 500) messages.shift();
}

function genKey() {
    return Math.random().toString(36).slice(2, 10);
}

function randSuffix() {
    return Math.floor(Math.random() * 9999).toString().padStart(4, '0');
}

wss.on('connection', (ws) => {
    let irc = null;
    let nickname = null;
    let currentChannel = PUBLIC_CHANNEL;
    let userInfo = { userId: '', username: '' };
    const pendingKey = new Map();

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        if (data.type === 'init') {
            if (irc) return;
            userInfo.userId = String(data.userId || '');
            userInfo.username = String(data.username || 'anon');
            nickname = 'L_' + userInfo.userId.slice(-8) + randSuffix();
            irc = new IRC.Client();

            irc.on('registered', () => {
                irc.join(PUBLIC_CHANNEL);
                ws.send(JSON.stringify({
                    type: 'ready',
                    channel: PUBLIC_CHANNEL,
                    nickname: nickname
                }));
                console.log(`[${nickname}] registered, joined ${PUBLIC_CHANNEL}`);
            });

            irc.on('message', (event) => {
                if (!event.target || !event.target.startsWith('#')) return;
                if (event.nick === nickname) return;

                let actualUsername = event.nick;
                let actualUserId = event.nick;
                let actualMessage = event.message;

                const match = event.message.match(/^\[([^|]+)\|([^\]]+)\]\s*([\s\S]*)$/);
                if (match) {
                    actualUsername = match[1];
                    actualUserId = match[2];
                    actualMessage = match[3];
                }

                const msg = {
                    id: ++nextId,
                    channel: event.target,
                    username: actualUsername,
                    displayName: actualUsername,
                    userId: actualUserId,
                    message: actualMessage,
                    timestamp: Date.now()
                };
                pushMessage(msg);
                ws.send(JSON.stringify({ type: 'message', data: msg }));
            });

            irc.on('join', (event) => {
                if (event.nick !== nickname) return;
                const key = pendingKey.get(event.channel);
                if (key) {
                    pendingKey.delete(event.channel);
                    irc.raw('MODE', event.channel, '+s');
                    irc.raw('MODE', event.channel, '+k', key);
                    ws.send(JSON.stringify({
                        type: 'private_created',
                        channel: event.channel,
                        key: key
                    }));
                    console.log(`[${nickname}] created private channel ${event.channel} key=${key}`);
                }
            });

            irc.on('close', () => {
                console.log(`[${nickname}] IRC closed`);
                try {
                    ws.send(JSON.stringify({ type: 'irc_closed' }));
                } catch {}
            });

            irc.connect({
                host: IRC_HOST,
                port: IRC_PORT,
                tls: IRC_TLS,
                nick: nickname,
                username: nickname,
                gecos: 'Luau IRC Bridge User'
            });
            return;
        }

        if (!irc) return;

        if (data.type === 'join') {
            if (!data.channel) return;
            irc.join(data.channel, data.key || '');
            currentChannel = data.channel;
        } else if (data.type === 'create_private') {
            if (!data.channel) return;
            const key = data.key || genKey();
            pendingKey.set(data.channel, key);
            irc.join(data.channel);
            currentChannel = data.channel;
        } else if (data.type === 'part') {
            const ch = data.channel || currentChannel;
            irc.part(ch);
            if (ch === currentChannel) currentChannel = PUBLIC_CHANNEL;
        } else if (data.type === 'switch') {
            if (data.channel) currentChannel = data.channel;
        } else if (data.type === 'message') {
            const target = data.channel || currentChannel;
            if (data.message) {
                const payload = `[${userInfo.username}|${userInfo.userId}] ${data.message}`;
                irc.say(target, payload.slice(0, 400));
            }
        }
    });

    ws.on('close', () => {
        if (irc) {
            try { irc.quit('Luau disconnected'); } catch {}
        }
    });
});

let sharedIrc = null;
let sharedNick = 'L_HTTP_' + randSuffix();

function ensureSharedIrc() {
    if (sharedIrc && sharedIrc.connected) return;
    sharedIrc = new IRC.Client();
    sharedIrc.on('registered', () => {
        sharedIrc.join(PUBLIC_CHANNEL);
        console.log(`[${sharedNick}] shared IRC connected`);
    });
    sharedIrc.on('message', (event) => {
        if (!event.target || !event.target.startsWith('#')) return;
        if (event.nick === sharedNick) return;

        let actualUsername = event.nick;
        let actualUserId = event.nick;
        let actualMessage = event.message;

        const match = event.message.match(/^\[([^|]+)\|([^\]]+)\]\s*([\s\S]*)$/);
        if (match) {
            actualUsername = match[1];
            actualUserId = match[2];
            actualMessage = match[3];
        }

        pushMessage({
            id: ++nextId,
            channel: event.target,
            username: actualUsername,
            displayName: actualUsername,
            userId: actualUserId,
            message: actualMessage,
            timestamp: Date.now()
        });
    });
    sharedIrc.on('close', () => {
        sharedIrc = null;
        setTimeout(ensureSharedIrc, 5000);
    });
    sharedIrc.connect({
        host: IRC_HOST,
        port: IRC_PORT,
        tls: IRC_TLS,
        nick: sharedNick,
        username: sharedNick,
        gecos: 'Luau HTTP User'
    });
}

app.post('/api/v1/chat/init', (req, res) => {
    res.json({ success: true });
});

app.post('/api/v1/chat/send', (req, res) => {
    const { userId, username, message } = req.body || {};
    if (!message) return res.status(400).json({ success: false });
    ensureSharedIrc();
    if (sharedIrc && sharedIrc.connected) {
        const payload = `[${username || 'HttpUser'}|${userId || '0'}] ${message}`;
        sharedIrc.say(PUBLIC_CHANNEL, payload.slice(0, 400));
        return res.json({ success: true });
    }
    res.json({ success: false });
});

app.get('/api/v1/chat/messages', (req, res) => {
    const after = parseInt(req.query.after) || 0;
    res.json({
        success: true,
        messages: messages.filter(m => m.timestamp > after)
    });
});

app.get('/', (req, res) => res.send('Luau IRC Bridge OK'));

function selfPing() {
    if (!SELF_URL) return;
    setInterval(() => {
        fetch(SELF_URL).catch(() => {});
    }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Server listening on port', PORT);
    console.log('IRC:', IRC_HOST + ':' + IRC_PORT, 'TLS:', IRC_TLS);
    console.log('Public channel:', PUBLIC_CHANNEL);
    selfPing();
});
