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
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.DEEPREEL_PORT || 7392;
const DS_UPSTREAM = process.env.DEEPREEL_UPSTREAM || 'api.deepseek.com';
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

/* ============ B站 playurl 代理 ============ */
function handleBiliPlayurl(req, res, parsed) {
  const bvid = parsed.searchParams.get('bvid');
  const cid = parsed.searchParams.get('cid');
  const qn = parsed.searchParams.get('qn') || '80';
  const fnval = parsed.searchParams.get('fnval') || '1';
  const cookie = req.headers['x-bili-cookie'] || '';

  if (!bvid || !cid) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ code: -1, message: 'missing bvid or cid' }));
  }

  const apiPath = `/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=${fnval}&fnver=0&fourk=1`;

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
  const streamUrl = parsed.searchParams.get('url');
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
    };
    if (cookie) h['Cookie'] = cookie;
    if (req.headers['range']) h['Range'] = req.headers['range'];
    return h;
  };

  // B站 CDN 可能返回 302 跳转到其它节点，跟随跳转（最多 5 次）
  const hop = (t, depth) => {
    const proxyReq = https.request({
      host: t.hostname,
      port: t.port || 443,
      path: t.pathname + t.search,
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
