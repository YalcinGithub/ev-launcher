(function () {
  'use strict';

  var SVC = 'http://127.0.0.1:8097';
  var BREW_WS = 'ws://127.0.0.1:8081';
  var BACK = 10009, IME_DONE = 65376, IME_CANCEL = 65385;
  var TILE_W = 404, VISIBLE = 4;

  /* ---------- kalici ayarlar (sadece TV'de, localStorage) ---------- */
  function read(key, def) { try { var v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? def : v; } catch (e) { return def; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  var favs = read('ev_favs', []).filter(function (x) { return x && x.url; });
  var theme = read('ev_theme', 'navy');
  var wx = read('ev_weather', { on: true, name: '', lat: null, lon: null, label: '' });
  var appPrefs = read('ev_apps', { hidden: [], extra: [] }); /* hidden: kapatilan yerlesik id'ler, extra: eklenen TV uygulama id'leri */

  /* ---------- yerlesik uygulamalar ---------- */
  var BUILTIN = [
    { id: 'youtube', name: 'YouTube', sub: 'reklamsız (TizenTube)', module: /tizentube/i, match: /^youtube$/i },
    { id: 'disney', name: 'Disney+', match: /disney/i },
    { id: 'prime', name: 'Prime Video', match: /prime video|amazon/i },
    { id: 'youfone', name: 'Youfone TV', sub: 'HDMI 2', key: 'KEY_HDMI2', iconFile: 'icons/youfone.png', glyph: '▣', color: '#f28c00' }
  ];

  var tvApps = [], modules = [], ws = null, wsQueue = [];

  /* ---------- genel yardimcilar ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function hostOf(url) { var m = /^https?:\/\/([^\/?#]+)/i.exec(url || ''); return m ? m[1] : ''; }
  function normalizeUrl(s) {
    s = String(s || '').replace(/\s+/g, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return /^https?:\/\/[^\/\s]+\.[^\/\s]+/i.test(s) ? s : '';
  }
  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.className = 'show';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ''; }, ms || 3000);
  }
  function xhr(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true); x.timeout = 60000;
    x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} cb(x.status === 200 ? null : (j && j.error) || ('HTTP ' + x.status), j); };
    x.onerror = x.ontimeout = function () { cb('bağlantı yok'); };
    x.send();
  }
  function svc(path, cb) { xhr(SVC + path, function (err, j) { cb(err === 'bağlantı yok' ? 'servis yanıt vermiyor' : err, j); }); }

  function setIcon(box, src, letter, color, siteStyle) {
    box.innerHTML = '';
    function fallback() { box.innerHTML = ''; box.className = box.className.replace(/\s*\bsite\b/, ''); box.style.background = color || '#3b4a5f'; box.textContent = letter; }
    if (!src) return fallback();
    if (siteStyle) box.className += ' site';
    var img = document.createElement('img'); img.onerror = fallback; img.src = src; box.appendChild(img);
  }
  function tvIcon(app) { return app && app.icon ? SVC + '/icon?id=' + encodeURIComponent(app.id) : ''; }

  /* ---------- tema ---------- */
  var THEMES = [
    { id: 'navy', name: 'Gece mavisi', bg: 'linear-gradient(160deg,#1d2a3e,#07090d)' },
    { id: 'anth', name: 'Antrasit', bg: 'linear-gradient(160deg,#2b2e33,#111214)' },
    { id: 'green', name: 'Koyu yeşil', bg: 'linear-gradient(160deg,#1f3a2e,#0a140f)' },
    { id: 'bordo', name: 'Bordo', bg: 'linear-gradient(160deg,#4a1d26,#14070a)' },
    { id: 'purple', name: 'Mor', bg: 'linear-gradient(160deg,#33244d,#0d0915)' },
    { id: 'cream', name: 'Krem', bg: 'linear-gradient(160deg,#f6f1e7,#e9e1d2)', light: true },
    { id: 'grey', name: 'Açık gri', bg: 'linear-gradient(160deg,#eef0f3,#d9dde3)', light: true },
    { id: 'auto', name: 'Otomatik (saate göre)', bg: 'linear-gradient(90deg,#c9826b,#3d6e9e,#4b2f5e,#0b1220)' }
  ];
  function applyTheme() {
    var id = theme;
    if (id === 'auto') { var h = new Date().getHours(); id = h < 6 ? 'night' : h < 11 ? 'morning' : h < 18 ? 'day' : h < 22 ? 'evening' : 'night'; }
    var t = THEMES.filter(function (x) { return x.id === id; })[0];
    document.body.className = 't-' + id + (t && t.light ? ' light' : '');
  }

  /* ---------- saat ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  var DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  var DAYS_SHORT = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
  var MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  function tick() {
    var d = new Date(), c = $('clockline');
    c.innerHTML = '';
    c.appendChild(el('b', '', pad(d.getHours()) + ':' + pad(d.getMinutes())));
    c.appendChild(document.createTextNode(' · ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + DAYS[d.getDay()]));
    if (theme === 'auto') applyTheme();
  }

  /* ---------- hava durumu (Open-Meteo) ---------- */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICON_PATHS = {
    sun: '<circle cx="32" cy="32" r="12" fill="#f5b83d"/><g stroke="#f5b83d" stroke-width="4" stroke-linecap="round"><path d="M32 6v8M32 50v8M6 32h8M50 32h8M13.6 13.6l5.7 5.7M44.7 44.7l5.7 5.7M13.6 50.4l5.7-5.7M44.7 19.3l5.7-5.7"/></g>',
    partly: '<circle cx="24" cy="24" r="10" fill="#f5b83d"/><path d="M20 50h28a10 10 0 0 0 0-20 14 14 0 0 0-26 4 8 8 0 0 0-2 16z" fill="#c9d2de"/>',
    cloud: '<path d="M14 48h34a11 11 0 0 0 0-22 15 15 0 0 0-28 4 9 9 0 0 0-6 18z" fill="#b5bfcc"/>',
    fog: '<path d="M14 36h34a11 11 0 0 0 0-22 15 15 0 0 0-28 4 9 9 0 0 0-6 18z" fill="#b5bfcc"/><g stroke="#b5bfcc" stroke-width="4" stroke-linecap="round"><path d="M12 46h40M18 54h28"/></g>',
    rain: '<path d="M16 40h32a10 10 0 0 0 0-20 14 14 0 0 0-26 4 8 8 0 0 0-6 16z" fill="#aab4c2"/><g stroke="#5aa8e6" stroke-width="4" stroke-linecap="round"><path d="M22 46l-3 8M32 46l-3 8M42 46l-3 8"/></g>',
    snow: '<path d="M16 40h32a10 10 0 0 0 0-20 14 14 0 0 0-26 4 8 8 0 0 0-6 16z" fill="#c9d2de"/><g fill="#e8f1fb"><circle cx="22" cy="50" r="3"/><circle cx="32" cy="55" r="3"/><circle cx="42" cy="50" r="3"/></g>',
    storm: '<path d="M16 38h32a10 10 0 0 0 0-20 14 14 0 0 0-26 4 8 8 0 0 0-6 16z" fill="#8f99a8"/><path d="M33 40l-8 12h7l-4 10 11-14h-7l5-8z" fill="#f5b83d"/>'
  };
  function wmo(code) {
    if (code === 0) return ['sun', 'açık'];
    if (code <= 2) return ['partly', 'parçalı bulutlu'];
    if (code === 3) return ['cloud', 'bulutlu'];
    if (code === 45 || code === 48) return ['fog', 'sisli'];
    if (code >= 51 && code <= 67) return ['rain', 'yağmurlu'];
    if (code >= 71 && code <= 77) return ['snow', 'karlı'];
    if (code >= 80 && code <= 82) return ['rain', 'sağanak'];
    if (code >= 85 && code <= 86) return ['snow', 'kar sağanağı'];
    if (code >= 95) return ['storm', 'fırtınalı'];
    return ['cloud', ''];
  }
  function svgIcon(kind) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 64 64');
    s.innerHTML = ICON_PATHS[kind] || ICON_PATHS.cloud;
    return s;
  }
  function renderWeather(data) {
    var box = $('weather');
    if (!wx.on || !wx.lat || !data) { box.className = ''; return; }
    box.innerHTML = '';
    var now = el('div', 'wnow'), w = wmo(data.current.weather_code);
    now.appendChild(svgIcon(w[0]));
    var txt = el('div');
    txt.appendChild(el('div', 't', Math.round(data.current.temperature_2m) + '°'));
    txt.appendChild(el('div', 'c', wx.name + (w[1] ? ' · ' + w[1] : '')));
    now.appendChild(txt); box.appendChild(now);
    for (var i = 1; i <= 2 && i < data.daily.time.length; i++) {
      var d = el('div', 'wday'), day = new Date(data.daily.time[i] + 'T12:00:00');
      d.appendChild(el('div', 'd', DAYS_SHORT[day.getDay()]));
      d.appendChild(svgIcon(wmo(data.daily.weather_code[i])[0]));
      var r = el('div', 'r', Math.round(data.daily.temperature_2m_max[i]) + '° ');
      r.appendChild(el('span', '', Math.round(data.daily.temperature_2m_min[i]) + '°'));
      d.appendChild(r); box.appendChild(d);
    }
    box.className = 'on';
  }
  function loadWeather() {
    if (!wx.on || !wx.lat) return renderWeather(null);
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + wx.lat + '&longitude=' + wx.lon +
      '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3';
    xhr(url, function (err, data) {
      if (!err && data && data.current) { write('ev_weather_cache', data); renderWeather(data); }
      else renderWeather(read('ev_weather_cache', null));
    });
  }

  /* ---------- TizenBrew kanali (TizenTube icin) ---------- */
  function brew(msg) {
    if (ws && ws.readyState === 1) return ws.send(JSON.stringify(msg));
    wsQueue.push(msg);
    if (ws) return;
    try { ws = new WebSocket(BREW_WS); } catch (e) { ws = null; return; }
    ws.onopen = function () { var q = wsQueue; wsQueue = []; q.forEach(function (m) { ws.send(JSON.stringify(m)); }); };
    ws.onmessage = function (ev) { var d; try { d = JSON.parse(ev.data); } catch (e) { return; } if (d.type === 4) { modules = d.payload || []; renderHome(); } };
    ws.onclose = ws.onerror = function () { ws = null; };
  }

  /* ---------- ana ekran ogeleri ---------- */
  function resolveBuiltin(b) {
    var r = { kind: 'builtin', def: b, name: b.name, mod: null, app: null };
    if (b.module) for (var i = 0; i < modules.length; i++) {
      var m = modules[i];
      if (m && b.module.test((m.name || '') + ' ' + (m.fullName || '') + ' ' + (m.appName || ''))) { r.mod = m; break; }
    }
    if (b.match) for (var j = 0; j < tvApps.length; j++) if (b.match.test(tvApps[j].name)) { r.app = tvApps[j]; break; }
    return r;
  }
  function findTvApp(id) { for (var i = 0; i < tvApps.length; i++) if (tvApps[i].id === id) return tvApps[i]; return null; }
  function homeApps() {
    var list = BUILTIN.filter(function (b) { return appPrefs.hidden.indexOf(b.id) < 0; }).map(resolveBuiltin);
    appPrefs.extra.forEach(function (id) { var a = findTvApp(id); if (a) list.push({ kind: 'tv', name: a.name, app: a }); });
    return list;
  }
  function homeFavs() { return favs.length ? favs.map(function (f, i) { return { kind: 'fav', fav: f, index: i }; }) : [{ kind: 'add' }]; }

  /* ---------- odak durumu ---------- */
  var view = 'home';
  var home = { row: 0, col: [0, 0] };          /* row: -1 = disli */
  var set = { sec: 0, zone: 'menu', line: 0, btn: 0 };
  var form = { open: false, index: -1, pos: 0 };

  function tileEl(item, focused) {
    var t = el('div', 'tile' + (focused ? ' f' : ''));
    var logo = el('div', 'logo');
    if (item.kind === 'add') { logo.className = 'logo plus'; logo.textContent = '+'; t.appendChild(logo); t.appendChild(el('div', 'name', 'Site ekle')); return t; }
    if (item.kind === 'fav') {
      var f = item.fav, host = hostOf(f.url), label = f.name || host.replace(/^www\./, '');
      setIcon(logo, f.icon || (host ? 'https://' + host + '/favicon.ico' : ''), label.charAt(0).toUpperCase(), '#3b4a5f', !f.icon);
      t.appendChild(logo); t.appendChild(el('div', 'name', label)); return t;
    }
    if (item.kind === 'builtin') {
      var b = item.def;
      if (!b.key && !item.mod && !item.app && tvApps.length) t.className += ' missing';
      setIcon(logo, b.iconFile || tvIcon(item.app), b.glyph || b.name.charAt(0), b.color);
    } else setIcon(logo, tvIcon(item.app), item.name.charAt(0), '#3b4a5f');
    t.appendChild(logo); t.appendChild(el('div', 'name', item.name));
    return t;
  }
  function renderRow(id, items, r) {
    var row = $(id); row.innerHTML = '';
    items.forEach(function (it, i) { row.appendChild(tileEl(it, view === 'home' && home.row === r && home.col[r] === i)); });
    var shift = Math.max(0, home.col[r] - (VISIBLE - 1));
    row.style.transform = 'translateX(' + (-shift * TILE_W) + 'px)';
  }
  function renderHome() {
    var a = homeApps(), f = homeFavs();
    home.col[0] = Math.min(home.col[0], Math.max(0, a.length - 1));
    home.col[1] = Math.min(home.col[1], f.length - 1);
    renderRow('row0', a, 0); renderRow('row1', f, 1);
    $('gear').className = view === 'home' && home.row === -1 ? 'f' : '';
  }

  /* ---------- acma islemleri ---------- */
  function launchModule(m) {
    brew({ type: 5, payload: m });
    setTimeout(function () { location.href = m.appPath; }, m.evaluateScriptOnDocumentStart ? 1200 : 300);
  }
  function openItem(item) {
    if (item.kind === 'add') return openForm(-1);
    if (item.kind === 'fav') {
      toast((item.fav.name || hostOf(item.fav.url)) + ' açılıyor…');
      return svc('/open-url?url=' + encodeURIComponent(item.fav.url), function (err) { if (err) toast('Tarayıcı açılamadı: ' + err, 6000); });
    }
    if (item.kind === 'builtin' && item.def.key) {
      toast(item.name + ' açılıyor…', 5000);
      return svc('/key?key=' + item.def.key, function (err, j) { if (err) toast('Geçiş olmadı: ' + err + (j && j.detail ? ' [' + j.detail + ']' : ''), 15000); });
    }
    if (item.mod) { toast(item.name + ' açılıyor…'); return launchModule(item.mod); }
    if (item.app) {
      toast(item.name + ' açılıyor…');
      return svc('/launch?back=1&id=' + encodeURIComponent(item.app.id), function (err) { if (err) toast('Açılamadı: ' + err, 6000); });
    }
    toast(item.name + ' bu TV\'de bulunamadı.', 4000);
  }

  /* ---------- ayarlar ---------- */
  var SECTIONS = ['Favori siteler', 'Uygulamalar', 'Görünüm', 'Hava durumu', 'Nasıl kullanılır'];
  var wxResults = [], wxSearching = false, wxQuery = '';

  function openSettings() { view = 'settings'; set.zone = 'menu'; set.line = 0; set.btn = 0; $('gear').className = ''; $('home').style.display = 'none'; $('settings').className = 'on'; renderSettings(); }
  function closeSettings() { view = 'home'; $('settings').className = ''; $('home').style.display = ''; var i = $('wx-input'); if (i) i.blur(); renderHome(); }

  /* her bolumun icerik satirlari: [{el, btns, onKey}] */
  function contentLines() {
    var lines = [];
    if (set.sec === 0) {
      lines.push({ label: '+ Yeni site ekle', btns: [], ok: function () { openForm(-1); } });
      favs.forEach(function (f, i) {
        lines.push({ fav: f, btns: ['Düzenle', '▲', '▼', 'Sil'], ok: function (b) {
          if (b === 0) return openForm(i);
          if (b === 1 && i > 0) { favs.splice(i - 1, 0, favs.splice(i, 1)[0]); write('ev_favs', favs); set.line--; }
          else if (b === 2 && i < favs.length - 1) { favs.splice(i + 1, 0, favs.splice(i, 1)[0]); write('ev_favs', favs); set.line++; }
          else if (b === 3) { favs.splice(i, 1); write('ev_favs', favs); set.btn = 0; set.line = Math.min(set.line, favs.length); toast('Silindi.'); }
          renderSettings();
        } });
      });
    } else if (set.sec === 1) {
      BUILTIN.forEach(function (b) {
        var r = resolveBuiltin(b);
        lines.push({ app: r, title: b.name, sub: b.sub || '', toggle: appPrefs.hidden.indexOf(b.id) < 0, ok: function () {
          var k = appPrefs.hidden.indexOf(b.id);
          if (k >= 0) appPrefs.hidden.splice(k, 1); else appPrefs.hidden.push(b.id);
          write('ev_apps', appPrefs); renderSettings();
        } });
      });
      var builtinIds = BUILTIN.map(function (b) { return resolveBuiltin(b).app; }).filter(Boolean).map(function (a) { return a.id; });
      tvApps.filter(function (a) { return builtinIds.indexOf(a.id) < 0; })
        .sort(function (x, y) { return x.name.localeCompare(y.name, 'tr'); })
        .forEach(function (a) {
          lines.push({ tv: a, title: a.name, sub: 'TV\'de yüklü', toggle: appPrefs.extra.indexOf(a.id) >= 0, ok: function () {
            var k = appPrefs.extra.indexOf(a.id);
            if (k >= 0) appPrefs.extra.splice(k, 1); else appPrefs.extra.push(a.id);
            write('ev_apps', appPrefs); renderSettings();
          } });
        });
    } else if (set.sec === 3) {
      lines.push({ title: 'Ana ekranda göster', toggle: wx.on, ok: function () { wx.on = !wx.on; write('ev_weather', wx); loadWeather(); renderSettings(); } });
      lines.push({ input: true, ok: function () { var i = $('wx-input'); if (i) i.focus(); } });
      wxResults.forEach(function (r) {
        lines.push({ result: r, ok: function () {
          wx.name = r.name; wx.lat = r.latitude; wx.lon = r.longitude; wx.label = [r.admin1, r.country].filter(Boolean).join(', '); wx.on = true;
          write('ev_weather', wx); wxResults = []; wxQuery = ''; set.line = 1; toast(r.name + ' kaydedildi.'); loadWeather(); renderSettings();
        } });
      });
    }
    return lines;
  }

  function renderSettings() {
    var menu = $('menu'); menu.innerHTML = '';
    SECTIONS.forEach(function (s, i) {
      menu.appendChild(el('div', 'menu-it' + (i === set.sec ? ' sel' : '') + (set.zone === 'menu' && i === set.sec ? ' f' : ''), s));
    });
    var c = $('content-list'); c.innerHTML = ''; c.className = ''; $('credit').textContent = '';
    var inContent = set.zone === 'content';

    if (set.sec === 2) {
      c.appendChild(el('h2', '', 'Arka plan'));
      c.appendChild(el('div', 'note', 'Yazı rengi seçilen arka plana göre otomatik ayarlanır.'));
      var grid = el('div', 'swatches');
      THEMES.forEach(function (t, i) {
        var chip = el('div', 'chip' + (t.id === theme ? ' cur sel' : ''));
        var box = el('div', 'c', 'Aa'); box.style.background = t.bg; box.style.color = t.light ? '#1f2329' : '#fff';
        if (inContent && set.line === i) box.className += ' f';
        chip.appendChild(box); chip.appendChild(el('div', 'lbl', t.name)); grid.appendChild(chip);
      });
      c.appendChild(grid);
      return;
    }
    if (set.sec === 4) {
      c.className = 'help';
      c.appendChild(el('h2', '', 'Nasıl kullanılır'));
      [
        ['OK', ' — seçili uygulamayı ya da siteyi açar.'],
        ['Yukarı ok', ' (en üst sıradayken) — ⚙ ayarlara gider.'],
        ['Geri', ' — ayarlardan ana ekrana, ana ekrandan TizenBrew\'a döner. Home — Samsung menüsü.'],
        ['', 'Launcher\'dan açılan bir uygulamadan çıkınca bu ekran kendiliğinden geri gelir.'],
        ['Favoriler', ' — Ayarlar → Favori siteler: ekle, düzenle, sırala, sil.'],
        ['Uygulamalar', ' — Ayarlar → Uygulamalar: ana ekranda görünecekleri aç/kapat.'],
        ['Youfone simgesi', ' — GitHub deposunda app/icons/youfone.png olarak yükle.'],
        ['Site simgesi', ' — beğenmezsen favoriyi düzenle, "Simge adresi"ne bir resim linki yaz.']
      ].forEach(function (p) { var e = el('p'); if (p[0]) e.appendChild(el('b', '', p[0])); e.appendChild(document.createTextNode(p[1])); c.appendChild(e); });
      return;
    }
    var titles = { 0: ['Favori siteler', ''], 1: ['Ana ekranda gösterilecek uygulamalar', ''], 3: ['Hava durumu', 'Şehir adını yaz, Bitti\'ye bas, listeden doğrusunu seç.'] };
    c.appendChild(el('h2', '', titles[set.sec][0]));
    if (titles[set.sec][1]) c.appendChild(el('div', 'note', titles[set.sec][1]));
    if (set.sec === 3) $('credit').textContent = 'Hava durumu verileri: Open-Meteo.com';

    contentLines().forEach(function (L, i) {
      var focused = inContent && set.line === i;
      if (L.input) {
        var inp = el('input', 'field' + (focused ? ' f' : ''));
        inp.id = 'wx-input'; inp.type = 'text'; inp.placeholder = 'Şehir adı';
        inp.value = wxSearching ? 'Aranıyor…' : (wxQuery || wx.name || '');
        c.appendChild(inp);
        return;
      }
      if (L.result) {
        var r = el('div', 'res-item' + (focused ? ' f' : ''), L.result.name);
        r.appendChild(el('small', '', [L.result.admin1, L.result.country].filter(Boolean).join(', ')));
        c.appendChild(r); return;
      }
      var line = el('div', 'line' + (focused && !L.btns ? ' f' : '') + (focused && L.btns && !L.btns.length ? ' f' : ''));
      if (L.fav) {
        var ic = el('div', 'ic'), host = hostOf(L.fav.url), label = L.fav.name || host;
        setIcon(ic, L.fav.icon || 'https://' + host + '/favicon.ico', label.charAt(0).toUpperCase(), '#3b4a5f', !L.fav.icon);
        line.appendChild(ic);
        var t = el('div', 't', label); t.appendChild(el('small', '', host)); line.appendChild(t);
      } else if (L.app || L.tv) {
        var ic2 = el('div', 'ic');
        if (L.app) setIcon(ic2, L.app.def.iconFile || tvIcon(L.app.app), L.app.def.glyph || L.title.charAt(0), L.app.def.color);
        else setIcon(ic2, tvIcon(L.tv), L.title.charAt(0), '#3b4a5f');
        line.appendChild(ic2);
        var t2 = el('div', 't', L.title); if (L.sub) t2.appendChild(el('small', '', L.sub)); line.appendChild(t2);
      } else line.appendChild(el('div', 't', L.label || L.title));
      if (L.toggle !== undefined) line.appendChild(el('div', 'sw' + (L.toggle ? ' on' : '')));
      if (L.btns) L.btns.forEach(function (b, bi) {
        line.appendChild(el('div', 'act' + (b === 'Sil' ? ' del' : '') + (focused && set.btn === bi ? ' f' : ''), b));
      });
      if (focused && L.btns && L.btns.length) line.className += ' f';
      c.appendChild(line);
    });
    var lineH = 106, maxVisible = 7;
    c.style.transform = 'translateY(' + (-Math.max(0, set.line - (maxVisible - 1)) * lineH) + 'px)';
  }

  function searchCity(q) {
    q = String(q || '').trim();
    if (q.length < 2) return toast('En az 2 harf yaz.');
    wxQuery = q; wxSearching = true;
    var i0 = $('wx-input'); if (i0) i0.blur();
    renderSettings();
    xhr('https://geocoding-api.open-meteo.com/v1/search?count=6&language=tr&name=' + encodeURIComponent(q), function (err, j) {
      wxSearching = false;
      wxResults = (j && j.results) || [];
      if (err) toast('Arama yapılamadı: ' + err, 5000);
      else if (!wxResults.length) toast('Şehir bulunamadı.');
      set.line = wxResults.length ? 2 : 1;
      var i = $('wx-input'); if (i) i.blur();
      renderSettings();
    });
  }

  function settingsKey(k) {
    if (set.zone === 'menu') {
      if (k === 38 && set.sec > 0) set.sec--;
      else if (k === 40 && set.sec < SECTIONS.length - 1) set.sec++;
      else if ((k === 39 || k === 13) && set.sec !== 4) { set.zone = 'content'; set.line = 0; set.btn = 0; }
      else if (k === BACK) return closeSettings();
      else return;
      wxResults = set.sec === 3 ? wxResults : [];
      return renderSettings();
    }
    /* icerik */
    if (set.sec === 2) {
      var cols = 4, n = THEMES.length;
      if (k === 37) { if (set.line % cols === 0) set.zone = 'menu'; else set.line--; }
      else if (k === 39 && set.line % cols < cols - 1 && set.line < n - 1) set.line++;
      else if (k === 38 && set.line >= cols) set.line -= cols;
      else if (k === 40 && set.line + cols < n) set.line += cols;
      else if (k === 13) { theme = THEMES[set.line].id; write('ev_theme', theme); applyTheme(); }
      else if (k === BACK) set.zone = 'menu';
      else return;
      return renderSettings();
    }
    var lines = contentLines(), L = lines[set.line];
    if (!L) { set.zone = 'menu'; return renderSettings(); }
    var nb = L.btns ? L.btns.length : 0;
    if (k === BACK) set.zone = 'menu';
    else if (k === 38 && set.line > 0) { set.line--; set.btn = 0; }
    else if (k === 40 && set.line < lines.length - 1) { set.line++; set.btn = 0; }
    else if (k === 37) { if (nb && set.btn > 0) set.btn--; else set.zone = 'menu'; }
    else if (k === 39 && nb && set.btn < nb - 1) set.btn++;
    else if (k === 13) { if (L.input) { var i = $('wx-input'); if (i) i.focus(); return; } return L.ok(set.btn); }
    else return;
    renderSettings();
  }

  /* ---------- favori formu ---------- */
  var FIELDS = ['f-name', 'f-url', 'f-icon'], BTNS = ['b-save', 'b-cancel'];
  function formFocus() {
    FIELDS.concat(BTNS).forEach(function (id) { $(id).className = $(id).className.replace(/\s*\bf\b/g, ''); });
    var id = form.pos < 3 ? FIELDS[form.pos] : BTNS[form.pos - 3];
    $(id).className += ' f';
    if (form.pos < 3) $(id).focus(); else FIELDS.forEach(function (x) { $(x).blur(); });
  }
  function openForm(index) {
    var f = index >= 0 ? favs[index] : { name: '', url: '', icon: '' };
    form.open = true; form.index = index; form.pos = 0;
    $('form-title').textContent = index >= 0 ? 'Favoriyi düzenle' : 'Yeni site ekle';
    $('f-name').value = f.name || ''; $('f-url').value = f.url || ''; $('f-icon').value = f.icon || '';
    $('form').className = 'on';
    setTimeout(formFocus, 50);
  }
  function closeForm() { form.open = false; FIELDS.forEach(function (x) { $(x).blur(); }); $('form').className = ''; }
  function saveForm() {
    var url = normalizeUrl($('f-url').value);
    if (!url) return toast('Adres geçersiz görünüyor.', 4000);
    var iconRaw = String($('f-icon').value || '').trim(), icon = iconRaw ? normalizeUrl(iconRaw) : '';
    if (iconRaw && !icon) return toast('Simge adresi geçersiz görünüyor.', 4000);
    var entry = { name: String($('f-name').value || '').trim().slice(0, 30), url: url, icon: icon };
    if (form.index >= 0) favs[form.index] = entry; else favs.push(entry);
    write('ev_favs', favs); closeForm(); toast('Kaydedildi.');
    if (view === 'settings') renderSettings(); else renderHome();
  }
  function formKey(k) {
    if (k === BACK || k === IME_CANCEL) return closeForm();
    if (k === 38) { if (form.pos >= 3) form.pos = 2; else if (form.pos > 0) form.pos--; return formFocus(); }
    if (k === 40) { if (form.pos < 3) { form.pos++; formFocus(); } return; }
    if (k === 37 && form.pos === 4) { form.pos = 3; return formFocus(); }
    if (k === 39 && form.pos === 3) { form.pos = 4; return formFocus(); }
    if (k === 13 || k === IME_DONE) {
      if (form.pos < 3) { form.pos++; return formFocus(); }
      return form.pos === 3 ? saveForm() : closeForm();
    }
  }

  /* ---------- ana ekran tuslari ---------- */
  function homeKey(k) {
    var lens = [homeApps().length, homeFavs().length];
    if (home.row === -1) {
      if (k === 13) return openSettings();
      if (k === 40) home.row = 0;
      else if (k === BACK) return history.back();
      else return;
      return renderHome();
    }
    switch (k) {
      case 37: if (home.col[home.row] > 0) home.col[home.row]--; break;
      case 39: if (home.col[home.row] < lens[home.row] - 1) home.col[home.row]++; break;
      case 38: home.row = home.row === 1 ? 0 : -1; break;
      case 40: if (home.row === 0) home.row = 1; break;
      case 13:
        var item = (home.row === 0 ? homeApps() : homeFavs())[home.col[home.row]];
        if (item) openItem(item);
        return;
      case BACK: return history.back();
      default: return;
    }
    renderHome();
  }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    var nav = [13, 37, 38, 39, 40, BACK, IME_DONE, IME_CANCEL];
    if (nav.indexOf(k) < 0) return;
    if (form.open) {
      if ((k === 37 || k === 39) && form.pos < 3) return; /* metin icinde imleci oynatsin */
      e.preventDefault(); return formKey(k);
    }
    var wxIn = $('wx-input');
    if (view === 'settings' && wxIn && document.activeElement === wxIn) {
      if (k === 37 || k === 39) return;
      e.preventDefault();
      if (k === 13 || k === IME_DONE) return searchCity(wxIn.value);
      if (k === BACK || k === IME_CANCEL || k === 38) { wxIn.blur(); if (k === 38) { set.line = 0; } return renderSettings(); }
      if (k === 40) { wxIn.blur(); if (wxResults.length) set.line = 2; return renderSettings(); }
      return;
    }
    e.preventDefault();
    if (view === 'settings') return settingsKey(k);
    homeKey(k);
  });

  function loadApps(retry) {
    svc('/apps', function (err, list) {
      if (err) {
        if (retry < 5) return setTimeout(function () { loadApps(retry + 1); }, 1500);
        return toast('Uygulama listesi alınamadı: ' + err, 6000);
      }
      tvApps = list || [];
      renderHome(); if (view === 'settings') renderSettings();
    });
  }

  applyTheme();
  tick(); setInterval(tick, 10000);
  renderHome();
  renderWeather(read('ev_weather_cache', null));
  loadWeather(); setInterval(loadWeather, 60 * 60 * 1000);
  brew({ type: 4, payload: false });
  loadApps(0);
})();
