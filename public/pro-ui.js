/*
 * Voltra Pro UI: mobile-first native-like shell over the existing, tested
 * Voltra control cards. All commands remain in their original adapters.
 */
(() => {
  'use strict';
  if (!window.VoltraAndroid) return;
  document.documentElement.classList.add('voltra-pro');
  const STORAGE = 'voltra.pro.preferences.v1';
  const byId = name => document.getElementById(name);
  const iconPaths = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    devices: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 9h8M8 13h8M8 17h4"/>',
    network: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a6 6 0 0 1 7 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/>',
    settings: '<path d="M10 3h4l.7 2.2 2 1.1 2.3-.5 2 3.5-1.7 1.8v2.2l1.7 1.8-2 3.5-2.3-.5-2 1.1L14 21h-4l-.7-2.2-2-1.1-2.3.5-2-3.5 1.7-1.8v-2.2L3 9.3l2-3.5 2.3.5 2-1.1z"/><circle cx="12" cy="12" r="3"/>',
    scan: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M3 12h18"/>',
    arrow: '<path d="m14 7-5 5 5 5"/>',
    star: '<path d="m12 2 3 6.5 7.1.9-5.2 5 1.3 7-6.2-3.4-6.2 3.4 1.3-7-5.2-5 7.1-.9z"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.4 8.2 8 11 4.6-2.8 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>',
    moon: '<path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.8 8.8 0 1 0 11.2 11.2z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M20 20v-4h-4"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m4 12 5 5 11-11"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6M12 7h.01"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'
  };
  const svg = (name, size = 21) => {
    const span = document.createElement('span');
    span.className = 'vp-icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      (iconPaths[name] || iconPaths.info) + '</svg>';
    return span;
  };
  const node = (tag, className, value) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined) el.textContent = value;
    return el;
  };
  const append = (parent, ...children) => { parent.append(...children); return parent; };
  function action(label, icon, fn, className = '') {
    const button = node('button', 'vp-action ' + className);
    button.type = 'button';
    append(button, svg(icon), node('span', '', label));
    button.addEventListener('click', fn);
    return button;
  }
  let preferences;
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    preferences = {
      theme: cached.theme === 'light' ? 'light' : 'dark',
      autoscan: cached.autoscan !== false,
      favorites: Array.isArray(cached.favorites) ?
        cached.favorites.filter(x => typeof x === 'string' && x.length < 180).slice(0, 100) : [],
      favoritesOnly: false
    };
  } catch {
    preferences = { theme: 'dark', autoscan: true, favorites: [], favoritesOnly: false };
  }
  const favoriteKey = (id, bridge) => bridge + ':' + id;
  const prefsSave = () => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({
        theme: preferences.theme, autoscan: preferences.autoscan, favorites: preferences.favorites
      }));
    } catch {}
  };
  const setTheme = value => {
    preferences.theme = value;
    document.documentElement.dataset.theme = value;
    const themeButton = byId('vp-theme-button');
    if (themeButton) themeButton.textContent = value === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن';
    prefsSave();
  };
  setTheme(preferences.theme);

  let page = 'home';
  let lastData = null;
  let initialized = false;
  let scanState = { busy: false, message: 'جاهز للبحث عن المشتركات' };
  const screens = [
    ['home', 'الرئيسية', 'home'],
    ['devices', 'المشتركات', 'devices'],
    ['network', 'الشبكة', 'network'],
    ['settings', 'الإعدادات', 'settings']
  ];
  function showPage(name, scroll = true) {
    if (!screens.some(s => s[0] === name)) return;
    page = name;
    document.documentElement.dataset.page = name;
    document.querySelectorAll('.vp-nav-button').forEach(button => {
      const active = button.dataset.screen === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'devices') {
      byId('search')?.focus?.({ preventScroll: true });
    }
    updateSummary();
  }

  function startScan() {
    showPage('network');
    window.VoltraMobile?.scanNow?.(false);
  }
  function openManual() {
    showPage('network');
    byId('bridge-name')?.focus?.({ preventScroll: false });
  }
  const shell = document.querySelector('.shell');
  if (!shell) return;

  // Set up a clear app bar, trustable connection state and an overview
  // without replacing existing forms or device controls.
  const top = shell.querySelector('.topbar');
  const mark = top?.querySelector('.mark');
  if (mark) {
    mark.textContent = '';
    mark.append(svg('bolt', 29));
  }
  const brand = top?.querySelector('.brand h1');
  if (brand) brand.innerHTML = 'VOLTRA <span>SMART HOME</span>';
  const brandDescription = top?.querySelector('.brand p');
  if (brandDescription) brandDescription.textContent = 'تحكم محلي • بدون إنترنت أو حساب';
  top?.querySelector('.top-actions')?.classList.add('vp-top-actions');

  const hero = node('section', 'vp-hero');
  hero.setAttribute('aria-label', 'ملخص المنزل');
  const heroCopy = node('div', 'vp-hero-copy');
  append(heroCopy,
    node('div', 'vp-eyebrow', 'VOLTRA  /  HOME CONTROL'),
    node('h2', 'vp-hero-title', 'بيتك تحت السيطرة'),
    node('p', 'vp-hero-desc', 'كل مشتركاتك الذكية، وحالة الطاقة والتحكم اللحظي في مكان واحد.'));
  const heroPill = node('div', 'vp-hero-chip');
  append(heroPill, svg('shield', 16), node('span', '', 'اتصال محلي وآمن داخل الشبكة'));
  heroCopy.append(heroPill);
  const heroVisual = node('div', 'vp-hero-visual');
  heroVisual.setAttribute('aria-hidden', 'true');
  const powerGlyph = node('div', 'vp-power-glyph');
  powerGlyph.append(svg('bolt', 60));
  append(heroVisual, node('div', 'vp-orbit vp-orbit-one'),
    node('div', 'vp-orbit vp-orbit-two'), powerGlyph);
  hero.append(heroCopy, heroVisual);
  const actions = node('div', 'vp-hero-actions');
  actions.append(
    action('اكتشاف المشتركات', 'scan', startScan, 'vp-primary'),
    action('عرض الأجهزة', 'devices', () => showPage('devices'), 'vp-glass'));
  hero.append(actions);
  shell.querySelector('.stats')?.before(hero);

  const welcome = node('section', 'vp-welcome');
  welcome.setAttribute('aria-live', 'polite');
  append(welcome, svg('network', 34),
    node('h3', '', 'جاهز نربط أول مشترك؟'),
    node('p', '', 'اتصل بنفس شبكة Wi-Fi اللي عليها المشترك، والتطبيق هيكتشف الأجهزة المتوافقة تلقائيًا.'));
  const welcomeActions = node('div', 'vp-welcome-actions');
  welcomeActions.append(
    action('ابدأ البحث', 'scan', startScan, 'vp-primary'),
    action('إضافة بالـ IP', 'plus', openManual));
  welcome.append(welcomeActions);
  hero.after(welcome);
  welcome.hidden = true;

  const layout = shell.querySelector('.layout');
  layout?.classList.add('vp-layout');
  const side = layout?.querySelector('.sidebar');
  const main = layout?.querySelector('.main-panel');
  const stats = shell.querySelector('.stats');
  const deviceHead = main?.querySelector('.devices-head');
  const toolbar = node('div', 'vp-section-title');
  append(toolbar, node('div', 'vp-kicker', 'MY DEVICES'),
    node('h2', '', 'المشتركات الذكية'),
    node('p', '', 'اضغط على أي مخرج للتحكم، أو افتح إعدادات المشترك للتفاصيل.'));
  main?.insertBefore(toolbar, deviceHead);

  const favoriteToggle = action('المفضلة', 'star', () => {
    preferences.favoritesOnly = !preferences.favoritesOnly;
    applyFavorites();
  }, 'vp-favorites-toggle');
  favoriteToggle.id = 'vp-favorites-toggle';
  main?.querySelector('.filters')?.append(favoriteToggle);

  const networkIntro = node('section', 'vp-network-intro');
  networkIntro.innerHTML = '<div class="vp-kicker">AUTO DISCOVERY</div>' +
    '<h2>أجهزتك على Wi-Fi</h2>' +
    '<p>التطبيق يبحث تلقائيًا في الشبكة المحلية ويتعرف على كل مشترك متوافق من عنوان MAC الحقيقي.</p>';
  const scanBanner = node('div', 'vp-scan-banner');
  const scanIcon = svg('scan', 25);
  const scanText = node('div', 'vp-scan-info');
  append(scanText,
    node('strong', '', 'البحث الذكي'),
    node('p', 'vp-scan-message', 'جاهز للبحث عن الأجهزة'));
  append(scanBanner, scanIcon, scanText);
  const scanButton = action('فحص الآن', 'refresh', startScan, 'vp-primary');
  scanButton.id = 'vp-main-scan';
  scanBanner.append(scanButton);
  networkIntro.append(scanBanner);
  side?.before(networkIntro);
  const sideTitle = side?.querySelector('.side-panel h2');
  if (sideTitle) sideTitle.textContent = 'الأجهزة المحفوظة';
  const sideDescription = side?.querySelector('.side-panel .hint');
  if (sideDescription) sideDescription.textContent = 'اتصال مباشر مع المشترك على نفس شبكة Wi-Fi. يمكنك حذف جهاز محفوظ أو إضافته من عنوانه.';
  const formPanel = side?.querySelectorAll('.side-panel')[1];
  const formTitle = formPanel?.querySelector('h2');
  if (formTitle) formTitle.textContent = 'إضافة جهاز يدويًا';
  const formExplain = formPanel?.querySelector('.tip');
  if (formExplain) formExplain.textContent = 'أدخل عنوان المشترك مثل 192.168.0.55، لو الاكتشاف التلقائي مش قادر يوصل له.';
  const formButton = byId('add-bridge');
  if (formButton) formButton.textContent = 'إضافة المشترك';
  const formUrl = byId('bridge-url');
  if (formUrl) formUrl.setAttribute('autocomplete', 'url');

  const prefPage = node('section', 'vp-settings-page');
  prefPage.id = 'vp-app-settings';
  prefPage.innerHTML = '<div class="vp-kicker">PREFERENCES</div><h2>إعدادات Voltra</h2>' +
    '<p class="vp-settings-lead">اختيارات التطبيق نفسه، غير إعدادات كل مشترك اللي بتلاقيها داخل الكارد.</p>';
  const settingsPanel = node('div', 'vp-settings-panel');
  const themeRow = node('div', 'vp-pref-row');
  const themeLabel = node('div', 'vp-pref-name');
  append(themeLabel, svg('sun'), node('div', '', 'المظهر'));
  const themeButton = node('button', 'vp-setting-button', 'الوضع الفاتح');
  themeButton.type = 'button'; themeButton.id = 'vp-theme-button';
  themeButton.addEventListener('click', () =>
    setTheme(preferences.theme === 'dark' ? 'light' : 'dark'));
  themeRow.append(themeLabel, themeButton);
  const scanRow = node('div', 'vp-pref-row');
  const scanLabel = node('div', 'vp-pref-name');
  append(scanLabel, svg('network'), node('div', '', 'الفحص التلقائي'));
  const scanToggle = node('input', 'vp-preference-checkbox');
  scanToggle.type = 'checkbox'; scanToggle.id = 'vp-autoscan-toggle';
  scanToggle.checked = preferences.autoscan;
  scanToggle.setAttribute('aria-label', 'تشغيل فحص شبكة Wi-Fi تلقائيًا');
  scanToggle.addEventListener('change', () => {
    preferences.autoscan = scanToggle.checked;
    prefsSave();
  });
  scanRow.append(scanLabel, scanToggle);
  const note = node('p', 'vp-setting-note',
    'الفحص تلقائي عند فتح التطبيق وكل 3 دقائق أثناء الاستخدام. لا يتم فحص الشبكة في الخلفية.');
  append(settingsPanel, themeRow, scanRow, note);
  prefPage.append(settingsPanel);
  const about = node('div', 'vp-about');
  append(about, svg('shield', 24), node('strong', '', 'البيانات تفضل على شبكتك'),
    node('p', '', 'اتصال الأجهزة محلي عبر Wi-Fi. التطبيق لا يطلب حسابًا ولا يرسل قراءاتك لسيرفر خارجي.'));
  const aboutLink = node('a', 'vp-about-link', 'المشروع على GitHub');
  aboutLink.href = 'https://github.com/aYmAn-Helmy/voltra-standalone';
  aboutLink.target = '_blank'; aboutLink.rel = 'noopener noreferrer';
  append(about, aboutLink);
  prefPage.append(about);
  layout?.after(prefPage);

  const nav = node('nav', 'vp-bottom-nav');
  nav.setAttribute('aria-label', 'التنقل الرئيسي');
  for (const [id, label, name] of screens) {
    const button = node('button', 'vp-nav-button');
    button.type = 'button'; button.dataset.screen = id;
    button.setAttribute('aria-label', label);
    append(button, svg(name), node('span', '', label));
    button.addEventListener('click', () => showPage(id));
    nav.append(button);
  }
  document.body.append(nav);

  const lastSync = node('div', 'vp-sync-line');
  lastSync.id = 'vp-sync-line';
  main?.querySelector('.legend')?.append(lastSync);

  function applyFavorites() {
    const all = [...document.querySelectorAll('#device-list article.device')];
    const favorites = new Set(preferences.favorites);
    const cards = all.map((card, index) => ({
      card, index, favorite: favorites.has(card.dataset.deviceKey)
    }));
    cards.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.index - b.index);
    const parent = byId('device-list');
    for (const item of cards) {
      parent.append(item.card);
      item.card.hidden = preferences.favoritesOnly && !item.favorite;
      const button = item.card.querySelector('.vp-favorite');
      if (button) {
        button.classList.toggle('selected', item.favorite);
        button.setAttribute('aria-pressed', String(item.favorite));
        button.setAttribute('aria-label', item.favorite ? 'إزالة من المفضلة' : 'إضافة للمفضلة');
      }
    }
    favoriteToggle.classList.toggle('selected', preferences.favoritesOnly);
    favoriteToggle.setAttribute('aria-pressed', String(preferences.favoritesOnly));
    const empty = byId('vp-favorite-empty');
    if (empty) empty.remove();
    if (preferences.favoritesOnly && all.length &&
        all.every(card => card.hidden)) {
      const prompt = node('p', 'vp-favorites-empty',
        'لسه ما عندكش مشتركات مفضّلة. اضغط على نجمة أي مشترك لإضافته.');
      prompt.id = 'vp-favorite-empty';
      parent.append(prompt);
    }
  }
  function enhanceCards() {
    for (const card of document.querySelectorAll('#device-list article.device')) {
      if (card.querySelector('.vp-favorite')) continue;
      const key = card.dataset.deviceKey;
      if (!key) continue;
      const button = node('button', 'vp-favorite');
      button.type = 'button';
      button.append(svg('star', 19));
      button.addEventListener('click', () => {
        const exists = preferences.favorites.includes(key);
        preferences.favorites = exists ?
          preferences.favorites.filter(s => s !== key) :
          [...preferences.favorites, key].slice(-100);
        prefsSave();
        applyFavorites();
      });
      const info = card.querySelector('.device-head > div');
      if (info) info.prepend(button);
      else card.querySelector('.device-head')?.prepend(button);
      const advanced = card.querySelector('details.device-advanced > summary');
      if (advanced && !advanced.querySelector('.vp-advanced-icon')) {
        const glyph = svg('settings', 16); glyph.classList.add('vp-advanced-icon');
        advanced.prepend(glyph);
      }
    }
    applyFavorites();
  }
  function updateSummary() {
    const s = lastData?.summary;
    const online = s?.devicesOnline ?? 0, total = s?.devices ?? 0;
    const active = s?.outletsOn ?? 0;
    const heroTitle = hero.querySelector('.vp-hero-title');
    const heroDescription = hero.querySelector('.vp-hero-desc');
    if (heroTitle) heroTitle.textContent = total ?
      online + ' من ' + total + ' مشتركات متصلة' : 'بيتك تحت السيطرة';
    if (heroDescription) heroDescription.textContent = total ?
      'دلوقتي ' + active + ' مخارج شغالة. تقدر تتحكم وتتابع كل مشترك لحظيًا.' :
      'كل مشتركاتك الذكية، وحالة الطاقة والتحكم اللحظي في مكان واحد.';
    welcome.hidden = total > 0 || !lastData;
    if (lastData && !total && page === 'home') {
      const root = byId('device-list');
      const empty = root?.querySelector('.empty');
      if (empty) empty.textContent = 'مستنيين نكتشف أول مشترك على شبكتك.';
    }
    const sync = byId('vp-sync-line');
    if (sync) {
      const at = window.view?.lastPollAt || Date.now();
      sync.textContent = total ? '● ' + online + ' متصل من ' + total : 'جاهز للبحث';
    }
    const chip = top?.querySelector('.health');
    if (chip) chip.classList.toggle('vp-healthy', online > 0);
  }
  function update(data) {
    lastData = data;
    if (!initialized) {
      initialized = true;
      const root = byId('vp-main-scan');
      if (root) root.disabled = false;
    }
    enhanceCards();
    updateSummary();
  }
  function setScanState(busy, message) {
    scanState = { busy, message };
    const item = networkIntro.querySelector('.vp-scan-message');
    if (item) item.textContent = message;
    const mainScan = byId('vp-main-scan');
    if (mainScan) {
      mainScan.disabled = busy;
      mainScan.classList.toggle('is-working', busy);
    }
    const network = document.querySelector('.vp-nav-button[data-screen="network"]');
    if (network) network.classList.toggle('is-working', busy);
  }
  function setError(message) {
    const bar = byId('vp-sync-line');
    if (bar) bar.textContent = message ? 'تعذر تحديث البيانات • جرب التحديث' : '';
  }
  window.VoltraPro = {
    showPage, update, setScanState, setError,
    get autoScanEnabled() { return preferences.autoscan; },
    get page() { return page; }
  };
  showPage('home', false);
  updateSummary();
})();
