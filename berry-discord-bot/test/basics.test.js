import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, loadConfig } from '../src/env.js';
import { splitText, cleanMentions, webhookName, ticketEmbed, INVITE_PERMISSIONS, MEMBER_ALLOW, Permissions } from '../src/format.js';
import { DiscordRest, DiscordError } from '../src/rest.js';
import { PanelClient, PanelError } from '../src/panel.js';
import { ticket } from './helpers.js';

const valid = {
    DISCORD_TOKEN: 'abc',
    GUILD_ID: '100000000000000001',
    TICKET_CATEGORY_ID: '100000000000000002',
    STAFF_ROLE_IDS: '100000000000000003, 100000000000000004',
    PANEL_URL: 'https://panel.theberryhost.com/',
    BOT_SECRET: 'y'.repeat(64),
};

test('reads .env files', () => {
    const values = parseEnv('# comment\nA=1\nexport B="two words"\nC=\'x\'\nD=value # note\n\nbad line\n');
    assert.deepEqual(values, { A: '1', B: 'two words', C: 'x', D: 'value' });
});

test('checks the settings and explains what is wrong', () => {
    const ok = loadConfig(valid, null);
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.config.staffRoleIds, ['100000000000000003', '100000000000000004']);
    assert.equal(ok.config.panelUrl, 'https://panel.theberryhost.com');

    const bad = loadConfig({ ...valid, GUILD_ID: 'abc', BOT_SECRET: 'short', PANEL_URL: 'http://panel.example.com', STAFF_ROLE_IDS: '' }, null);
    assert.equal(bad.errors.length, 4);
    assert.ok(bad.errors.some((e) => e.includes('https://')));
    // Local addresses may use http (e.g. when the bot runs next to the Panel).
    assert.deepEqual(loadConfig({ ...valid, PANEL_URL: 'http://127.0.0.1:8080' }, null).errors, []);
});

test('splits long messages for Discord', () => {
    assert.deepEqual(splitText('hello'), ['hello']);
    const long = ('line '.repeat(30) + '\n').repeat(30);
    const parts = splitText(long);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 2000));
    assert.equal(parts.join('\n').replace(/\n/g, '').length, long.replace(/\n/g, '').length);
    assert.ok(splitText('x'.repeat(4500)).every((p) => p.length <= 2000));
});

test('turns mentions into names and makes webhook names safe', () => {
    const text = cleanMentions('Hi <@123> and <@!456>, see <#789> <:berry:1111> <@&999>', {
        mentions: [{ id: '123', username: 'alex' }, { id: '456', username: 'sam', global_name: 'Sammy' }],
    });
    assert.equal(text, 'Hi @alex and @Sammy, see #channel :berry: @role');
    assert.equal(webhookName('discord pro'), 'Dsc pro');
    assert.equal(webhookName('@#'), 'Member');
    assert.equal(webhookName('a'.repeat(100)).length, 80);
});

test('the ticket card shows the important details', () => {
    const embed = ticketEmbed(ticket({ status: 'answered', priority: 'urgent', assigned_to: 'staffy' }));
    assert.equal(embed.title, '#0042 · Server will not start');
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.equal(fields.Customer, '<@200000000000000001>');
    assert.equal(fields.Priority, '🔴 Urgent');
    assert.equal(fields['Handled by'], 'staffy');
});

test('permission numbers are right', () => {
    assert.equal(MEMBER_ALLOW & Permissions.VIEW_CHANNEL, Permissions.VIEW_CHANNEL);
    assert.equal(MEMBER_ALLOW & Permissions.MANAGE_CHANNELS, 0n);
    assert.equal(INVITE_PERMISSIONS & Permissions.MANAGE_ROLES, Permissions.MANAGE_ROLES);
    assert.equal(INVITE_PERMISSIONS & Permissions.ADMINISTRATOR, 0n);
});

test('rate limit buckets keep only the important IDs', () => {
    assert.equal(DiscordRest.bucketKey('POST', '/channels/123456789012345678/messages'), 'POST /channels/123456789012345678/messages');
    assert.equal(
        DiscordRest.bucketKey('PATCH', '/channels/123456789012345678/messages/223456789012345678'),
        'PATCH /channels/123456789012345678/messages/:id'
    );
});

test('REST client waits and retries when rate limited', async () => {
    const calls = [];
    const waits = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) return new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429 });
        return new Response(JSON.stringify({ id: '1' }), { status: 200 });
    };
    const rest = new DiscordRest({ token: 't', fetchImpl, sleep: async (ms) => waits.push(ms) });

    const result = await rest.post('/channels/123456789012345678/messages', { content: 'hi' });
    assert.deepEqual(result, { id: '1' });
    assert.equal(calls.length, 2);
    assert.ok(waits[0] >= 500);
    assert.equal(calls[1].init.headers.Authorization, 'Bot t');
    assert.equal(calls[1].init.body, JSON.stringify({ content: 'hi' }));
});

test('REST client sends files as multipart and reports errors', async () => {
    let sent;
    const rest = new DiscordRest({
        token: 't',
        sleep: async () => {},
        fetchImpl: async (url, init) => {
            sent = init.body;
            return new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 });
        },
    });

    await assert.rejects(
        rest.request('POST', '/webhooks/1/abc', { body: { content: 'x' }, files: [{ name: 'a.txt', type: 'text/plain', data: Buffer.from('hi') }] }),
        (error) => error instanceof DiscordError && error.code === 50013 && error.status === 403
    );
    assert.ok(sent instanceof FormData);
    assert.deepEqual(JSON.parse(sent.get('payload_json')).attachments, [{ id: 0, filename: 'a.txt' }]);
    assert.equal(await sent.get('files[0]').text(), 'hi');
});

test('Panel client sends the secret and explains errors', async () => {
    const seen = [];
    const panel = new PanelClient({
        url: 'https://panel.test/',
        secret: 's3cret',
        fetchImpl: async (url, init) => {
            seen.push({ url, init });
            if (url.endsWith('/tickets/by-channel/1')) return new Response('{}', { status: 404 });
            return new Response(JSON.stringify({ error: 'Only the person who opened this ticket and staff can reply to it.' }), { status: 422 });
        },
    });

    assert.equal(await panel.byChannel('1'), null);
    await assert.rejects(panel.close('u', { id: '1', name: 'x' }), (e) => e instanceof PanelError && e.status === 422 && e.message.startsWith('Only the person'));
    assert.equal(seen[0].url, 'https://panel.test/api/discord-bot/tickets/by-channel/1');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer s3cret');
});
