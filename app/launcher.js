(function () {
  'use strict';

  var SVC = 'http://127.0.0.1:8097';
  var BREW_WS = 'ws://127.0.0.1:8081';
  var COLS = 4;
  var BACK = 10009;

  /* match: yuklu uygulama adinda aranacak ifade. module: once denenecek TizenBrew modulu.
     key: kumanda tusu. action: launcher icindeki ozel islem. */
  var TILES = [
    { name: 'YouTube', sub: 'reklamsız', letter: '▶', color: '#e62117', module: /tizentube/i, match: /^youtube$/i },
    { name: 'Disney+', sub: '', letter: 'D', color: '#113ccf', match: /disney/i },
    { name: 'Prime Video', sub: '', letter: 'P', color: '#00a8e1', match: /prime video|amazon/i },
    { name: 'IPTV', sub: '', letter: 'TV', color: '#7b3fe4', match: /iptv/i },
    { name: 'İnternet', sub: 'tarayıcı', letter: '◎', color: '#1f9d6b', match: /^internet$|browser|tarayıcı/i },
    { name: 'Youfone TV', sub: 'HDMI 2', letter: 'Y', color: '#f28c00', key: 'KEY_HDMI2' },
    { name: 'Uygulamalar', sub: 'tümü', letter: '⋯', color: '#5a6270', action: 'all' },
    { name: 'TizenBrew', sub: 'modüller', letter: 'B', color: '#8a5a2b', action: 'brew' }
  ];

  var focus = 0, apps = [], modules = [], ws = null, wsQueue = [];
  var overlay = { open: false, focus: 0, items: [] };

  function $(id) { return document.getElementById(id); }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.className = 'show';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ''; }, ms || 3000);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  var DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  var MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  function tick() {
    var d = new Date(), h = d.getHours();
    $('clock').textContent = pad(h) + ':' + pad(d.getMinutes());
    $('date').textContent = d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + DAYS[d.getDay()];
    $('greet').textContent = h < 6 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
  }

  function get(path, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', SVC + path, true);
    x.timeout = 60000;
    x.onload = function () {
      var j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
      cb(x.status === 200 ? null : (j && j.error) || ('HTTP ' + x.status), j);
    };
    x.onerror = x.ontimeout = function () { cb('servis yanıt vermiyor'); };
    x.send();
  }

  /* TizenBrew'un kendi kanali: type 4 = modul listesi, type 5 = modul secimi */
  function brew(msg) {
    if (ws && ws.readyState === 1) return ws.send(JSON.stringify(msg));
    wsQueue.push(msg);
    if (ws) return;
    try { ws = new WebSocket(BREW_WS); } catch (e) { ws = null; return; }
    ws.onopen = function () { var q = wsQueue; wsQueue = []; q.forEach(function (m) { ws.send(JSON.stringify(m)); }); };
    ws.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === 4) { modules = d.payload || []; resolveTiles(); }
    };
    ws.onclose = ws.onerror = function () { ws = null; };
  }

  function launchModule(m) {
    brew({ type: 5, payload: m });
    var wait = m.evaluateScriptOnDocumentStart ? 1200 : 300;
    setTimeout(function () { location.href = m.appPath; }, wait);
  }

  function findApp(re) {
    for (var i = 0; i < apps.length; i++) if (re.test(apps[i].name)) return apps[i];
    return null;
  }
  function findModule(re) {
    for (var i = 0; i < modules.length; i++) {
      var m = modules[i];
      if (m && re.test((m.name || '') + ' ' + (m.fullName || '') + ' ' + (m.appName || ''))) return m;
    }
    return null;
  }

  function resolveTiles() {
    TILES.forEach(function (t) {
      t.mod = t.module ? findModule(t.module) : null;
      t.app = t.match ? findApp(t.match) : null;
    });
    render();
  }

  function tileEl(t, focused) {
    var el = document.createElement('div');
    var available = t.key || t.action || t.mod || t.app || !apps.length;
    el.className = 'tile' + (focused ? ' focus' : '') + (available ? '' : ' missing');
    var icon = document.createElement('div');
    icon.className = 'icon'; icon.style.background = t.color; icon.textContent = t.letter;
    if (t.letter.length > 1) icon.style.fontSize = '32px';
    var txt = document.createElement('div');
    var n = document.createElement('div'); n.className = 'name'; n.textContent = t.name;
    var s = document.createElement('div'); s.className = 'sub';
    s.textContent = available ? t.sub : 'yüklü değil';
    txt.appendChild(n); txt.appendChild(s);
    el.appendChild(icon); el.appendChild(txt);
    return el;
  }

  function render() {
    var grid = $('grid');
    grid.innerHTML = '';
    TILES.forEach(function (t, i) { grid.appendChild(tileEl(t, i === focus)); });
  }

  function renderOverlay() {
    var list = $('all-list');
    list.innerHTML = '';
    overlay.items.forEach(function (a, i) {
      var el = document.createElement('div');
      el.className = 'app' + (i === overlay.focus ? ' focus' : '');
      el.textContent = a.name;
      list.appendChild(el);
    });
    var f = list.children[overlay.focus];
    if (f) list.scrollTop = Math.max(0, f.offsetTop - 360);
  }

  function openOverlay() {
    if (!apps.length) return toast('Uygulama listesi henüz yüklenmedi.', 3000);
    overlay.items = apps.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'tr'); });
    overlay.focus = 0; overlay.open = true;
    $('all').className = 'show';
    renderOverlay();
  }
  function closeOverlay() { overlay.open = false; $('all').className = ''; }

  function launchById(id, name) {
    toast(name + ' açılıyor…');
    get('/launch?back=1&id=' + encodeURIComponent(id), function (err) { if (err) toast('Açılamadı: ' + err, 6000); });
  }

  function open(t) {
    if (t.action === 'all') return openOverlay();
    if (t.action === 'brew') return history.back();
    if (t.key) {
      toast(t.name + ' açılıyor… (ilk seferde TV izin sorabilir)', 6000);
      return get('/key?key=' + t.key, function (err, j) {
        if (err) toast('Geçiş olmadı: ' + err + (j && j.detail ? ' [' + j.detail + ']' : ''), 15000);
      });
    }
    if (t.mod) { toast(t.name + ' açılıyor…'); return launchModule(t.mod); }
    if (t.app) return launchById(t.app.id, t.name);
    toast(t.name + ' bu TV\'de bulunamadı.', 4000);
  }

  function move(dx, dy) {
    var n = focus + dx + dy * COLS;
    if (n < 0 || n >= TILES.length) return;
    if (dx !== 0 && Math.floor(n / COLS) !== Math.floor(focus / COLS)) return;
    focus = n; render();
  }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (overlay.open) {
      if (k === 38 && overlay.focus > 0) { overlay.focus--; renderOverlay(); }
      else if (k === 40 && overlay.focus < overlay.items.length - 1) { overlay.focus++; renderOverlay(); }
      else if (k === 13) { var a = overlay.items[overlay.focus]; closeOverlay(); launchById(a.id, a.name); }
      else if (k === BACK || k === 37) closeOverlay();
      else return;
      return e.preventDefault();
    }
    switch (k) {
      case 37: move(-1, 0); break;
      case 39: move(1, 0); break;
      case 38: move(0, -1); break;
      case 40: move(0, 1); break;
      case 13: open(TILES[focus]); break;
      case BACK: history.back(); break;
      default: return;
    }
    e.preventDefault();
  });

  function loadApps(retry) {
    get('/apps', function (err, list) {
      if (err) {
        if (retry < 5) return setTimeout(function () { loadApps(retry + 1); }, 1500);
        toast('Uygulama listesi alınamadı: ' + err, 6000);
        return;
      }
      apps = list || [];
      resolveTiles();
    });
  }

  tick(); setInterval(tick, 10000);
  render();
  brew({ type: 4, payload: false });
  loadApps(0);
})();
