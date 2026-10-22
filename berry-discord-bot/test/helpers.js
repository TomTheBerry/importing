import { quiet } from '../src/log.js';
import { StateStore } from '../src/state.js';
import { TicketBot } from '../src/tickets.js';

export const GUILD = '100000000000000001';
export const CATEGORY = '100000000000000002';
export const STAFF_ROLE = '100000000000000003';
export const BOT_USER = '100000000000000004';
export const GUEST_CATEGORY = '100000000000000005';

export const config = {
    token: 'token',
    guildId: GUILD,
    categoryId: CATEGORY,
    guestCategoryId: GUEST_CATEGORY,
    staffRoleIds: [STAFF_ROLE],
    pingRoleId: null,
    supportChannelId: null,
    panelUrl: 'https://panel.test',
    secret: 'x'.repeat(40),
    pollMs: 2000,
};

/**
 * Records every Discord call. Responses can be set per "METHOD path" prefix.
 */
export class FakeRest {
    constructor() {
        this.calls = [];
        this.handlers = [];
        this.ids = 500000000000000000n;
    }

    on(method, pathStart, fn) {
        this.handlers.unshift({ method, pathStart, fn });
    }

    nextId() {
        this.ids += 1n;
        return String(this.ids);
    }

    async request(method, path, options = {}) {
        this.calls.push({ method, path, ...options });
        const handler = this.handlers.find((h) => h.method === method && path.startsWith(h.pathStart));
        if (handler) return handler.fn(path, options);
        if (method === 'POST' && path.endsWith('/channels')) return { id: this.nextId(), ...options.body };
        if (method === 'POST' && path.includes('/messages')) return { id: this.nextId() };
        if (method === 'GET' && path.endsWith('/webhooks')) return [];
        if (method === 'POST' && path.endsWith('/webhooks')) return { id: this.nextId(), token: 'hooktoken' };
        if (method === 'POST' && path.startsWith('/webhooks/')) return { id: this.nextId() };
        return null;
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

    find(method, pathStart) {
        return this.calls.filter((c) => c.method === method && c.path.startsWith(pathStart));
    }
}

export const ticket = (overrides = {}) => ({
    uuid: '11111111-2222-3333-4444-555555555555',
    number: '#0042',
    channel_name: 'ticket-0042',
    subject: 'Server will not start',
    category: '🛠️ Server problem',
    status: 'open',
    priority: 'normal',
    assigned_to: null,
    customer: { name: 'alex', discord_id: '200000000000000001', guest: false },
    server: null,
    discord_channel_id: null,
    panel_url: 'https://panel.test/admin/tickets/42',
    ...overrides,
});

export class FakePanel {
    constructor() {
        this.calls = [];
        this.items = [];
        this.acks = [];
        this.tickets = new Map();
        this.fail = {};
    }

    record(name, args) {
        this.calls.push({ name, args });
        if (this.fail[name]) throw this.fail[name];
    }

    async config() {
        return { app_name: 'TheBerryHost', panel_url: 'https://panel.test', categories: [{ id: 2, name: 'Server problem', emoji: '🛠️', description: 'Crashes' }], limits: { max_files: 5, max_kb: 8192, extensions: ['png', 'txt', 'log'] } };
    }

    async outbox() {
        return this.items.filter((i) => !this.acks.some((a) => a.id === i.id && a.ok));
    }

    async ack(id, ok, error = null, retry = true) {
        this.acks.push({ id, ok, error, retry });
    }

    async createTicket(author, categoryId, subject, message) {
        this.record('createTicket', { author, categoryId, subject, message });
        this.created = ticket({ customer: { name: author.name, discord_id: author.id, guest: true }, subject });
        return this.created;
    }

    async setChannel(uuid, channelId) {
        this.record('setChannel', { uuid, channelId });
        return { ...(this.created || ticket()), discord_channel_id: channelId };
    }

    async byChannel(channelId) {
        this.record('byChannel', { channelId });
        return this.tickets.get(channelId) || null;
    }

    async postMessage(uuid, author, messageId, body, files) {
        this.record('postMessage', { uuid, author, messageId, body, files });
        return { id: 1 };
    }

    async close(uuid, author, reason) {
        this.record('close', { uuid, author, reason });
        return ticket({ status: 'closed' });
    }

    async claim(uuid, authorId) {
        this.record('claim', { uuid, authorId });
        return ticket({ assigned_to: 'staffy' });
    }

    async roles(discordId) {
        this.record('roles', { discordId });
        return { discord_id: discordId, roles: ['400000000000000001'], managed: ['400000000000000001', '400000000000000002'] };
    }

    async attachment(uuid) {
        this.record('attachment', { uuid });
        return { data: Buffer.from('file-' + uuid), type: 'text/plain' };
    }
}

export function makeBot(overrides = {}) {
    const rest = overrides.rest || new FakeRest();
    const panel = overrides.panel || new FakePanel();
    const bot = new TicketBot({
        rest,
        panel,
        config: { ...config, ...(overrides.config || {}) },
        state: new StateStore('unused.json', { memory: true }),
        log: quiet,
        sleep: async () => {},
        fetchImpl: overrides.fetchImpl || (async () => new Response('discord-file')),
    });
    bot.setIdentity({ id: BOT_USER }, '300000000000000001');

    return { bot, rest, panel };
}
