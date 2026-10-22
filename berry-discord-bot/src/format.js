/**
 * Messages, embeds and buttons the bot shows in Discord, plus small text helpers.
 */
export const Permissions = {
    ADD_REACTIONS: 1n << 6n,
    ADMINISTRATOR: 1n << 3n,
    MANAGE_CHANNELS: 1n << 4n,
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
    EMBED_LINKS: 1n << 14n,
    ATTACH_FILES: 1n << 15n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    MANAGE_ROLES: 1n << 28n,
    MANAGE_WEBHOOKS: 1n << 29n,
    USE_APPLICATION_COMMANDS: 1n << 31n,
};

const P = Permissions;

// What the customer and staff can do in a ticket channel.
export const MEMBER_ALLOW = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS | P.ATTACH_FILES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS | P.USE_APPLICATION_COMMANDS;
export const BOT_ALLOW = MEMBER_ALLOW | P.MANAGE_CHANNELS | P.MANAGE_WEBHOOKS | P.MANAGE_MESSAGES;

// Permissions to give the bot's role when inviting it.
export const INVITE_PERMISSIONS = P.MANAGE_CHANNELS | P.MANAGE_ROLES | P.MANAGE_WEBHOOKS | P.MANAGE_MESSAGES | MEMBER_ALLOW;

export const COLOURS = { brand: 0xd6336c, open: 0xf0b429, answered: 0x3ebd93, closed: 0x7b8794, info: 0x3c8dbc };

export const MAX_MESSAGE = 2000;

/**
 * Splits long text into Discord-sized pieces, preferring to break at new lines.
 */
export function splitText(text, size = MAX_MESSAGE) {
    const chunks = [];
    let rest = String(text || '');
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
        if (cut < size / 2) cut = size;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length || !chunks.length) chunks.push(rest);

    return chunks;
}

/**
 * Turns <@123> style mentions in a Discord message into readable names for the Panel.
 */
export function cleanMentions(content, message = {}) {
    const users = new Map((message.mentions || []).map((u) => [u.id, displayName(u, u.member)]));
    const roles = message.roleNames || new Map();
    const channels = message.channelNames || new Map();

    return String(content || '')
        .replace(/<@!?(\d+)>/g, (m, id) => `@${users.get(id) || 'user'}`)
        .replace(/<@&(\d+)>/g, (m, id) => `@${roles.get(id) || 'role'}`)
        .replace(/<#(\d+)>/g, (m, id) => `#${channels.get(id) || 'channel'}`)
        .replace(/<a?:(\w+):\d+>/g, ':$1:')
        .replace(/<t:(\d+)(?::\w)?>/g, (m, s) => new Date(Number(s) * 1000).toUTCString());
}

export function displayName(user, member) {
    return (member && member.nick) || user.global_name || user.username || 'Discord user';
}

export function avatarUrl(user) {
    if (!user || !user.avatar) return null;
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';

    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

/**
 * Webhook names can't contain "discord" or "clyde" and must be 1-80 characters.
 */
export function webhookName(name) {
    const clean = String(name || '')
        .replace(/discord/gi, 'Dsc')
        .replace(/clyde/gi, 'Clyd')
        .replace(/[@#:`]/g, '')
        .trim();

    return (clean || 'Member').slice(0, 80);
}

const statusText = { open: 'Waiting for staff', answered: 'Waiting for customer', closed: 'Closed' };
const priorityText = { low: 'Low', normal: 'Normal', high: '🟠 High', urgent: '🔴 Urgent' };

/**
 * The pinned message at the top of every ticket channel.
 */
export function ticketEmbed(ticket, appName = 'TheBerryHost') {
    const customer = ticket.customer?.discord_id ? `<@${ticket.customer.discord_id}>` : ticket.customer?.name || 'Unknown';
    const fields = [
        { name: 'Customer', value: `${customer}${ticket.customer?.guest ? ' · no Panel account' : ''}`, inline: true },
        { name: 'Topic', value: ticket.category || 'Not chosen', inline: true },
        { name: 'Priority', value: priorityText[ticket.priority] || ticket.priority, inline: true },
        { name: 'Status', value: statusText[ticket.status] || ticket.status, inline: true },
        { name: 'Handled by', value: ticket.assigned_to || 'Nobody yet', inline: true },
    ];
    if (ticket.server) fields.push({ name: 'Server', value: `${ticket.server.name} (\`${ticket.server.uuid}\`)`, inline: true });

    return {
        title: `${ticket.number} · ${truncate(ticket.subject, 200)}`,
        color: ticket.status === 'closed' ? COLOURS.closed : ticket.status === 'answered' ? COLOURS.answered : COLOURS.open,
        fields,
        footer: { text: `${appName} Support · Messages here are kept in sync with the Panel` },
    };
}

export function ticketButtons(ticket) {
    const row = [
        { type: 2, style: 2, label: ticket.assigned_to ? 'Take over' : 'Claim', emoji: { name: '🙋' }, custom_id: `bt:claim:${ticket.uuid}` },
        { type: 2, style: 4, label: 'Close', emoji: { name: '🔒' }, custom_id: `bt:close:${ticket.uuid}` },
    ];
    if (ticket.panel_url) row.push({ type: 2, style: 5, label: 'Staff: open on Panel', url: ticket.panel_url });

    return [{ type: 1, components: row }];
}

export function supportPanelMessage(appName, panelUrl) {
    return {
        embeds: [
            {
                title: 'Need help? Open a ticket',
                description:
                    `Press the button below to open a private ticket with the ${appName} team. ` +
                    'Only you and our staff can see it.\n\n' +
                    `You can also open and reply to tickets on the Panel: ${panelUrl}/support\n\n` +
                    '**Never share your password or card details** — our staff will never ask for them.',
                color: COLOURS.brand,
            },
        ],
        components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Open a ticket', emoji: { name: '🎫' }, custom_id: 'bt:start' }] }],
    };
}

export function categorySelect(categories) {
    return [
        {
            type: 1,
            components: [
                {
                    type: 3,
                    custom_id: 'bt:cat',
                    placeholder: 'What do you need help with?',
                    options: categories.slice(0, 25).map((c) => ({
                        label: truncate(c.name, 100),
                        value: String(c.id),
                        description: c.description ? truncate(c.description, 100) : undefined,
                        emoji: c.emoji ? { name: c.emoji } : undefined,
                    })),
                },
            ],
        },
    ];
}

export function ticketModal(categoryId, categoryName) {
    return {
        custom_id: `bt:new:${categoryId || 0}`,
        title: truncate(categoryName ? `New ticket: ${categoryName}` : 'Open a ticket', 45),
        components: [
            { type: 1, components: [{ type: 4, custom_id: 'subject', label: 'Subject', style: 1, min_length: 3, max_length: 120, required: true, placeholder: 'e.g. My server crashes when players join' }] },
            {
                type: 1,
                components: [
                    { type: 4, custom_id: 'message', label: 'What happened?', style: 2, min_length: 5, max_length: 4000, required: true, placeholder: 'Tell us what happened and anything you have already tried.' },
                ],
            },
        ],
    };
}

export function truncate(text, length) {
    const value = String(text || '');
    return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
