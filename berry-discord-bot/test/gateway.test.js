import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, DEFAULT_INTENTS } from '../src/gateway.js';
import { quiet } from '../src/log.js';

class FakeSocket {
    static all = [];

    constructor(url) {
        this.url = url;
        this.sent = [];
        this.readyState = 1;
        FakeSocket.all.push(this);
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close(code) {
        this.readyState = 3;
        this.closedWith = code;
    }

    receive(payload) {
        this.onmessage({ data: JSON.stringify(payload) });
    }
}

const rest = { get: async () => ({ url: 'wss://gateway.test' }) };

test('identifies with the ticket intents and resumes after a reconnect request', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeSocket.all = [];
    const gateway = new Gateway({ token: 'tok', rest, WebSocketImpl: FakeSocket, log: quiet, random: () => 0 });
    const events = [];
    gateway.on('MESSAGE_CREATE', (d) => events.push(d));

    await gateway.connect();
    const ws = FakeSocket.all[0];
    assert.equal(ws.url, 'wss://gateway.test/?v=10&encoding=json');

    ws.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    assert.equal(ws.sent[0].op, 2);
    assert.equal(ws.sent[0].d.intents, DEFAULT_INTENTS);
    assert.equal(DEFAULT_INTENTS, 33281);

    ws.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://resume.test', user: { id: '9', username: 'bot' }, application: { id: '8' } } });
    assert.equal(gateway.applicationId, '8');
    ws.receive({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1' } });
    assert.deepEqual(events, [{ id: 'm1' }]);

    // Heartbeats carry the last sequence number.
    t.mock.timers.tick(1);
    assert.deepEqual(ws.sent.at(-1), { op: 1, d: 2 });
    ws.receive({ op: 11 });

    // Discord asks us to reconnect: we resume the same session on the resume URL.
    ws.receive({ op: 7, d: null });
    assert.equal(ws.closedWith, 4000);
    t.mock.timers.tick(5000);
    await new Promise((r) => setImmediate(r));
    const next = FakeSocket.all[1];
    assert.equal(next.url, 'wss://resume.test/?v=10&encoding=json');
    next.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    assert.deepEqual(next.sent[0], { op: 6, d: { token: 'tok', session_id: 'sess', seq: 2 } });
    gateway.stop();
});

test('a missed heartbeat reconnects, and a fatal close code stops with a clear message', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    FakeSocket.all = [];
    const gateway = new Gateway({ token: 'tok', rest, WebSocketImpl: FakeSocket, log: quiet, random: () => 0 });
    await gateway.connect();
    const ws = FakeSocket.all[0];
    ws.receive({ op: 10, d: { heartbeat_interval: 1000 } });

    t.mock.timers.tick(1); // first beat
    t.mock.timers.tick(1000); // no ACK came back
    assert.equal(ws.closedWith, 4000);

    t.mock.timers.tick(5000);
    await new Promise((r) => setImmediate(r));
    const next = FakeSocket.all[1];
    let fatal = null;
    gateway.on('fatal', (code, message) => (fatal = { code, message }));
    next.onclose({ code: 4014, reason: 'Disallowed intent(s).' });
    assert.equal(fatal.code, 4014);
    assert.match(fatal.message, /MESSAGE CONTENT INTENT/);
    t.mock.timers.tick(60000);
    assert.equal(FakeSocket.all.length, 2, 'No reconnect after a fatal error.');
});
