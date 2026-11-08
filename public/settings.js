/* Per-device management panel for Standalone Firmware 2.1.x. */
(() => {
  'use strict';

  const text = (tag, str, cls) => {
    const node = document.createElement(tag);
    if (str !== undefined && str !== null) node.textContent = String(str);
    if (cls) node.className = cls;
    return node;
  };
  const add = (parent, ...nodes) => { parent.append(...nodes); return parent; };
  const btn = (label, action, cls = 'secondary') => {
    const b = text('button', label, 'btn ' + cls);
    b.type = 'button';
    if (action) b.addEventListener('click', action);
    return b;
  };
  const field = (form, name, type, value, opts = {}) => {
    const label = text('label', name);
    let input;
    if (opts.options) {
      input = document.createElement('select');
      for (const option of opts.options) {
        const o = text('option', option[1]);
        o.value = String(option[0]);
        input.append(o);
      }
      input.value = String(value ?? '');
    } else {
      input = document.createElement('input');
      input.type = type;
      if (type === 'checkbox') input.checked = Boolean(value);
      else input.value = value == null ? '' : String(value);
      if (opts.min !== undefined) input.min = opts.min;
      if (opts.max !== undefined) input.max = opts.max;
      if (opts.step !== undefined) input.step = opts.step;
      if (opts.maxLength !== undefined) input.maxLength = opts.maxLength;
      if (opts.placeholder) input.placeholder = opts.placeholder;
    }
    label.append(input);
    if (opts.help) label.append(text('small', opts.help, 'advanced-help'));
    form.append(label);
    return input;
  };
  const format = (v, digits = 0) => Number.isFinite(Number(v)) && v != null
    ? Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
  const endpoint = device => '/api/bridges/' + encodeURIComponent(device.bridgeId) +
    '/devices/' + encodeURIComponent(device.id) + '/standalone';
  const json = async (url, init = {}) => {
    const res = await fetch(url, { cache: 'no-store', ...init });
    let data;
    try { data = await res.json(); } catch { throw Error('استجابة غير صالحة من الجهاز'); }
    if (!res.ok) throw Error(data.error || ('HTTP ' + res.status));
    return data;
  };
  const post = (url, value) => json(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  const note = (form, msg, type = '') => form.append(text('p', msg, 'advanced-note ' + type));
  const errText = e => e instanceof Error ? e.message : String(e);
  const days = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];
  const emptyRule = () => ({ minute: 0, mode: 0, day: 0, channel: 0, on: 0 });
  const eventLog = new Map();
  function observe(d) {
    const key = d.bridgeId + ':' + d.id;
    const state = {
      online: d.reachable, firmware: d.firmwareVersion,
      outputs: d.outlets.map(o => o.on)
    };
    const previous = eventLog.get(key);
    const logs = previous?.logs ?? [];
    const log = msg => {
      logs.push({ at: new Date().toLocaleTimeString('ar-EG'), msg });
      if (logs.length > 64) logs.shift();
    };
    if (!previous) log('بدأت مراقبة حالة المشترك');
    else {
      if (previous.state.online !== state.online) log(state.online ? 'عاد المشترك Online' : 'المشترك Offline');
      if (previous.state.firmware !== state.firmware) log('تغيّر إصدار الـFirmware');
      state.outputs.forEach((on, i) => {
        if (typeof on === 'boolean' && previous.state.outputs[i] !== on)
          log('المخرج ' + (i + 1) + ': ' + (on ? 'ON' : 'OFF'));
      });
    }
    eventLog.set(key, { logs, state });
    // Small bounded in-memory log only; no credentials or persistent storage.
    if (eventLog.size > 128) eventLog.delete(eventLog.keys().next().value);
  }
  const pad = n => String(n).padStart(2, '0');

  function create(device, onRefresh) {
    const details = document.createElement('details');
    details.className = 'device-advanced';
    details.dataset.deviceKey = device.bridgeId + ':' + device.id;
    const summary = text('summary', '⚙️ إدارة كل إعدادات المشترك • افتح الأقسام');
    const root = text('div', null, 'advanced-body');
    details.append(summary, root);
    const state = { tab: 'overview', info: null, busy: false, ruleDraft: null };

    const message = (msg, error = false) => {
      const n = root.querySelector('.advanced-message');
      if (n) { n.textContent = msg; n.classList.toggle('error', error); }
    };

    async function load() {
      if (state.busy) return;
      root.replaceChildren(text('p', 'جاري قراءة الإعدادات من المشترك...', 'advanced-help'));
      try {
        const info = await json(endpoint(device) + '/settings');
        state.info = info;
        state.ruleDraft = null;
        render();
      } catch (e) {
        root.replaceChildren(text('p', 'تعذر تحميل الإعدادات: ' + errText(e), 'alert'));
        root.append(btn('↻ إعادة المحاولة', load));
      }
    }

    async function save(payload) {
      if (state.busy) return;
      state.busy = true;
      message('جاري إرسال الإعدادات والتحقق من حفظها على فلاش المشترك...');
      try {
        const data = await post(endpoint(device) + '/settings', payload);
        if (!data.confirmed) throw Error('تعذر تأكيد الحفظ');
        state.info = await json(endpoint(device) + '/settings');
        state.ruleDraft = null;
        state.busy = false;
        render();
        message('✓ تم حفظ الإعدادات والتأكد منها على الجهاز');
        if (onRefresh) onRefresh();
      } catch (e) {
        state.busy = false;
        message('لم نقدر نؤكد الحفظ: ' + errText(e) + ' — راجع الحالة قبل إعادة المحاولة', true);
      }
    }

    function formSubmit(form, action, caption = 'حفظ على المشترك') {
      const submit = btn(caption, null, 'primary');
      submit.type = 'submit';
      form.append(submit);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (state.busy || !form.reportValidity()) return;
        submit.disabled = true;
        try { await action(); } finally { submit.disabled = false; }
      });
      return form;
    }

    function overview() {
      const pane = text('div', null, 'advanced-grid');
      const i = state.info, s = i.status, d = i.device, f = i.firmware;
      const fields = [
        ['Firmware', f?.version || d?.revision || '—'],
        ['Build ID', f?.build_id || '—'],
        ['MAC', s?.mac || '—'],
        ['Uptime', s ? format(Math.floor(s.uptime_ms / 60000)) + ' دقيقة' : '—'],
        ['Wi-Fi RSSI', s?.rssi == null ? '—' : s.rssi + ' dBm'],
        ['الجهد', d?.voltage_dv == null ? '—' : format(d.voltage_dv / 10, 1) + ' V'],
        ['القدرة الكلية', d?.power_mw == null ? '—' : format(d.power_mw / 1000, 2) + ' W'],
        ['التيار الكلي', d?.current_ma == null ? '—' : format(d.current_ma / 1000, 3) + ' A'],
        ['الطاقة التراكمية', d?.meter_wh == null ? '—' : format(d.meter_wh / 1000, 3) + ' kWh'],
        ['MQTT State', d?.mqtt_state ?? '—'],
        ['حماية / سبب القطع', d?.protection?.reason ?? '—'],
        ['أخطاء الحساسات', d?.protection?.error ?? '—'],
        ['حفظ الفلاش الأخير', Array.isArray(s?.storage) ?
          (s.storage[3] ? 'آخر محاولة فشلت' : s.storage[1] ? 'OK' : 'لم يُحفظ بعد') : '—'],
        ['فشل حفظ الفلاش', Array.isArray(s?.storage) ? s.storage[2] : '—'],
        ['Heap Free', i.memory?.heap_free_bytes == null ? '—' : i.memory.heap_free_bytes + ' bytes'],
        ['Energy Save Failures', i.energy?.save_failures ?? '—']
      ];
      for (const [label, value] of fields) {
        const cell = text('div', null, 'advanced-data');
        cell.append(text('span', label), text('strong', value));
        pane.append(cell);
      }
      root.append(pane);
      note(root, 'القراءات دي من المشترك مباشرة؛ اضغط «إعادة قراءة» علشان تحدّث التفاصيل. تحديث المخارج الأساسية مستمر تلقائيًا.');
    }

    function logs() {
      const key = device.bridgeId + ':' + device.id;
      const list = text('pre', null, 'advanced-log');
      const entries = eventLog.get(key)?.logs || [];
      list.textContent = entries.length ?
        entries.map(entry => '[' + entry.at + '] ' + entry.msg).join('\n') :
        'لا توجد أحداث مسجلة في جلسة Voltra الحالية';
      root.append(list);
      note(root, 'ده سجل للمتصفح أثناء تشغيل Voltra فقط، مش سجل محفوظ في فلاش المشترك.');
      root.append(btn('مسح السجل', () => {
        const entry = eventLog.get(key);
        if (entry) entry.logs.length = 0;
        render();
      }, 'secondary tiny'));
    }

    function names() {
      const c = state.info.config, form = text('form', null, 'advanced-form');
      const deviceName = field(form, 'اسم المشترك', 'text', c.device, { maxLength: 64 });
      const channels = c.channels.map((n, i) => field(form, 'اسم المخرج ' + (i + 1), 'text', n, { maxLength: 64 }));
      root.append(formSubmit(form, () => save({
        section: 'names', device: deviceName.value, channels: channels.map(n => n.value)
      })));
      const locks = text('form', null, 'advanced-form advanced-divider');
      locks.append(text('h4', 'قفل الأزرار الفيزيائية'));
      note(locks, 'القفل يمنع الزر الموجود على المشترك نفسه؛ التحكم من Voltra والجدولة بيكملوا شغالين.');
      const boxes = Array.from({ length: 4 }, (_, i) =>
        field(locks, 'قفل زر المخرج ' + (i + 1), 'checkbox', !!(c.button_lock & (1 << i))));
      root.append(formSubmit(locks, () => save({
        section: 'locks', button_lock: boxes.reduce((sum, b, i) => sum | (b.checked ? 1 << i : 0), 0)
      }), 'حفظ حالة الأقفال'));
      const lang = text('form', null, 'advanced-form advanced-divider');
      const language = field(lang, 'لغة واجهة الجهاز الأصلية', 'select', c.language, {
        options: [[0, 'الكورية'], [1, 'English']]
      });
      root.append(formSubmit(lang, () => save({ section: 'language', language: Number(language.value) }), 'حفظ اللغة'));
    }

    function timers() {
      const c = state.info.config, form = text('form', null, 'advanced-form');
      note(form, 'التايمر يبدأ مع ON ويعمل OFF تلقائيًا، من دقيقة إلى 24 ساعة. 00:00 يحذف التايمر. لا يمكن وضع Schedule وTimer على نفس المخرج.');
      const inputs = c.timer_minutes.map((v, i) => {
        const row = text('div', null, 'advanced-inline');
        row.append(text('span', 'مخرج ' + (i + 1)));
        const hours = field(row, 'ساعات', 'number', Math.floor(v / 60), { min: 0, max: 24, step: 1 });
        const mins = field(row, 'دقائق', 'number', v % 60, { min: 0, max: 59, step: 1 });
        form.append(row);
        return [hours, mins];
      });
      root.append(formSubmit(form, () => save({
        section: 'timers',
        timer_minutes: inputs.map(([h, m]) => Number(h.value) * 60 + Number(m.value))
      })));
      const d = state.info.device;
      if (d?.timer_running != null) note(root, 'الحالة الحالية: Mask ' + d.timer_running +
        ' • المدة الباقية بتتغير مع الوقت؛ الداشبورد المحلية تعرض عدّادًا مستمرًا.');
    }

    function schedules() {
      const c = state.info.config;
      if (!state.ruleDraft) {
        state.ruleDraft = JSON.parse(JSON.stringify(state.info.schedule));
      }
      const draft = state.ruleDraft;
      const form = text('form', null, 'advanced-form');
      note(form, 'حد أقصى 8 حجوزات. لازم الساعة تكون متزامنة عبر NTP. التوقيت UTC Offset بدون ضبط تلقائي للتوقيت الصيفي.');
      const zone = field(form, 'فرق التوقيت بالدقائق من UTC (مثل القاهرة +120 أو +180)', 'number',
        draft.timezone, { min: -720, max: 840, step: 15 });
      zone.addEventListener('input', () => { draft.timezone = Number(zone.value); });
      const rules = draft.rules.filter(r => (r.mode & 127) !== 0);
      for (let idx = 0; idx < rules.length; idx++) {
        const r = rules[idx], box = text('div', null, 'schedule-card');
        box.append(text('strong', 'قاعدة ' + (idx + 1)));
        const enabled = field(box, 'تفعيل القاعدة', 'checkbox', !!(r.mode & 128));
        enabled.addEventListener('change', () => { r.mode = (r.mode & 127) | (enabled.checked ? 128 : 0); });
        const mode = field(box, 'التكرار', 'select', r.mode & 127, {
          options: [[1, 'يوميًا'], [2, 'أيام الأسبوع'], [3, 'يوم محدد كل شهر'], [4, 'آخر يوم في الشهر']]
        });
        mode.addEventListener('change', () => {
          r.mode = Number(mode.value) | (r.mode & 128);
          r.day = Number(mode.value) === 2 ? 127 : Number(mode.value) === 3 ? 1 : 0;
          render();
        });
        if ((r.mode & 127) === 2) {
          const weeks = text('div', null, 'schedule-days');
          days.forEach((day, i) => {
            const checkbox = field(weeks, day, 'checkbox', !!(r.day & (1 << i)));
            checkbox.addEventListener('change', () => {
              r.day = checkbox.checked ? r.day | (1 << i) : r.day & ~(1 << i);
            });
          });
          box.append(weeks);
        }
        if ((r.mode & 127) === 3) {
          const date = field(box, 'يوم الشهر', 'number', r.day, { min: 1, max: 31 });
          date.addEventListener('input', () => { r.day = Number(date.value); });
        }
        const time = field(box, 'الساعة', 'time',
          pad(Math.floor(r.minute / 60)) + ':' + pad(r.minute % 60));
        time.addEventListener('change', () => {
          const bits = time.value.split(':').map(Number);
          if (bits.length === 2) r.minute = bits[0] * 60 + bits[1];
        });
        const target = field(box, 'المخرج', 'select', r.channel, {
          options: [[0, '1'], [1, '2'], [2, '3'], [3, '4'], [4, 'كل المخارج']]
        });
        target.addEventListener('change', () => { r.channel = Number(target.value); });
        const on = field(box, 'الإجراء', 'select', r.on, {
          options: [[1, 'تشغيل ON'], [0, 'إيقاف OFF']]
        });
        on.addEventListener('change', () => { r.on = Number(on.value); });
        box.append(btn('حذف القاعدة', () => {
          draft.rules = draft.rules.filter(x => x !== r);
          while (draft.rules.length < 8) draft.rules.push(emptyRule());
          render();
        }, 'danger tiny'));
        form.append(box);
      }
      if (rules.length < 8) form.append(btn('＋ إضافة قاعدة', () => {
        const first = draft.rules.findIndex(r => !(r.mode & 127));
        if (first >= 0) draft.rules[first] = { minute: 600, mode: 129, day: 0, channel: 4, on: 0 };
        render();
      }, 'secondary'));
      form.append(text('p', rules.length + ' من 8 قواعد', 'advanced-help'));
      root.append(formSubmit(form, () => save({ section: 'schedule', schedule: draft })));
    }

    function protection() {
      const p = state.info.config.protection, form = text('form', null, 'advanced-form');
      note(form, 'حماية الجهاز الفعلية تقدر تفصل كل المخارج عند تجاوز الحدود. عدّل القيم بحذر؛ الحماية البرمجية ليست بديلًا عن وسائل الأمان الكهربائية.');
      const tempOn = field(form, 'تفعيل حماية الحرارة', 'checkbox', !!(p.enabled & 1));
      const temperature = field(form, 'درجة الحرارة °C (50–90)', 'number', p.temperature, { min: 50, max: 90 });
      const currOn = field(form, 'تفعيل حماية التيار الكلي', 'checkbox', !!(p.enabled & 2));
      const current = field(form, 'أقصى تيار A (1–16)', 'number', p.current / 1000, {
        min: 1, max: 16, step: 0.1
      });
      const powerOn = field(form, 'تفعيل حماية القدرة الكلية', 'checkbox', !!(p.enabled & 4));
      const power = field(form, 'أقصى قدرة W (100–3000)', 'number', p.power, { min: 100, max: 3000 });
      root.append(formSubmit(form, () => save({
        section: 'protection',
        protection: {
          enabled: (tempOn.checked ? 1 : 0) | (currOn.checked ? 2 : 0) | (powerOn.checked ? 4 : 0),
          temperature: Number(temperature.value),
          current: Math.round(Number(current.value) * 1000),
          power: Number(power.value)
        }
      })));
    }

    function mqtt() {
      const c = state.info.config, form = text('form', null, 'advanced-form');
      note(form, 'الربط بـHome Assistant عن طريق MQTT Discovery. بيانات الباسورد لا تُعرض ولا تُحفظ في المتصفح.');
      const enabled = field(form, 'تفعيل MQTT', 'checkbox', c.enabled);
      const broker = field(form, 'Broker IPv4', 'text', c.broker, { maxLength: 253, placeholder: '192.168.0.10' });
      const port = field(form, 'Port', 'number', c.port, { min: 1, max: 65535 });
      const user = field(form, 'MQTT Username', 'text', c.user, { maxLength: 64 });
      const topic = field(form, 'Topic', 'text', c.topic, { maxLength: 64 });
      const password = field(form, 'Password (اتركه فاضي للحفاظ على الحالي)', 'password', '',
        { maxLength: 64 });
      root.append(formSubmit(form, async () => {
        const newPassword = password.value;
        password.value = '';
        await save({
          section: 'mqtt', enabled: enabled.checked, broker: broker.value,
          port: Number(port.value), user: user.value, topic: topic.value,
          ...(newPassword ? { password: newPassword } : {})
        });
      }));
      note(root, 'الباسورد المحفوظ على الجهاز: ' + (c.mqtt_password_set ? 'موجود' : 'غير موجود'));
    }

    function wifi() {
      const form = text('form', null, 'advanced-form');
      note(form, 'تغيير شبكة Wi-Fi ممكن يغيّر IP المشترك أو يفصل الاتصال بالداشبورد. يفضّل يكون عندك وصول فعلي للجهاز قبل التغيير.', 'warning');
      const netRow = text('div', null, 'advanced-inline');
      const scan = btn('🔎 فحص الشبكات القريبة', async () => {
        scan.disabled = true;
        message('جاري فحص الشبكات...');
        try {
          const result = await post(endpoint(device) + '/wifi/scan', {});
          networks.replaceChildren();
          for (const n of result.networks) {
            const option = text('option', n.ssid + (n.rssi == null ? '' : ' (' + n.rssi + ' dBm)'));
            option.value = n.ssid; networks.append(option);
          }
          if (networks.options.length) ssid.value = networks.value;
          message('✓ تم العثور على ' + result.networks.length + ' شبكة');
        } catch (e) { message(errText(e), true); } finally { scan.disabled = false; }
      });
      netRow.append(scan);
      const networks = document.createElement('select');
      networks.setAttribute('aria-label', 'شبكات Wi-Fi');
      networks.addEventListener('change', () => { ssid.value = networks.value; });
      netRow.append(networks);
      form.append(netRow);
      const ssid = field(form, 'SSID اسم الشبكة', 'text', '', { maxLength: 32 });
      const password = field(form, 'Wi-Fi Password', 'password', '', { maxLength: 64 });
      root.append(formSubmit(form, async () => {
        if (!confirm('تغيير Wi-Fi ممكن يفصل المشترك ويتغير الـIP. هل أنت متأكد؟')) return;
        const secret = password.value;
        password.value = '';
        state.busy = true;
        message('جارٍ إرسال إعدادات Wi-Fi؛ من الطبيعي الاتصال ينقطع بعدها');
        try {
          const result = await post(endpoint(device) + '/wifi/connect', {
            ssid: ssid.value, password: secret, confirm: true
          });
          message(result.accepted ? '✓ تم قبول الطلب. راقب الـIP الجديد من الراوتر.' : 'النتيجة غير مؤكدة');
        } catch (e) { message('نتيجة تغيير الشبكة غير مؤكدة: ' + errText(e), true); }
        finally { state.busy = false; }
      }, 'الاتصال بشبكة Wi-Fi'));
    }

    function firmware() {
      const f = state.info.firmware, form = text('form', null, 'advanced-form');
      if (!f) {
        note(form, 'الجهاز لم يوفّر API التحديث. افتح الداشبورد المحلية لتحديث الفيرموير.');
        const a = text('a', 'فتح الداشبورد المحلية', 'btn secondary');
        a.href = device.sourceUrl || '/';
        a.target = '_blank'; a.rel = 'noopener noreferrer';
        form.append(a); root.append(form);
        return;
      }
      note(form, 'Version: ' + (f.version || '—') + ' • Build ID: ' + (f.build_id || '—'));
      note(form, 'OTA ready: ' + (f.ota_ready ? 'نعم' : 'لا'));
      if (!f.ota_ready) { root.append(form); return; }
      note(form, 'تحديث الفيرموير عملية حساسة. استخدم ملف .fwr متوافق ومصدر موثوق، وتأكد من SHA-256 المنشورة من صاحب الفيرموير. ممنوع قطع الكهرباء أثناء التحديث.', 'warning');
      const file = field(form, 'ملف Firmware بصيغة .fwr', 'file', '');
      file.accept = '.fwr';
      const expected = field(form, 'SHA-256 الرسمية (64 رمزًا)', 'text', '', {
        maxLength: 64, placeholder: 'Paste release checksum'
      });
      const checked = field(form, 'أؤكد أن الملف مطابق لهذا المشترك وأقبل مخاطر التحديث', 'checkbox', false);
      root.append(formSubmit(form, async () => {
        if (!file.files?.length || !file.files[0].name.toLowerCase().endsWith('.fwr')) {
          message('اختر ملف .fwr صحيح', true); return;
        }
        if (!/^[a-f0-9]{64}$/i.test(expected.value)) {
          message('لازم تدخل SHA-256 من مصدر الفيرموير', true); return;
        }
        if (!checked.checked) { message('لازم توافق على تحذير التحديث', true); return; }
        const binary = file.files[0];
        if (binary.size < 44 || binary.size > 0x70000) {
          message('حجم الملف غير مناسب للـFirmware', true); return;
        }
        if (!confirm('تحذير أخير: تحديث Firmware على ' + device.name +
          ' قد يقطع الاتصال أو يفشل ويحتاج استعادة الجهاز. هل تريد بدء الكتابة الآن؟')) return;
        state.busy = true;
        message('جاري إرسال ملف التحديث. لا تفصل الكهرباء ولا تعيد الإرسال...');
        try {
          const result = await json(endpoint(device) + '/firmware/upload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-mttl-fwr',
              'X-Voltra-Confirm': 'FLASH',
              'X-Voltra-FWR-SHA256': expected.value.trim()
            },
            body: binary
          });
          message(result.already_installed
            ? 'النسخة موجودة بالفعل، لم تتم إعادة التثبيت'
            : '✓ تم قبول التحديث. الجهاز سيعيد التشغيل؛ تحقق من Build ID بعد الاتصال');
        } catch (e) {
          message('نتيجة OTA: ' + errText(e) + ' — لا تُعد المحاولة قبل فحص نسخة الجهاز', true);
        } finally { state.busy = false; }
      }, 'بدء تحديث الفيرموير'));
    }

    const tabs = [
      ['overview', 'القراءات والتشخيص'], ['logs', 'سجل الأحداث'], ['names', 'الأسماء والأقفال'],
      ['timers', 'التايمر'], ['schedules', 'الجدولة'],
      ['protection', 'الحماية'], ['mqtt', 'MQTT'],
      ['wifi', 'Wi-Fi'], ['firmware', 'Firmware']
    ];
    const views = { overview, logs, names, timers, schedules, protection, mqtt, wifi, firmware };
    function render() {
      if (!details.open || !state.info) return;
      root.replaceChildren();
      const bar = text('div', null, 'advanced-toolbar');
      for (const [key, label] of tabs) {
        const b = btn(label, () => { state.tab = key; render(); },
          (state.tab === key ? 'primary ' : 'secondary ') + 'tiny');
        bar.append(b);
      }
      bar.append(btn('↻ إعادة قراءة', load, 'secondary tiny'));
      root.append(bar, text('p', '', 'advanced-message'));
      views[state.tab]();
    }

    details.addEventListener('toggle', () => {
      if (details.open) {
        if (!state.info) load();
        else render();
      }
    });
    return details;
  }
  globalThis.VoltraSettings = { create, observe };
})();
