import { EventEmitter } from 'node:events';

/**
 * Discord's real-time connection (Gateway v10), using Node's built-in WebSocket.
 * Handles heartbeats, resuming after drops and reconnecting with back-off.
 */
export const Intents = {
    GUILDS: 1 << 0,
    GUILD_MEMBERS: 1 << 1,
    GUILD_MESSAGES: 1 << 9,
    MESSAGE_CONTENT: 1 << 15,
};

export const DEFAULT_INTENTS = Intents.GUILDS | Intents.GUILD_MESSAGES | Intents.MESSAGE_CONTENT;

// Close codes that mean "stop and fix the settings": reconnecting won't help.
export const FATAL_CLOSE_CODES = {
    4004: 'Discord rejected the bot token. Check DISCORD_TOKEN (Developer Portal -> Bot -> Reset Token).',
    4010: 'Invalid shard sent to Discord.',
    4011: 'Discord says this bot needs sharding (it is in too many servers).',
    4012: 'Invalid Discord API version.',
    4013: 'Invalid gateway intents.',
    4014: 'Discord refused a privileged intent. In the Developer Portal (Bot page) turn on "MESSAGE CONTENT INTENT", and "SERVER MEMBERS INTENT" if you use Discord roles for plans, then restart.',
};

// After these, the old session can't be resumed: start a new one.
const NO_RESUME = new Set([4007, 4009]);

export class Gateway extends EventEmitter {
    constructor({ token, rest, intents = DEFAULT_INTENTS, WebSocketImpl = globalThis.WebSocket, log, random = Math.random } = {}) {
        super();
        this.token = token;
        this.rest = rest;
        this.intents = intents;
        this.WebSocket = WebSocketImpl;
        this.log = log;
        this.random = random;
        this.ws = null;
        this.seq = null;
        this.sessionId = null;
        this.resumeUrl = null;
        this.gatewayUrl = null;
        this.heartbeat = null;
        this.acked = true;
        this.stopped = false;
        this.failures = 0;
        this.user = null;
        this.applicationId = null;
    }

    async connect() {
        this.stopped = false;
        if (!this.gatewayUrl) {
            const info = await this.rest.get('/gateway/bot');
            this.gatewayUrl = info.url;
            if (info.session_start_limit?.remaining === 0) {
                this.log?.warn('Discord login limit reached for today; waiting before connecting.');
            }
        }
        this.open(this.sessionId && this.resumeUrl ? this.resumeUrl : this.gatewayUrl);
    }

    open(base) {
        const ws = new this.WebSocket(`${base}/?v=10&encoding=json`);
        this.ws = ws;
        this.acked = true;
        ws.onmessage = (event) => {
            if (this.ws !== ws) return;
            let payload;
            try {
                payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
            } catch {
                return;
            }
            this.onPayload(payload);
        };
        ws.onclose = (event) => {
            if (this.ws !== ws) return;
            this.onClose(event.code, event.reason);
        };
        ws.onerror = () => {
            // A close event always follows, which is where we reconnect.
        };
    }

    send(op, d) {
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
    }

    onPayload({ op, d, s, t }) {
        if (s !== null && s !== undefined) this.seq = s;

        switch (op) {
            case 10: // Hello
                this.startHeartbeat(d.heartbeat_interval);
                if (this.sessionId) {
                    this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
                } else {
                    this.identify();
                }
                break;
            case 11: // Heartbeat ACK
                this.acked = true;
                break;
            case 1: // Discord asked for a heartbeat now
                this.beat();
                break;
            case 7: // Reconnect
                this.log?.info('Discord asked us to reconnect.');
                this.restart(4000);
                break;
            case 9: // Invalid session
                if (!d) {
                    this.sessionId = null;
                    this.seq = null;
                }
                this.restart(4000);
                break;
            case 0: // Dispatch
                if (t === 'READY') {
                    this.sessionId = d.session_id;
                    this.resumeUrl = d.resume_gateway_url;
                    this.user = d.user;
                    this.applicationId = d.application?.id;
                    this.failures = 0;
                }
                if (t === 'RESUMED') this.failures = 0;
                this.emit('dispatch', t, d);
                this.emit(t, d);
                break;
            default:
                break;
        }
    }

    identify() {
        this.send(2, {
            token: this.token,
            intents: this.intents,
            properties: { os: process.platform, browser: 'berry-tickets', device: 'berry-tickets' },
            presence: { status: 'online', activities: [{ name: 'support tickets', type: 3 }], since: null, afk: false },
        });
    }

    startHeartbeat(interval) {
        this.stopHeartbeat();
        const beat = () => {
            if (!this.acked) {
                // No answer to the last heartbeat: the connection is dead.
                this.log?.warn('Discord stopped answering heartbeats; reconnecting.');
                this.restart(4000);
                return;
            }
            this.beat();
        };
        // The first heartbeat is sent at a random point, as Discord asks.
        this.heartbeat = setTimeout(() => {
            beat();
            this.heartbeat = setInterval(beat, interval);
        }, Math.floor(interval * this.random()));
    }

    beat() {
        this.acked = false;
        this.send(1, this.seq);
    }

    stopHeartbeat() {
        if (this.heartbeat) {
            clearTimeout(this.heartbeat);
            clearInterval(this.heartbeat);
        }
        this.heartbeat = null;
    }

    /**
     * Drops the current connection and reconnects (resuming when possible).
     */
    restart(code = 4000) {
        const ws = this.ws;
        this.ws = null;
        this.stopHeartbeat();
        try {
            ws?.close(code);
        } catch {
            // Already closed.
        }
        this.scheduleReconnect();
    }

    onClose(code, reason) {
        this.ws = null;
        this.stopHeartbeat();
        if (this.stopped) return;

        if (FATAL_CLOSE_CODES[code]) {
            this.stopped = true;
            this.emit('fatal', code, FATAL_CLOSE_CODES[code]);
            return;
        }
        if (NO_RESUME.has(code)) {
            this.sessionId = null;
            this.seq = null;
        }
        this.log?.warn(`Disconnected from Discord (${code}${reason ? `: ${reason}` : ''}); reconnecting.`);
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnecting) return;
        this.reconnecting = true;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5)) + Math.floor(this.random() * 1000);
        this.failures++;
        setTimeout(() => {
            this.reconnecting = false;
            this.connect().catch((error) => {
                this.log?.error(`Could not reach Discord: ${error.message}`);
                this.scheduleReconnect();
            });
        }, delay);
    }

    stop() {
        this.stopped = true;
        this.stopHeartbeat();
        const ws = this.ws;
        this.ws = null;
        try {
            ws?.close(1000);
        } catch {
            // Already closed.
        }
    }
}
