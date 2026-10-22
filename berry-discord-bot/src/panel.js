/**
 * Talks to BerryPanel's bot API (/api/discord-bot). Every request carries BOT_SECRET.
 */
export class PanelError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export class PanelClient {
    constructor({ url, secret, fetchImpl = globalThis.fetch } = {}) {
        this.url = url.replace(/\/+$/, '');
        this.secret = secret;
        this.fetch = fetchImpl;
    }

    async call(method, path, { json, form, raw = false, timeout = 20000 } = {}) {
        const headers = { Authorization: `Bearer ${this.secret}`, Accept: 'application/json', 'User-Agent': 'BerryTicketsBot/1.0' };
        let body;
        if (form) {
            body = form;
        } else if (json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(json);
        }

        const res = await this.fetch(`${this.url}/api/discord-bot${path}`, { method, headers, body, signal: AbortSignal.timeout(timeout) });

        if (raw && res.ok) {
            return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'application/octet-stream' };
        }
        if (res.status === 204) return null;

        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        if (!res.ok) {
            // Only show the Panel's own words for problems with the request, never server errors.
            const message =
                res.status >= 500
                    ? `The Panel had a problem (HTTP ${res.status}). Please try again shortly.`
                    : data?.error || data?.errors?.[0]?.detail || data?.message || `Panel returned HTTP ${res.status}`;
            throw new PanelError(res.status, message);
        }

        return data;
    }

    ping() {
        return this.call('GET', '/ping');
    }

    config() {
        return this.call('GET', '/config');
    }

    async outbox(limit = 20) {
        return (await this.call('GET', `/outbox?limit=${limit}`)).data;
    }

    ack(id, ok, error = null, retry = true) {
        return this.call('POST', `/outbox/${id}/ack`, { json: { ok, error: error ? String(error).slice(0, 480) : null, retry } });
    }

    async createTicket(author, categoryId, subject, message) {
        return (await this.call('POST', '/tickets', { json: { author, category_id: categoryId, subject, message } })).data;
    }

    async setChannel(uuid, channelId) {
        return (await this.call('POST', `/tickets/${uuid}/channel`, { json: { channel_id: channelId } })).data;
    }

    async byChannel(channelId) {
        try {
            return (await this.call('GET', `/tickets/by-channel/${channelId}`)).data;
        } catch (error) {
            if (error instanceof PanelError && error.status === 404) return null;
            throw error;
        }
    }

    /**
     * @param {{name: string, type: string, data: Buffer}[]} files
     */
    async postMessage(uuid, author, messageId, body, files = []) {
        const form = new FormData();
        form.append('author[id]', author.id);
        form.append('author[name]', author.name);
        if (author.avatar) form.append('author[avatar]', author.avatar);
        form.append('author[staff]', author.staff ? '1' : '0');
        form.append('message_id', messageId);
        form.append('body', body || '');
        for (const file of files) form.append('files[]', new Blob([file.data], { type: file.type }), file.name);

        return (await this.call('POST', `/tickets/${uuid}/messages`, { form, timeout: 120000 })).data;
    }

    async close(uuid, author, reason) {
        return (await this.call('POST', `/tickets/${uuid}/close`, { json: { author, reason: reason || null } })).data;
    }

    async claim(uuid, authorId) {
        return (await this.call('POST', `/tickets/${uuid}/claim`, { json: { author: { id: authorId } } })).data;
    }

    async roles(discordId) {
        return (await this.call('GET', `/members/${discordId}/roles`)).data;
    }

    attachment(uuid) {
        return this.call('GET', `/attachments/${uuid}`, { raw: true, timeout: 120000 });
    }
}
