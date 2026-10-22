import { loadConfig } from './env.js';
import { log } from './log.js';
import { DiscordRest } from './rest.js';
import { Gateway, Intents } from './gateway.js';
import { PanelClient } from './panel.js';
import { StateStore } from './state.js';
import { TicketBot } from './tickets.js';
import { INVITE_PERMISSIONS } from './format.js';

/**
 * BerryHost support tickets for Discord. Start with: node src/index.js
 */
const { config, errors } = loadConfig();
if (errors.length) {
    log.error('The bot is not set up yet. Fix these in the .env file and restart:');
    for (const error of errors) log.error(`  - ${error}`);
    process.exit(1);
}
if (typeof WebSocket === 'undefined') {
    log.error(`Node.js 22 or newer is needed (this is ${process.version}). Pick a Node.js 22 image for this server.`);
    process.exit(1);
}

const rest = new DiscordRest({ token: config.token, log });
const panel = new PanelClient({ url: config.panelUrl, secret: config.secret });
const state = new StateStore('data/state.json');
const bot = new TicketBot({ rest, panel, config, state, log });
const gateway = new Gateway({ token: config.token, rest, log });

let pollTimer = null;
let configTimer = null;
let stopping = false;
let panelDown = false;
let polling = false;

async function checkPanel() {
    try {
        const ping = await panel.ping();
        await bot.refreshConfig();
        log.info(`Connected to the Panel (${config.panelUrl}). ${ping.pending} jobs waiting.`);
    } catch (error) {
        if (error.status === 401) log.error('The Panel rejected BOT_SECRET. It must match DISCORD_BOT_SECRET in the Panel .env.');
        else if (error.status === 403) log.error('The Panel refused this IP. Add it to DISCORD_BOT_ALLOWED_IPS in the Panel .env, or leave that empty.');
        else if (error.status === 404) log.error('The Panel bot API is turned off. Set DISCORD_BOT_SECRET in the Panel .env and run "php artisan config:clear".');
        else log.error(`Could not reach the Panel at ${config.panelUrl}: ${error.message}`);
        throw error;
    }
}

async function poll() {
    if (stopping) return;
    let delay = config.pollMs;
    try {
        const count = await bot.pollOnce();
        if (panelDown) log.info('The Panel is reachable again.');
        panelDown = false;
        // Busy: check again straight away.
        if (count >= 20) delay = 250;
    } catch (error) {
        if (!panelDown) log.warn(`Could not check the Panel for new replies: ${error.message}`);
        panelDown = true;
        delay = Math.min(30000, config.pollMs * 5);
    }
    pollTimer = setTimeout(poll, delay);
}

gateway.on('READY', async (data) => {
    bot.setIdentity(data.user, gateway.applicationId);
    log.info(`Logged in to Discord as ${data.user.username} (${data.user.id}).`);
    if (!data.guilds?.some((g) => g.id === config.guildId)) {
        log.error(`The bot is not in the server ${config.guildId}. Invite it with:`);
        log.error(`  https://discord.com/oauth2/authorize?client_id=${gateway.applicationId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`);
    }
    // Buttons only: remove any slash commands an older version added.
    await bot.clearCommands().catch(() => null);
    // Start collecting the Panel's jobs once we know who we are in Discord.
    if (!polling) {
        polling = true;
        poll();
    }
});

gateway.on('GUILD_CREATE', async (guild) => {
    bot.onGuildCreate(guild);
    if (guild.id !== config.guildId) return;
    const category = (guild.channels || []).find((c) => c.id === config.categoryId);
    if (!category || category.type !== 4) log.error(`TICKET_CATEGORY_ID ${config.categoryId} is not a category in ${guild.name}.`);
    if (config.guestCategoryId && !(guild.channels || []).some((c) => c.id === config.guestCategoryId && c.type === 4)) {
        log.error(`NO_ACCOUNT_CATEGORY_ID ${config.guestCategoryId} is not a category in ${guild.name}.`);
    }
    if (!config.supportChannelId) log.warn('SUPPORT_CHANNEL_ID is not set, so there is no "Open a ticket" button in Discord. Tickets can still be opened on the Panel.');
    await bot.ensureSupportPanel().catch((error) => log.warn(`Could not post the "Open a ticket" message: ${error.message}`));
});

for (const event of ['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE']) {
    gateway.on(event, (channel) => bot.onChannelEvent(event, channel));
}

gateway.on('INTERACTION_CREATE', (interaction) => {
    bot.onInteraction(interaction).catch((error) => log.error(`Interaction error: ${error.message}`));
});

gateway.on('GUILD_MEMBER_ADD', (member) => {
    bot.onMemberAdd(member).catch((error) => log.warn(`Could not give roles to a new member: ${error.message}`));
});

gateway.on('MESSAGE_CREATE', (message) => {
    bot.onMessage(message).catch((error) => log.error(`Message error: ${error.message}`));
});

gateway.on('fatal', (code, message) => {
    log.error(`Discord closed the connection (${code}): ${message}`);
    shutdown(1);
});

function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down…');
    clearTimeout(pollTimer);
    clearInterval(configTimer);
    gateway.stop();
    setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (error) => log.error(`Unexpected error: ${error?.message || error}`));

(async () => {
    log.info('Starting the BerryHost ticket bot…');
    try {
        await checkPanel();
    } catch {
        log.warn('Carrying on anyway; the bot will keep trying to reach the Panel.');
    }
    configTimer = setInterval(() => bot.refreshConfig().catch(() => null), 60000);
    // Member join events (to give roles straight away) need Discord's Server Members intent.
    if (bot.panelConfig.role_sync) {
        gateway.intents |= Intents.GUILD_MEMBERS;
        log.info('Discord roles for linked accounts / plans are on.');
    }
    try {
        await gateway.connect();
    } catch (error) {
        log.error(`Could not connect to Discord: ${error.message}`);
        if (error.status === 401) {
            log.error('Discord rejected DISCORD_TOKEN.');
            process.exit(1);
        }
        gateway.scheduleReconnect();
    }
})();
