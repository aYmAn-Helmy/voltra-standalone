/* PowerA original web client: no frameworks, remote fonts or trackers. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const n = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const number = (x, digits = 1) =>
    typeof x === 'number' && Number.isFinite(x)
      ? x.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
  let data = { devices: [], summary: {}, pricePerKwh: 0 };
  let rooms = [];
  let activePage = 'devices';
  let busy = false;
  let toastTimer;

  function toast(message, error = false) {
    const div = $('toast');
    div.textContent = message;
    div.className = 'toast' + (error ? ' error' : '');
    div.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { div.hidden = true; }, 4400);
  }
  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-PowerA-Client': 'PowerA' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('استجابة غير صحيحة من PowerA Hub'); }
    if (!response.ok) throw new Error(result.error || 'فشل الاتصال');
    return result;
  }
  function doubleTap(button, doWork) {
    let armedAt = 0, timeout;
    button.addEventListener('click', async () => {
      if (busy || button.disabled) return;
      if (Date.now() - armedAt > 3000) {
        armedAt = Date.now();
        button.classList.add('armed');
        button.setAttribute('aria-label', 'اضغط مرة ثانية خلال ثلاث ثوانٍ للتأكيد');
        toast('اضغط مرة ثانية خلال 3 ثوانٍ لتأكيد الأمر');
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          armedAt = 0;
          button.classList.remove('armed');
          button.removeAttribute('aria-label');
        }, 3100);
        return;
      }
      clearTimeout(timeout);
      armedAt = 0;
      button.classList.remove('armed');
      button.removeAttribute('aria-label');
      busy = true;
      button.disabled = true;
      try { await doWork(); }
      catch (error) { toast(error.message, true); }
      finally { busy = false; button.disabled = false; }
    });
  }
  function button(text, css, onclick) {
    const b = n('button', css, text);
    b.type = 'button';
    if (onclick) b.addEventListener('click', onclick);
    return b;
  }
  function page(name) {
    activePage = name;
    document.querySelectorAll('.tab').forEach(tab => {
      const selected = tab.dataset.page === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    document.querySelectorAll('.page').forEach(section => {
      section.hidden = section.id !== name + '-page';
    });
    if (name === 'rooms') loadRooms();
    if (name === 'activity') loadNotifications();
    if (name === 'settings') $('price-input').value = String(data.pricePerKwh || 0);
  }
  const isAvailable = d => d.online && d.controlAvailable;
  function aliasControl(d, outlet, oldName) {
    const replacement = window.prompt(outlet === 0 ? 'الاسم الجديد للمشترك' : 'الاسم الجديد للمخرج', oldName);
    if (replacement === null || !replacement.trim()) return;
    request('/api/alias', { deviceId: d.id, outlet, name: replacement.trim() })
      .then(() => refresh()).then(() => toast('تم حفظ الاسم داخل PowerA'))
      .catch(e => toast(e.message, true));
  }
  function powerControl(d, outlet, on) {
    return request('/api/control', { deviceId: d.id, outlet, on, confirm: outlet === 0 })
      .then(async result => {
        if (!result.confirmed) throw new Error('حالة المخرج غير مؤكدة');
        await refresh();
        toast('تم تأكيد تغيير حالة المشترك');
      });
  }
  function deviceCard(d) {
    const card = n('article', 'device-card' + (d.online ? '' : ' offline'));
    const top = n('div', 'device-top');
    const heading = n('div');
    const title = n('h3', 'device-title', d.name);
    title.append(button('✎', '', () => aliasControl(d, 0, d.name)));
    const desc = n('p', 'device-description',
      d.type.toUpperCase() + ' • ' + d.mac + ' • ' + (d.firmware || 'Firmware —'));
    heading.append(title, desc);
    top.append(heading, n('span', 'status-pill ' + (d.online ? 'online' : 'offline'),
      d.online ? '● متصل' : '● غير متصل'));
    card.append(top);

    const controls = n('div', 'device-actions');
    const offAll = button('فصل المشترك', 'button danger');
    offAll.disabled = !isAvailable(d);
    doubleTap(offAll, () => powerControl(d, 0, false));
    const onAll = button('تشغيل المشترك', 'button muted');
    onAll.disabled = !isAvailable(d);
    doubleTap(onAll, () => powerControl(d, 0, true));
    controls.append(offAll, onAll);
    card.append(controls);

    const outlets = n('div', 'outlets');
    for (const o of d.outlets) {
      const tile = n('div', 'outlet-card' + (o.on === true ? ' on' : ''));
      const head = n('div', 'outlet-head');
      const label = n('span', 'outlet-name', o.name);
      label.append(button('✎', '', () => aliasControl(d, o.index, o.name)));
      const switchButton = button('', 'switch' + (o.on === true ? ' on' : ''));
      const known = typeof o.on === 'boolean';
      switchButton.disabled = !isAvailable(d) || !known;
      switchButton.setAttribute('role', 'switch');
      switchButton.setAttribute('aria-checked', String(o.on === true));
      switchButton.setAttribute('aria-label', (o.on ? 'فصل ' : 'تشغيل ') + o.name);
      doubleTap(switchButton, () => powerControl(d, o.index, !o.on));
      head.append(label, switchButton);
      tile.append(head);
      const watts = n('div', 'watts', number(o.powerW));
      watts.append(n('small', '', ' W'));
      tile.append(watts, n('div', 'reading', number(o.energyKwh, 3) + ' kWh'),
        n('div', 'reading', o.temperatureC == null ? '—' : number(o.temperatureC) + ' °C'));
      outlets.append(tile);
    }
    card.append(outlets);
    const foot = n('div', 'device-footer');
    const energy = d.energyKwh;
    const cost = typeof energy === 'number' ? energy * data.pricePerKwh : null;
    foot.append(n('span', '', 'القدرة: ' + number(d.powerW) + ' W'),
      n('span', '', 'الجهد: ' + number(d.voltageV) + ' V'),
      n('span', '', 'التكلفة التقديرية التراكمية: ' + (cost === null ? '—' : number(cost, 2) + ' ج.م')));
    card.append(foot);
    const history = button('عرض سجل الاستهلاك', 'button muted');
    history.addEventListener('click', async () => {
      if (card.querySelector('.history-list')) {
        card.querySelector('.history-list').remove(); return;
      }
      try {
        const result = await request('/api/history?deviceId=' + encodeURIComponent(d.id) + '&limit=24');
        const box = n('div', 'history-list');
        box.append(n('h4', '', 'آخر القراءات المسجلة'));
        if (!result.history.length) box.append(n('p', 'quiet', 'لسه مفيش قراءات تاريخية.'));
        for (const row of result.history.slice(-12).reverse()) {
          const at = row.at ? new Date(row.at).toLocaleString('ar-EG') : '';
          box.append(n('p', 'quiet', at + ' • مخرج ' + row.outlet + ' • ' + number(row.power_w) + ' W • ' + number(row.energy_kwh, 3) + ' kWh'));
        }
        card.append(box);
      } catch (e) { toast(e.message, true); }
    });
    card.append(history);
    return card;
  }
  function render() {
    const s = data.summary || {};
    $('device-total').textContent = String(s.devices ?? '—');
    $('device-online').textContent = String(s.online ?? 0) + ' متصل';
    $('outlets-on').textContent = String(s.outletsOn ?? 0);
    $('power-total').textContent = number(s.powerW) + ' W';
    $('price-total').textContent = number(data.pricePerKwh, 2);
    $('connection').classList.toggle('connected', (s.online || 0) > 0);
    $('connection').lastChild.textContent = (s.online || 0) > 0 ? 'متصل بـ ' + s.online + ' مشترك' : 'لا توجد مشتركات متصلة';

    const filter = $('type-filter').value;
    const online = $('online-filter').value;
    const search = $('search').value.trim().toLowerCase();
    const list = $('device-list');
    list.replaceChildren();
    const filtered = (data.devices || []).filter(d =>
      (filter === 'all' || d.type === filter) &&
      (online === 'all' || (d.online ? 'online' : 'offline') === online) &&
      (d.name.toLowerCase().includes(search) || d.mac.toLowerCase().includes(search) ||
        d.outlets.some(o => o.name.toLowerCase().includes(search))));
    if (!filtered.length) list.append(n('p', 'empty',
      (data.devices || []).length ? 'مفيش أجهزة مطابقة للبحث.' : 'مفيش أجهزة معروفة. راجع إعداد مصادر الاتصال.'));
    filtered.forEach(d => list.append(deviceCard(d)));
  }
  async function refresh() {
    const result = await request('/api/status');
    data = result;
    render();
  }
  async function safeRefresh() {
    try { await refresh(); }
    catch (e) {
      $('connection').classList.remove('connected');
      $('connection').lastChild.textContent = 'تعذر الاتصال بالخادم';
      toast(e.message, true);
    }
  }
  async function loadRooms() {
    try {
      const result = await request('/api/rooms');
      rooms = result.rooms;
      const list = $('room-list');
      list.replaceChildren();
      if (!rooms.length) list.append(n('p', 'empty', 'لسه مفيش غرف. أضف أول غرفة من فوق.'));
      for (const room of rooms) {
        const card = n('div', 'room-card');
        const top = n('div', 'room-top');
        top.append(n('h3', '', room.name), n('span', 'quiet', room.members.length + ' مخرج'));
        card.append(top);
        const members = room.members.map(m => {
          const d = data.devices.find(d => d.id === m.deviceId);
          const o = d?.outlets.find(o => o.index === m.outlet);
          return (d?.name || m.deviceId) + ' / ' + (o?.name || 'مخرج ' + m.outlet);
        });
        card.append(n('p', 'room-members', members.join(' • ') || 'الغرفة فاضية حاليًا'));
        const actions = n('div', 'room-actions');
        for (const state of [false, true]) {
          const b = button(state ? 'تشغيل الغرفة' : 'فصل الغرفة', 'button ' + (state ? 'primary' : 'muted'));
          b.disabled = room.members.length === 0;
          doubleTap(b, async () => {
            if (!window.confirm('تأكيد ' + (state ? 'تشغيل' : 'فصل') + ' مخارج غرفة ' + room.name + '؟')) return;
            const result = await request('/api/rooms/control',
              { roomId: room.id, on: state, confirm: true });
            await refresh();
            toast(result.ok ? 'تم تنفيذ أوامر الغرفة' : 'بعض المخارج لم تستجب. راجع حالتها', !result.ok);
          });
          actions.append(b);
        }
        card.append(actions);
        const add = n('div', 'room-selects');
        const devices = n('select');
        const outlet = n('select');
        for (const d of data.devices) {
          const option = n('option', '', d.name + ' (' + d.type + ')');
          option.value = d.id; devices.append(option);
        }
        function updateOutlets() {
          outlet.replaceChildren();
          const d = data.devices.find(x => x.id === devices.value);
          for (const o of d?.outlets || []) {
            const option = n('option', '', o.name);
            option.value = String(o.index); outlet.append(option);
          }
        }
        devices.addEventListener('change', updateOutlets);
        updateOutlets();
        const addButton = button('إضافة مخرج', 'button muted', async () => {
          try {
            if (!devices.value) throw new Error('مفيش مشترك متاح');
            await request('/api/rooms/member', {
              roomId: room.id, deviceId: devices.value, outlet: Number(outlet.value)
            });
            await loadRooms();
            toast('تم إضافة المخرج للغرفة');
          } catch (e) { toast(e.message, true); }
        });
        add.append(devices, outlet, addButton);
        card.append(add);
        list.append(card);
      }
    } catch (e) { toast(e.message, true); }
  }
  async function loadNotifications() {
    try {
      const result = await request('/api/notifications');
      const list = $('notifications');
      list.replaceChildren();
      if (!result.notifications.length) list.append(n('p', 'empty', 'لا توجد إشعارات لحد دلوقتي.'));
      for (const item of result.notifications) {
        const row = n('article', 'notification' + (item.is_read ? '' : ' unread'));
        const content = n('div');
        content.append(n('strong', '', item.kind === 'online' ? 'عودة الاتصال' : 'انقطاع الاتصال'));
        content.append(n('p', '', item.message));
        content.append(n('small', '', new Date(item.at).toLocaleString('ar-EG')));
        row.append(content);
        if (!item.is_read) {
          const seen = button('تحديد كمقروء', 'button muted', async () => {
            try {
              await request('/api/notifications/read', { id: item.id });
              await loadNotifications();
            } catch (e) { toast(e.message, true); }
          });
          row.append(seen);
        }
        list.append(row);
      }
    } catch (e) { toast(e.message, true); }
  }

  document.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => page(tab.dataset.page)));
  $('search').addEventListener('input', render);
  $('type-filter').addEventListener('change', render);
  $('online-filter').addEventListener('change', render);
  $('refresh').addEventListener('click', safeRefresh);
  $('notifications-refresh').addEventListener('click', loadNotifications);
  $('theme').addEventListener('click', () => {
    const light = document.documentElement.dataset.theme !== 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    $('theme').textContent = light ? '☀' : '☾';
    localStorage.setItem('powera.theme', light ? 'light' : 'dark');
  });
  const savedTheme = localStorage.getItem('powera.theme');
  if (savedTheme === 'light') { document.documentElement.dataset.theme = 'light'; $('theme').textContent = '☀'; }
  $('room-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await request('/api/rooms', { name: form.elements.namedItem('name').value });
      form.reset();
      await loadRooms();
      toast('تم إنشاء الغرفة');
    } catch (e) { toast(e.message, true); }
  });
  $('price-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/price', { pricePerKwh: Number($('price-input').value) });
      await refresh();
      toast('تم حفظ سعر الكهرباء');
    } catch (e) { toast(e.message, true); }
  });
  for (const state of [false, true]) {
    const b = $(state ? 'all-on' : 'all-off');
    doubleTap(b, async () => {
      if (!window.confirm('متأكد من ' + (state ? 'تشغيل' : 'فصل') +
          ' كل المشتركات المتصلة؟ الأمر قد يؤثر على الأجهزة الكهربائية.')) return;
      const result = await request('/api/control-all', { on: state, confirm: true });
      await refresh();
      toast(result.ok ? 'تم تنفيذ أوامر كل المشتركات' :
        'بعض الأوامر لم تكتمل. راجع حالة الأجهزة', !result.ok);
    });
  }
  safeRefresh();
  setInterval(() => { if (!document.hidden && !busy) safeRefresh(); }, 15000);
})();
