/**
 * A small Discord REST client (API v10) with rate-limit handling, built on Node's own
 * fetch so no packages are needed.
 */
export class DiscordError extends Error {
    constructor(status, data, method, path) {
        super(`Discord ${method} ${path} failed (${status}): ${data?.message || 'unknown error'}${data?.code ? ` [code ${data.code}]` : ''}`);
        this.status = status;
        this.code = data?.code ?? null;
        this.data = data;
    }
}

// Discord error codes we handle specially.
export const UNKNOWN_CHANNEL = 10003;
export const UNKNOWN_MESSAGE = 10008;
export const UNKNOWN_MEMBER = 10007;
export const UNKNOWN_ROLE = 10011;
export const UNKNOWN_WEBHOOK = 10015;
export const MISSING_ACCESS = 50001;
export const MISSING_PERMISSIONS = 50013;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DiscordRest {
    constructor({ token, fetchImpl = globalThis.fetch, base = 'https://discord.com/api/v10', sleep = defaultSleep, log } = {}) {
        this.token = token;
        this.fetch = fetchImpl;
        this.base = base;
        this.sleep = sleep;
        this.log = log;
        this.buckets = new Map();
        this.globalUntil = 0;
    }

    /**
     * Rate limits are tracked per route, ignoring IDs other than the channel, guild or
     * webhook a request is for (Discord's "major parameters").
     */
    static bucketKey(method, path) {
        const clean = path.split('?')[0].replace(/\/(\d{16,})/g, (m, id, offset, all) => {
            const before = all.slice(0, offset);
            return /\/(channels|guilds|webhooks)$/.test(before) ? m : '/:id';
        });

        return `${method} ${clean}`;
    }

    async request(method, path, { body, files, reason, query } = {}) {
        const key = DiscordRest.bucketKey(method, path);
        const url = this.base + path + (query ? `?${new URLSearchParams(query)}` : '');

        for (let attempt = 0; attempt < 6; attempt++) {
            const wait = Math.max(this.globalUntil, this.buckets.get(key) || 0) - Date.now();
            if (wait > 0) await this.sleep(wait);

            const headers = {
                Authorization: `Bot ${this.token}`,
                'User-Agent': 'DiscordBot (https://theberryhost.com, 1.0) BerryTickets',
            };
            if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);

            let payload;
            if (files && files.length) {
                payload = new FormData();
                const json = { ...(body || {}), attachments: files.map((f, i) => ({ id: i, filename: f.name })) };
                payload.append('payload_json', JSON.stringify(json));
                files.forEach((f, i) => payload.append(`files[${i}]`, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name));
            } else if (body !== undefined) {
                headers['Content-Type'] = 'application/json';
                payload = JSON.stringify(body);
            }

            let res;
            try {
                res = await this.fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
            } catch (error) {
                if (attempt >= 3) throw error;
                await this.sleep(1000 * 2 ** attempt);
                continue;
            }

            const remaining = res.headers.get('x-ratelimit-remaining');
            const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
            if (remaining === '0' && resetAfter > 0) this.buckets.set(key, Date.now() + resetAfter * 1000);

            if (res.status === 429) {
                const data = await res.json().catch(() => ({}));
                const retry = Math.ceil((Number(data.retry_after) || 1) * 1000) + 50;
                if (data.global || res.headers.get('x-ratelimit-global')) this.globalUntil = Date.now() + retry;
                else this.buckets.set(key, Date.now() + retry);
                this.log?.debug(`Rate limited on ${key}, waiting ${retry}ms`);
                continue;
            }

            if (res.status >= 500 && attempt < 3) {
                await this.sleep(1000 * 2 ** attempt);
                continue;
            }

            if (res.status === 204) return null;
            const text = await res.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = { message: text.slice(0, 200) };
            }
            if (!res.ok) throw new DiscordError(res.status, data, method, path.split('?')[0]);

            return data;
        }

        throw new DiscordError(429, { message: 'Still rate limited after several tries' }, method, path);
    }

    get(path, options) {
        return this.request('GET', path, options);
    }

    post(path, body, options = {}) {
        return this.request('POST', path, { ...options, body });
    }

    patch(path, body, options = {}) {
        return this.request('PATCH', path, { ...options, body });
    }

    put(path, body, options = {}) {
        return this.request('PUT', path, { ...options, body });
    }

    delete(path, options) {
        return this.request('DELETE', path, options);
    }
}
