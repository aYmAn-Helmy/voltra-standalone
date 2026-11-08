'use strict';

const $ = id => document.getElementById(id);
const view = { data: null, loading: false, busy: new Set(), toastTimer: null };

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
    container.append(el('div', 'empty compact', 'ضيف أول Bridge بعنوان الداشبورد المحلية علشان تظهر الأجهزة هنا.'));
    return;
  }
  for (const b of data.bridges) {
    const card = el('article', 'bridge');
    const top = el('div', 'bridge-top');
    top.append(el('div', 'bridge-name', b.name), el('span', 'state ' + (b.online ? 'online' : 'offline'), b.online ? '● Online' : '● Offline'));
    card.append(top, el('p', 'bridge-url', b.url));
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
  if (o.locked) box.append(el('div', 'device-sub', '🔒 الزر الفيزيائي مقفول'));
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
    const info = el('div');
    info.append(el('h3', 'device-title', d.name));
    details(info, 'MAC / ID: ' + d.id + '   •   FW: ' + (d.firmwareVersion || '—') + '   •   Source: ' + d.bridgeName);
    if (d.sourceType === 'standalone') {
      details(info, 'Standalone مباشر • ' + fmt(d.voltageV) + ' V • ' + fmt(d.currentA, 3) + ' A • Wi-Fi ' + (d.rssi == null ? '—' : d.rssi + ' dBm'));
      if (d.protection?.reason || d.protection?.error) info.append(el('div', 'alert', '⚠️ تنبيه حماية / حساسات؛ افتح الداشبورد المحلية للتفاصيل'));
      if (d.controlAvailable === false && d.reachable) info.append(el('div', 'alert', 'الهاردوير غير جاهز للتحكم'));
    }
    const actions = el('div', 'device-actions');
    actions.append(el('span', 'state ' + (d.reachable ? 'online' : 'offline'), d.reachable ? '● Online' : '● Offline'));
    actions.append(button('↻ تحديث', 'tiny secondary', () => deviceRefresh(d), !d.reachable));
    if (!d.reachable && d.sourceType !== 'standalone') actions.append(button('حذف الجهاز', 'tiny danger', () => removeDevice(d)));
    head.append(info, actions); card.append(head);
    const outlets = el('div', 'outlets');
    for (const o of d.outlets) outlets.append(drawOutlet(d, o));
    card.append(outlets);
    if (d.sourceType === 'standalone') {
      const key = d.bridgeId + ':' + d.id;
      const panel = savedPanels.get(key) || globalThis.VoltraSettings.create(d, refresh);
      card.append(panel);
    }
    target.append(card);
  }
}
function render(data) {
  view.data = data;
  renderSummary(data);
  renderFilter(data);
  renderBridges(data);
  renderDevices(data);
}
async function refresh() {
  if (view.loading) return;
  view.loading = true;
  try { render(await api('/api/status')); }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
