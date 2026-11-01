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

  /* TV'nin kumanda kanalina baglanip tek bir tus gonderir. Once 8002 (TLS + token), olmazsa 8001 denenir. */
  function sendRemoteKey(key, cb) {
    var attempts = [{ tls: true, port: 8002 }, { tls: false, port: 8001 }];
    var finished = false;
    function finish(err) { if (!finished) { finished = true; cb(err); } }

    function attempt(i, lastErr) {
      if (i >= attempts.length) return finish(lastErr || 'baglanti kurulamadi');
      var a = attempts[i], token = readToken();
      var path = '/api/v2/channels/samsung.remote.control?name=' + REMOTE_NAME + (a.tls && token ? '&token=' + encodeURIComponent(token) : '');
      var opts = {
        host: '127.0.0.1', port: a.port, path: path, rejectUnauthorized: false,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }
      };
      var done = false;
      var req = (a.tls ? https : http).request(opts);
      var timer = setTimeout(function () { if (!done) { done = true; try { req.abort(); } catch (e) {} attempt(i + 1, 'zaman asimi (TV ekraninda izin sorusu olabilir)'); } }, 30000);
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
        cb(null, list.filter(function (a) { return a.show !== false; }).map(function (a) { return { id: a.id, name: a.name }; }));
      }, function (e) { cb(e && e.message || 'getAppsInfo hatasi'); });
    } catch (e) { cb(e.message); }
  }

  function launchApp(id, cb) {
    try {
      tizen.application.launch(id, function () { cb(null); }, function (e) { cb(e && e.message || 'acilamadi'); });
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
    if (u.pathname === '/apps') return listApps(function (err, apps) { err ? send(res, 500, { error: err }) : send(res, 200, apps); });
    if (u.pathname === '/launch') {
      if (!q.id) return send(res, 400, { error: 'id gerekli' });
      return launchApp(String(q.id), function (err) { err ? send(res, 500, { error: err }) : send(res, 200, { ok: true }); });
    }
    if (u.pathname === '/key') {
      var key = String(q.key || '').replace(/[^A-Z0-9_]/g, '');
      if (!/^KEY_/.test(key)) return send(res, 400, { error: 'gecersiz tus' });
      return sendRemoteKey(key, function (err) { err ? send(res, 500, { error: err }) : send(res, 200, { ok: true }); });
    }
    send(res, 404, { error: 'bulunamadi' });
  });

  server.on('error', function (e) { log('sunucu hatasi: ' + e.message); });
  server.listen(PORT, '127.0.0.1', function () { log('dinliyor ' + PORT); });
})();
