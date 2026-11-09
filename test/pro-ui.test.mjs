import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const htmlFile = new URL('../public/index.html', import.meta.url);
const scriptFile = new URL('../public/pro-ui.js', import.meta.url);

async function makePage() {
  const html = await readFile(htmlFile, 'utf8');
  const script = await readFile(scriptFile, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://appassets.androidplatform.net/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const themeCalls = [], scans = [];
  window.VoltraAndroid = { setTheme: value => themeCalls.push(value) };
  window.VoltraMobile = { scanNow: silent => scans.push(silent) };
  window.scrollTo = () => {};
  window.eval(script);
  return { window, dom, themeCalls, scans };
}
function fixtureCard(document, key) {
  const card = document.createElement('article');
  card.className = 'device';
  card.dataset.deviceKey = key;
  card.innerHTML = '<div class="device-head"><div><h3 class="device-title">Test</h3></div></div>' +
    '<details class="device-advanced"><summary>إعدادات الجهاز</summary>' +
    '<form><input name="deviceName" value="Unsaved name"></form></details>';
  document.getElementById('device-list').append(card);
  return card;
}
const data = (total = 1) => ({
  summary: { bridges: total, bridgesOnline: total, devices: total,
    devicesOnline: total, outletsOn: total, powerW: 12, energyWh: 250 },
  bridges: [], devices: []
});

test('Voltra Pro creates accessible four-tab Android navigation and overview', async () => {
  const { window, dom } = await makePage();
  try {
    assert.equal(window.document.documentElement.classList.contains('voltra-pro'), true);
    assert.equal(window.document.documentElement.dataset.page, 'home');
    const nav = [...window.document.querySelectorAll('.vp-nav-button')];
    assert.deepEqual(nav.map(x => x.textContent.trim()), ['الرئيسية', 'المشتركات', 'الشبكة', 'الإعدادات']);
    assert.equal(nav[0].getAttribute('aria-current'), 'page');
    assert.ok(window.document.querySelector('.vp-hero-title'));
    assert.ok(window.document.querySelector('.vp-welcome'));
    assert.ok(window.document.querySelector('.vp-settings-page'));
    nav[1].click();
    assert.equal(window.VoltraPro.page, 'devices');
    assert.equal(nav[1].getAttribute('aria-current'), 'page');
    nav[2].click();
    assert.equal(window.VoltraPro.page, 'network');
    const scanBtn = window.document.getElementById('vp-main-scan');
    scanBtn.click();
    assert.equal(scans.length, 1, 'real Wi-Fi scan action is connected');
  } finally { dom.window.close(); }
});

test('first launch onboarding and live summary reflect real device totals', async () => {
  const { window, dom } = await makePage();
  try {
    window.VoltraPro.update(data(0));
    assert.equal(window.document.querySelector('.vp-welcome').hidden, false);
    window.VoltraPro.update(data(3));
    assert.equal(window.document.querySelector('.vp-welcome').hidden, true);
    assert.match(window.document.querySelector('.vp-hero-title').textContent, /3 من 3/);
  } finally { dom.window.close(); }
});

test('favorites persist and the favorites-only filter is user-controlled', async () => {
  const { window, dom } = await makePage();
  try {
    const card = fixtureCard(window.document, 'auto_MAC:AABB');
    window.VoltraPro.update(data());
    const star = card.querySelector('.vp-favorite');
    assert.ok(star);
    assert.equal(star.getAttribute('aria-pressed'), 'false');
    star.click();
    assert.equal(star.getAttribute('aria-pressed'), 'true');
    const saved = JSON.parse(window.localStorage.getItem('voltra.pro.preferences.v1'));
    assert.ok(saved.favorites.includes('auto_MAC:AABB'));
    const filter = window.document.getElementById('vp-favorites-toggle');
    filter.click();
    assert.equal(filter.getAttribute('aria-pressed'), 'true');
    assert.equal(card.hidden, false);
    star.click();
    assert.equal(card.hidden, true);
  } finally { dom.window.close(); }
});

test('background refresh does not detach a focused advanced-settings form', async () => {
  const { window, dom } = await makePage();
  try {
    const one = fixtureCard(window.document, 'source1:AABB');
    fixtureCard(window.document, 'source2:CCDD');
    const details = one.querySelector('details');
    details.open = true;
    const input = one.querySelector('input');
    input.focus();
    input.value = 'My uncommitted edit';
    assert.equal(window.document.activeElement, input);
    window.VoltraPro.update(data(2));
    assert.equal(input.isConnected, true);
    assert.equal(window.document.activeElement, input);
    assert.equal(input.value, 'My uncommitted edit');
  } finally { dom.window.close(); }
});

test('theme and automatic discovery settings persist and change actual behavior', async () => {
  const { window, dom, themeCalls } = await makePage();
  try {
    window.VoltraPro.showPage('settings');
    window.document.getElementById('vp-theme-button').click();
    assert.equal(window.document.documentElement.dataset.theme, 'light');
    assert.ok(themeCalls.includes('light'));
    window.document.getElementById('vp-autoscan-toggle').click();
    assert.equal(window.VoltraPro.autoScanEnabled, false);
    const persisted = JSON.parse(window.localStorage.getItem('voltra.pro.preferences.v1'));
    assert.equal(persisted.autoscan, false);
    assert.equal(persisted.theme, 'light');
  } finally { dom.window.close(); }
});

test('scan state uses actual progress counts rather than fake animation numbers', async () => {
  const { window, dom } = await makePage();
  try {
    window.VoltraPro.setScanState(true, 'جاري البحث');
    const scan = window.document.getElementById('vp-main-scan');
    assert.equal(scan.disabled, true);
    window.VoltraPro.updateDiscoveryProgress({ scanned: 112, total: 253 });
    assert.match(window.document.querySelector('.vp-scan-message').textContent, /112 من 253/);
    window.VoltraPro.updateDiscoveryProgress({ scanned: -100, total: 253 });
    assert.match(window.document.querySelector('.vp-scan-message').textContent, /112 من 253/);
    window.VoltraPro.setScanState(false, 'تم الانتهاء');
    assert.equal(scan.disabled, false);
    assert.match(window.document.querySelector('.vp-scan-message').textContent, /تم الانتهاء/);
  } finally { dom.window.close(); }
});
