import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../powera/web/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../powera/web/app.js', import.meta.url), 'utf8');
const MAC_STOCK = 'stock:AABBCCDDEEFF', MAC_STAND = 'standalone:001122334455';
const device = (id, type, name) => ({
  id, type, name, mac: id.split(':')[1], online: true, controlAvailable: true,
  firmware: type, voltageV: 220, powerW: 120, currentA: .5, energyKwh: 1.75,
  outlets: [1, 2, 3, 4].map(index => ({
    index, name: 'Outlet ' + index, on: index === 1,
    powerW: index === 1 ? 120 : 0, energyKwh: .5, temperatureC: 26
  }))
});

async function createApp() {
  const dom = new JSDOM(html, { url: 'http://192.168.1.2:8098/', runScripts: 'outside-only' });
  const { window } = dom;
  const requests = [];
  let snapshots = 0;
  window.confirm = () => true;
  window.prompt = () => '15';
  window.scrollTo = () => {};
  window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    let result;
    const method = options.method || 'GET';
    if (url === '/api/status') {
      snapshots++;
      result = {
        devices: [device(MAC_STOCK, 'stock', 'Office'), device(MAC_STAND, 'standalone', 'Living Room')],
        summary: { devices: 2, online: 2, outletsOn: 2, powerW: 240 },
        pricePerKwh: 2.25
      };
    } else if (url === '/api/rooms') {
      result = method === 'GET' ? { rooms: [] } : { ok: true };
    } else if (url === '/api/notifications') {
      result = { notifications: [] };
    } else if (url === '/api/schedules') {
      result = method === 'GET' ? { schedules: [] } : { id: 1, nextRunAt: '2026-11-13T18:00:00Z' };
    } else if (url === '/api/timers') {
      result = method === 'GET' ? { timers: [] } : { ok: true, dueAt: '2026-11-11T19:00:00Z' };
    } else if (String(url).startsWith('/api/history')) {
      result = { history: [1, 2, 3, 4].flatMap(outlet =>
        [1, 2, 3].map(i => ({
          at: '2026-11-11T17:0' + i + ':00Z',
          outlet, power_w: i * 10 * outlet, energy_kwh: i / 100
        }))) };
    } else if (url === '/api/control') {
      result = { ok: true, confirmed: true };
    } else {
      result = { ok: true };
    }
    return { ok: true, status: 200, json: async () => result };
  };
  window.eval(script);
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  };
  await settle();
  return { window, dom, requests, settle, get snapshots() { return snapshots; } };
}

test('PowerA initial home has unified Stock and Standalone devices with outlet charts', async () => {
  const { window, dom } = await createApp();
  try {
    assert.equal(window.document.querySelectorAll('.device-card').length, 2);
    assert.equal(window.document.querySelectorAll('.outlet-card').length, 8);
    assert.equal(window.document.querySelectorAll('.power-bar-row').length, 8);
    assert.equal(window.document.getElementById('device-total').textContent, '2');
    assert.equal(window.document.querySelector('#token-input'), null,
      'No access token or login field');
  } finally { dom.window.close(); }
});

test('favorites survive renders and can filter across firmware types', async () => {
  const { window, dom } = await createApp();
  try {
    const star = window.document.querySelector('.favorite-star');
    star.click();
    const saved = JSON.parse(window.localStorage.getItem('powera.favorites.v1'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0], MAC_STOCK);
    const filter = window.document.querySelector('#fav-only');
    filter.click();
    assert.equal(window.document.querySelectorAll('.device-card').length, 1);
    assert.equal(filter.getAttribute('aria-pressed'), 'true');
    filter.click();
    assert.equal(window.document.querySelectorAll('.device-card').length, 2);
  } finally { dom.window.close(); }
});

test('whole outlet card acts on one tap without token; nested tools do not toggle', async () => {
  const { window, dom, requests, settle } = await createApp();
  try {
    const tile = window.document.querySelector('.outlet-card');
    assert.equal(tile.getAttribute('role'),'button');
    tile.querySelector('.tile-tools button').click(); // opens name editor only
    await settle();
    assert.equal(requests.filter(r => r.url === '/api/control').length, 0);
    tile.click();
    await settle();
    const controls = requests.filter(r => r.url === '/api/control');
    assert.equal(controls.length, 1);
    assert.equal(controls[0].options.headers['X-PowerA-Client'], 'PowerA');
    assert.equal(Object.hasOwn(controls[0].options.headers, 'X-PowerA-Token'), false);
    assert.deepEqual(JSON.parse(controls[0].options.body), {
      deviceId: MAC_STOCK, outlet: 1, on: false, confirm: false
    });
  } finally { dom.window.close(); }
});

test('visual Smart Timer chooses time, submits timezone and selected weekdays', async () => {
  const { window, dom, requests, settle } = await createApp();
  try {
    window.document.querySelector('.tab[data-page="schedules"]').click();
    await settle();
    assert.equal(window.document.querySelector('#schedule-device').options.length, 2);
    window.document.querySelector('#schedule-repeat').value = 'weekly';
    window.document.querySelector('#schedule-repeat').dispatchEvent(new window.Event('change'));
    assert.equal(window.document.querySelector('#weekday-wrap').hidden, false);
    const wednesday = window.document.querySelector('#weekday-wrap input[value="2"]');
    wednesday.checked = true;
    const hours = window.document.querySelector('#smart-timeline .smart-hour');
    hours.click();
    assert.equal(window.document.querySelector('#schedule-clock').value, '00:00');
    window.document.querySelector('#schedule-zone').value = 'Africa/Cairo';
    window.document.querySelector('#schedule-form').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const schedules = requests.filter(r => r.url === '/api/schedules' && r.options.method === 'POST');
    assert.equal(schedules.length, 1);
    const body = JSON.parse(schedules[0].options.body);
    assert.equal(body.confirm, true);
    assert.equal(body.clock, '00:00');
    assert.equal(body.timezone, 'Africa/Cairo');
    assert.deepEqual(body.weekdays, [2]);
    assert.equal(body.repeat, 'weekly');
  } finally { dom.window.close(); }
});

test('saved historical readings render offline SVG charts, not fictitious samples', async () => {
  const { window, dom, settle } = await createApp();
  try {
    const history = [...window.document.querySelectorAll('button')].find(x =>
      x.textContent === 'عرض سجل الاستهلاك');
    assert.ok(history);
    history.click();
    await settle();
    const graph = window.document.querySelector('.history-chart svg');
    assert.ok(graph);
    assert.equal(graph.querySelectorAll('path').length, 4);
    assert.ok(graph.getAttribute('aria-label').includes('الوات'));
  } finally { dom.window.close(); }
});
