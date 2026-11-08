'use strict';

const $ = id => document.getElementById(id);
const view = { data: null, loading: false, busy: new Set(), toastTimer: null, lastPollAt: 0 };

function el(tag, className, label) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (label !== undefined) n.textContent = label;
  return n;
}
function button(label, kind, fn, disabled = false) {
  const b = el('button', 'btn ' + (kind || 'secondary'), label);
  b.type = 'button'; b.disabled = disabled;
  b.addEventListener('click', fn);
  return b;
}
function fmt(value, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? '—' :
    Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function notify(message, error = false) {
  const n = $('toast');
  n.textContent = message; n.hidden = false; n.className = 'toast' + (error ? ' error' : '');
  clearTimeout(view.toastTimer); view.toastTimer = setTimeout(() => { n.hidden = true; }, 4200);
}
async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error('استجابة غير صحيحة من السيرفر'); }
  if (!response.ok) throw new Error(data.error || 'فشل الاتصال بالسيرفر');
  return data;
}
async function act(path, method = 'POST', body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const result = await api(path, opts);
  // An old firmware snapshot must not undo a newly confirmed command while
  // waiting for the following SSE frame.
  globalThis.VoltraLive?.invalidateCommand(path);
  await refresh();
  return result;
}
function reset(node) { node.replaceChildren(); }
function pathFor(b, d) {
  return '/api/bridges/' + encodeURIComponent(b) + '/devices/' + encodeURIComponent(d);
}
function details(node, text) { node.append(el('p', 'device-sub', text)); }
function renderSummary(data) {
  const s = data.summary;
  $('stat-devices').textContent = String(s.devices);
  $('stat-online').textContent = s.devicesOnline + ' Online / ' + (s.devices - s.devicesOnline) + ' Offline';
  $('stat-bridges').textContent = String(s.bridges);
  $('stat-bridges-online').textContent = s.bridgesOnline + ' متصل من ' + s.bridges;
  $('stat-power').textContent = fmt(s.powerW) + ' W';
  $('stat-energy').textContent = fmt(s.energyWh, 2) + ' Wh';
  $('outlet-count').textContent = s.outletsOn + ' مخارج تعمل';
  $('health-dot').classList.toggle('ok', s.bridges > 0 && s.bridgesOnline > 0);
  $('health').textContent = s.bridges === 0 ? 'لم يتم إضافة مصادر' :
    s.bridgesOnline === s.bridges ? 'كل المصادر متصلة' :
    s.bridgesOnline + '/' + s.bridges + ' Bridge متصلة';
}
function renderFilter(data) {
  const select = $('bridge-filter'), selected = select.value;
  reset(select);
  const all = el('option', '', 'كل المصادر'); all.value = 'all'; select.append(all);
  for (const b of data.bridges) {
    const option = el('option', '', b.name); option.value = b.id; select.append(option);
  }
  select.value = [...select.options].some(o => o.value === selected) ? selected : 'all';
}
function showQr(b) {
  $('qr-title').textContent = 'Matter • ' + b.name;
  $('qr-code').textContent = b.commissioning?.manualPairingCode || '—';
  $('qr-image').src = '/api/bridges/' + encodeURIComponent(b.id) + '/qr.svg?ts=' + Date.now();
  $('qr-dialog').showModal();
}
async function reconnect(b) {
  if (!confirm('إعادة ربط Matter على ' + b.name + ' هتحتاج تعمل Pairing من جديد مع كل المنصات. متأكد؟')) return;
  try {
    await act('/api/bridges/' + encodeURIComponent(b.id) + '/matter/reconnect', 'POST', { confirm: true });
    notify('تمت إعادة تهيئة Matter. افتح QR Code لعمل Pairing جديد.');
  } catch (e) { notify(e.message, true); }
}
async function removeBridge(b) {
  if (!confirm('إزالة ' + b.name + ' من Voltra فقط؟ مش هيتم حذف الأجهزة من السيرفر الأصلي.')) return;
  try {
    await act('/api/bridges/' + encodeURIComponent(b.id), 'DELETE');
    notify('تم حذف المصدر من Voltra');
  } catch (e) { notify(e.message, true); }
}
function renderBridges(data) {
  const container = $('bridge-list'); reset(container);
  if (!data.bridges.length) {
    container.append(el('div', 'empty compact', 'ضيف IP المشترك Standalone أو رابط MatterBridge لعرض الأجهزة.'));
    return;
  }
  for (const b of data.bridges) {
    const card = el('article', 'bridge');
    const top = el('div', 'bridge-top');
    top.append(el('div', 'bridge-name', b.name), el('span', 'state ' + (b.online ? 'online' : 'offline'), b.online ? '● Online' : '● Offline'));
    card.append(top, el('p', 'bridge-url', b.url));
    if (b.type === 'standalone') {
      const indicator = el('div', 'bridge-stream', '◌ SSE: جاري الاتصال');
      indicator.dataset.bridgeId = b.id;
      const state = [...globalThis.VoltraLive.states.entries()].find(([k]) =>
        k.startsWith(b.id + ':'))?.[1];
      indicator.textContent = b.online ? (state?.connected ? '● SSE Live' : '◌ HTTP fallback') : '● Offline';
      indicator.classList.toggle('connected', !!state?.connected);
      card.append(indicator);
    }
    const meta = el('div', 'bridge-meta');
    meta.append(el('span', '', b.devices.length + ' مشترك'), el('span', '', b.type === 'standalone' ? 'Standalone • Direct LAN' : (b.type === 'matterbridge' ? (b.commissioning?.commissioned ? 'Matter paired' : 'Matter not paired') : 'النوع غير معروف')));
    card.append(meta);
    if (!b.online && b.error) card.append(el('p', 'alert', b.error));
    const actions = el('div', 'bridge-actions');
    if (b.type === 'standalone') {
      const link = el('a', 'btn tiny secondary', 'الداشبورد المحلية');
      link.href = b.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      actions.append(link);
    } else if (b.type === 'matterbridge') {
      if (!b.commissioning?.commissioned) {
        actions.append(button('QR / Pairing', 'tiny primary', () => showQr(b), !b.online));
      } else {
        actions.append(button('إعادة ربط Matter', 'tiny secondary', () => reconnect(b), !b.online));
      }
    }
    actions.append(button('إزالة المصدر', 'tiny danger', () => removeBridge(b)));
    card.append(actions);
    container.append(card);
  }
}
async function outletAction(device, outlet, toggle) {
  const key = device.bridgeId + ':' + device.id + ':' + outlet.index;
  if (view.busy.has(key)) return;
  view.busy.add(key); toggle.disabled = true;
  try {
    await act(pathFor(device.bridgeId, device.id) + '/outlets/' + outlet.index + '/state',
      'POST', { on: !outlet.on });
    notify('تم تحديث حالة المخرج ' + outlet.index);
  } catch (e) { notify(e.message, true); }
  finally { view.busy.delete(key); toggle.disabled = false; }
}
function drawOutlet(d, o) {
  const box = el('div', 'outlet'), header = el('div', 'outlet-head');
  box.dataset.outletIndex = String(o.index);
  box.classList.toggle('outlet-on', o.on === true);
  const toggle = el('button', 'switch' + (o.on ? ' on' : ''));
  toggle.type = 'button'; toggle.disabled = !d.reachable;
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(o.on));
  toggle.setAttribute('aria-label', 'تشغيل أو إيقاف المخرج ' + o.index + ' في ' + d.name);
  toggle.addEventListener('click', () => outletAction(d, o, toggle));
  toggle.disabled = !d.reachable || d.controlAvailable === false || o.on === null;
  header.append(el('span', '', o.name || 'مخرج ' + o.index), toggle);
  box.append(header);
  const power = el('div', 'measure', fmt(o.powerW) + ' ');
  power.append(el('small', '', 'W'));
  box.append(power, el('div', 'submeasure', fmt(o.energyWh, 2) + ' Wh • ' + fmt(o.temperatureC, 0) + ' °C'));
  if (o.currentA != null) box.append(el('div', 'submeasure', fmt(o.currentA, 3) + ' A'));
  const locked = el('div', 'outlet-lock', o.locked ? '🔒 الزر الفيزيائي مقفول' : '🔓 الزر متاح');
  box.append(locked);
  const status = el('span', 'outlet-state', o.on === true ? 'ON' : o.on === false ? 'OFF' : '—');
  box.append(status);
  if (o.overheatProtection || o.overloadProtection) box.append(el('p', 'alert',
    o.overheatProtection ? 'تنبيه: حماية الحرارة' : 'تنبيه: حماية الحمل'));
  return box;
}
async function deviceRefresh(d) {
  try { await act(pathFor(d.bridgeId, d.id) + '/refresh', 'POST', {}); notify('تم تحديث الجهاز'); }
  catch (e) { notify(e.message, true); }
}
async function removeDevice(d) {
  if (!confirm('حذف ' + d.name + ' من سجل الـBridge الأصلية؟ الجهاز قد يظهر مرة أخرى عند إعادة اتصاله.')) return;
  try { await act(pathFor(d.bridgeId, d.id), 'DELETE'); notify('تم حذف الجهاز من سجل الـBridge'); }
  catch (e) { notify(e.message, true); }
}
function renderDevices(data) {
  const target = $('device-list');
  // Do not detach a focused, unsaved settings form on background HTTP refresh.
  // Device telemetry is patched in place, and any new cards appear on the next
  // refresh after the user leaves the form.
  const activeForm = document.activeElement?.closest?.('details.device-advanced');
  if (activeForm?.open) {
    for (const d of data.devices) {
      if (d.sourceType === 'standalone') patchLiveCard(d);
    }
    return;
  }
  // Preserve expanded management panels and unsaved inputs across 5-second polling.
  const savedPanels = new Map([...target.querySelectorAll('details.device-advanced')]
    .map(panel => [panel.dataset.deviceKey, panel]));
  reset(target);
  const query = $('search').value.trim().toLowerCase();
  const source = $('bridge-filter').value, status = $('status-filter').value;
  const devices = data.devices.filter(d =>
    (source === 'all' || d.bridgeId === source) &&
    (status === 'all' || (d.reachable ? 'online' : 'offline') === status) &&
    (!query || [d.name, d.id, d.firmwareVersion, d.bridgeName]
      .some(value => String(value ?? '').toLowerCase().includes(query)))
  );
  $('device-count').textContent = String(devices.length);
  if (!devices.length) {
    target.append(el('div', 'empty', data.bridges.length ? 'مافيش أجهزة مطابقة للبحث أو الفلاتر.' : 'ضيف IP مشترك Standalone أو Bridge من القائمة الجانبية علشان تبدأ.'));
    return;
  }
  for (const d of devices) {
    const card = el('article', 'device'), head = el('div', 'device-head');
    card.dataset.deviceKey = d.bridgeId + ':' + d.id;
    card.classList.toggle('device-live', !!d.streamConnected);
  const status = card.querySelector('.device-actions .state');
  if (status) {
    status.textContent = d.reachable ? '● Online' : '● Offline';
    status.className = 'state ' + (d.reachable ? 'online' : 'offline');
  }
    const info = el('div');
    info.append(el('h3', 'device-title', d.name));
    details(info, 'MAC / ID: ' + d.id + '   •   FW: ' + (d.firmwareVersion || '—') + '   •   Source: ' + d.bridgeName);
    if (d.sourceType === 'standalone') {
      info.append(el('p', 'device-live-telemetry',
        '⚡ ' + fmt(d.outlets.reduce((sum, o) => sum + (o.powerW || 0), 0)) +
        ' W  •  ' + fmt(d.voltageV) + ' V  •  ' + fmt(d.currentA, 3) +
        ' A  •  Wi-Fi ' + (d.rssi == null ? '—' : d.rssi + ' dBm')));
      if (d.protection?.reason || d.protection?.error) info.append(el('div', 'alert', '⚠️ تنبيه حماية / حساسات؛ افتح الداشبورد المحلية للتفاصيل'));
      if (d.controlAvailable === false && d.reachable) info.append(el('div', 'alert', 'الهاردوير غير جاهز للتحكم'));
    }
    const actions = el('div', 'device-actions');
    actions.append(el('span', 'state ' + (d.reachable ? 'online' : 'offline'), d.reachable ? '● Online' : '● Offline'));
    if (d.sourceType === 'standalone') {
      const live = el('span', 'device-live-label' + (d.streamConnected ? ' connected' : ''),
        d.streamConnected ? '● SSE مباشر' : '◌ HTTP احتياطي');
      live.title = 'SSE مباشر من Firmware أو تحديث احتياطي عبر HTTP';
      actions.append(live);
    }
    actions.append(button('↻ تحديث', 'tiny secondary', () => deviceRefresh(d), !d.reachable));
    if (d.sourceType === 'standalone') {
      const all = on => {
        if (!confirm((on ? 'تشغيل' : 'إيقاف') + ' كل مخارج ' + d.name + '؟')) return;
        act(pathFor(d.bridgeId, d.id) + '/outlets/5/state', 'POST', { on })
          .then(() => notify('تم تأكيد حالة كل المخارج'))
          .catch(e => notify(e.message, true));
      };
      actions.append(button('تشغيل الكل', 'tiny primary', () => all(true),
        !d.reachable || d.controlAvailable === false));
      actions.append(button('إيقاف الكل', 'tiny danger', () => all(false),
        !d.reachable || d.controlAvailable === false));
    }
    if (!d.reachable && d.sourceType !== 'standalone') actions.append(button('حذف الجهاز', 'tiny danger', () => removeDevice(d)));
    head.append(info, actions); card.append(head);
    const outlets = el('div', 'outlets');
    for (const o of d.outlets) outlets.append(drawOutlet(d, o));
    card.append(outlets);
    if (d.sourceType === 'standalone') {
      const trend = el('div', 'power-trend');
      const head = el('div', 'power-trend-header');
      head.append(el('span', '', '⚡ اتجاه القدرة • آخر 60 قراءة'), el('strong', 'power-trend-value', 'في انتظار SSE'));
      const canvas = el('canvas', 'power-canvas');
      canvas.width = 360; canvas.height = 64;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'تاريخ قصير لاستهلاك القدرة من أحداث SSE');
      trend.append(head, canvas);
      card.append(trend);
    }
    if (d.sourceType === 'standalone') {
      const key = d.bridgeId + ':' + d.id;
      const panel = savedPanels.get(key) || globalThis.VoltraSettings.create(d, refresh);
      card.append(panel);
    }
    target.append(card);
    if (d.sourceType === 'standalone') drawPowerTrend(d, card);
  }
}

function liveTotals(data) {
  const active = data.devices.filter(d => d.reachable).flatMap(d => d.outlets);
  data.summary.outletsOn = active.filter(o => o.on === true).length;
  data.summary.powerW = active.reduce((sum, o) => sum + (o.powerW ?? 0), 0);
  data.summary.energyWh = active.reduce((sum, o) => sum + (o.energyWh ?? 0), 0);
}

function drawPowerTrend(d, card) {
  const canvas = card.querySelector('canvas.power-canvas');
  if (!canvas || !globalThis.VoltraLive?.samples) return;
  const samples = globalThis.VoltraLive.samples(d.bridgeId, d.id);
  const current = card.querySelector('.power-trend-value');
  if (current) current.textContent = samples.length ? fmt(samples[samples.length - 1].powerW) + ' W' : 'في انتظار SSE';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pad = 6;
  ctx.strokeStyle = '#2a3f50';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, h - pad); ctx.stroke();
  if (!samples.length) return;
  const max = Math.max(10, ...samples.map(s => s.powerW));
  const coords = samples.map((s, i) => ({
    x: pad + (samples.length === 1 ? 0.5 : i / (samples.length - 1)) * (w - 2 * pad),
    y: h - pad - Math.max(0, s.powerW / max) * (h - 2 * pad)
  }));
  ctx.beginPath(); ctx.moveTo(coords[0].x, h - pad);
  for (const pt of coords) ctx.lineTo(pt.x, pt.y);
  ctx.lineTo(coords[coords.length - 1].x, h - pad); ctx.closePath();
  ctx.fillStyle = 'rgba(71, 230, 177, 0.10)'; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (const pt of coords.slice(1)) ctx.lineTo(pt.x, pt.y);
  ctx.strokeStyle = '#47e6b1'; ctx.lineWidth = 2; ctx.stroke();
  const last = coords[coords.length - 1];
  ctx.beginPath(); ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#9af9d6'; ctx.fill();
  canvas.setAttribute('aria-label', 'اتجاه القدرة: آخر ' + samples.length +
    ' قراءة، أحدث قراءة ' + fmt(samples[samples.length - 1].powerW) + ' وات');
}
function patchLiveCard(d) {
  const card = [...$('device-list').querySelectorAll('article.device')].find(node =>
    node.dataset.deviceKey === d.bridgeId + ':' + d.id);
  if (!card) return;
  card.classList.toggle('device-live', !!d.streamConnected);
  const heading = card.querySelector('.device-title');
  if (heading) heading.textContent = d.name;
  const summary = card.querySelector('.device-live-telemetry');
  if (summary) summary.textContent = '⚡ ' +
    fmt(d.outlets.reduce((sum, o) => sum + (o.powerW ?? 0), 0)) + ' W • ' +
    fmt(d.voltageV) + ' V • ' + fmt(d.currentA, 3) + ' A • Wi-Fi ' +
    (d.rssi == null ? '—' : d.rssi + ' dBm');
  const label = card.querySelector('.device-live-label');
  if (label) {
    label.classList.toggle('connected', !!d.streamConnected);
    label.textContent = d.streamConnected ? '● SSE مباشر' : '◌ HTTP احتياطي';
    label.title = d.streamConnected ? 'بيانات حية من الجهاز' : 'جارٍ استخدام التحديث الدوري';
  }
  for (const o of d.outlets) {
    const tile = [...card.querySelectorAll('.outlet')].find(n => n.dataset.outletIndex === String(o.index));
    if (!tile) continue;
    tile.classList.toggle('outlet-on', o.on === true);
    const name = tile.querySelector('.outlet-head span');
    if (name) name.textContent = o.name || 'مخرج ' + o.index;
    const toggle = tile.querySelector('button.switch');
    if (toggle) {
      toggle.classList.toggle('on', o.on === true);
      toggle.setAttribute('aria-checked', String(o.on === true));
      const busy = view.busy.has(d.bridgeId + ':' + d.id + ':' + o.index);
      toggle.disabled = busy || !d.reachable || !d.controlAvailable || o.on === null;
    }
    const watts = tile.querySelector('.measure');
    if (watts) watts.replaceChildren(document.createTextNode(fmt(o.powerW) + ' '), el('small', '', 'W'));
    const sub = tile.querySelector('.submeasure');
    if (sub) sub.textContent = fmt(o.energyWh, 2) + ' Wh • ' + fmt(o.temperatureC, 0) + ' °C';
    const amp = tile.querySelectorAll('.submeasure')[1];
    if (amp) amp.textContent = fmt(o.currentA, 3) + ' A';
    const lock = tile.querySelector('.outlet-lock');
    if (lock) lock.textContent = o.locked ? '🔒 الزر الفيزيائي مقفول' : '🔓 الزر متاح';
    const state = tile.querySelector('.outlet-state');
    if (state) state.textContent = o.on === true ? 'ON' : o.on === false ? 'OFF' : '—';
  }
  drawPowerTrend(d, card);
}
function patchSourceIndicator(x) {
  if (!view.data) return;
  const d = view.data.devices.find(device => device.bridgeId === x.bridgeId &&
    device.id === x.deviceId);
  if (d) {
    d.streamConnected = x.connected === true;
    patchLiveCard(d);
    if (globalThis.VoltraSettings?.updateLive) globalThis.VoltraSettings.updateLive(d, 'source', {});
  }
  const label = [...document.querySelectorAll('.bridge-stream')].find(el => el.dataset.bridgeId === x.bridgeId);
  if (label) {
    label.textContent = x.connected ? '● SSE Live' : '◌ HTTP fallback';
    label.classList.toggle('connected', !!x.connected);
  }
  updateStreamSummary();
}
function updateStreamSummary() {
  const count = globalThis.VoltraLive.liveCount();
  const total = view.data?.devices.filter(d => d.sourceType === 'standalone' && d.reachable).length ?? 0;
  $('stream-summary').textContent = count
    ? '● SSE مباشر: ' + count + '/' + total + ' مشترك'
    : '◌ SSE غير متاح • تحديث HTTP احتياطي';
  $('stream-summary').classList.toggle('connected', count > 0);
}
function onLiveEvent(kind, envelope) {
  if (!view.data || !globalThis.VoltraLive.receive(kind, envelope, view.data.devices)) return;
  const d = view.data.devices.find(d => d.bridgeId === envelope.bridgeId && d.id === envelope.deviceId);
  if (!d) return;
  if (globalThis.VoltraSettings?.observe) globalThis.VoltraSettings.observe(d);
  if (globalThis.VoltraSettings?.updateLive) globalThis.VoltraSettings.updateLive(d, kind, envelope.snapshot);
  patchLiveCard(d);
  liveTotals(view.data);
  renderSummary(view.data);
  updateStreamSummary();
}
function render(data) {
  globalThis.VoltraLive.hydrate(data);
  view.data = data;
  if (globalThis.VoltraSettings?.observe) {
    for (const device of data.devices) {
      if (device.sourceType === 'standalone') globalThis.VoltraSettings.observe(device);
    }
  }
  renderSummary(data);
  renderFilter(data);
  renderBridges(data);
  renderDevices(data);
  updateStreamSummary();
}
async function refresh() {
  if (view.loading) return;
  view.loading = true;
  try {
    const result = await api('/api/status');
    view.lastPollAt = Date.now();
    render(result);
  }
  catch (e) {
    $('health-dot').classList.remove('ok');
    $('health').textContent = 'فشل الاتصال بـVoltra';
    notify(e.message, true);
  } finally { view.loading = false; }
}
$('bridge-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('add-bridge'); submit.disabled = true;
  try {
    await api('/api/bridges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('bridge-name').value, url: $('bridge-url').value })
    });
    $('bridge-form').reset();
    notify('تم حفظ المصدر. تأكد أن Bridge الأصلية شغالة.');
    await refresh();
  } catch (e) { notify(e.message, true); } finally { submit.disabled = false; }
});
$('search').addEventListener('input', () => { if (view.data) renderDevices(view.data); });
$('bridge-filter').addEventListener('change', () => { if (view.data) renderDevices(view.data); });
$('status-filter').addEventListener('change', () => { if (view.data) renderDevices(view.data); });
$('refresh-all').addEventListener('click', refresh);
$('qr-dialog').addEventListener('close', () => { $('qr-image').removeAttribute('src'); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) globalThis.VoltraLive.stop();
  else { refresh(); globalThis.VoltraLive.start(onLiveEvent, patchSourceIndicator); }
});
globalThis.VoltraLive.start(onLiveEvent, patchSourceIndicator);
refresh();
// SSE updates are immediate. HTTP refresh remains as a safety fallback when
// firmware permits only one SSE client (e.g. its own local dashboard).
setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
