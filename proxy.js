/* eslint-disable */
/*
  DEEPREEL 本地代理 v3
  ------------------------------------------------------------------
  一个命令，开箱即用：
    1) 托管整个应用（index.html / app.js / styles.css）
    2) DeepSeek API 代理      → POST /chat/completions
    3) B站视频流 API 代理     → GET /bili/playurl?bvid=xxx&cid=xxx&qn=80&fnval=1
    4) B站视频流转发          → GET /bili/stream?url=xxx
    5) 健康检查               → GET /healthz
    6) 启动后自动打开浏览器   → http://localhost:7392/

  用法：
    npm start        # 或 node proxy.js
  端口默认 7392，可用环境变量 DEEPREEL_PORT 修改
  不想自动打开浏览器：DEEPREEL_NO_OPEN=1 node proxy.js
*/
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { exec } = require('child_process');

const PORT = process.env.DEEPREEL_PORT || 7392;
const DS_UPSTREAM = process.env.DEEPREEL_UPSTREAM || 'api.deepseek.com';
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* 全局 keep-alive：常驻连接避免每个请求冷启动（DNS/TLS），
   实测空闲后首个请求常超 20s、热连接 200ms —— 保持连接可根治 */
https.globalAgent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });

/* ============ 上游 HTTP 代理（VPN 加速） ============
   现象：系统全局代理开着时，浏览器/curl 走 VPN 快（B站 CDN ~457KB/s），
   但 Node 的 https.request 默认不走系统代理，直连只有 ~83KB/s。
   解决：探测本机 VPN 代理（默认 127.0.0.1:7790，可用 DEEPREEL_HTTP_PROXY 覆盖），
   B站请求经 HTTP CONNECT 隧道走代理；代理不可用则自动回退直连。 */
let UPSTREAM_PROXY = null;   // { host, port } 或 null
/* 只让 API 域名走代理（实测 api 走 VPN 快 20 倍），视频 CDN（bilivideo/mcdn）直连更快（VPN 绕远） */
const PROXY_HOSTS = new Set(['api.bilibili.com']);
function detectUpstreamProxy(){
  const env = process.env.DEEPREEL_HTTP_PROXY;
  if(env){
    try{ const u = new URL(env); UPSTREAM_PROXY = { host:u.hostname, port: parseInt(u.port||'7790',10) }; return; }catch{}
  }
  const s = net.connect(7790, '127.0.0.1');
  let ok = false;
  s.on('connect', ()=>{ ok = true; UPSTREAM_PROXY = { host:'127.0.0.1', port:7790 }; logLine('[proxy] upstream proxy detected 127.0.0.1:7790'); s.destroy(); });
  s.on('error', ()=>{ if(!ok) UPSTREAM_PROXY = null; });
  s.setTimeout(1500, ()=> s.destroy());
}

/* 经 CONNECT 隧道发起 https 请求，返回兼容 https.request 的接口（on/setTimeout/end） */
function proxiedHttpsRequest(targetUrl, opts, onResponse){
  const u = new URL(targetUrl);
  const events = {};
  const api = {
    on(ev, cb){ events[ev] = cb; return api; },
    setTimeout(ms, cb){ api._timeoutMs = ms; api._timeoutCb = cb; return api; },
    end(){ api._ended = true; launch(); return api; },
    destroy(e){ if(api._req) api._req.destroy(e); },
    _timeoutMs: 0, _timeoutCb: null, _ended: false, _req: null,
  };
  const fail = e => { if(events['error']) events['error'](e); };
  const direct = () => {
    const r = https.request({ host:u.hostname, port:u.port||443, path:u.pathname+u.search, method:opts.method||'GET', headers:opts.headers||{}, rejectUnauthorized: opts.rejectUnauthorized !== false }, onResponse);
    api._req = r;
    r.on('error', fail);
    if(api._timeoutMs) r.setTimeout(api._timeoutMs, api._timeoutCb || (()=>{}));
    return r;
  };
  function launch(){
    if(!UPSTREAM_PROXY || !PROXY_HOSTS.has(u.hostname)){ direct().end(); return; }
    const socket = net.connect(UPSTREAM_PROXY.port, UPSTREAM_PROXY.host);
    let settled = false;
    socket.setTimeout(12000, ()=>{ if(!settled){ settled=true; socket.destroy(); fail(new Error('proxy connect timeout')); } });
    socket.on('connect', ()=>{ socket.write(`CONNECT ${u.hostname}:${u.port||443} HTTP/1.1\r\nHost: ${u.hostname}:${u.port||443}\r\n\r\n`); });
    let buf = '';
    const onData = d => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if(i === -1) return;
      socket.removeListener('data', onData);
      const statusLine = buf.slice(0, i).split('\r\n')[0];
      if(!/ 200 /.test(statusLine)){ if(!settled){ settled=true; socket.destroy(); fail(new Error('CONNECT '+statusLine)); } return; }
      settled = true;
      socket.setTimeout(0);
      /* CONNECT 隧道打通后，在明文 socket 上手动做 TLS 握手，再把 TLS socket 交给 https.request */
      const tlsSock = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: opts.rejectUnauthorized !== false });
      tlsSock.once('secureConnect', () => {
        const r = https.request({ host:u.hostname, port:u.port||443, path:u.pathname+u.search, method:opts.method||'GET', headers:opts.headers||{}, agent:false, createConnection: ()=>tlsSock }, onResponse);
        api._req = r;
        r.on('error', fail);
        if(api._timeoutMs) r.setTimeout(api._timeoutMs, api._timeoutCb || (()=>{}));
        r.end();
      });
      tlsSock.on('error', e => { if(settled){ settled = false; direct().end(); } else { fail(e); } });
    };
    socket.on('data', onData);
    socket.on('error', () => { if(!settled){ settled=true; direct().end(); } });  // 代理不可用 → 直连兜底
  }
  return api;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, PUT, MKCOL, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bili-Cookie, X-Webdav-Auth, X-Webdav-Host, X-Webdav-Path, X-Webdav-Scheme',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};

/* 上游（B站 CDN）自带 CORS 头时先剥掉，避免与本地 CORS 叠加成 '*, *' 导致浏览器拒绝 */
function stripCors(headers) {
  const h = { ...headers };
  for (const k of Object.keys(h)) {
    if (/^access-control-/i.test(k)) delete h[k];
  }
  return h;
}

/* 统一请求处理器：http(7392) 与 https(7443) 共用 */
const handler = (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const path = parsed.pathname;

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ ok: true, name: 'deepreel-proxy', version: 3 }));
  } else if (path === '/debug-report') {
    const m = parsed.searchParams.get('m') || '';
    logLine(`[app] from=${req.socket.remoteAddress} ${m}`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end('{}');
  } else if (path === '/chat/completions' || path === '/v1/chat/completions') {
    handleDeepSeek(req, res);
  } else if (path === '/bili/playurl') {
    handleBiliPlayurl(req, res, parsed);
  } else if (path === '/bili/view') {
    handleBiliView(req, res, parsed);
  } else if (path === '/bili/player') {
    handleBiliPlayer(req, res, parsed);
  } else if (path === '/bili/qrcode/generate') {
    handleBiliQrGenerate(req, res);
  } else if (path === '/bili/qrcode/poll') {
    handleBiliQrPoll(req, res, parsed);
  } else if (path === '/bili/stream') {
    handleBiliStream(req, res, parsed);
  } else if (path === '/bili/img') {
    handleBiliImg(req, res, parsed);
  } else if (path.startsWith('/webdav/')) {
    handleWebdav(req, res, parsed);
  } else {
    serveStatic(req, res, path);
  }
};

/* ---------- HTTP 服务（本机 7392） ---------- */
http.createServer(handler).on('error', (err) => {
  /* 端口已被占用：代理多半已在运行，直接打开应用即可，不必报错 */
  if (err && err.code === 'EADDRINUSE') {
    console.log(`\n  端口 ${PORT} 已被占用 —— 代理似乎已经在运行。`);
    console.log(`  直接打开应用：http://localhost:${PORT}/\n`);
    if (!process.env.DEEPREEL_NO_OPEN) openBrowser(`http://localhost:${PORT}/`);
    process.exit(0);
  }
  throw err;
}).listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\n  DEEPREEL 代理 v3 已启动`);
  console.log(`  应用地址  → ${url}`);
  console.log(`  DeepSeek  → /chat/completions`);
  console.log(`  B站 API   → /bili/playurl, /bili/view, /bili/player`);
  console.log(`  B站 流    → /bili/stream?url=xxx`);
  console.log(`  按 Ctrl+C 停止\n`);
  if (!process.env.DEEPREEL_NO_OPEN) openBrowser(url);
  /* 探测本机 VPN 代理（加速 B站 CDN）；每 60s 重检，代理开关时自动切换 */
  detectUpstreamProxy();
  setInterval(detectUpstreamProxy, 60000);
  /* 预热：解析并轻连一次 api.bilibili.com，避免首个播放请求因 DNS/连接冷启动超时 */
  try { dns.lookup('api.bilibili.com', () => {}); } catch {}
  try {
    const warm = https.request({ host: 'api.bilibili.com', path: '/x/web-interface/nav', method: 'HEAD' }, () => {});
    warm.on('error', () => {});
    warm.end();
  } catch {}
  /* 常驻保活：每 20s 轻连一次 B站，让 keep-alive 连接不被回收（杜绝冷启动超时） */
  setInterval(() => {
    try {
      const ping = https.request({ host: 'api.bilibili.com', path: '/x/web-interface/nav', method: 'HEAD' }, () => {});
      ping.on('error', () => {});
      ping.end();
    } catch {}
  }, 20000);
});

/* ---------- HTTPS 服务（局域网/手机 7443，需 certs/ 证书） ---------- */
const HTTPS_PORT = process.env.DEEPREEL_HTTPS_PORT || 7443;
const certDir = path.join(__dirname, 'certs');
if (fs.existsSync(path.join(certDir, 'cert.pem')) && fs.existsSync(path.join(certDir, 'key.pem'))) {
  try {
    const tlsOpts = {
      key: fs.readFileSync(path.join(certDir, 'key.pem')),
      cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
    };
    https.createServer(tlsOpts, handler).on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.log(`  端口 ${HTTPS_PORT} 已被占用 —— HTTPS 服务已在运行。`);
        return;
      }
      throw err;
    }).listen(HTTPS_PORT, () => {
      console.log(`  HTTPS    → https://localhost:${HTTPS_PORT}/（手机/平板用 https://<电脑局域网IP>:${HTTPS_PORT}/，需先安装 certs/deepreel-cert.cer 并信任）`);
    });
  } catch (e) {
    console.log('  HTTPS 启动失败：' + String(e && e.message || e));
  }
} else {
  console.log('  HTTPS    → 未启用（缺少 certs/cert.pem 与 key.pem，可运行 certs 生成脚本后重启）');
}

/* ============ WebDAV 云同步转发 ============ */
/* 浏览器直连坚果云 WebDAV 会被 CORS 拦，经本地代理转发。
   前端传 X-Webdav-Auth（Basic 凭据）、X-Webdav-Host、X-Webdav-Path。 */
function handleWebdav(req, res, parsed) {
  const auth = req.headers['x-webdav-auth'] || '';
  const rawHost = req.headers['x-webdav-host'] || 'dav.jianguoyun.com';
  const fwdPath = req.headers['x-webdav-path'] || `/dav/${parsed.pathname.replace(/^\/webdav\//, '')}`;
  logLine(`[webdav] req from=${req.socket.remoteAddress} method=${req.method} path=${fwdPath} auth=${auth ? 'yes' : 'no'}`);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ code: 401, message: 'missing X-Webdav-Auth' }));
  }
  let host = rawHost, port = 443, useHttps = true;
  const hc = rawHost.match(/^(.*):(\d+)$/);
  if (hc){ host = hc[1]; port = parseInt(hc[2], 10); }
  if (req.headers['x-webdav-scheme'] === 'http') useHttps = false;
  const method = req.method || 'GET';
  const headers = {
    'Authorization': auth,
    'User-Agent': 'DeepReel/1.0',
    'Accept': '*/*',
  };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const transport = useHttps ? https : http;
  const proxyReq = transport.request({ host, port, path: fwdPath, method, headers }, up => {
    /* 上游自带 CORS 头时剥掉，避免叠加 */
    const respHeaders = { ...stripCors(up.headers), ...CORS };
    res.writeHead(up.statusCode || 200, respHeaders);
    up.pipe(res);
  });
  proxyReq.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ code: -1, message: 'webdav_upstream_error: ' + String(e && e.message || e) }));
  });
  req.pipe(proxyReq);
}

/* ============ 静态文件托管（让 npm start 直接打开完整应用） ============ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(__dirname, rel));
  /* 防目录穿越：只能访问代理所在目录内的文件 */
  if (!file.startsWith(__dirname + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ============ 自动打开浏览器 ============ */
function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/* ============ DeepSeek 代理 ============ */
function handleDeepSeek(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', () => { res.writeHead(400, CORS); res.end('bad request'); });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const outHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Authorization': req.headers['authorization'] || '',
      'Content-Length': body.length,
      'Accept': req.headers['accept'] || 'application/json',
      // SSE 流式转发时禁止上游 gzip，否则分块语义会被压缩层吞掉
      'Accept-Encoding': 'identity',
      'User-Agent': 'deepreel-proxy/2.0',
    };
    const proxyReq = https.request(
      { host: DS_UPSTREAM, path: req.url, method: req.method, headers: outHeaders },
      up => {
        const respHeaders = { ...stripCors(up.headers), ...CORS };
        res.writeHead(up.statusCode || 200, respHeaders);
        res.flushHeaders();
        up.pipe(res);
      }
    );
    proxyReq.on('error', e => {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'upstream_error', detail: String(e?.message || e) }));
    });
    proxyReq.end(body);
  });
}

/* ============ 调试日志（写入 deepreel-proxy.log，排查手机播放问题用） ============ */
function logLine(msg) {
  try { fs.appendFileSync(path.join(__dirname, 'deepreel-proxy.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

/* ============ B站 playurl 代理 ============ */
function handleBiliPlayurl(req, res, parsed) {
  const bvid = parsed.searchParams.get('bvid');
  const cid = parsed.searchParams.get('cid');
  const qn = parsed.searchParams.get('qn') || '80';
  const fnval = parsed.searchParams.get('fnval') || '1';
  const cookie = req.headers['x-bili-cookie'] || '';
  logLine(`[playurl] req from=${req.socket.remoteAddress} bvid=${bvid} cid=${cid} qn=${qn} fnval=${fnval} cookie=${cookie ? 'yes' : 'no'}`);

  if (!bvid || !cid) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ code: -1, message: 'missing bvid or cid' }));
  }

  const apiPath = `/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=${fnval}&fnver=0&fourk=1`;

  const proxyReq = proxiedHttpsRequest(`https://api.bilibili.com${apiPath}`, {
    method: 'GET',
    headers: {
      'Referer': 'https://www.bilibili.com',
      'User-Agent': BILI_UA,
      'Cookie': cookie,
    },
  }, up => {
    const respHeaders = { 'Content-Type': 'application/json', ...CORS };
    res.writeHead(up.statusCode || 200, respHeaders);
    up.pipe(res);
  });
  proxyReq.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ code: -1, message: 'upstream_error: ' + String(e?.message || e) }));
  });
  proxyReq.end();
}

/* ============ B站 view 代理（视频信息） ============ */
function handleBiliView(req, res, parsed) {
  const bvid = parsed.searchParams.get('bvid');
  const cookie = req.headers['x-bili-cookie'] || '';

  if (!bvid) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ code: -1, message: 'missing bvid' }));
  }

  const apiPath = `/x/web-interface/view?bvid=${bvid}`;

  const proxyReq = https.request({
    host: 'api.bilibili.com',
    path: apiPath,
    method: 'GET',
    headers: {
      'Referer': 'https://www.bilibili.com',
      'User-Agent': BILI_UA,
      'Cookie': cookie,
    },
  }, up => {
    const respHeaders = { 'Content-Type': 'application/json', ...CORS };
    res.writeHead(up.statusCode || 200, respHeaders);
    up.pipe(res);
  });
  proxyReq.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ code: -1, message: 'upstream_error: ' + String(e?.message || e) }));
  });
  proxyReq.end();
}

/* ============ B站 player/v2 代理（字幕信息） ============ */
function handleBiliPlayer(req, res, parsed) {
  const bvid = parsed.searchParams.get('bvid');
  const cid = parsed.searchParams.get('cid');
  const cookie = req.headers['x-bili-cookie'] || '';

  if (!bvid || !cid) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ code: -1, message: 'missing bvid or cid' }));
  }

  const apiPath = `/x/player/wbi/v2?bvid=${bvid}&cid=${cid}&web_location=1315873`;

  const proxyReq = https.request({
    host: 'api.bilibili.com',
    path: apiPath,
    method: 'GET',
    headers: {
      'Referer': 'https://www.bilibili.com',
      'User-Agent': BILI_UA,
      'Cookie': cookie,
    },
  }, up => {
    const respHeaders = { 'Content-Type': 'application/json', ...CORS };
    res.writeHead(up.statusCode || 200, respHeaders);
    up.pipe(res);
  });
  proxyReq.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ code: -1, message: 'upstream_error: ' + String(e?.message || e) }));
  });
  proxyReq.end();
}

/* ============ B站扫码登录 · 生成二维码 ============ */
function handleBiliQrGenerate(req, res) {
  const proxyReq = https.request({
    host: 'passport.bilibili.com',
    path: '/x/passport-login/web/qrcode/generate',
    method: 'GET',
    headers: {
      'User-Agent': BILI_UA,
      'Referer': 'https://www.bilibili.com',
    },
  }, up => {
    const respHeaders = { 'Content-Type': 'application/json', ...CORS };
    res.writeHead(up.statusCode || 200, respHeaders);
    up.pipe(res);
  });
  proxyReq.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ code: -1, message: 'upstream_error: ' + String(e?.message || e) }));
  });
  proxyReq.end();
}

/* ============ B站扫码登录 · 轮询状态 ============ */
function handleBiliQrPoll(req, res, parsed) {
  const key = parsed.searchParams.get('key');
  if (!key) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ code: -1, message: 'missing key' }));
  }

  const proxyReq = https.request({
    host: 'passport.bilibili.com',
    path: `/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    method: 'GET',
    headers: {
      'User-Agent': BILI_UA,
      'Referer': 'https://www.bilibili.com',
    },
  }, up => {
    const setCookies = up.headers['set-cookie'] || [];
    let body = '';
    up.on('data', c => body += c);
    up.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (setCookies.length) {
          j._cookie = setCookies.map(c => c.split(';')[0]).join('; ');
        }
        res.writeHead(up.statusCode || 200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify(j));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ code: -1, message: 'parse error' }));
      }
    });
  });
  proxyReq.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ code: -1, message: 'upstream_error: ' + String(e?.message || e) }));
  });
  proxyReq.end();
}

/* ============ B站视频流转发 ============ */
function handleBiliStream(req, res, parsed) {
  /* 兼容两种参数：url=原始编码地址（旧），u=base64url 伪装地址（新，防浏览器拦截） */
  let streamUrl = parsed.searchParams.get('url') || '';
  const uParam = parsed.searchParams.get('u');
  if (uParam) {
    try {
      const b = uParam.replace(/-/g, '+').replace(/_/g, '/');
      streamUrl = Buffer.from(b, 'base64').toString('utf8');
    } catch { /* 保持空 */ }
  }
  logLine(`[stream] req from=${req.socket.remoteAddress} range=${req.headers['range'] || '-'} url=${(streamUrl||'').slice(0,60)}`);
  if (!streamUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ error: 'missing url param' }));
  }

  const cookie = req.headers['x-bili-cookie'] || '';
  let target;
  try { target = new URL(streamUrl); }
  catch { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'invalid url' })); }
  if (target.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ error: 'https only' }));
  }

  const buildHeaders = () => {
    const h = {
      'Referer': 'https://www.bilibili.com',
      'User-Agent': BILI_UA,
      'Accept': '*/*',
      'Accept-Encoding': 'identity',   // 视频流禁止压缩，保证 Range 字节对齐
    };
    if (cookie) h['Cookie'] = cookie;
    if (req.headers['range']) h['Range'] = req.headers['range'];
    return h;
  };

  // B站 CDN 可能返回 302 跳转到其它节点，跟随跳转（最多 5 次）
  const hop = (t, depth) => {
    const proxyReq = proxiedHttpsRequest(t.href, {
      method: 'GET',
      headers: buildHeaders(),
      rejectUnauthorized: false, // mcdn 节点证书与域名不匹配，仅拉流可忽略
    }, up => {
      const st = up.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(st) && up.headers.location && depth < 5) {
        up.resume();
        try { hop(new URL(up.headers.location, t), depth + 1); }
        catch {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
            res.end(JSON.stringify({ error: 'bad redirect' }));
          }
        }
        return;
      }
      const respHeaders = { ...stripCors(up.headers), ...CORS };
      res.writeHead(st || 200, respHeaders);
      up.pipe(res);
      up.on('error', () => { try { res.end(); } catch {} });
    });
    proxyReq.on('error', e => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: 'upstream_error: ' + String(e?.message || e) }));
      } else {
        try { res.end(); } catch {}
      }
    });
    /* 连接/空闲超时：上游 CDN 建立连接后 12s 无任何数据视为挂起，主动断开让浏览器重试，
       避免"一直转圈"而非"慢" */
    proxyReq.setTimeout(12000, () => { proxyReq.destroy(new Error('stream upstream timeout')); });
    proxyReq.end();
  };
  hop(target, 0);
}

/* ============ B站封面图代理（绕过防盗链） ============ */
function handleBiliImg(req, res, parsed) {
  const raw = parsed.searchParams.get('url');
  if (!raw) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ error: 'missing url param' }));
  }
  let target;
  try { target = new URL(raw); }
  catch { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'invalid url' })); }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ error: 'http(s) only' }));
  }
  const mod = target.protocol === 'https:' ? https : http;
  const proxyReq = mod.request({
    host: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers: {
      'Referer': 'https://www.bilibili.com',
      'User-Agent': BILI_UA,
      'Accept': 'image/*',
    },
    rejectUnauthorized: false,
  }, up => {
    const respHeaders = { ...stripCors(up.headers), ...CORS, 'Cache-Control': 'public, max-age=86400' };
    res.writeHead(up.statusCode || 200, respHeaders);
    up.pipe(res);
  });
  proxyReq.on('error', e => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'upstream_error: ' + String(e?.message || e) }));
    } else { try { res.end(); } catch {} }
  });
  proxyReq.end();
}
