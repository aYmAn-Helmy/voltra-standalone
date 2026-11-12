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
  const FAVORITES_KEY = 'powera.favorites.v1';
  let favorites;
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    favorites = new Set(Array.isArray(stored) ? stored.filter(x => typeof x === 'string' && /^(?:stock|standalone):[A-F0-9]{12}$/.test(x)).slice(0,200) : []);
  } catch {
    favorites = new Set();
  }
  let favoritesOnly = false;
  const toggleFavorite = id => {
    if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch {}
    render();
  };
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
  function runConfirmedAction(button, doWork) {
    // Exactly one click. Destructive bulk and whole-strip actions
    // explicitly ask for a separate confirmation dialog.
    button.addEventListener('click', async event => {
      event.stopPropagation();
      if (busy || button.disabled) return;
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
    if (name === 'schedules') loadSchedules();
    if (name === 'energy') window.PowerAEnergy?.open(data.devices || []);
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
    if (outlet === 0 && !window.confirm((on ? 'تشغيل' : 'فصل') +
        ' المشترك بالكامل (' + d.name + ')؟')) return Promise.resolve();
    return request('/api/control', { deviceId: d.id, outlet, on, confirm: outlet === 0 })
      .then(async result => {
        if (!result.confirmed) throw new Error('حالة المخرج غير مؤكدة');
        await refresh();
        toast('تم تأكيد تغيير حالة المشترك');
      });
  }
  function historyGraph(rows, device) {
    const valid = rows.filter(row => row && row.outlet >= 1 && row.outlet <= 4 &&
      typeof row.power_w === 'number' && Number.isFinite(row.power_w) &&
      Number.isFinite(Date.parse(row.at)));
    const panel = n('div', 'history-chart');
    if (!valid.length) {
      panel.append(n('p', 'quiet', 'مفيش قراءات كافية لعرض الرسم البياني.'));
      return panel;
    }
    const times = valid.map(row => Date.parse(row.at));
    const minAt = Math.min(...times), maxAt = Math.max(...times);
    const maximum = Math.max(1, ...valid.map(row => Math.max(0, row.power_w)));
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 640 210');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'رسم بياني لقدرة المخارج الأربعة بمرور الوقت بالوات');
    const title = document.createElementNS(ns, 'title');
    title.textContent = 'آخر قياسات القدرة بالوات';
    svg.append(title);
    for (let i = 0; i <= 4; i++) {
      const horizontal = document.createElementNS(ns, 'line');
      horizontal.setAttribute('x1', '18');
      horizontal.setAttribute('x2', '620');
      horizontal.setAttribute('y1', String(18 + i * 43));
      horizontal.setAttribute('y2', String(18 + i * 43));
      horizontal.setAttribute('stroke', '#6b83a5');
      horizontal.setAttribute('stroke-opacity', '.2');
      svg.append(horizontal);
    }
    const palette = ['#60e7b9','#7b9dff','#f5b86f','#d895e8'];
    for (let index = 1; index <= 4; index++) {
      const points = valid.filter(row => row.outlet === index)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', palette[index - 1]);
      path.setAttribute('stroke-width', '3');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      const d = points.map((point, i) => {
        const at = Date.parse(point.at);
        const x = 20 + (maxAt > minAt ? (at - minAt) / (maxAt - minAt) * 600 : 300);
        const y = 190 - Math.max(0, point.power_w) / maximum * 164;
        return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      path.setAttribute('d', d);
      svg.append(path);
    }
    panel.append(svg);
    const legend = n('div', 'history-legend');
    device.outlets.forEach((outlet, i) => {
      const item = n('span', '', outlet.name);
      item.style.setProperty('--chart-color', palette[i]);
      legend.append(item);
    });
    panel.append(legend);
    panel.append(n('p', 'quiet', 'رسم مبني على القراءات المحفوظة، مش تقدير للفترات الناقصة.'));
    return panel;
  }

  function deviceCard(d) {
    const card = n('article', 'device-card' + (d.online ? '' : ' offline'));
    const top = n('div', 'device-top');
    const heading = n('div');
    const title = n('h3', 'device-title', d.name);
    const star = button(favorites.has(d.id) ? '★' : '☆', 'favorite-star' +
      (favorites.has(d.id) ? ' selected' : ''), () => toggleFavorite(d.id));
    star.setAttribute('aria-label', favorites.has(d.id) ? 'إزالة من المفضلة' : 'إضافة للمفضلة');
    star.setAttribute('aria-pressed', String(favorites.has(d.id)));
    title.prepend(star);
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
    runConfirmedAction(offAll, () => powerControl(d, 0, false));
    const onAll = button('تشغيل المشترك', 'button muted');
    onAll.disabled = !isAvailable(d);
    runConfirmedAction(onAll, () => powerControl(d, 0, true));
    controls.append(offAll, onAll);
    if (d.type === 'standalone') {
      const settings = button('⚙ إعدادات الجهاز', 'button muted device-settings-launch', async () => {
        page('device-settings');
        try {
          if (!window.PowerADeviceSettings) throw Error('واجهة إعدادات الجهاز مش محمّلة');
          await window.PowerADeviceSettings.open(d);
        } catch (err) { toast(err.message, true); }
      });
      controls.append(settings);
    }
    card.append(controls);

    const outlets = n('div', 'outlets');
    for (const o of d.outlets) {
      const known = typeof o.on === 'boolean';
      const canToggle = isAvailable(d) && known;
      const tile = n('div', 'outlet-card ' + (o.on === true ? 'on' : 'off') +
        (canToggle ? '' : ' unavailable'));
      tile.setAttribute('role', 'button');
      tile.setAttribute('tabindex', canToggle ? '0' : '-1');
      tile.setAttribute('aria-disabled', String(!canToggle));
      tile.setAttribute('aria-label', (o.on ? 'فصل' : 'تشغيل') + ' ' + o.name +
        ' • ' + number(o.powerW) + ' وات');
      async function toggle() {
        if (!canToggle || busy || tile.classList.contains('pending')) return;
        busy = true;
        tile.classList.add('pending');
        tile.setAttribute('aria-busy','true');
        const note = tile.querySelector('.outlet-state');
        if (note) note.textContent='جاري التنفيذ…';
        try {
          await powerControl(d, o.index, !o.on);
        } catch (err) {
          toast('تعذر تأكيد الحالة: ' + err.message, true);
          await safeRefresh();
        } finally {
          busy = false;
          tile.classList.remove('pending');
          tile.removeAttribute('aria-busy');
        }
      }
      tile.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        toggle();
      });
      tile.addEventListener('keydown', e => {
        if (e.target !== tile || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        toggle();
      });
      const head = n('div', 'outlet-head');
      const name = n('div', 'outlet-name', o.name);
      head.append(name, n('span','outlet-icon',o.on===true?'⏻':'⏼'));
      const state=n('div','outlet-state', known ? (o.on ? '● يعمل' : '○ متوقف') : 'الحالة غير معروفة');
      tile.append(head,state);
      const watts=n('div','watts',number(o.powerW));
      watts.append(n('small','',' W'));
      tile.append(watts);
      const extra=n('div','outlet-extra');
      extra.append(n('span','reading',number(o.energyKwh,3)+' kWh'));
      const tools=n('div','tile-tools');
      const rename=button('✎','',e=>{
        e.stopPropagation();aliasControl(d,o.index,o.name);
      });
      rename.setAttribute('aria-label','تغيير اسم '+o.name);
      const timer=button('⏱','',async e=>{
        e.stopPropagation();
        if (!canToggle) return;
        const minutes=window.prompt('المدة بالدقائق من 1 إلى 1440:', '15');
        if(minutes===null)return;
        if(!/^[0-9]{1,4}$/.test(minutes.trim())||Number(minutes)<1||Number(minutes)>1440){
          toast('ادخل مدة صحيحة من 1 إلى 1440 دقيقة',true);return;
        }
        if (!window.confirm('تغيير ' + o.name +
            ' ثم محاولة استعادة حالته الأصلية بعد '+minutes+' دقيقة؟')) return;
        if(busy)return;
        busy=true;timer.disabled=true;
        try {
          await request('/api/timers',{deviceId:d.id,outlet:o.index,on:!o.on,
            minutes:Number(minutes),confirm:true});
          toast('تم ضبط المؤقت مع التحقق من حالة الجهاز');
          await refresh();
        } catch(err){toast(err.message,true);}
        finally{busy=false;timer.disabled=false;}
      });
      timer.setAttribute('aria-label','ضبط مؤقت رجوع '+o.name);
      timer.disabled=!canToggle;
      tools.append(rename,timer);
      extra.append(tools);
      tile.append(extra);
      outlets.append(tile);
    }
    card.append(outlets);
    const details = n('details', 'device-details');
    details.append(n('summary', '', 'القراءات والتفاصيل ›'));
    card.append(details);
    const compare = n('div', 'outlet-comparison');
    compare.append(n('h4', '', 'مقارنة القدرة اللحظية'));
    const numbers = d.outlets.map(o => typeof o.powerW === 'number' && Number.isFinite(o.powerW)
      ? Math.max(0, o.powerW) : null);
    const highest = Math.max(1, ...numbers.filter(x => x !== null));
    d.outlets.forEach((o, i) => {
      const row = n('div', 'power-bar-row');
      row.append(n('span', 'power-bar-label', o.name));
      const track = n('div', 'power-bar-track');
      const fill = n('span', 'power-bar-fill');
      fill.style.width = numbers[i] === null ? '0' : (numbers[i] / highest * 100).toFixed(2) + '%';
      track.append(fill);
      row.append(track, n('span', 'power-bar-value', number(numbers[i]) + ' W'));
      compare.append(row);
    });
    details.append(compare);
    const foot = n('div', 'device-footer');
    const energy = d.energyKwh;
    const cost = typeof energy === 'number' ? energy * data.pricePerKwh : null;
    foot.append(n('span', '', 'القدرة: ' + number(d.powerW) + ' W'),
      n('span', '', 'الجهد: ' + number(d.voltageV) + ' V'),
      n('span', '', 'التكلفة التقديرية التراكمية: ' + (cost === null ? '—' : number(cost, 2) + ' ج.م')));
    details.append(foot);
    const history = button('عرض سجل الاستهلاك', 'button muted');
    history.addEventListener('click', async () => {
      if (card.querySelector('.history-list')) {
        card.querySelector('.history-list').remove(); return;
      }
      try {
        const result = await request('/api/history?deviceId=' + encodeURIComponent(d.id) + '&limit=240');
        const box = n('div', 'history-list');
        box.append(n('h4', '', 'آخر القراءات المسجلة'));
        box.append(historyGraph(result.history, d));
        if (!result.history.length) box.append(n('p', 'quiet', 'لسه مفيش قراءات تاريخية.'));
        for (const row of result.history.slice(-12).reverse()) {
          const at = row.at ? new Date(row.at).toLocaleString('ar-EG') : '';
          box.append(n('p', 'quiet', at + ' • مخرج ' + row.outlet + ' • ' + number(row.power_w) + ' W • ' + number(row.energy_kwh, 3) + ' kWh'));
        }
        details.append(box);
      } catch (e) { toast(e.message, true); }
    });
    details.append(history);
    return card;
  }
  function render() {
    const s = data.summary || {};
    $('device-total').textContent = String(s.devices ?? '—');
    $('device-online').textContent = String(s.online ?? 0) + ' متصل';
    $('outlets-on').textContent = String(s.outletsOn ?? 0);
    $('power-total').textContent = number(s.powerW) + ' W';
    $('price-total').textContent = number(data.pricePerKwh, 2);
    const receiver = data.stockReceiver;
    const hint = $('stock-hint');
    if (receiver && !receiver.enabled) {
      hint.hidden = false;
      hint.textContent = 'دعم المشتركات الرسمية مش مفعّل في إعدادات Hub. أضف مصدر type: stock-native إلى powera/config.json وأعد تشغيل السيرفر.';
    } else if (receiver && receiver.enabled && !receiver.listening) {
      hint.hidden = false;
      hint.textContent = 'مستقبل المشتركات الرسمية TCP 10086 غير شغّال؛ راجع سجل تشغيل PowerA Hub.';
    } else if (receiver && receiver.enabled && receiver.connected === 0) {
      hint.hidden = false;
      hint.textContent = 'مستقبل المشتركات الرسمية شغّال على TCP 10086، لكن مفيش مشترك متصل. لازم توجّه المشترك الرسمي إلى IP جهاز PowerA Hub من وضع الإعداد (SoftAP).';
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
    $('connection').classList.toggle('connected', (s.online || 0) > 0);
    $('connection').lastChild.textContent = (s.online || 0) > 0 ? 'متصل بـ ' + s.online + ' مشترك' : 'لا توجد مشتركات متصلة';

    const filter = $('type-filter').value;
    const online = $('online-filter').value;
    const search = $('search').value.trim().toLowerCase();
    const list = $('device-list');
    list.replaceChildren();
    const filtered = (data.devices || []).filter(d =>
      (!favoritesOnly || favorites.has(d.id)) &&
      (filter === 'all' || d.type === filter) &&
      (online === 'all' || (d.online ? 'online' : 'offline') === online) &&
      (d.name.toLowerCase().includes(search) || d.mac.toLowerCase().includes(search) ||
        d.outlets.some(o => o.name.toLowerCase().includes(search))));
    if (!filtered.length) list.append(n('p', 'empty',
      (data.devices || []).length ? 'مفيش أجهزة مطابقة للبحث.' : 'مفيش أجهزة معروفة. راجع إعداد مصادر الاتصال.'));
    filtered.sort((a,b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)));
    filtered.forEach(d => list.append(deviceCard(d)));
  }
  async function refresh() {
    const result = await request('/api/status');
    data = result;
    render();
    if (activePage === 'schedules') scheduleTargets();
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
          runConfirmedAction(b, async () => {
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
  function scheduleTargets() {
    const devices = $('schedule-device');
    const selected = devices.value;
    devices.replaceChildren();
    for (const d of data.devices) {
      const option = n('option', '', d.name + ' • ' + d.type);
      option.value = d.id;
      devices.append(option);
    }
    if (data.devices.some(d => d.id === selected)) devices.value = selected;
    updateScheduleOutlets();
  }

  function updateScheduleOutlets() {
    const outlet = $('schedule-outlet');
    const old = outlet.value;
    outlet.replaceChildren();
    const device = data.devices.find(d => d.id === $('schedule-device').value);
    for (const o of device?.outlets || []) {
      const option = n('option', '', o.name);
      option.value = String(o.index);
      outlet.append(option);
    }
    if ([...outlet.options].some(opt => opt.value === old)) outlet.value = old;
  }

  function scheduleFormType() {
    const weekly = $('schedule-repeat').value === 'weekly';
    $('schedule-date-wrap').hidden = weekly;
    $('schedule-date').required = !weekly;
    $('weekday-wrap').hidden = !weekly;
  }

  async function loadDeviceSchedules() {
    const list = $('device-schedule-list');
    list.replaceChildren();
    const devices = (data.devices||[]).filter(x=>x.type==='standalone');
    if (!devices.length) {
      list.append(n('p','empty','مافيش مشتركات Standalone مُضافة.'));
      return;
    }
    for(const device of devices) {
      const panel=n('div','schedule-row');
      panel.append(n('strong','',device.name+' • محفوظ على المشترك'));
      if(!device.online){
        panel.append(n('span','quiet','المشترك غير متصل — الجداول الداخلية مستمرة داخل الفيرموير إن كان يعمل.'));
        list.append(panel);continue;
      }
      try {
        const result=await request('/api/device-settings?deviceId='+encodeURIComponent(device.id));
        const schedule=result.schedule;
        const active=schedule.rules.filter(x=>(x.mode&127)!==0);
        const details=n('div','device-source-rules');
        if (!active.length) details.append(n('p','quiet','مافيش جداول داخلية محفوظة.'));
        active.forEach((rule,index)=>{
          const type=rule.mode&127;
          const repeat=type===1?'يومي':type===2?'أسبوعي':
            type===3?'يوم '+rule.day+' من الشهر':'آخر يوم في الشهر';
          const clock=String(Math.floor(rule.minute/60)).padStart(2,'0')+':'+
            String(rule.minute%60).padStart(2,'0');
          const target=rule.channel===4?'كل المخارج':'المخرج '+(rule.channel+1);
          details.append(n('p','quiet',(rule.mode&128?'● مفعّل':'○ متوقف')+
            ' • '+repeat+' • '+clock+' • '+target+' • '+(rule.on?'تشغيل':'فصل')));
        });
        panel.append(details);
        panel.append(n('span','quiet','UTC offset: '+schedule.timezone+' دقيقة • تزامن مباشر'));
        const open=button('تعديل داخل المشترك','button primary',async()=>{
          page('device-settings');
          try {await window.PowerADeviceSettings.open(device);}
          catch(e){toast(e.message,true);}
        });
        panel.append(open);
      } catch(e){
        panel.append(n('p','quiet','تعذر قراءة الجداول الداخلية: '+e.message));
      }
      list.append(panel);
    }
  }

  async function loadSchedules() {
    try {
      scheduleTargets();
      loadDeviceSchedules();
      const [all, currentTimers] = await Promise.all([
        request('/api/schedules'), request('/api/timers')
      ]);
      const list = $('schedule-list');
      list.replaceChildren();
      if (!all.schedules.length) list.append(n('p', 'empty', 'مفيش جداول محفوظة لسه.'));
      for (const item of all.schedules) {
        const card = n('div', 'schedule-row');
        const d = data.devices.find(x => x.id === item.deviceId);
        const o = d?.outlets.find(o => o.index === item.outlet);
        const label = (d?.name || item.deviceId) + ' / ' + (o?.name || 'مخرج ' + item.outlet);
        const text = n('div', 'schedule-description');
        text.append(n('strong', '', label));
        text.append(n('p', 'quiet',
          (item.on ? 'تشغيل' : 'فصل') + ' • ' +
          (item.repeat === 'weekly' ? 'أسبوعيًا، أيام ' + item.weekdays.join('،') : 'مرة واحدة ' + item.date) +
          ' • ' + item.clock + ' (' + item.timezone + ')'));
        text.append(n('small', '',
          item.enabled && item.nextRunAt ? 'القادم: ' + new Date(item.nextRunAt).toLocaleString('ar-EG') :
          'متوقف • ' + (item.lastResult || '—')));
        const actions = n('div', 'schedule-actions');
        const toggle = button(item.enabled ? 'إيقاف' : 'تفعيل', 'button muted', async () => {
          try {
            if (!window.confirm('تأكيد تغيير حالة الجدول؟')) return;
            await request('/api/schedules/enabled', { id: item.id, enabled: !item.enabled });
            await loadSchedules();
          } catch (e) { toast(e.message, true); }
        });
        const remove = button('حذف', 'button danger', async () => {
          try {
            if (!window.confirm('حذف الجدول نهائيًا؟')) return;
            await request('/api/schedules/remove', { id: item.id });
            await loadSchedules();
          } catch (e) { toast(e.message, true); }
        });
        actions.append(toggle, remove);
        card.append(text, actions);
        list.append(card);
      }
      const timers = $('timer-list');
      timers.replaceChildren();
      const active = currentTimers.timers.filter(x => ['active', 'pending', 'needs_review', 'claimed'].includes(x.status));
      if (!active.length) timers.append(n('p', 'empty', 'مفيش مؤقتات رجوع نشطة.'));
      for (const item of active) {
        const d = data.devices.find(x => x.id === item.deviceId);
        const box = n('div', 'schedule-row');
        const state = item.status === 'active' ? 'شغّال' : 'مراجعة يدوية مطلوبة';
        box.append(n('strong', '', (d?.name || item.deviceId) + ' / مخرج ' +
          item.outlet + ' • ' + state));
        box.append(n('p', 'quiet', 'وقت الرجوع المتوقع: ' +
          new Date(item.dueAt).toLocaleString('ar-EG') +
          (item.detail ? ' • ' + item.detail : '')));
        timers.append(box);
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
        content.append(n('strong', '', item.kind === 'online' ? 'عودة الاتصال' :
          item.kind === 'offline' ? 'انقطاع الاتصال' :
          item.kind === 'settings' ? 'مزامنة إعدادات الجهاز' :
          item.kind === 'automation' ? 'تنفيذ جدول أو مؤقت' : 'إشعار PowerA'));
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
  $('schedule-device').addEventListener('change', updateScheduleOutlets);
  $('schedule-repeat').addEventListener('change', scheduleFormType);
  $('schedule-date').value = new Date().toLocaleDateString('sv-SE');
  const guessedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (guessedZone && /^[A-Za-z][A-Za-z0-9_+./-]{0,60}$/.test(guessedZone)) {
    $('schedule-zone').value = guessedZone;
  }
  for (let hour = 0; hour < 24; hour += 2) {
    const time = String(hour).padStart(2, '0') + ':00';
    $('smart-timeline').append(button(time, 'smart-hour', () => {
      $('schedule-clock').value = time;
      document.querySelectorAll('.smart-hour').forEach(x =>
        x.classList.toggle('selected', x.textContent === time));
    }));
  }
  scheduleFormType();
  $('schedules-refresh').addEventListener('click', loadSchedules);
  $('schedule-form').addEventListener('submit', async event => {
    event.preventDefault();
    const weekly = $('schedule-repeat').value === 'weekly';
    const days = [...document.querySelectorAll('#weekday-wrap input:checked')].map(x => Number(x.value));
    if (weekly && !days.length) { toast('اختار يوم واحد على الأقل', true); return; }
    const deviceId = $('schedule-device').value;
    if (!deviceId) { toast('لازم يكون فيه مشترك معروف', true); return; }
    const payload = {
      deviceId, outlet: Number($('schedule-outlet').value),
      on: $('schedule-action').value === 'on',
      repeat: weekly ? 'weekly' : 'once',
      clock: $('schedule-clock').value,
      date: weekly ? null : $('schedule-date').value,
      timezone: $('schedule-zone').value,
      weekdays: days, confirm: true
    };
    if (!window.confirm('تأكيد إنشاء موعد ' + (payload.on ? 'تشغيل' : 'فصل') +
      ' الجهاز؟ لازم الـHub يفضل شغال وقت التنفيذ.')) return;
    try {
      const result = await request('/api/schedules', payload);
      toast('تم إنشاء الجدول. الموعد القادم: ' + new Date(result.nextRunAt).toLocaleString('ar-EG'));
      await loadSchedules();
    } catch (e) { toast(e.message, true); }
  });
  $('fav-only').addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    $('fav-only').classList.toggle('active', favoritesOnly);
    $('fav-only').setAttribute('aria-pressed', String(favoritesOnly));
    render();
  });
  $('search').addEventListener('input', render);
  $('type-filter').addEventListener('change', render);
  $('online-filter').addEventListener('change', render);
  $('refresh').addEventListener('click', safeRefresh);
  $('notifications-refresh').addEventListener('click', loadNotifications);
  document.addEventListener('powera:settings-saved', async () => {
    await safeRefresh();
    if (activePage === 'schedules') loadDeviceSchedules();
  });
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
    runConfirmedAction(b, async () => {
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
