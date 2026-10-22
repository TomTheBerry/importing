import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_ALLOW, Permissions } from '../src/format.js';
import { PanelError } from '../src/panel.js';
import { DiscordError } from '../src/rest.js';
import { BOT_USER, CATEGORY, GUEST_CATEGORY, GUILD, STAFF_ROLE, makeBot, ticket } from './helpers.js';

const user = { id: '200000000000000001', username: 'alex', global_name: 'Alex', avatar: 'abc123' };
const interaction = (type, data, extra = {}) => ({ id: '700000000000000001', token: 'itok', type, guild_id: GUILD, channel_id: '600000000000000001', data, member: { user, roles: [] }, ...extra });

test('the "Open a ticket" button offers topics, then a form', async () => {
    const { bot, rest } = makeBot();
    await bot.refreshConfig();

    await bot.onInteraction(interaction(3, { custom_id: 'bt:start' }));
    let [call] = rest.find('POST', '/interactions/');
    assert.equal(call.body.type, 4);
    assert.equal(call.body.data.flags, 64);
    assert.equal(call.body.data.components[0].components[0].options[0].label, 'Server problem');

    await bot.onInteraction(interaction(3, { custom_id: 'bt:cat', values: ['2'] }));
    call = rest.find('POST', '/interactions/').at(-1);
    assert.equal(call.body.type, 9);
    assert.equal(call.body.data.custom_id, 'bt:new:2');
    assert.equal(call.body.data.title, 'New ticket: Server problem');
});

test('submitting the form opens a ticket with a private channel', async () => {
    const { bot, rest, panel } = makeBot();
    await bot.refreshConfig();

    await bot.onInteraction(
        interaction(5, {
            custom_id: 'bt:new:2',
            components: [{ components: [{ custom_id: 'subject', value: ' Lag ' }] }, { components: [{ custom_id: 'message', value: 'My server lags a lot.' }] }],
        })
    );

    assert.deepEqual(panel.calls[0], {
        name: 'createTicket',
        args: { author: { id: user.id, name: 'Alex', avatar: `https://cdn.discordapp.com/avatars/${user.id}/abc123.png?size=128` }, categoryId: 2, subject: 'Lag', message: 'My server lags a lot.' },
    });

    const [channel] = rest.find('POST', `/guilds/${GUILD}/channels`);
    // No Panel account: kept apart from customer tickets.
    assert.equal(channel.body.name, 'ticket-0042', 'The Panel decides the name.');
    assert.equal(channel.body.parent_id, GUEST_CATEGORY);
    const overwrites = Object.fromEntries(channel.body.permission_overwrites.map((o) => [o.id, o]));
    assert.equal(overwrites[GUILD].deny, String(Permissions.VIEW_CHANNEL), 'Everyone else is kept out.');
    assert.equal(overwrites[STAFF_ROLE].allow, String(MEMBER_ALLOW));
    assert.equal(overwrites[user.id].allow, String(MEMBER_ALLOW));
    assert.equal(overwrites[BOT_USER].type, 1);

    assert.equal(panel.calls[1].name, 'setChannel');
    // Ticket card, then the customer's message posted with their own name and picture.
    const opener = rest.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages') && c.body.embeds);
    assert.equal(opener.body.embeds[0].title, '#0042 · Lag');
    // Staff are pinged, the customer never is.
    assert.equal(opener.body.content, `<@&${STAFF_ROLE}>`);
    assert.deepEqual(opener.body.allowed_mentions, { parse: [], users: [], roles: [STAFF_ROLE] });
    const hook = rest.calls.find((c) => c.method === 'POST' && c.path.startsWith('/webhooks/') && c.query?.wait);
    assert.equal(hook.body.username, 'Alex');
    assert.equal(hook.body.content, 'My server lags a lot.');
    assert.deepEqual(hook.body.allowed_mentions, { parse: [] });

    const done = rest.find('PATCH', '/webhooks/300000000000000001/itok/messages/@original').at(-1);
    assert.match(done.body.content, /Your ticket \*\*#0042\*\* is open: <#\d+>/);
});

test('the Panel refusing a ticket shows its reason', async () => {
    const { bot, rest, panel } = makeBot();
    panel.fail.createTicket = new PanelError(422, 'You already have 5 open tickets.');

    await bot.onInteraction(interaction(5, { custom_id: 'bt:new:0', components: [] }));

    assert.equal(rest.find('PATCH', '/webhooks/').at(-1).body.content, '⚠️ You already have 5 open tickets.');
    assert.equal(rest.find('POST', `/guilds/${GUILD}/channels`).length, 0);
});

test('messages in ticket channels go to the Panel, with staff detected by role', async () => {
    const fetched = [];
    const { bot, panel, rest } = makeBot({ fetchImpl: async (url) => (fetched.push(url), new Response('log contents')) });
    await bot.refreshConfig();
    panel.tickets.set('600000000000000009', ticket({ discord_channel_id: '600000000000000009' }));
    bot.onChannelEvent('CHANNEL_CREATE', { id: '600000000000000009', parent_id: CATEGORY, guild_id: GUILD });

    await bot.onMessage({
        id: '800000000000000001',
        type: 0,
        guild_id: GUILD,
        channel_id: '600000000000000009',
        author: { id: '200000000000000002', username: 'helper' },
        member: { roles: [STAFF_ROLE], nick: 'Helper' },
        content: 'Hi <@200000000000000001>, try this',
        mentions: [{ id: '200000000000000001', username: 'alex' }],
        attachments: [
            { filename: 'latest.log', size: 100, url: 'https://cdn.discordapp.com/a/latest.log', content_type: 'text/plain' },
            { filename: 'virus.exe', size: 100, url: 'https://cdn.discordapp.com/a/virus.exe' },
        ],
    });

    const post = panel.calls.find((c) => c.name === 'postMessage').args;
    assert.equal(post.uuid, ticket().uuid);
    assert.equal(post.author.staff, true);
    assert.equal(post.author.name, 'Helper');
    assert.equal(post.body, 'Hi @alex, try this');
    assert.equal(post.messageId, '800000000000000001');
    assert.deepEqual(post.files.map((f) => f.name), ['latest.log']);
    assert.deepEqual(fetched, ['https://cdn.discordapp.com/a/latest.log']);
    // The file that couldn't be sent is explained.
    assert.match(rest.find('POST', '/channels/600000000000000009/messages').at(-1).body.content, /Not sent to the Panel: virus\.exe/);
});

test('bots, webhooks and other channels are ignored', async () => {
    const { bot, panel } = makeBot();
    bot.onChannelEvent('CHANNEL_CREATE', { id: '600000000000000010', parent_id: '999999999999999999', guild_id: GUILD });
    const base = { id: '1', type: 0, guild_id: GUILD, channel_id: '600000000000000009', author: { id: '2', username: 'x' }, content: 'hi', attachments: [] };

    await bot.onMessage({ ...base, author: { id: '3', bot: true } });
    await bot.onMessage({ ...base, webhook_id: '5' });
    await bot.onMessage({ ...base, channel_id: '600000000000000010' });
    await bot.onMessage({ ...base, guild_id: '1' });
    assert.equal(panel.calls.length, 0);

    // Unknown channel: asked once, then remembered for a minute.
    await bot.onMessage(base);
    await bot.onMessage(base);
    assert.equal(panel.calls.filter((c) => c.name === 'byChannel').length, 1);
});

test('replies the Panel refuses get a visible warning', async () => {
    const { bot, panel, rest } = makeBot();
    panel.tickets.set('600000000000000009', ticket());
    panel.postMessage = async () => {
        throw new PanelError(422, 'Only the person who opened this ticket and staff can reply to it.');
    };

    await bot.onMessage({ id: '1', type: 0, guild_id: GUILD, channel_id: '600000000000000009', author: { id: '2', username: 'x' }, content: 'hi', attachments: [] });
    assert.match(rest.find('POST', '/channels/600000000000000009/messages').at(-1).body.content, /Only the person/);
});

test('Panel jobs: new channel, then a reply with files, in order', async () => {
    const { bot, panel, rest } = makeBot();
    const t = ticket();
    panel.items = [
        { id: 1, type: 'create_channel', payload: { ticket: t, message: { id: 5, username: 'alex', avatar_url: null, staff: false, body: 'First message', attachments: [] } } },
        { id: 2, type: 'post_message', payload: { ticket: { ...t, discord_channel_id: '900000000000000001' }, message: { id: 6, username: 'sam • Support', avatar_url: 'https://panel.test/avatars/x/public', staff: true, body: 'Try this', attachments: [{ id: 'att-1', filename: 'fix.txt', size: 10, mime: 'text/plain' }] } } },
    ];

    await bot.pollOnce();

    assert.deepEqual(panel.acks.map((a) => [a.id, a.ok]), [[1, true], [2, true]]);
    assert.equal(rest.find('POST', `/guilds/${GUILD}/channels`).length, 1);
    const hooks = rest.calls.filter((c) => c.path.startsWith('/webhooks/') && c.method === 'POST');
    assert.equal(hooks[0].body.content, 'First message');
    assert.equal(hooks[1].body.username, 'sam • Support');
    assert.equal(hooks[1].files[0].name, 'fix.txt');
    assert.equal(hooks[1].files[0].data.toString(), 'file-att-1');
});

test('a reply waits for its channel, and a failure holds back that ticket\'s later jobs', async () => {
    const { bot, panel, rest } = makeBot();
    const t = ticket();
    const other = ticket({ uuid: '99999999-2222-3333-4444-555555555555', discord_channel_id: '900000000000000002' });
    panel.items = [
        { id: 1, type: 'post_message', payload: { ticket: t, message: { body: 'a', attachments: [] } } },
        { id: 2, type: 'post_message', payload: { ticket: { ...t, discord_channel_id: '900000000000000001' }, message: { body: 'b', attachments: [] } } },
        { id: 3, type: 'post_message', payload: { ticket: other, message: { username: 'x', body: 'c', attachments: [] } } },
    ];

    await bot.pollOnce();

    assert.deepEqual(panel.acks, [
        { id: 1, ok: false, error: 'The ticket channel has not been made yet.', retry: true },
        { id: 3, ok: true, error: null, retry: true },
    ]);
    assert.equal(rest.calls.filter((c) => c.path.startsWith('/webhooks/') && c.method === 'POST').length, 1);
});

test('a deleted channel stops retries instead of trying forever', async () => {
    const { bot, panel, rest } = makeBot();
    rest.on('GET', '/channels/900000000000000001/webhooks', () => {
        throw new DiscordError(404, { message: 'Unknown Channel', code: 10003 }, 'GET', '/channels');
    });
    panel.items = [{ id: 1, type: 'post_message', payload: { ticket: ticket({ discord_channel_id: '900000000000000001' }), message: { body: 'x', attachments: [] } } }];

    await bot.pollOnce();
    assert.equal(panel.acks[0].ok, false);
    assert.equal(panel.acks[0].retry, false);
});

test('closing posts a notice, deletes the channel and forgets it', async () => {
    const { bot, panel, rest } = makeBot();
    bot.state.setOpener(ticket().uuid, { channelId: '900000000000000001', messageId: '1' });
    panel.items = [{ id: 7, type: 'close_channel', payload: { ticket: ticket({ status: 'closed', discord_channel_id: '900000000000000001' }), reason: 'Solved', closed_by: 'sam' } }];

    await bot.pollOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.match(rest.find('POST', '/channels/900000000000000001/messages')[0].body.embeds[0].description, /closed by \*\*sam\*\*\. Reason: Solved/);
    assert.equal(rest.find('DELETE', '/channels/900000000000000001').length, 1);
    assert.equal(bot.state.opener(ticket().uuid), null);
    assert.deepEqual(panel.acks, [{ id: 7, ok: true, error: null, retry: true }]);
});

test('ticket changes update the card and let a newly linked customer in', async () => {
    const { bot, panel, rest } = makeBot();
    bot.state.setOpener(ticket().uuid, { channelId: '900000000000000001', messageId: '42' });
    panel.items = [{ id: 1, type: 'update_ticket', payload: { ticket: ticket({ discord_channel_id: '900000000000000001', assigned_to: 'sam' }), text: 'sam is now handling this ticket.' } }];

    await bot.pollOnce();

    const edit = rest.find('PATCH', '/channels/900000000000000001/messages/42')[0];
    assert.equal(edit.body.embeds[0].fields.find((f) => f.name === 'Handled by').value, 'sam');
    assert.equal(edit.body.components[0].components[0].label, 'Take over');
    assert.equal(rest.find('POST', '/channels/900000000000000001/messages')[0].body.embeds[0].description, 'sam is now handling this ticket.');
    assert.equal(rest.find('PUT', '/channels/900000000000000001/permissions/200000000000000001')[0].body.allow, String(MEMBER_ALLOW));
});

test('close and claim buttons go through the Panel', async () => {
    const { bot, panel, rest } = makeBot();
    const uuid = ticket().uuid;

    await bot.onInteraction(interaction(3, { custom_id: `bt:close:${uuid}` }));
    assert.equal(rest.find('POST', '/interactions/').at(-1).body.data.components[0].components[0].custom_id, `bt:closeyes:${uuid}`);
    assert.equal(panel.calls.length, 0, 'Asks first.');

    await bot.onInteraction(interaction(3, { custom_id: `bt:closeyes:${uuid}` }, { member: { user, roles: [STAFF_ROLE] } }));
    assert.deepEqual(panel.calls.at(-1), { name: 'close', args: { uuid, author: { id: user.id, name: 'Alex', avatar: `https://cdn.discordapp.com/avatars/${user.id}/abc123.png?size=128`, staff: true }, reason: null } });

    panel.fail.claim = new PanelError(422, 'Link your Discord account to your staff account on the Panel (Account → Connections) to claim tickets.');
    await bot.onInteraction(interaction(3, { custom_id: `bt:claim:${uuid}` }));
    assert.match(rest.find('PATCH', '/webhooks/').at(-1).body.content, /Link your Discord account/);

    await bot.onInteraction(interaction(3, { custom_id: 'bt:close:not-a-uuid' }));
    assert.equal(rest.find('POST', '/interactions/').at(-1).body.data.content, 'This button has expired.');
});

test('there are no slash commands: old ones are removed', async () => {
    const { bot, rest } = makeBot();
    await bot.clearCommands();
    const [call] = rest.find('PUT', `/applications/300000000000000001/guilds/${GUILD}/commands`);
    assert.deepEqual(call.body, []);

    await bot.onInteraction(interaction(2, { name: 'close', options: [] }));
    assert.equal(rest.find('POST', '/interactions/').at(-1).body.data.content, 'Use the buttons on the ticket instead.');
    assert.equal(rest.find('POST', `/guilds/${GUILD}/channels`).length, 0);
});

test('tickets from linked customers go in the main category, staff pinged and never the customer', async () => {
    const { bot, rest, panel } = makeBot();
    panel.items = [{ id: 1, type: 'create_channel', payload: { ticket: ticket(), message: { username: 'alex', body: 'Help', attachments: [] } } }];

    await bot.pollOnce();

    const [channel] = rest.find('POST', `/guilds/${GUILD}/channels`);
    assert.equal(channel.body.name, 'ticket-0042');
    assert.equal(channel.body.parent_id, CATEGORY);
    // They can still see their ticket because their Discord is linked.
    assert.ok(channel.body.permission_overwrites.some((o) => o.id === '200000000000000001' && o.type === 1));
    const opener = rest.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages') && c.body.embeds);
    assert.ok(!opener.body.content.includes('200000000000000001'));
    assert.deepEqual(opener.body.allowed_mentions.users, []);
});

test('a no-account ticket moves to the main category once linked to an account', async () => {
    const { bot, rest, panel } = makeBot();
    bot.onChannelEvent('CHANNEL_CREATE', { id: '900000000000000001', parent_id: GUEST_CATEGORY, guild_id: GUILD });
    panel.items = [{ id: 1, type: 'update_ticket', payload: { ticket: ticket({ discord_channel_id: '900000000000000001' }) } }];

    await bot.pollOnce();

    const move = rest.find('PATCH', '/channels/900000000000000001').find((c) => c.path === '/channels/900000000000000001');
    assert.deepEqual(move.body, { parent_id: CATEGORY, name: 'ticket-0042', lock_permissions: false });
});

test('messages in the no-account category are synced too', async () => {
    const { bot, panel } = makeBot();
    panel.tickets.set('600000000000000009', ticket());
    bot.onChannelEvent('CHANNEL_CREATE', { id: '600000000000000009', parent_id: GUEST_CATEGORY, guild_id: GUILD });

    await bot.onMessage({ id: '1', type: 0, guild_id: GUILD, channel_id: '600000000000000009', author: { id: '2', username: 'x' }, content: 'hi', attachments: [] });
    assert.equal(panel.calls.filter((c) => c.name === 'postMessage').length, 1);
});

test('the support message is posted once and re-posted if deleted', async () => {
    const { bot, rest } = makeBot({ config: { supportChannelId: '600000000000000020' } });

    await bot.ensureSupportPanel();
    assert.equal(rest.find('POST', '/channels/600000000000000020/messages').length, 1);
    const saved = bot.state.get('panel');

    rest.on('GET', `/channels/600000000000000020/messages/${saved.messageId}`, () => ({ id: saved.messageId }));
    await bot.ensureSupportPanel();
    assert.equal(rest.find('POST', '/channels/600000000000000020/messages').length, 1);

    rest.on('GET', `/channels/600000000000000020/messages/${saved.messageId}`, () => {
        throw new DiscordError(404, { message: 'Unknown Message', code: 10008 }, 'GET', '/');
    });
    await bot.ensureSupportPanel();
    assert.equal(rest.find('POST', '/channels/600000000000000020/messages').length, 2);
});

test('the channel is renamed when the topic or customer changes', async () => {
    const { bot, rest, panel } = makeBot();
    bot.onGuildCreate({ id: GUILD, channels: [{ id: '900000000000000001', name: 'other-alex-0042', parent_id: CATEGORY }] });
    panel.items = [{ id: 1, type: 'update_ticket', payload: { ticket: ticket({ discord_channel_id: '900000000000000001', channel_name: 'billing-payments-alex-0042' }) } }];

    await bot.pollOnce();
    const rename = rest.calls.find((c) => c.method === 'PATCH' && c.path === '/channels/900000000000000001');
    assert.deepEqual(rename.body, { name: 'billing-payments-alex-0042' });

    // Nothing changed: no rename (Discord only allows 2 renames per 10 minutes).
    panel.items.push({ id: 2, type: 'update_ticket', payload: { ticket: ticket({ discord_channel_id: '900000000000000001', channel_name: 'billing-payments-alex-0042' }) } });
    await bot.pollOnce();
    assert.equal(rest.calls.filter((c) => c.method === 'PATCH' && c.path === '/channels/900000000000000001').length, 1);
});

test('role sync only adds and removes the roles the Panel looks after', async () => {
    const { bot, rest } = makeBot();
    rest.on('GET', `/guilds/${GUILD}/members/200000000000000001`, () => ({ roles: ['400000000000000002', '999999999999999999'] }));

    await bot.syncRoles({ discord_id: '200000000000000001', roles: ['400000000000000001'], managed: ['400000000000000001', '400000000000000002', '400000000000000003'] });

    assert.deepEqual(rest.find('PUT', `/guilds/${GUILD}/members/`).map((c) => c.path), [`/guilds/${GUILD}/members/200000000000000001/roles/400000000000000001`]);
    assert.deepEqual(rest.find('DELETE', `/guilds/${GUILD}/members/`).map((c) => c.path), [`/guilds/${GUILD}/members/200000000000000001/roles/400000000000000002`]);
    // The hand-given role 999… is never touched.
    assert.ok(!rest.calls.some((c) => c.path.endsWith('999999999999999999')));
});

test('role sync for someone not in the Discord server does nothing', async () => {
    const { bot, rest, panel } = makeBot();
    rest.on('GET', `/guilds/${GUILD}/members/`, () => {
        throw new DiscordError(404, { message: 'Unknown Member', code: 10007 }, 'GET', '/members');
    });
    panel.items = [{ id: 1, type: 'sync_roles', payload: { discord_id: '200000000000000001', roles: ['400000000000000001'], managed: ['400000000000000001'] } }];

    await bot.pollOnce();
    assert.deepEqual(panel.acks, [{ id: 1, ok: true, error: null, retry: true }]);
    assert.equal(rest.find('PUT', `/guilds/${GUILD}/members/`).length, 0);
});

test('a role the bot is not allowed to give stops with a clear message', async () => {
    const { bot, rest, panel } = makeBot();
    rest.on('GET', `/guilds/${GUILD}/members/`, () => ({ roles: [] }));
    rest.on('PUT', `/guilds/${GUILD}/members/`, () => {
        throw new DiscordError(403, { message: 'Missing Permissions', code: 50013 }, 'PUT', '/roles');
    });
    panel.items = [{ id: 1, type: 'sync_roles', payload: { discord_id: '200000000000000001', roles: ['400000000000000001'], managed: ['400000000000000001'] } }];

    await bot.pollOnce();
    assert.equal(panel.acks[0].ok, false);
    assert.equal(panel.acks[0].retry, false);
    assert.match(panel.acks[0].error, /move the bot's role above/);
});

test('people joining the Discord server get their roles straight away', async () => {
    const { bot, rest, panel } = makeBot();
    await bot.refreshConfig();
    bot.panelConfig.role_sync = true;

    await bot.onMemberAdd({ guild_id: GUILD, user: { id: '200000000000000001' }, roles: [] });

    assert.equal(panel.calls.at(-1).name, 'roles');
    assert.deepEqual(rest.find('PUT', `/guilds/${GUILD}/members/`).map((c) => c.path), [`/guilds/${GUILD}/members/200000000000000001/roles/400000000000000001`]);
    assert.equal(rest.find('GET', `/guilds/${GUILD}/members/`).length, 0, 'Uses the roles from the join event.');
});
