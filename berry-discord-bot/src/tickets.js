import { PanelError } from './panel.js';
import { DiscordError, UNKNOWN_CHANNEL, UNKNOWN_MESSAGE, UNKNOWN_WEBHOOK, UNKNOWN_MEMBER, UNKNOWN_ROLE, MISSING_ACCESS, MISSING_PERMISSIONS } from './rest.js';
import {
    BOT_ALLOW,
    COLOURS,
    MEMBER_ALLOW,
    Permissions,
    avatarUrl,
    categorySelect,
    cleanMentions,
    displayName,
    formatSize,
    splitText,
    supportPanelMessage,
    ticketButtons,
    ticketEmbed,
    ticketModal,
    truncate,
    webhookName,
} from './format.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discord's upload limit for servers without boosts is 10 MB per message.
export const DISCORD_UPLOAD_LIMIT = 9.5 * 1024 * 1024;
export const CLOSE_DELAY_MS = 10000;
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };

/** An outbox job that can't be done now but should be tried again later. */
export class RetryLater extends Error {}

/**
 * Everything the bot does with tickets: the Discord side of the conversation, and
 * jobs sent by the Panel (new channels, replies written on the Panel, closing).
 */
export class TicketBot {
    constructor({ rest, panel, config, state, log, sleep = defaultSleep, now = Date.now, fetchImpl = globalThis.fetch }) {
        this.rest = rest;
        this.panel = panel;
        this.config = config;
        this.state = state;
        this.log = log;
        this.sleep = sleep;
        this.now = now;
        this.fetch = fetchImpl;
        this.botUserId = null;
        this.appId = null;
        this.panelConfig = { app_name: 'TheBerryHost', panel_url: config.panelUrl, categories: [], limits: { max_files: 5, max_kb: 8192, extensions: [] } };
        this.channelParents = new Map();
        this.channelNames = new Map();
        this.ticketByChannel = new Map();
        this.notTicket = new Map();
        this.webhooks = new Map();
        this.inFlight = new Set();
    }

    setIdentity(user, applicationId) {
        this.botUserId = user?.id || null;
        this.appId = applicationId || user?.id || null;
    }

    async refreshConfig() {
        this.panelConfig = { ...this.panelConfig, ...(await this.panel.config()) };

        return this.panelConfig;
    }

    // ------------------------------------------------------------------ Discord state

    onGuildCreate(guild) {
        if (guild.id !== this.config.guildId) return;
        for (const channel of guild.channels || []) {
            this.channelParents.set(channel.id, channel.parent_id || null);
            this.channelNames.set(channel.id, channel.name);
        }
    }

    onChannelEvent(type, channel) {
        if (channel.guild_id && channel.guild_id !== this.config.guildId) return;
        if (type === 'CHANNEL_DELETE') {
            this.channelParents.delete(channel.id);
            this.channelNames.delete(channel.id);
            this.ticketByChannel.delete(channel.id);
            this.webhooks.delete(channel.id);
            return;
        }
        this.channelParents.set(channel.id, channel.parent_id || null);
        this.channelNames.set(channel.id, channel.name);
    }

    isStaff(member) {
        if (!member) return false;
        if ((member.roles || []).some((role) => this.config.staffRoleIds.includes(role))) return true;
        try {
            return member.permissions ? (BigInt(member.permissions) & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR : false;
        } catch {
            return false;
        }
    }

    author(user, member) {
        return { id: user.id, name: truncate(displayName(user, member), 100), avatar: avatarUrl(user), staff: this.isStaff(member) };
    }

    async ticketFor(channelId) {
        if (this.ticketByChannel.has(channelId)) return this.ticketByChannel.get(channelId);
        if ((this.notTicket.get(channelId) || 0) > this.now()) return null;

        const ticket = await this.panel.byChannel(channelId);
        if (ticket) {
            this.ticketByChannel.set(channelId, ticket.uuid);
            return ticket.uuid;
        }
        this.notTicket.set(channelId, this.now() + 60000);

        return null;
    }

    // ------------------------------------------------------------------ Interactions

    respond(interaction, type, data) {
        return this.rest.post(`/interactions/${interaction.id}/${interaction.token}/callback`, data === undefined ? { type } : { type, data });
    }

    editOriginal(interaction, data) {
        return this.rest.patch(`/webhooks/${this.appId}/${interaction.token}/messages/@original`, { allowed_mentions: NO_PINGS, ...data });
    }

    reply(interaction, content, extra = {}) {
        return this.respond(interaction, 4, { content, flags: EPHEMERAL, allowed_mentions: NO_PINGS, ...extra });
    }

    async onInteraction(interaction) {
        if (interaction.guild_id !== this.config.guildId) {
            return this.reply(interaction, 'Tickets only work in our Discord server.');
        }

        try {
            // The bot has no slash commands: everything is done with buttons.
            if (interaction.type === 2) return await this.reply(interaction, 'Use the buttons on the ticket instead.');
            if (interaction.type === 3) return await this.onComponent(interaction);
            if (interaction.type === 5) return await this.onModal(interaction);
        } catch (error) {
            this.log.error(`Interaction failed: ${error.message}`);
            const message = `⚠️ ${error instanceof PanelError ? error.message : 'Something went wrong. Please try again in a moment.'}`;
            await this.reply(interaction, message).catch(() => this.editOriginal(interaction, { content: message, components: [] }).catch(() => null));
        }

        return null;
    }

    async claim(interaction, uuid, user) {
        try {
            await this.panel.claim(uuid, user.id);
            return this.editOriginal(interaction, { content: '✅ You are now handling this ticket.' });
        } catch (error) {
            if (error instanceof PanelError) return this.editOriginal(interaction, { content: `⚠️ ${error.message}` });
            throw error;
        }
    }

    async onComponent(interaction) {
        const id = interaction.data?.custom_id || '';
        const user = interaction.member?.user || interaction.user;

        if (id === 'bt:start') {
            if (!this.panelConfig.categories?.length) await this.refreshConfig().catch(() => null);
            const categories = this.panelConfig.categories || [];
            if (!categories.length) return this.respond(interaction, 9, ticketModal(0, null));

            return this.reply(interaction, 'What do you need help with?', { components: categorySelect(categories) });
        }

        if (id === 'bt:cat') {
            const categoryId = Number(interaction.data.values?.[0]) || 0;
            const category = (this.panelConfig.categories || []).find((c) => c.id === categoryId);

            return this.respond(interaction, 9, ticketModal(categoryId, category?.name));
        }

        const [, action, uuid] = id.split(':');
        if (!/^[0-9a-f-]{36}$/i.test(uuid || '')) return this.reply(interaction, 'This button has expired.');

        if (action === 'close') {
            return this.reply(interaction, 'Close this ticket? The channel will be deleted; the full conversation stays on the Panel.', {
                components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Yes, close it', emoji: { name: '🔒' }, custom_id: `bt:closeyes:${uuid}` }] }],
            });
        }

        if (action === 'closeyes') {
            await this.respond(interaction, 7, { content: '🔒 Closing the ticket…', components: [] });
            try {
                await this.panel.close(uuid, this.author(user, interaction.member), null);
            } catch (error) {
                if (!(error instanceof PanelError)) throw error;
                await this.editOriginal(interaction, { content: `⚠️ ${error.message}` });
            }
            return null;
        }

        if (action === 'claim') {
            await this.respond(interaction, 5, { flags: EPHEMERAL });
            return this.claim(interaction, uuid, user);
        }

        return this.reply(interaction, 'This button has expired.');
    }

    async onModal(interaction) {
        const id = interaction.data?.custom_id || '';
        if (!id.startsWith('bt:new:')) return this.reply(interaction, 'This form has expired.');

        const fields = {};
        for (const row of interaction.data.components || []) for (const c of row.components || []) fields[c.custom_id] = c.value;
        const categoryId = Number(id.split(':')[2]) || null;
        const user = interaction.member?.user || interaction.user;
        const author = this.author(user, interaction.member);

        await this.respond(interaction, 5, { flags: EPHEMERAL });

        let ticket;
        try {
            ticket = await this.panel.createTicket({ id: author.id, name: author.name, avatar: author.avatar }, categoryId, String(fields.subject || '').trim(), String(fields.message || '').trim());
        } catch (error) {
            if (!(error instanceof PanelError)) throw error;
            return this.editOriginal(interaction, { content: `⚠️ ${error.message}` });
        }

        try {
            const channel = await this.createChannel(ticket);
            ticket = (await this.panel.setChannel(ticket.uuid, channel.id)) || { ...ticket, discord_channel_id: channel.id };
            await this.postOpening(ticket, channel.id);
            await this.sendAs(channel.id, { username: webhookName(author.name), avatar_url: author.avatar, content: String(fields.message || '').trim() });

            return this.editOriginal(interaction, { content: `✅ Your ticket **${ticket.number}** is open: <#${channel.id}>` });
        } catch (error) {
            this.log.error(`Ticket ${ticket.number} was opened but its channel could not be made: ${error.message}`);
            return this.editOriginal(interaction, {
                content: `✅ Your ticket **${ticket.number}** is open, but we couldn't make its channel right now. Our team has it and will reply soon.`,
            });
        }
    }

    // ------------------------------------------------------------------ Channels & sending

    async createChannel(ticket) {
        const overwrites = [
            { id: this.config.guildId, type: 0, deny: String(Permissions.VIEW_CHANNEL) },
            ...this.config.staffRoleIds.map((id) => ({ id, type: 0, allow: String(MEMBER_ALLOW) })),
        ];
        if (this.botUserId) overwrites.push({ id: this.botUserId, type: 1, allow: String(BOT_ALLOW) });
        if (ticket.customer?.discord_id) overwrites.push({ id: ticket.customer.discord_id, type: 1, allow: String(MEMBER_ALLOW) });

        const parent = this.categoryFor(ticket);
        const channel = await this.rest.post(
            `/guilds/${this.config.guildId}/channels`,
            {
                name: this.channelName(ticket),
                type: 0,
                parent_id: parent,
                topic: truncate(`${ticket.number} · ${ticket.subject}`, 1024),
                permission_overwrites: overwrites,
            },
            { reason: `Support ticket ${ticket.number}` }
        );
        this.channelParents.set(channel.id, parent);
        this.channelNames.set(channel.id, channel.name || this.channelName(ticket));
        this.ticketByChannel.set(channel.id, ticket.uuid);
        this.notTicket.delete(channel.id);

        return channel;
    }

    /**
     * Tickets from people without a Panel account go in their own category (if set).
     */
    categoryFor(ticket) {
        return ticket.customer?.guest && this.config.guestCategoryId ? this.config.guestCategoryId : this.config.categoryId;
    }

    /**
     * The Panel names channels by topic, customer and number, e.g. billing-payments-alex-0042.
     */
    channelName(ticket) {
        return ticket.channel_name;
    }

    ticketCategories() {
        return [this.config.categoryId, this.config.guestCategoryId].filter(Boolean);
    }

    /**
     * Staff are pinged about every new ticket; customers never are.
     */
    async postOpening(ticket, channelId) {
        const roles = this.config.pingRoleId ? [this.config.pingRoleId] : [...this.config.staffRoleIds];
        const content = roles.map((r) => `<@&${r}>`).join(' ');

        const message = await this.rest.post(`/channels/${channelId}/messages`, {
            content: content || undefined,
            embeds: [ticketEmbed(ticket, this.panelConfig.app_name)],
            components: ticketButtons(ticket),
            allowed_mentions: { parse: [], users: [], roles },
        });
        await this.rest.put(`/channels/${channelId}/pins/${message.id}`).catch(() => null);
        this.state.setOpener(ticket.uuid, { channelId, messageId: message.id });

        return message;
    }

    async webhookFor(channelId) {
        if (this.webhooks.has(channelId)) return this.webhooks.get(channelId);

        const existing = (await this.rest.get(`/channels/${channelId}/webhooks`)) || [];
        let hook = existing.find((w) => w.token && (!this.botUserId || w.user?.id === this.botUserId));
        if (!hook) hook = await this.rest.post(`/channels/${channelId}/webhooks`, { name: truncate(`${this.panelConfig.app_name} Tickets`, 80) });

        const value = { id: hook.id, token: hook.token };
        this.webhooks.set(channelId, value);

        return value;
    }

    /**
     * Posts as someone else (their Panel name and picture) through the channel webhook.
     */
    async sendAs(channelId, { username, avatar_url, content, files = [] }, retried = false) {
        const hook = await this.webhookFor(channelId);
        const chunks = content ? splitText(content) : [];
        if (!chunks.length && !files.length) return;

        try {
            for (let i = 0; i < Math.max(chunks.length, 1); i++) {
                const last = i === Math.max(chunks.length, 1) - 1;
                const body = { username: webhookName(username), avatar_url: avatar_url || undefined, content: chunks[i] || undefined, allowed_mentions: NO_PINGS };
                await this.rest.request('POST', `/webhooks/${hook.id}/${hook.token}`, { body, files: last ? files : [], query: { wait: 'true' } });
            }
        } catch (error) {
            if (!retried && error instanceof DiscordError && error.code === UNKNOWN_WEBHOOK) {
                this.webhooks.delete(channelId);
                return this.sendAs(channelId, { username, avatar_url, content, files }, true);
            }
            throw error;
        }
    }

    sendSystem(channelId, text, colour = COLOURS.info) {
        return this.rest.post(`/channels/${channelId}/messages`, { embeds: [{ description: truncate(text, 4000), color: colour }], allowed_mentions: NO_PINGS });
    }

    /**
     * A message written on the Panel, with its files.
     */
    async postPanelMessage(channelId, message) {
        const notes = [];
        const files = [];
        for (const file of message.attachments || []) {
            if (file.size > DISCORD_UPLOAD_LIMIT) {
                notes.push(`📎 ${file.filename} (${formatSize(file.size)}) is too big for Discord — it's on the Panel.`);
                continue;
            }
            const download = await this.panel.attachment(file.id);
            files.push({ name: file.filename, type: download.type, data: download.data });
        }

        // Split files into messages Discord will accept (10 files / ~10 MB each).
        const batches = [];
        let batch = [];
        let size = 0;
        for (const file of files) {
            if (batch.length && (batch.length >= 10 || size + file.data.length > DISCORD_UPLOAD_LIMIT)) {
                batches.push(batch);
                batch = [];
                size = 0;
            }
            batch.push(file);
            size += file.data.length;
        }
        if (batch.length) batches.push(batch);

        const content = [message.body, ...notes].filter((t) => t && String(t).trim()).join('\n\n');
        const who = { username: message.username, avatar_url: message.avatar_url };
        await this.sendAs(channelId, { ...who, content, files: batches.shift() || [] });
        for (const more of batches) await this.sendAs(channelId, { ...who, content: '', files: more });
    }

    // ------------------------------------------------------------------ Panel outbox

    /**
     * Collects and does the Panel's waiting jobs. Returns how many there were.
     */
    async pollOnce() {
        const items = await this.panel.outbox(20);
        const blocked = new Set();

        for (const item of items) {
            if (this.inFlight.has(item.id)) continue;
            const ticket = item.payload?.ticket;
            // Keep each ticket's messages in order: stop at the first one that fails.
            if (ticket && blocked.has(ticket.uuid)) continue;

            if (item.type === 'close_channel') {
                this.inFlight.add(item.id);
                this.closeChannel(item).finally(() => this.inFlight.delete(item.id));
                continue;
            }

            try {
                await this.handle(item);
                await this.panel.ack(item.id, true);
            } catch (error) {
                if (ticket) blocked.add(ticket.uuid);
                const permanent = error instanceof DiscordError && [UNKNOWN_CHANNEL, MISSING_ACCESS, MISSING_PERMISSIONS].includes(error.code);
                if (!(error instanceof RetryLater)) this.log.warn(`Job ${item.id} (${item.type}) failed: ${error.message}`);
                await this.panel.ack(item.id, false, error.message, !permanent).catch(() => null);
            }
        }

        return items.length;
    }

    async handle(item) {
        const ticket = item.payload?.ticket;
        const payload = item.payload || {};

        switch (item.type) {
            case 'create_channel': {
                if (!ticket || ticket.status === 'closed') return;
                if (ticket.discord_channel_id && (await this.channelExists(ticket.discord_channel_id))) return;

                const channel = await this.createChannel(ticket);
                const updated = (await this.panel.setChannel(ticket.uuid, channel.id)) || { ...ticket, discord_channel_id: channel.id };
                await this.postOpening(updated, channel.id);
                if (payload.reopened) await this.sendSystem(channel.id, '🔓 This ticket was reopened. Here are the last few messages:');
                for (const message of payload.recent || []) await this.postPanelMessage(channel.id, message);
                if (payload.message) await this.postPanelMessage(channel.id, payload.message);
                return;
            }
            case 'post_message': {
                if (!ticket.discord_channel_id) {
                    if (ticket.status === 'closed') return;
                    throw new RetryLater('The ticket channel has not been made yet.');
                }
                await this.postPanelMessage(ticket.discord_channel_id, payload.message);
                return;
            }
            case 'post_system': {
                if (ticket?.discord_channel_id) await this.sendSystem(ticket.discord_channel_id, payload.text);
                return;
            }
            case 'update_ticket': {
                if (!ticket?.discord_channel_id) return;
                const opener = this.state.opener(ticket.uuid);
                if (opener) {
                    await this.rest
                        .patch(`/channels/${opener.channelId}/messages/${opener.messageId}`, { embeds: [ticketEmbed(ticket, this.panelConfig.app_name)], components: ticketButtons(ticket) })
                        .catch((error) => {
                            if (!(error instanceof DiscordError && error.code === UNKNOWN_MESSAGE)) throw error;
                        });
                }
                if (payload.text) await this.sendSystem(ticket.discord_channel_id, payload.text);
                // Topic or customer changed: rename. A no-account ticket now linked to an
                // account: move it to the main category.
                const changes = {};
                const channelId = ticket.discord_channel_id;
                if (this.channelNames.has(channelId) && this.channelNames.get(channelId) !== this.channelName(ticket)) {
                    changes.name = this.channelName(ticket);
                }
                const parent = this.categoryFor(ticket);
                if (this.channelParents.has(channelId) && this.channelParents.get(channelId) !== parent && this.ticketCategories().includes(this.channelParents.get(channelId))) {
                    changes.parent_id = parent;
                    changes.lock_permissions = false;
                }
                if (Object.keys(changes).length) {
                    await this.rest
                        .patch(`/channels/${channelId}`, changes, { reason: `Support ticket ${ticket.number} updated` })
                        .then(() => {
                            if (changes.name) this.channelNames.set(channelId, changes.name);
                            if (changes.parent_id) this.channelParents.set(channelId, changes.parent_id);
                        })
                        .catch((error) => this.log.warn(`Could not rename or move the channel for ${ticket.number}: ${error.message}`));
                }
                // A newly linked Discord account: let them see their ticket.
                if (ticket.customer?.discord_id) {
                    await this.rest
                        .put(`/channels/${ticket.discord_channel_id}/permissions/${ticket.customer.discord_id}`, { type: 1, allow: String(MEMBER_ALLOW) })
                        .catch(() => null);
                }
                return;
            }
            case 'sync_roles':
                await this.syncRoles(payload);
                return;
            default:
                this.log.debug(`Ignoring unknown job type ${item.type}`);
        }
    }

    // ------------------------------------------------------------------ Roles

    /**
     * Gives or takes away the roles the Panel looks after (linked account and plan roles).
     * Any other roles the member has are never touched.
     */
    async syncRoles({ discord_id: id, roles = [], managed = [] }, current = null) {
        if (!id || !managed.length) return;

        if (!current) {
            try {
                current = (await this.rest.get(`/guilds/${this.config.guildId}/members/${id}`)).roles || [];
            } catch (error) {
                // Not in the Discord server (yet): they get their roles when they join.
                if (error instanceof DiscordError && (error.code === UNKNOWN_MEMBER || error.status === 404)) return;
                throw error;
            }
        }

        for (const role of managed) {
            const want = roles.includes(role);
            const has = current.includes(role);
            if (want === has) continue;
            const path = `/guilds/${this.config.guildId}/members/${id}/roles/${role}`;
            try {
                if (want) await this.rest.put(path, undefined, { reason: 'BerryHost account / plan' });
                else await this.rest.delete(path, { reason: 'BerryHost account / plan' });
            } catch (error) {
                if (error instanceof DiscordError && error.code === MISSING_PERMISSIONS) {
                    throw new DiscordError(403, { message: "Can't change roles: move the bot's role above the account/plan roles in Server Settings -> Roles", code: MISSING_PERMISSIONS }, 'PUT', '/roles');
                }
                if (error instanceof DiscordError && error.code === UNKNOWN_ROLE) {
                    this.log.warn(`Role ${role} doesn't exist in the Discord server. Check the role IDs on the Panel.`);
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Someone joined the Discord server: give them their roles straight away.
     */
    async onMemberAdd(member) {
        if (member.guild_id !== this.config.guildId || member.user?.bot || !this.panelConfig.role_sync) return;
        const payload = await this.panel.roles(member.user.id);
        await this.syncRoles(payload, member.roles || []);
    }

    async channelExists(channelId) {
        try {
            await this.rest.get(`/channels/${channelId}`);
            return true;
        } catch (error) {
            if (error instanceof DiscordError && (error.code === UNKNOWN_CHANNEL || error.status === 404)) return false;
            throw error;
        }
    }

    async closeChannel(item) {
        const ticket = item.payload?.ticket;
        const channelId = ticket?.discord_channel_id;
        try {
            if (channelId) {
                const reason = item.payload.reason ? ` Reason: ${item.payload.reason}` : '';
                await this.sendSystem(channelId, `🔒 Ticket closed by **${item.payload.closed_by || 'staff'}**.${reason}\nThis channel will be deleted in 10 seconds — the full conversation stays on the Panel.`, COLOURS.closed).catch(() => null);
                await this.sleep(CLOSE_DELAY_MS);
                await this.rest.delete(`/channels/${channelId}`, { reason: `Support ticket ${ticket.number} closed` }).catch((error) => {
                    if (!(error instanceof DiscordError && error.code === UNKNOWN_CHANNEL)) throw error;
                });
                this.ticketByChannel.delete(channelId);
                this.webhooks.delete(channelId);
            }
            if (ticket) this.state.setOpener(ticket.uuid, null);
            await this.panel.ack(item.id, true);
        } catch (error) {
            this.log.warn(`Could not close the channel for ${ticket?.number}: ${error.message}`);
            await this.panel.ack(item.id, false, error.message, true).catch(() => null);
        }
    }

    // ------------------------------------------------------------------ Messages from Discord

    async onMessage(message) {
        if (message.guild_id !== this.config.guildId || message.author?.bot || message.webhook_id) return;
        if (![0, 19].includes(message.type)) return;
        const parent = this.channelParents.get(message.channel_id);
        if (parent !== undefined && !this.ticketCategories().includes(parent)) return;

        const uuid = await this.ticketFor(message.channel_id);
        if (!uuid) return;

        const author = this.author(message.author, message.member);
        const body = cleanMentions(message.content, message).trim();
        const limits = this.panelConfig.limits || {};
        const allowed = limits.extensions || [];
        const maxBytes = (limits.max_kb || 8192) * 1024;
        const files = [];
        const skipped = [];

        for (const attachment of (message.attachments || []).slice(0, limits.max_files || 5)) {
            const extension = (attachment.filename.split('.').pop() || '').toLowerCase();
            if ((allowed.length && !allowed.includes(extension)) || attachment.size > maxBytes) {
                skipped.push(attachment.filename);
                continue;
            }
            try {
                const res = await this.fetch(attachment.url, { signal: AbortSignal.timeout(60000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                files.push({ name: attachment.filename, type: attachment.content_type || 'application/octet-stream', data: Buffer.from(await res.arrayBuffer()) });
            } catch (error) {
                this.log.warn(`Could not download ${attachment.filename}: ${error.message}`);
                skipped.push(attachment.filename);
            }
        }
        if ((message.attachments || []).length > (limits.max_files || 5)) skipped.push('extra files');

        if (body || files.length) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await this.panel.postMessage(uuid, author, message.id, body, files);
                    break;
                } catch (error) {
                    if (error instanceof PanelError && error.status === 404) {
                        this.ticketByChannel.delete(message.channel_id);
                        return;
                    }
                    if (error instanceof PanelError && error.status === 422) {
                        await this.notice(message, `⚠️ ${error.message}`);
                        return;
                    }
                    if (attempt === 2) {
                        this.log.error(`Could not send a message to the Panel: ${error.message}`);
                        await this.rest.put(`/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent('❌')}/@me`).catch(() => null);
                        return;
                    }
                    await this.sleep(2000 * (attempt + 1));
                }
            }
        }

        if (skipped.length) {
            await this.notice(message, `⚠️ Not sent to the Panel: ${skipped.join(', ')}. Only images, text/log files, PDFs and ZIPs up to ${Math.round(maxBytes / 1024 / 1024)} MB can be attached.`);
        }
    }

    async notice(message, text) {
        await this.rest
            .post(`/channels/${message.channel_id}/messages`, { content: text, message_reference: { message_id: message.id, fail_if_not_exists: false }, allowed_mentions: NO_PINGS })
            .catch(() => null);
    }

    // ------------------------------------------------------------------ Setup

    /**
     * The bot uses buttons only. This removes any slash commands registered by older
     * versions so they don't show up in the server.
     */
    clearCommands() {
        return this.rest.put(`/applications/${this.appId}/guilds/${this.config.guildId}/commands`, []);
    }

    /**
     * Makes sure the "Open a ticket" message is in SUPPORT_CHANNEL_ID.
     */
    async ensureSupportPanel() {
        const channelId = this.config.supportChannelId;
        if (!channelId) return;

        const saved = this.state.get('panel');
        if (saved && saved.channelId === channelId) {
            try {
                await this.rest.get(`/channels/${channelId}/messages/${saved.messageId}`);
                return;
            } catch (error) {
                if (!(error instanceof DiscordError && (error.code === UNKNOWN_MESSAGE || error.status === 404))) throw error;
            }
        }

        const message = await this.rest.post(`/channels/${channelId}/messages`, {
            ...supportPanelMessage(this.panelConfig.app_name, this.panelConfig.panel_url || this.config.panelUrl),
            allowed_mentions: NO_PINGS,
        });
        this.state.set('panel', { channelId, messageId: message.id });
        this.log.info(`Posted the "Open a ticket" message in #${channelId}.`);
    }
}
