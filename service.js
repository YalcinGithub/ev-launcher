/* Ev Launcher arka plan servisi. TizenBrew bunu TV'de Node ile calistirir (ES5).
   127.0.0.1:8097 uzerinde sadece TV'nin kendisinden erisilen kucuk bir HTTP API sunar:
     GET /apps            -> yuklu uygulamalar [{id, name}]
     GET /launch?id=...   -> uygulamayi ac
     GET /key?key=KEY_... -> TV'ye kumanda tusu gonder (orn. KEY_HDMI1) */
(function () {
  'use strict';
  var http = require('http');
  var https = require('https');
  var crypto = require('crypto');
  var fs = require('fs');

  var PORT = 8097;
  var ALLOWED_ORIGIN = 'http://127.0.0.1:8081';
  var TOKEN_FILE = '/home/owner/share/ev-launcher-token.json';
  var REMOTE_NAME = Buffer.from ? Buffer.from('Ev Launcher').toString('base64') : new Buffer('Ev Launcher').toString('base64');

  function log(m) { try { console.log('EvLauncher: ' + m); } catch (e) {} }

  function readToken() {
    try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || ''; } catch (e) { return ''; }
  }
  function saveToken(t) {
    try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: t })); } catch (e) { log('token kaydedilemedi: ' + e.message); }
  }

  function bytes(str) { return Buffer.from ? Buffer.from(str, 'utf8') : new Buffer(str, 'utf8'); }

  function encodeFrame(text) {
    var payload = bytes(text), len = payload.length, mask = crypto.randomBytes(4), head;
    if (len < 126) { head = bytes('\u0000\u0000'); head[0] = 0x81; head[1] = 0x80 | len; }
    else { head = new Buffer(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    var masked = new Buffer(len);
    for (var i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([head, mask, masked]);
  }

  /* Tek bir sunucu mesajini cozer; tamamlanmamissa null doner. */
  function decodeFrame(buf) {
    if (buf.length < 2) return null;
    var len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); off = 10; }
    if (buf.length < off + len) return null;
    return { text: buf.slice(off, off + len).toString('utf8'), rest: buf.slice(off + len) };
  }

  function lanIp() {
    try {
      var ifs = require('os').networkInterfaces();
      for (var n in ifs) {
        for (var j = 0; j < ifs[n].length; j++) {
          var a = ifs[n][j];
          if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
        }
      }
    } catch (e) {}
    return null;
  }

  var lastKeyError = '';

  /* TV'nin kumanda kanalina baglanip tek bir tus gonderir.
     Kanal bazi TV'lerde 127.0.0.1'i reddeder; bu yuzden TV'nin ag IP'si de denenir. */
  function sendRemoteKey(key, cb) {
    var hosts = ['127.0.0.1'], ip = lanIp();
    if (ip) hosts.unshift(ip);
    var attempts = [];
    hosts.forEach(function (h) { attempts.push({ host: h, tls: true, port: 8002 }, { host: h, tls: false, port: 8001 }); });
    var errors = [];
    var finished = false;
    function finish(err) { if (!finished) { finished = true; cb(err); } }

    function attempt(i, lastErr) {
      if (lastErr && i > 0) { var p = attempts[i - 1]; errors.push(p.host + ':' + p.port + ' ' + lastErr); }
      if (i >= attempts.length) { lastKeyError = errors.join(' | '); return finish(lastErr || 'baglanti kurulamadi'); }
      var a = attempts[i], token = readToken();
      var path = '/api/v2/channels/samsung.remote.control?name=' + REMOTE_NAME + (a.tls && token ? '&token=' + encodeURIComponent(token) : '');
      var opts = {
        host: a.host, port: a.port, path: path, rejectUnauthorized: false,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }
      };
      var done = false;
      var req = (a.tls ? https : http).request(opts);
      var timer = setTimeout(function () { if (!done) { done = true; try { req.abort(); } catch (e) {} attempt(i + 1, 'zaman asimi (TV ekraninda izin sorusu olabilir)'); } }, a.tls ? 20000 : 8000);
      req.on('error', function (e) { if (!done) { done = true; clearTimeout(timer); attempt(i + 1, e.message); } });
      req.on('response', function (res) { if (!done) { done = true; clearTimeout(timer); attempt(i + 1, 'HTTP ' + res.statusCode); } });
      req.on('upgrade', function (res, socket, head) {
        var buf = head || new Buffer(0);
        socket.on('data', function (d) {
          buf = Buffer.concat([buf, d]);
          var f;
          while ((f = decodeFrame(buf))) {
            buf = f.rest;
            var msg; try { msg = JSON.parse(f.text); } catch (e) { continue; }
            if (msg.event === 'ms.channel.connect') {
              if (msg.data && msg.data.token) saveToken(msg.data.token);
              socket.write(encodeFrame(JSON.stringify({
                method: 'ms.remote.control',
                params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
              })));
              done = true; clearTimeout(timer);
              setTimeout(function () { try { socket.destroy(); } catch (e) {} finish(null); }, 500);
            } else if (msg.event === 'ms.channel.unauthorized') {
              done = true; clearTimeout(timer); try { socket.destroy(); } catch (e) {}
              attempt(i + 1, 'TV izin vermedi');
            }
          }
        });
        socket.on('error', function () {});
      });
      req.end();
    }
    attempt(0);
  }

  function listApps(cb) {
    try {
      tizen.application.getAppsInfo(function (list) {
        cb(null, list.filter(function (a) { return a.show !== false; }).map(function (a) { return { id: a.id, name: a.name, icon: !!a.iconPath }; }));
      }, function (e) { cb(e && e.message || 'getAppsInfo hatasi'); });
    } catch (e) { cb(e.message); }
  }

  function launchApp(id, cb) {
    try {
      tizen.application.launch(id, function () { cb(null); }, function (e) { cb(e && e.message || 'acilamadi'); });
    } catch (e) { cb(e.message); }
  }

  function selfAppId() {
    try { return tizen.application.getCurrentApplication().appInfo.id; } catch (e) { return null; }
  }

  /* Launcher'dan acilan uygulama kapaninca TizenBrew'u (ve dolayisiyla launcher'i) tekrar one getirir. */
  var watcher = null;
  function watchApp(id) {
    if (watcher) clearInterval(watcher.timer);
    var w = { seen: false, started: Date.now() };
    w.timer = setInterval(function () {
      if (Date.now() - w.started > 8 * 3600 * 1000) { clearInterval(w.timer); return; }
      try {
        tizen.application.getAppsContext(function (ctxs) {
          var running = ctxs.some(function (c) { return c.appId === id; });
          if (running) { w.seen = true; return; }
          if (w.seen || Date.now() - w.started > 30000) {
            clearInterval(w.timer); watcher = null;
            if (w.seen) {
              var me = selfAppId();
              if (me) setTimeout(function () { try { tizen.application.launch(me, function () {}, function (e) { log('geri donus: ' + (e && e.message)); }); } catch (e) {} }, 700);
            }
          }
        }, function () {});
      } catch (e) { clearInterval(w.timer); watcher = null; }
    }, 2000);
    watcher = w;
  }

  /* Uygulamanin TV'de kurulu olan kendi simgesini dondurur (launcher kendi logo dosyasi tasimaz). */
  function sendIcon(id, res) {
    try {
      var info = tizen.application.getAppInfo(id);
      var p = String(info && info.iconPath || '').replace(/^file:\/\//, '');
      if (!p) return send(res, 404, { error: 'simge yok' });
      fs.readFile(p, function (err, data) {
        if (err) return send(res, 404, { error: 'simge okunamadi' });
        var type = /\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.svg$/i.test(p) ? 'image/svg+xml' : 'image/png';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
        res.end(data);
      });
    } catch (e) { send(res, 404, { error: e.message }); }
  }

  /* Bir web adresini TV'nin varsayilan tarayicisinda acar. Varsayilan secilemezse Samsung Internet denenir. */
  function openUrl(url, cb) {
    try {
      var ctrl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url, null, null, null);
      tizen.application.launchAppControl(ctrl, null, function () { cb(null); }, function () {
        tizen.application.getAppsInfo(function (list) {
          var b = list.filter(function (a) { return /^internet$|browser/i.test(a.name) || /browser/i.test(a.id); })[0];
          if (!b) return cb('tarayici bulunamadi');
          var c2 = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url, null, null, null);
          tizen.application.launchAppControl(c2, b.id, function () { cb(null); }, function (e) { cb(e && e.message || 'tarayici acilamadi'); });
        }, function (e) { cb(e && e.message || 'uygulama listesi alinamadi'); });
      });
    } catch (e) { cb(e.message); }
  }

  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
    res.end(JSON.stringify(obj));
  }

  var server = http.createServer(function (req, res) {
    var origin = req.headers.origin;
    if (origin && origin !== ALLOWED_ORIGIN) return send(res, 403, { error: 'yasak' });
    var u = require('url').parse(req.url, true), q = u.query;

    if (u.pathname === '/ping') return send(res, 200, { ok: true });
    if (u.pathname === '/icon') return sendIcon(String(q.id || ''), res);
    if (u.pathname === '/apps') return listApps(function (err, apps) { err ? send(res, 500, { error: err }) : send(res, 200, apps); });
    if (u.pathname === '/launch') {
      if (!q.id) return send(res, 400, { error: 'id gerekli' });
      return launchApp(String(q.id), function (err) {
        if (err) return send(res, 500, { error: err });
        if (q.back === '1') watchApp(String(q.id));
        send(res, 200, { ok: true });
      });
    }
    if (u.pathname === '/open-url') {
      var target = String(q.url || '');
      if (!/^https?:\/\/[^\s]+$/i.test(target)) return send(res, 400, { error: 'gecersiz adres' });
      return openUrl(target, function (err) { err ? send(res, 500, { error: err }) : send(res, 200, { ok: true }); });
    }
    if (u.pathname === '/key') {
      var key = String(q.key || '').replace(/[^A-Z0-9_]/g, '');
      if (!/^KEY_/.test(key)) return send(res, 400, { error: 'gecersiz tus' });
      return sendRemoteKey(key, function (err) { err ? send(res, 500, { error: err, detail: lastKeyError }) : send(res, 200, { ok: true }); });
    }
    send(res, 404, { error: 'bulunamadi' });
  });

  server.on('error', function (e) { log('sunucu hatasi: ' + e.message); });
  server.listen(PORT, '127.0.0.1', function () { log('dinliyor ' + PORT); });
})();
