(function () {
  'use strict';

  var SVC = 'http://127.0.0.1:8097';
  var BREW_WS = 'ws://127.0.0.1:8081';
  var COLS = 3;

  /* match: yuklu uygulama adinda aranacak ifade. module: once denenecek TizenBrew modulu. key: kumanda tusu. */
  var TILES = [
    { name: 'YouTube', sub: 'reklamsız', letter: '▶', color: '#e62117', module: /tizentube/i, match: /^youtube$/i },
    { name: 'Disney+', sub: '', letter: 'D', color: '#113ccf', match: /disney/i },
    { name: 'Prime Video', sub: '', letter: 'P', color: '#00a8e1', match: /prime video|amazon/i },
    { name: 'IPTV', sub: '', letter: 'TV', color: '#7b3fe4', match: /iptv/i },
    { name: 'İnternet', sub: 'tarayıcı', letter: '◎', color: '#1f9d6b', match: /^internet$|browser|tarayıcı/i },
    { name: 'Youfone TV', sub: 'HDMI 1', letter: 'Y', color: '#f28c00', key: 'KEY_HDMI1' }
  ];

  var focus = 0, apps = [], modules = [], ws = null, wsQueue = [], pendingModule = null;
  var grid = document.getElementById('grid');

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
    x.timeout = 35000;
    x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} cb(x.status === 200 ? null : (j && j.error) || ('HTTP ' + x.status), j); };
    x.onerror = x.ontimeout = function () { cb('servis yanıt vermiyor'); };
    x.send();
  }

  /* TizenBrew'un kendi kanali: type 4 = modul listesi, type 5 = modul ac */
  function brew(msg) {
    if (ws && ws.readyState === 1) return ws.send(JSON.stringify(msg));
    wsQueue.push(msg);
    if (ws) return;
    try { ws = new WebSocket(BREW_WS); } catch (e) { ws = null; return; }
    ws.onopen = function () { var q = wsQueue; wsQueue = []; q.forEach(function (m) { ws.send(JSON.stringify(m)); }); };
    ws.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === 4) { modules = d.payload || []; resolveTiles(); }
      else if (d.type === 5 && pendingModule) { var m = pendingModule; pendingModule = null; location.href = m.appPath; }
    };
    ws.onclose = ws.onerror = function () { ws = null; };
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

  function render() {
    grid.innerHTML = '';
    TILES.forEach(function (t, i) {
      var el = document.createElement('div');
      var available = t.key || t.mod || t.app || !apps.length;
      el.className = 'tile' + (i === focus ? ' focus' : '') + (available ? '' : ' missing');
      var icon = document.createElement('div');
      icon.className = 'icon'; icon.style.background = t.color; icon.textContent = t.letter;
      if (t.letter.length > 1) icon.style.fontSize = '34px';
      var txt = document.createElement('div');
      var n = document.createElement('div'); n.className = 'name'; n.textContent = t.name;
      var s = document.createElement('div'); s.className = 'sub';
      s.textContent = available ? t.sub : 'yüklü değil';
      txt.appendChild(n); txt.appendChild(s);
      el.appendChild(icon); el.appendChild(txt);
      grid.appendChild(el);
    });
  }

  function open(t) {
    if (t.key) {
      toast(t.name + ' açılıyor…', 4000);
      return get('/key?key=' + t.key, function (err) {
        if (err) toast('Geçiş olmadı: ' + err + '. Kumandada Source → HDMI 1 kullan.', 7000);
      });
    }
    if (t.mod) { pendingModule = t.mod; toast(t.name + ' açılıyor…'); return brew({ type: 5, payload: t.mod }); }
    if (t.app) {
      toast(t.name + ' açılıyor…');
      return get('/launch?id=' + encodeURIComponent(t.app.id), function (err) { if (err) toast('Açılamadı: ' + err, 6000); });
    }
    toast(t.name + ' bu TV\'de bulunamadı.', 4000);
  }

  function move(dx, dy) {
    var n = focus + dx + dy * COLS;
    if (n >= 0 && n < TILES.length && (dx === 0 || Math.floor(n / COLS) === Math.floor(focus / COLS))) { focus = n; render(); }
  }

  document.addEventListener('keydown', function (e) {
    switch (e.keyCode) {
      case 37: move(-1, 0); break;
      case 39: move(1, 0); break;
      case 38: move(0, -1); break;
      case 40: move(0, 1); break;
      case 13: open(TILES[focus]); break;
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
