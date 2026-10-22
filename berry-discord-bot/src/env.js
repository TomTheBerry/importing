import { existsSync, readFileSync } from 'node:fs';

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Reads a .env file (KEY=value per line). Quotes around values are removed, and lines
 * starting with # are ignored.
 */
export function parseEnv(text) {
    const values = {};
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else {
            // Allow "value # comment" for unquoted values.
            value = value.replace(/\s+#.*$/, '');
        }
        values[match[1]] = value;
    }

    return values;
}

const list = (value) =>
    String(value || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

/**
 * Builds the bot's settings from the environment (and .env file, which never
 * overrides variables already set, e.g. by the Ptero egg).
 *
 * @returns {{ config: object, errors: string[] }}
 */
export function loadConfig(env = process.env, file = '.env') {
    const fromFile = file && existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
    const get = (key) => {
        const value = env[key] !== undefined && env[key] !== '' ? env[key] : fromFile[key];
        return value === undefined ? '' : String(value).trim();
    };

    const config = {
        token: get('DISCORD_TOKEN'),
        guildId: get('GUILD_ID'),
        categoryId: get('TICKET_CATEGORY_ID'),
        guestCategoryId: get('NO_ACCOUNT_CATEGORY_ID') || null,
        staffRoleIds: list(get('STAFF_ROLE_IDS')),
        pingRoleId: get('SUPPORT_PING_ROLE_ID') || null,
        supportChannelId: get('SUPPORT_CHANNEL_ID') || null,
        panelUrl: get('PANEL_URL').replace(/\/+$/, ''),
        secret: get('BOT_SECRET'),
        pollMs: Math.max(1000, Number(get('POLL_INTERVAL_MS')) || 2000),
        debug: ['1', 'true'].includes(get('DEBUG')),
    };

    const errors = [];
    if (!config.token) errors.push('DISCORD_TOKEN is missing (Developer Portal -> Bot -> Reset Token).');
    if (!SNOWFLAKE.test(config.guildId)) errors.push('GUILD_ID must be your Discord server ID.');
    if (!SNOWFLAKE.test(config.categoryId)) errors.push('TICKET_CATEGORY_ID must be the ID of the category for ticket channels.');
    if (!config.staffRoleIds.length) errors.push('STAFF_ROLE_IDS needs at least one staff role ID.');
    for (const id of config.staffRoleIds) if (!SNOWFLAKE.test(id)) errors.push(`STAFF_ROLE_IDS: "${id}" is not a role ID.`);
    if (config.guestCategoryId && !SNOWFLAKE.test(config.guestCategoryId)) errors.push('NO_ACCOUNT_CATEGORY_ID must be the ID of a category.');
    if (config.pingRoleId && !SNOWFLAKE.test(config.pingRoleId)) errors.push('SUPPORT_PING_ROLE_ID must be a role ID.');
    if (config.supportChannelId && !SNOWFLAKE.test(config.supportChannelId)) errors.push('SUPPORT_CHANNEL_ID must be a channel ID.');
    if (!/^https?:\/\/[^\s/]+/.test(config.panelUrl)) errors.push('PANEL_URL must be your Panel address, e.g. https://panel.theberryhost.com');
    else if (config.panelUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(config.panelUrl)) {
        errors.push('PANEL_URL must use https:// so the bot secret is never sent unencrypted.');
    }
    if (config.secret.length < 32) errors.push('BOT_SECRET must be the same value as DISCORD_BOT_SECRET in the Panel .env (at least 32 characters).');

    return { config, errors };
}
