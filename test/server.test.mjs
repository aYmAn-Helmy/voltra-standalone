import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server.mjs';

test('protects APIs with Basic auth and forwards outlet commands safely', async () => {
  const calls = [];
  const manager = {
    status: async () => ({ bridges: [], devices: [], summary: {} }),
    list: () => [],
    request: async (id, path, options) => {
      calls.push({ id, path, options });
      return { ok: true };
    }
  };
  const server = createHttpServer({ manager, user: 'admin', password: 'secret', publicDir: '.' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = 'Basic ' + Buffer.from('admin:secret').toString('base64');
  try {
    assert.equal((await fetch(base + '/api/status')).status, 401);
    assert.equal((await fetch(base + '/api/status',
      { headers: { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })).status, 401);
    const state = await fetch(base + '/api/status', { headers: { Authorization: auth } });
    assert.equal(state.status, 200);
    const response = await fetch(base + '/api/bridges/office/devices/AABBCCDDEEFF/outlets/1/state', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: true })
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      id: 'office', path: '/devices/AABBCCDDEEFF/outlets/1/state',
      options: { method: 'POST', body: { on: true } }
    });
    const bad = await fetch(base + '/api/bridges/office/devices/AABBCCDDEEFF/outlets/5/state', {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: true })
    });
    assert.equal(bad.status, 400);
    const originBlocked = await fetch(base + '/api/bridges', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad', url: 'http://192.168.1.100:8086' })
    });
    assert.equal(originBlocked.status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});
