/* ============================================================
   DEEPREEL · 深刷  —  app.js
   依托 B 站的专注式学习追踪
   ============================================================ */
'use strict';

/* ============ 常量 & 示例数据 ============ */
const LS_COURSES = 'deepreel.courses.v1';
const LS_SETTINGS = 'deepreel.settings.v1';
const LS_ACTIVITY = 'deepreel.activity.v1';
const LS_SAMPLE = 'deepreel.sample.loaded';

const PLAYER_ORIGIN = 'https://player.bilibili.com';
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const PLAYER_V2 = 'https://api.bilibili.com/x/player/wbi/v2';

// 多代理兜底（浏览器无法直连 api.bilibili.com）
const PROXIES = [
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://thingproxy.freeecodecamp.com/fetch/${u}`,
];

// 离线示例课程（字幕为模拟内容，用于完整预览所有功能）
const SAMPLE_COURSE = {
  bvid: 'BV0SAMPLE000', aid: 0, isSample: true,
  title: '现代前端动画工程 · 从动效原理到落地',
  up: '示例课程 · DEEPREEL',
  cover: '',
  parts: [
    { page:1, part:'动效认知与时间曲线', duration:932, text:
      '这一集我们从人眼对运动的感知讲起。运动的连贯性依赖时间曲线，而非位移本身。线性匀速在界面上永远显得机械，因为它违背了物理直觉。缓动函数本质是给时间加权，让前段加速、后段减速。我们要建立对 ease 的直觉，而不是死记 cubic-bezier 的数值。帧率也很关键，60 帧意味着每帧约 16 毫秒，任何主线程阻塞都会让缓动断裂。' },
    { page:2, part:'缓动函数与 ease 体系', duration:874, text:
      'ease 体系分为 in、out、inOut 与自定义。power 系列用指数控制加速强度，expo 是最陡的。缓动函数和时间曲线在本集细化。我们对比 ease-out 与 ease-in-out 在滚动场景的手感差异。记住一个原则：进入要快、停得稳。视口进入动画应优先 ease-out，离场才考虑 ease-in。' },
    { page:3, part:'滚动驱动：Lenis 与视口', duration:1015, text:
      '滚动驱动动画的核心是把进度映射到时间轴。Lenis 做的是平滑滚动，它给 window 滚动加了惯性。但 Lenis 不直接驱动动画，驱动的是 ScrollTrigger 或 GSAP 的时间轴。视口进入用 IntersectionObserver 或 ScrollTrigger 的 toggleActions 控制。注意 Lenis 与 ScrollTrigger 要用 lenis.on(\'scroll\', ScrollTrigger.update) 联动。' },
    { page:4, part:'GSAP 时间轴与状态机', duration:1188, text:
      'GSAP 的 timeline 让多段动画按序与重叠编排。状态机把界面拆成有限状态，每个状态对应一组时间轴。切换状态时清理上一状态的动画，避免叠加。这里和上一集的滚动驱动配合，用 ScrollTrigger 触发状态迁移。状态机的价值是让复杂交互可推理、可回放。' },
    { page:5, part:'落地：性能与可访问性', duration:793, text:
      '落地阶段关心两件事：性能与可访问性。性能上，优先 transform 与 opacity，避免触发布局。will-context 不可滥用。可访问性上，动效要响应 prefers-reduced-motion。没有这一步，前面所有缓动函数都是负担。性能和可访问性是工程的底线，不是收尾的装饰。' },
  ]
};

/* 中文停用词（摘要用） */
const STOP = new Set('的了是在和与及或而我你他这那有也就都还又才把被让使到从对给向以之其于了着过吗呢吧啊呀哦嗯一个一种一些这那'.split(''));

/* 错误上报到代理日志（排查手机端问题用） */
function reportDebug(msg){
  try{ fetch(`${proxyBase()}/debug-report?m=${encodeURIComponent(String(msg).slice(0,200))}`).catch(()=>{}); }catch{}
}

function b64url(s){ return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
/* 拉流地址（上游 URL base64 伪装，避免请求里出现 bilivideo.com 等被浏览器拦截） */
function streamUrl(u){ return `${proxyBase()}/bili/stream?u=${b64url(u)}`; }

/* ============ 状态 & 存储 ============ */
let state = {
  courses: [],
  settings: { endpoint:'', key:'', model:'', biliCookie:'', biliQuality:'80', categories:[] },
  activity: {},          // 'YYYY-MM-DD' -> { w:观看秒, p:思考秒, c:学完P数, co:{bvid:秒} }
  hourDist: null,        // [24] 全时段观看秒数分布（年度报告用）
  activeCourseId: null,   // bvid
  activePart: 0,          // 0-based index
  libFilter: { q:'', cat:'__all', page:1 },  // 课程库视图状态（不持久化）
  statsCursor: null,      // 统计页日历游标 {y, m, selKey}
};
const PAGE_SIZE = 12;
const THINK_CAP = 30 * 60;   // 单次连续暂停最长计入思考 30 分钟（防止挂机过夜刷数据）
const APP_VERSION = '1.3.5'; // 调试/版本标识：控制台可见，设置页脚可见

function loadState(){
  try{ const c = JSON.parse(localStorage.getItem(LS_COURSES) || '[]'); state.courses = Array.isArray(c)? c : []; }catch{ state.courses=[]; }
  try{ const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); state.settings = Object.assign(state.settings, s); }catch{}
  if(!Array.isArray(state.settings.categories)) state.settings.categories = [];
  try{ const a = JSON.parse(localStorage.getItem(LS_ACTIVITY) || '{}'); state.activity = (a && typeof a==='object')? a : {}; }catch{ state.activity={}; }
  // 旧格式迁移：number → {w,p,c,co}
  for(const k of Object.keys(state.activity)){
    const v = state.activity[k];
    if(typeof v === 'number') state.activity[k] = { w:v, p:0, c:0, co:{} };
  }
  try{ const h = JSON.parse(localStorage.getItem('deepreel.hours.v1') || 'null'); state.hourDist = Array.isArray(h) && h.length===24 ? h : new Array(24).fill(0); }catch{ state.hourDist = new Array(24).fill(0); }
}

/* —— 活动记录：watch=真实观看，think=暂停思考（含封顶），bvid 归属课程 —— */
function recordActivity(watch, think, bvid){
  watch = Math.max(0, Math.round(watch||0));
  think = Math.max(0, Math.round(think||0));
  if(watch + think <= 0) return;
  const k = todayKey();
  const day = state.activity[k] || (state.activity[k] = { w:0, p:0, c:0, co:{} });
  day.w += watch; day.p += think;
  if(bvid){
    if(!day.co) day.co = {};
    day.co[bvid] = (day.co[bvid]||0) + watch + think;
  }
  const hr = new Date().getHours();
  state.hourDist[hr] = (state.hourDist[hr]||0) + watch;
}
function actDay(k){ return state.activity[k] || { w:0, p:0, c:0, co:{} }; }
function actW(k){ const a = state.activity[k]; return (a && a.w) || 0; }
function saveHours(){ try{ localStorage.setItem('deepreel.hours.v1', JSON.stringify(state.hourDist)); }catch{} }
function saveCourses(){ try{ localStorage.setItem(LS_COURSES, JSON.stringify(state.courses)); }catch{} }
function saveSettings(){ try{ localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); }catch{} }
function saveActivity(){ try{ localStorage.setItem(LS_ACTIVITY, JSON.stringify(state.activity)); }catch{} }

/* ============ 工具 ============ */
const qs = (s,el=document)=>el.querySelector(s);
const qsa = (s,el=document)=>[...el.querySelectorAll(s)];
function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec||0));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  const mm = h? String(m).padStart(2,'0') : m;
  const ss = String(s).padStart(2,'0');
  return h? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtDur(sec){ sec=Math.round(sec||0); if(sec<60) return sec+'秒'; const m=Math.floor(sec/60), s=sec%60; if(s) return `${m}分${s}秒`; return `${m}分钟`; }
function parseBvid(input){
  if(!input) return null;
  input = String(input).trim();
  const m = input.match(/BV[0-9A-Za-z]{10}/);
  if(m) return m[0];
  return /^BV[0-9A-Za-z]+$/i.test(input) ? input : null;
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
let toastTimer;
function toast(msg){
  const el = qs('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>el.classList.remove('show'), 2600);
}

function llmContentFromJSON(j){
  if(!j || typeof j !== 'object') return '';
  const choice = Array.isArray(j.choices) ? (j.choices[0] || {}) : {};
  if(choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if(choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if(typeof choice.text === 'string') return choice.text;
  if(typeof j.output_text === 'string') return j.output_text;
  if(typeof j.content === 'string') return j.content;
  return '';
}

async function readLLMStream(resp, onDelta){
  if(!resp.body || !resp.body.getReader) return '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventLines = [];
  let text = '';
  let done = false;

  const emit = raw => {
    if(raw == null) return;
    const payload = String(raw).trim();
    if(!payload) return;
    if(payload === '[DONE]'){ done = true; return; }
    let chunk = '';
    try{
      const json = JSON.parse(payload);
      chunk = llmContentFromJSON(json);
    }catch{
      chunk = payload.replace(/^data:\s*/, '');
    }
    if(chunk){
      text += chunk;
      if(onDelta) onDelta(chunk, text);
    }
  };

  try{
    while(true){
      const { done: readDone, value } = await reader.read();
      if(readDone) break;
      buffer += decoder.decode(value, { stream:true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for(const line of lines){
        if(done) break;
        if(line === ''){
          if(eventLines.length){
            emit(eventLines.join('\n'));
            eventLines = [];
          }
          continue;
        }
        if(line.startsWith('data:')) eventLines.push(line.slice(5).replace(/^\s+/, ''));
        else if(line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) continue;
        else eventLines.push(line);
      }
      if(done) break;
    }
    const tail = decoder.decode();
    if(tail) buffer += tail;
    if(!done){
      if(buffer) eventLines.push(buffer);
      if(eventLines.length) emit(eventLines.join('\n'));
    }
  } finally {
    try{ reader.releaseLock(); }catch{}
  }
  return text;
}

async function requestLLM(s, messages, opts={}){
  if(!s.endpoint || !s.key) throw new Error('NO_KEY');
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.4;
  const stream = !!opts.stream;
  const r = await fetch(s.endpoint, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Authorization':`Bearer ${s.key}`,
      'Accept': stream ? 'text/event-stream, application/json' : 'application/json',
    },
    body: JSON.stringify({
      model: s.model || 'deepseek-v4-flash',
      temperature,
      messages,
      ...(stream ? { stream:true } : {}),
    }),
    signal: opts.signal,
  });
  if(!r.ok){
    const t = await r.text().catch(()=> '');
    throw new Error('HTTP '+r.status+(t?(' · '+t.slice(0,120)):''));
  }
  if(!stream){
    const t = await r.text().catch(()=> '');
    try{ return llmContentFromJSON(JSON.parse(t)); }catch{ return t; }
  }
  const ctype = (r.headers.get('content-type') || '').toLowerCase();
  if(!r.body || !r.body.getReader || ctype.includes('application/json')){
    const t = await r.text().catch(()=> '');
    try{ return llmContentFromJSON(JSON.parse(t)); }catch{ return t; }
  }
  return await readLLMStream(r, opts.onDelta);
}

/* ============ 动效（GSAP / Lenis） ============ */
let lenis=null;
function initMotion(){
  if(window.Lenis){
    try{
      lenis = new Lenis({ lerp:0.09, smoothWheel:true, wheelMultiplier:1 });
      const raf = t => { lenis.raf(t); requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
    }catch{ lenis=null; }
  }
  /* 内部滚动容器已加 data-lenis-prevent-wheel（Lenis 官方豁免属性）：
     Lenis 对落在这些容器上的滚轮事件直接放行，不 preventDefault，原生滚动生效 */
}
function reveal(sel, opts={}){
  if(!window.gsap) return;
  const els = typeof sel === 'string'
    ? [...document.querySelectorAll(sel)]
    : (sel && sel.length !== undefined ? [...sel] : [sel]);
  if(!els.length) return;
  // 关键：动画期间压制目标自身的 CSS transition。
  // stagger 惰性初始化会读取元素当前 computed 值当终点，CSS 过渡滞后会让终点被错捕成半途值，
  // 卡片就永久停在半透明（gsap.from 与 transition 的经典冲突）。
  els.forEach(el=>{ if(el && el.style) el.style.transition = 'none'; });
  gsap.from(els, Object.assign(
    { y:22, opacity:0, duration:0.9, ease:'power3.out', stagger:0.07, clearProps:'opacity,transform' },
    opts,
    { onComplete(){ els.forEach(el=>{ if(el && el.style) el.style.removeProperty('transition'); }); } }
  ));
}

/* ============ B 站接口（多代理兜底） ============ */
function proxyBase(){
  /* 页面由本地代理托管（http/https 打开，含手机/平板经局域网 IP）→ 一律同源。
     即使旧设置里存了 localhost endpoint 也忽略，否则手机上的 localhost 会指向手机自己 */
  if(location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  const ep = state.settings.endpoint || '';
  const m = ep.match(/^(https?:\/\/[^/]+)/);
  if(m) return m[1];
  return 'http://localhost:7392';
}
/* 带超时的 fetch：任何请求都不会无限挂起 */
function fetchTimeout(url, opts={}, ms=8000){
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(()=>clearTimeout(timer));
}
/* 并行赛跑：直连 + 全部公共代理同时发起，先成功者胜，总耗时 ≈ 最快路径 */
async function biliJSON(apiUrl){
  const attempts = [
    { url: apiUrl, opts: { credentials:'omit', mode:'cors' }, ms: 6000 },
    ...PROXIES.map(fn=>({ url: fn(apiUrl), opts: {}, ms: 8000 })),
  ];
  const results = await Promise.allSettled(attempts.map(async a=>{
    const r = await fetchTimeout(a.url, a.opts, a.ms);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j = JSON.parse(await r.text());
    if(j && j.code===0) return j;
    throw new Error('code '+(j&&j.code));
  }));
  const ok = results.find(x=>x.status==='fulfilled');
  return ok ? ok.value : null;
}
/* B站封面：直连优先（实测浏览器直连可正常加载，无需代理）；失败时再走本地代理防盗链兜底 */
function coverUrl(u){
  if(!u) return u || '';
  const s = u.replace(/^http:\/\//i, 'https://');
  return s;
}
/* 生成封面样式：直连 https + data-cover 记录原图地址，供兜底 */
function coverStyleAttr(u){
  if(!u) return '';
  return `style="background-image:url('${coverUrl(u)}')" data-cover="${escapeHtml(u)}"`;
}
/* 封面加载兜底：直连失败（防盗链/网络）时换成本地代理 /bili/img */
function wireCoverFallbacks(scope){
  qsa('[data-cover]', scope||document).forEach(el=>{
    const orig = el.getAttribute('data-cover');
    el.removeAttribute('data-cover');
    const img = new Image();
    img.onerror = ()=>{
      const prox = `${proxyBase()}/bili/img?url=${encodeURIComponent(orig)}`;
      el.style.backgroundImage = `url('${prox}')`;
    };
    img.src = coverUrl(orig);
  });
}
function biliCookie(){ return state.settings.biliCookie || ''; }

function parseVideoData(bvid, d){
  return {
    bvid, aid:d.aid, isSample:false,
    title:d.title, up:d.owner && d.owner.name, cover:d.pic,
    parts:(d.pages||[]).map(p=>({ page:p.page, part:p.part, duration:p.duration, cid:p.cid, progress:0, done:false, lastTime:0 }))
  };
}

async function fetchVideoInfo(bvid){
  // 本地代理 + 直连 + 公共代理 并行赛跑，先成功者胜；每路均带超时
  const makeAttempt = async (url, opts, ms, needData) => {
    const r = await fetchTimeout(url, opts, ms);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j = await r.json();
    if(j && j.code===0 && (!needData || j.data)) return j;
    throw new Error('code '+(j&&j.code));
  };
  const jobs = [
    makeAttempt(`${proxyBase()}/bili/view?bvid=${bvid}`, { headers:{'X-Bili-Cookie':biliCookie()} }, 6000, true),
    makeAttempt(`${VIEW_API}?bvid=${bvid}`, { credentials:'omit', mode:'cors' }, 6000, true),
    ...PROXIES.map(p=>makeAttempt(p(`${VIEW_API}?bvid=${bvid}`), {}, 8000, true)),
  ];
  const results = await Promise.allSettled(jobs);
  const ok = results.find(x=>x.status==='fulfilled');
  if(!ok || !ok.value || !ok.value.data) return null;
  return parseVideoData(bvid, ok.value.data);
}

async function fetchSubtitle(bvid, cid){
  // 1) 本地代理（字幕列表 + 字幕正文，均带超时）
  try{
    const r = await fetchTimeout(`${proxyBase()}/bili/player?bvid=${bvid}&cid=${cid}`, { headers: { 'X-Bili-Cookie': biliCookie() } }, 6000);
    if(r.ok){
      const j = await r.json();
      if(j && j.data && j.data.subtitle){
        const subs = j.data.subtitle.subtitles || [];
        if(subs.length){
          let url = subs[0].subtitle_url || '';
          if(url.startsWith('//')) url = 'https:'+url;
          try{ const r2 = await fetchTimeout(`${proxyBase()}/bili/stream?url=${encodeURIComponent(url)}`, {}, 8000); if(r2.ok){ const t = await r2.text(); return JSON.parse(t); } }catch{}
          try{ const r2 = await fetchTimeout(url, {credentials:'omit'}, 8000); if(r2.ok){ const t = await r2.text(); return JSON.parse(t); } }catch{}
        }
      }
    }
  }catch{}
  // 2) 公共代理兜底（并行赛跑）
  const j = await biliJSON(`${PLAYER_V2}?bvid=${bvid}&cid=${cid}&web_location=1315873`);
  if(!j || !j.data || !j.data.subtitle) return null;
  const subs = j.data.subtitle.subtitles || [];
  if(!subs.length) return null;
  let url = subs[0].subtitle_url || '';
  if(url.startsWith('//')) url = 'https:'+url;
  const jobs = [
    fetchTimeout(url, {credentials:'omit'}, 8000).then(r=>r.ok?r.text():Promise.reject(new Error('HTTP '+r.status))),
    ...PROXIES.map(p=>fetchTimeout(p(url), {}, 8000).then(r=>r.ok?r.text():Promise.reject(new Error('HTTP '+r.status)))),
  ];
  const results = await Promise.allSettled(jobs);
  for(const x of results){
    if(x.status==='fulfilled'){ try{ return JSON.parse(x.value); }catch{} }
  }
  return null;
}

/* ============ 进度模型 ============ */
function courseProgress(c){
  if(!c.parts.length) return 0;
  const total = c.parts.reduce((a,p)=>a+(p.duration||0),0) || 1;
  const learned = c.parts.reduce((a,p)=>a+(p.duration||0)*Math.min(1,p.progress||0),0);
  return learned/total;
}
function learnedSecondsOf(c){ return c.parts.reduce((a,p)=>a+(p.duration||0)*Math.min(1,p.progress||0),0); }
function overallLearnedSeconds(){ return state.courses.reduce((a,c)=>a+learnedSecondsOf(c),0); }
function totalParts(){ return state.courses.reduce((a,c)=>a+c.parts.length,0); }
function avgPercent(){ if(!state.courses.length) return 0; return state.courses.reduce((a,c)=>a+courseProgress(c),0)/state.courses.length; }
function activeCourse(){ return state.courses.find(c=>c.bvid===state.activeCourseId); }

/* ============ 渲染：资料库 ============ */
function libCategories(){
  // 已有分类 + 课程里手动设置但不在列表中的（历史数据兜底）
  const set = new Set(state.settings.categories || []);
  state.courses.forEach(c=>{ if(c.category) set.add(c.category); });
  return [...set];
}
function visibleCourses(){
  const { q, cat } = state.libFilter;
  let list = state.courses.slice();
  if(cat === '__none') list = list.filter(c=>!c.category);
  else if(cat && cat !== '__all') list = list.filter(c=>c.category === cat);
  const k = (q||'').trim().toLowerCase();
  if(k) list = list.filter(c=>(c.title||'').toLowerCase().includes(k) || (c.up||'').toLowerCase().includes(k));
  return list;
}
function renderLibrary(){
  const grid = qs('#library-grid');
  const empty = qs('#empty-state');
  const pinnedWrap = qs('#pinned-wrap');
  const toolbar = qs('#lib-toolbar');
  const pager = qs('#lib-pager');
  grid.innerHTML = '';

  if(!state.courses.length){
    empty.hidden = false;
    pinnedWrap.hidden = true;
    toolbar.hidden = true;
    pager.hidden = true;
    renderDashboard();
    return;
  }
  empty.hidden = true;
  toolbar.hidden = false;
  renderCatChips();
  renderPinnedRow(pinnedWrap);

  const list = visibleCourses();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if(state.libFilter.page > totalPages) state.libFilter.page = totalPages;
  const page = state.libFilter.page;
  list.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE).forEach(c=>{
    grid.appendChild(buildCourseCard(c));
  });
  wireCoverFallbacks(grid);
  renderPager(pager, page, totalPages, list.length);
  // 搜索/分类过滤后无结果
  if(!list.length){
    const tip = document.createElement('div');
    tip.className = 'lib-noresult';
    tip.textContent = '架中无此卷。换个词，或另择分类。';
    grid.appendChild(tip);
  }
  renderDashboard();
  reveal('.course-card', { stagger:0.05, duration:0.7 });
}

function buildCourseCard(c){
  const pct = Math.round(courseProgress(c)*100);
  const doneN = c.parts.filter(p=>p.done).length;
  const coverStyle = coverStyleAttr(c.cover);
  const coverCls = c.cover ? '' : 'no-cover';
  const card = document.createElement('article');
  card.className = 'course-card';
  card.innerHTML = `
    <div class="course-cover ${coverCls}" ${coverStyle}>
      ${c.isSample?'<span class="cc-badge">示例</span>':''}
      <span class="cc-percent">${pct}%</span>
      ${c.category?`<span class="cc-cat">${escapeHtml(c.category)}</span>`:''}
    </div>
    <div class="course-body">
      <h3 class="course-title">${escapeHtml(c.title)}</h3>
      <p class="course-up">${escapeHtml(c.up||'')} · ${c.parts.length}P</p>
      <div class="course-progress"><i style="width:${pct}%"></i></div>
      <div class="course-meta">
        <span>${doneN}/${c.parts.length} 已学完</span>
        <span class="done-tag">${pct===100?'已完成':'继续观看 →'}</span>
      </div>
    </div>
    <button class="card-more" title="课程操作">···</button>
    <div class="card-menu" hidden>
      <button data-act="pin">${c.pinned?'★ 取消置顶':'☆ 置顶'}</button>
      <button data-act="cat">▣ 设置分类</button>
      <button data-act="rename">✎ 重命名</button>
      <button data-act="del" class="danger">✕ 删除课程</button>
    </div>`;
  card.addEventListener('click', ()=>openCourse(c.bvid));
  const moreBtn = card.querySelector('.card-more');
  const menu = card.querySelector('.card-menu');
  moreBtn.addEventListener('click', e=>{
    e.stopPropagation();
    closeAllCardMenus(menu);
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', e=>{
    e.stopPropagation();
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    menu.hidden = true;
    const act = btn.dataset.act;
    if(act === 'pin'){ togglePin(c.bvid); }
    else if(act === 'cat'){ openCategoryPicker(c); }
    else if(act === 'rename'){ openRenameDialog(c); }
    else if(act === 'del'){ openDeleteDialog(c); }
  });
  return card;
}
function closeAllCardMenus(except){
  qsa('.card-menu').forEach(m=>{ if(m!==except) m.hidden = true; });
}
document.addEventListener('click', ()=>closeAllCardMenus());

/* —— 置顶栏 —— */
function renderPinnedRow(wrap){
  const row = qs('#pinned-row');
  const pinned = state.courses.filter(c=>c.pinned);
  wrap.hidden = !pinned.length;
  row.innerHTML = '';
  pinned.forEach(c=>{
    const pct = Math.round(courseProgress(c)*100);
    const coverStyle = coverStyleAttr(c.cover);
    const el = document.createElement('article');
    el.className = 'pin-card';
    el.innerHTML = `
      <div class="pin-cover ${c.cover?'':'no-cover'}" ${coverStyle}></div>
      <div class="pin-info">
        <div class="pin-title">${escapeHtml(c.title)}</div>
        <div class="pin-meta">
          <div class="pin-bar"><i style="width:${pct}%"></i></div>
          <span>${pct}%</span>
        </div>
      </div>
      <button class="pin-unpin" title="取消置顶">✕</button>`;
    el.addEventListener('click', ()=>openCourse(c.bvid));
    el.querySelector('.pin-unpin').addEventListener('click', e=>{
      e.stopPropagation();
      togglePin(c.bvid);
    });
    row.appendChild(el);
  });
  wireCoverFallbacks(row);
}
function togglePin(bvid){
  const c = state.courses.find(x=>x.bvid===bvid);
  if(!c) return;
  c.pinned = !c.pinned;
  saveCourses();
  renderLibrary();
  toast(c.pinned ? '「'+c.title+'」已置于案头' : '已撤下案头');
}

/* —— 分类 chips —— */
function renderCatChips(){
  const box = qs('#lib-cats');
  if(!box) return;
  const cats = libCategories();
  const cur = state.libFilter.cat;
  let html = `<button class="cat-chip ${cur==='__all'?'on':''}" data-cat="__all">全部 ${state.courses.length}</button>`;
  const noneN = state.courses.filter(c=>!c.category).length;
  html += `<button class="cat-chip ${cur==='__none'?'on':''}" data-cat="__none">未分类 ${noneN}</button>`;
  cats.forEach(cat=>{
    const n = state.courses.filter(c=>c.category===cat).length;
    html += `<button class="cat-chip ${cur===cat?'on':''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)} ${n}</button>`;
  });
  html += `<button class="cat-chip cat-add" data-cat="__add" title="新建分类">＋ 新建</button>`;
  box.innerHTML = html;
}
function switchLibCat(cat){
  if(cat === '__add'){ openCategoryCreate(); return; }
  state.libFilter.cat = cat;
  state.libFilter.page = 1;
  renderLibrary();
}
function openCategoryCreate(){
  askMiniModal({
    title:'新建分类',
    body:`<input class="mm-input" id="mm-field" type="text" maxlength="12" placeholder="分类名，如：前端 / 算法 / 英语">`,
    okText:'创建',
    onOpen:(body)=>{
      const f = body.querySelector('#mm-field');
      f.focus();
    },
    onOk:(body)=>{
      const name = (body.querySelector('#mm-field').value||'').trim();
      if(!name) return false;
      if(!state.settings.categories.includes(name)) state.settings.categories.push(name);
      saveSettings();
      state.libFilter.cat = name;
      state.libFilter.page = 1;
      renderLibrary();
      toast('已创建分类「'+name+'」');
    },
  });
}
function openCategoryPicker(c){
  const cats = libCategories();
  let body = `<div class="mm-cats">`;
  body += `<button class="mm-cat ${!c.category?'on':''}" data-v="">未分类</button>`;
  cats.forEach(cat=>{
    body += `<button class="mm-cat ${c.category===cat?'on':''}" data-v="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`;
  });
  body += `</div><input class="mm-input" id="mm-field" type="text" maxlength="12" placeholder="或输入新分类名，回车确认">`;
  askMiniModal({
    title:'设置分类 · ' + c.title.slice(0, 18),
    body,
    okText:'确定',
    onOpen:(el)=>{
      el.querySelectorAll('.mm-cat').forEach(b=>{
        b.addEventListener('click', ()=>{
          el.querySelectorAll('.mm-cat').forEach(x=>x.classList.remove('on'));
          b.classList.add('on');
        });
      });
      el.querySelector('#mm-field').addEventListener('keydown', e=>{
        if(e.key==='Enter'){ e.preventDefault(); qs('#mm-ok').click(); }
      });
    },
    onOk:(el)=>{
      const typed = (el.querySelector('#mm-field').value||'').trim();
      let cat = typed;
      if(!cat){
        const on = el.querySelector('.mm-cat.on');
        cat = on ? on.dataset.v : '';
      }
      if(typed && !state.settings.categories.includes(typed)) state.settings.categories.push(typed);
      c.category = cat || null;
      saveSettings(); saveCourses();
      state.libFilter.page = 1;
      renderLibrary();
      toast(cat ? '已归入「'+cat+'」' : '已移出分类');
    },
  });
}
function openRenameDialog(c){
  askMiniModal({
    title:'重命名课程',
    body:`<input class="mm-input" id="mm-field" type="text" maxlength="40" value="${escapeHtml(c.title)}">`,
    okText:'保存',
    onOpen:(el)=>{ const f = el.querySelector('#mm-field'); f.focus(); f.select(); },
    onOk:(el)=>{
      const name = (el.querySelector('#mm-field').value||'').trim();
      if(!name) return false;
      c.title = name;
      saveCourses();
      renderLibrary();
      toast('已重命名');
    },
  });
}
function openDeleteDialog(c){
  askMiniModal({
    title:'删除课程',
    body:`<p class="mm-text">确定删除「<b>${escapeHtml(c.title)}</b>」吗？学习进度与笔记将一并移除，此操作不可撤销。</p>`,
    okText:'删除',
    danger:true,
    onOk:()=>{
      state.courses = state.courses.filter(x=>x.bvid!==c.bvid);
      saveCourses();
      state.libFilter.page = 1;
      renderLibrary();
      toast('「'+c.title+'」已下架');
    },
  });
}

/* —— 通用小弹窗 —— */
function askMiniModal({ title, body, okText='确定', danger=false, onOpen, onOk }){
  const mask = qs('#mini-modal');
  const tEl = qs('#mm-title');
  const bEl = qs('#mm-body');
  const okBtn = qs('#mm-ok');
  tEl.textContent = title;
  bEl.innerHTML = body;
  okBtn.textContent = okText;
  okBtn.classList.toggle('danger', !!danger);
  mask.hidden = false;
  const close = ()=>{ mask.hidden = true; okBtn.onclick = null; qs('#mm-cancel').onclick = null; mask.onclick = null; };
  qs('#mm-cancel').onclick = close;
  mask.onclick = e=>{ if(e.target === mask) close(); };
  okBtn.onclick = ()=>{
    if(onOk && onOk(bEl) === false) return;   // 返回 false 表示校验失败，不关闭
    close();
  };
  if(onOpen) onOpen(bEl);
}

/* —— 分页 —— */
function renderPager(pager, page, totalPages, total){
  pager.hidden = totalPages <= 1;
  if(totalPages <= 1){ pager.innerHTML=''; return; }
  let btns = '';
  const mk = (p, label, cls='') =>
    `<button class="pg-btn ${cls} ${p===page?'on':''}" data-p="${p}">${label}</button>`;
  btns += mk(page-1, '‹', 'pg-nav' + (page<=1?' disabled':''));
  const pages = [];
  for(let i=1;i<=totalPages;i++){
    if(i===1 || i===totalPages || Math.abs(i-page)<=1) pages.push(i);
    else if(pages[pages.length-1] !== '…') pages.push('…');
  }
  pages.forEach(p=>{
    if(p === '…') btns += `<span class="pg-ellipsis">…</span>`;
    else btns += mk(p, p);
  });
  btns += mk(page+1, '›', 'pg-nav' + (page>=totalPages?' disabled':''));
  pager.innerHTML = btns + `<span class="pg-info">共 ${total} 门 · ${page}/${totalPages} 页</span>`;
}
function gotoLibPage(p){
  const list = visibleCourses();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const np = Math.max(1, Math.min(totalPages, p));
  if(np === state.libFilter.page) return;
  state.libFilter.page = np;
  renderLibrary();
  const sec = qs('.library-section');
  if(sec) sec.scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ============ 学习统计 ============ */
let prevStatsFrom = null;
function openStats(){
  const v = document.body.dataset.view;
  if(v === 'watch') prevStatsFrom = 'watch';
  else if(v === 'library' || v === 'settings') prevStatsFrom = 'library';
  showView('stats');
}
/* 课程累计已学秒数：优先真实计时，无则按进度折算 */
function courseLearnedSec(c){
  return c.parts.reduce((a,p)=>{
    if(p.watch) return a + p.watch;
    return a + (p.progress||0) * (p.duration||0);
  }, 0);
}
/* 热图强度：按当日观看分钟数分 5 档 */
function calLevel(wSec){
  const m = (wSec||0)/60;
  if(m <= 0) return 0;
  if(m < 10) return 1;
  if(m < 30) return 2;
  if(m < 60) return 3;
  return 4;
}
function renderStats(){
  const wrap = qs('#stats-body'); if(!wrap) return;
  if(!state.statsCursor){
    const now = new Date();
    state.statsCursor = { y:now.getFullYear(), m:now.getMonth(), selKey:null };
  }
  const cur = state.statsCursor;
  const today = todayKey();
  const day = actDay(today);
  const s = streakInfo();

  // —— 今日概览 ——
  let html = `
  <section class="st-hero">
    <div class="st-hero-main">
      <p class="st-eyebrow">TODAY · ${today}</p>
      <div class="st-big">${fmtDur(day.w)}</div>
      <p class="st-sub">今日专注观看${day.p>0?` · 思考 ${fmtDur(day.p)}`:''}</p>
    </div>
    <div class="st-hero-side">
      <div class="st-hstat"><b>${fmtDur(day.p)}</b><span>今日思考</span></div>
      <div class="st-hstat"><b>${day.c||0}</b><span>学完分 P</span></div>
      <div class="st-hstat"><b>${Object.keys(day.co||{}).length}</b><span>触达课程</span></div>
      <div class="st-hstat"><b>${s.streak}</b><span>连续天数</span></div>
    </div>
  </section>`;

  // —— 日历 ——
  html += renderCalendarBlock(cur);

  // —— 课程投入排行（无数据时留空） ——
  html += renderRankingBlock();

  // —— 年度报告入口（始终可用，不依赖排行数据） ——
  html += `
  <div class="st-year-entry">
    <button class="solid-btn" id="btn-year-report">查看年度学习报告 →</button>
  </div>`;

  wrap.innerHTML = html;
  renderDayDetail();
  reveal('.st-hero > *, .st-cal, .st-rank', { stagger:0.06, duration:0.7 });
}

function renderCalendarBlock(cur){
  const { y, m } = cur;
  const monthName = `${y} 年 ${m+1} 月`;
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const lead = first.getDay();                     // 周日=0，前置空位
  const now = new Date();
  const isCurrentMonth = (y===now.getFullYear() && m===now.getMonth());

  // 月度汇总
  let mW=0, mP=0, mC=0, activeDays=0;
  for(let d=1; d<=daysInMonth; d++){
    const k = `${y}-${pad2(m+1)}-${pad2(d)}`;
    const a = actDay(k);
    if(a.w>0){ activeDays++; mW+=a.w; mP+=a.p; mC+=(a.c||0); }
  }

  const wds = '日一二三四五六';
  let cells = '<span class="cal-ghost"></span>'.repeat(lead);
  for(let d=1; d<=daysInMonth; d++){
    const k = `${y}-${pad2(m+1)}-${pad2(d)}`;
    const a = actDay(k);
    const lv = calLevel(a.w);
    const isToday = k === todayKey();
    const future = new Date(y, m, d) > now;
    const sel = cur.selKey === k ? ' sel' : '';
    const tip = a.w>0 ? `${d} 日 · 观看 ${fmtDur(a.w)} · 思考 ${fmtDur(a.p)}` : `${d} 日`;
    cells += `<button class="cal-cell lv${lv}${isToday?' today':''}${future?' future':''}${sel}" data-k="${k}" title="${tip}"><i>${d}</i></button>`;
  }
  return `
  <section class="st-cal panel-card">
    <div class="cal-head">
      <button class="mini-btn" id="cal-prev" title="上月">‹</button>
      <h3 class="cal-title">${monthName}</h3>
      <button class="mini-btn" id="cal-next" title="下月">›</button>
      <button class="mini-btn" id="cal-today">今天</button>
    </div>
    <div class="cal-week">${wds.split('').map(w=>`<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend">
      <span>少</span>
      <i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i>
      <span>多</span>
      <span class="cal-month-meta">${isCurrentMonth?'本月':''} 观看 ${fmtDur(mW)}${mP>0?` · 思考 ${fmtDur(mP)}`:''} · 学习 ${activeDays} 天${mC>0?` · 学完 ${mC} 个分 P`:''}</span>
    </div>
  </section>
  <section class="st-day-detail panel-card" id="st-day-detail"></section>`;
}

function renderDayDetail(){
  const el = qs('#st-day-detail'); if(!el) return;
  const cur = state.statsCursor; if(!cur){ el.hidden = true; return; }
  const k = cur.selKey;
  if(!k){ el.hidden = true; el.innerHTML=''; return; }
  const a = actDay(k);
  const co = a.co || {};
  const rows = Object.entries(co).sort((x,y)=>y[1]-x[1]).map(([bvid, sec])=>{
    const c = state.courses.find(x=>x.bvid===bvid);
    return `<div class="dd-course"><span class="dd-dot"></span><span class="dd-name">${escapeHtml(c?c.title:bvid)}</span><b>${fmtDur(sec)}</b></div>`;
  }).join('');
  el.hidden = false;
  el.innerHTML = `
    <div class="dd-head">
      <h3>${k}</h3>
      <button class="mini-btn" id="dd-close">关闭</button>
    </div>
    <div class="dd-stats">
      <div class="dd-stat"><b>${fmtDur(a.w)}</b><span>观看</span></div>
      <div class="dd-stat"><b>${fmtDur(a.p)}</b><span>思考</span></div>
      <div class="dd-stat"><b>${a.c||0}</b><span>学完分 P</span></div>
    </div>
    ${rows?`<div class="dd-courses">${rows}</div>`:'<p class="dd-empty">这一天有学习记录，但没有归到具体课程（早期数据）。</p>'}`;
}

function renderRankingBlock(){
  const ranked = state.courses
    .map(c=>({ c, sec:courseLearnedSec(c) }))
    .filter(x=>x.sec > 30)
    .sort((a,b)=>b.sec-a.sec)
    .slice(0, 6);
  if(!ranked.length) return '';
  const max = ranked[0].sec || 1;
  const bars = ranked.map(({c, sec}, i)=>{
    const pct = Math.round(sec/max*100);
    const done = c.parts.filter(p=>p.done).length;
    return `
    <div class="rk-row">
      <span class="rk-no">${i+1}</span>
      <div class="rk-main">
        <div class="rk-title">${escapeHtml(c.title)}</div>
        <div class="rk-bar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="rk-meta">
        <b>${fmtDur(sec)}</b>
        <span>${done}/${c.parts.length} P</span>
      </div>
    </div>`;
  }).join('');
  return `
  <section class="st-rank panel-card">
    <div class="cal-head"><h3 class="cal-title">课程投入排行</h3><span class="cal-month-meta">按累计观看时长</span></div>
    ${bars}
  </section>`;
}

function statsShiftMonth(delta){
  const cur = state.statsCursor; if(!cur) return;
  let m = cur.m + delta, y = cur.y;
  if(m < 0){ m = 11; y--; }
  if(m > 11){ m = 0; y++; }
  cur.y = y; cur.m = m; cur.selKey = null;
  renderStats();
}
function statsGoToday(){
  const now = new Date();
  state.statsCursor = { y:now.getFullYear(), m:now.getMonth(), selKey:null };
  renderStats();
}
function statsSelectDay(k){
  const cur = state.statsCursor; if(!cur) return;
  cur.selKey = cur.selKey === k ? null : k;
  renderStats();
}

/* —— 年度报告 —— */
function openYearReport(){
  const mask = qs('#year-report');
  renderYearReport();
  mask.hidden = false;
  if(lenis) lenis.stop();
}
function closeYearReport(){
  const mask = qs('#year-report');
  mask.hidden = true;
  if(lenis) lenis.start();
}
function renderYearReport(){
  const el = qs('#yr-body'); if(!el) return;
  const year = new Date().getFullYear();
  // 年度聚合
  let days=0, w=0, p=0, parts=0;
  const monthsW = new Array(12).fill(0);
  for(const [k, a] of Object.entries(state.activity)){
    if(!k.startsWith(String(year)+'-')) continue;
    const aw = a.w || (typeof a==='number' ? a : 0);
    if(aw > 0){ days++; w += aw; p += a.p||0; parts += a.c||0; monthsW[parseInt(k.slice(5,7),10)-1] += aw; }
  }
  // 最长连续（年内）
  let best=0, run=0;
  const d0 = new Date(year, 0, 1);
  const dEnd = new Date(year, 11, 31);
  for(let d=new Date(d0); d<=dEnd; d.setDate(d.getDate()+1)){
    if(actW(keyFor(d))>0){ run++; best=Math.max(best, run); } else run=0;
  }
  const bestMonth = monthsW.indexOf(Math.max(...monthsW));
  const favHour = state.hourDist.indexOf(Math.max(...state.hourDist));
  const ranked = state.courses.map(c=>({c, sec:courseLearnedSec(c)})).sort((a,b)=>b.sec-a.sec).slice(0,3);
  const maxH = Math.max(1, ...state.hourDist);
  const hasData = w > 0;
  const hasHour = Math.max(...state.hourDist) > 0;

  // 12 个月迷你热图
  const wds='日一二三四五六';
  let months = '';
  for(let m=0; m<12; m++){
    const first = new Date(year, m, 1);
    const dim = new Date(year, m+1, 0).getDate();
    let cells = '<i></i>'.repeat(first.getDay());
    for(let d=1; d<=dim; d++){
      const k = `${year}-${pad2(m+1)}-${pad2(d)}`;
      cells += `<i class="lv${calLevel(actW(k))}"></i>`;
    }
    months += `<div class="yr-month"><span class="yr-mname">${m+1}月</span><div class="yr-mgrid">${cells}</div></div>`;
  }

  const hourBar = state.hourDist.map((sec, h)=>{
    const hgt = Math.round(sec/maxH*100);
    return hgt>0?`<div class="yr-hour" title="${pad2(h)}:00 · ${fmtDur(sec)}"><i style="height:${Math.max(6,hgt)}%"></i><span>${h%6===0?pad2(h):''}</span></div>`:'';
  }).join('');

  el.innerHTML = `
    <header class="yr-head">
      <p class="st-eyebrow">ANNUAL REPORT</p>
      <h2>${year} 年度学习报告</h2>
    </header>
    <section class="yr-hero">
      <div class="yr-big">${hasData ? fmtDur(w) : '尚未开始'}</div>
      <p class="yr-big-label">${hasData ? '这一年，你在屏幕前专注了这么久' : '看第一个视频，点亮属于你的第一格日历'}</p>
    </section>
    <section class="yr-grid">
      <div class="yr-stat"><b>${days}</b><span>学习天数</span></div>
      <div class="yr-stat"><b>${best}</b><span>最长连续（天）</span></div>
      <div class="yr-stat"><b>${parts}</b><span>学完分 P</span></div>
      <div class="yr-stat"><b>${fmtDur(p)}</b><span>暂停思考</span></div>
      <div class="yr-stat"><b>${hasData ? `${bestMonth+1} 月` : '—'}</b><span>最投入的月份</span></div>
      <div class="yr-stat"><b>${hasHour ? `${pad2(favHour)}:00` : '—'}</b><span>常学时段</span></div>
    </section>
    <section class="yr-sec">
      <h3>这一年的足迹</h3>
      <div class="yr-months">${months}</div>
    </section>
    ${hourBar?`
    <section class="yr-sec">
      <h3>你常在几点学习</h3>
      <div class="yr-hours">${hourBar}</div>
    </section>`:''}
    ${ranked.length?`
    <section class="yr-sec">
      <h3>陪你最久的课程</h3>
      ${ranked.map(({c, sec}, i)=>`
        <div class="rk-row">
          <span class="rk-no">${i+1}</span>
          <div class="rk-main">
            <div class="rk-title">${escapeHtml(c.title)}</div>
            <div class="rk-bar"><i style="width:${Math.round(sec/ranked[0].sec*100)}%"></i></div>
          </div>
          <div class="rk-meta"><b>${fmtDur(sec)}</b><span>${c.parts.filter(x=>x.done).length}/${c.parts.length} P</span></div>
        </div>`).join('')}
    </section>`:''}
    <p class="yr-foot">— DEEPREEL · 深刷 · 保持深度 —</p>`;
  reveal('.yr-hero, .yr-stat', { stagger:0.06, duration:0.7 });
}

/* ============ 日期 & 活动 ============ */
function pad2(n){ return String(n).padStart(2,'0'); }
function keyFor(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function todayKey(){ return keyFor(new Date()); }
function addActivity(sec){
  // 兼容保留：示例课程旧入口（真实计时走 recordActivity）
  if(!sec||sec<=0) return;
  recordActivity(sec, 0, null);
}
function last7Days(){
  const wds='日一二三四五六'; const arr=[]; const now=new Date();
  for(let i=6;i>=0;i--){ const d=new Date(now); d.setDate(now.getDate()-i); arr.push({ key:keyFor(d), wd:wds[d.getDay()], today:i===0 }); }
  return arr;
}
function streakInfo(){
  let streak=0; const now=new Date(); let d=new Date(now);
  const todayLearned=actW(todayKey())>0;
  if(!todayLearned) d.setDate(d.getDate()-1); // 今日尚未学习，从昨日起算（给一天宽限）
  while(true){ const k=keyFor(d); if(actW(k)>0){ streak++; d.setDate(d.getDate()-1);} else break; }
  return { streak, todayLearned };
}

/* ============ 实时图表（纯 SVG） ============ */
function ringSVG(pct){
  const r=52, C=2*Math.PI*r, off=C*(1-pct/100);
  let ticks='';
  [25,50,75].forEach(m=>{
    const a=(-90+m*3.6)*Math.PI/180;
    const x1=60+Math.cos(a)*44, y1=60+Math.sin(a)*44, x2=60+Math.cos(a)*60, y2=60+Math.sin(a)*60;
    ticks+=`<line class="tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  });
  return `<svg class="ring-svg" viewBox="0 0 120 120">
    <circle class="track" cx="60" cy="60" r="${r}"/>
    <circle class="fill" cx="60" cy="60" r="${r}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 60 60)"/>
    ${ticks}
  </svg>`;
}

function renderDashboard(){
  const el=qs('#learn-dashboard'); if(!el) return;
  const pct=Math.round(avgPercent()*100);
  const totalMin=Math.round(overallLearnedSeconds()/60);
  const parts=totalParts();
  const s=streakInfo();
  const days=last7Days();
  const maxM=Math.max(1, ...days.map(d=>Math.round(actW(d.key)/60)));
  const bars=days.map(d=>{
    const m=Math.round(actW(d.key)/60);
    const h=Math.max(3, Math.round(m/maxM*100));
    return `<div class="bar ${d.today?'today':''}">
      <b>${m||''}</b>
      <i style="height:${h}%"></i>
      <span>${d.wd}</span>
    </div>`;
  }).join('');
  const todayMin=Math.round(actW(todayKey())/60);
  el.innerHTML=`
    <div class="ld-card ld-ring">
      ${ringSVG(pct)}
      <div>
        <div class="ring-num">${pct}<small>%</small></div>
        <div class="ring-label">平均完成度</div>
      </div>
    </div>
    <div class="ld-card ld-7day">
      <h4>近 7 日 · 学习时长（分）</h4>
      <div class="bars">${bars}</div>
    </div>
    <div class="ld-card ld-stats">
      <h4>学习足迹</h4>
      <div class="ld-stat"><b>${state.courses.length}</b><span>课程</span></div>
      <div class="ld-stat"><b>${parts}</b><span>分 P</span></div>
      <div class="ld-stat"><b>${totalMin>=60?(totalMin/60).toFixed(1)+'h':totalMin+'m'}</b><span>已学时长</span></div>
      <div class="streak ${s.streak>=3?'fire':(s.streak===0?'warn':'')}">
        <span class="flame">${s.streak>=3?'◆':(s.streak>0?'·':'○')}</span>
        ${s.todayLearned ? `今日已学 ${todayMin} 分钟 · 连续 ${s.streak} 天` : (s.streak>0?`连续 ${s.streak} 天 · 今日还没学，别断了`:'今天还没开始学习')}
      </div>
    </div>`;
  // 环形填充动画（从空到目标）
  if(window.gsap){
    const fill=el.querySelector('.ring-svg .fill');
    if(fill){ const C=parseFloat(fill.getAttribute('stroke-dasharray'))||326.7; fill.style.strokeDashoffset=C; gsap.to(fill,{ strokeDashoffset:C*(1-pct/100), duration:1.2, ease:'power2.out' }); }
  }
}

/* 分 P 进度柱状（专注视图，实时更新） */
function renderPartChart(){
  const c=activeCourse(); if(!c) return;
  const meta=qs('#pc-meta'); if(meta) meta.textContent=`${c.parts.length}P`;
  const box=qs('#part-chart'); if(!box) return;
  let bars=box.querySelector('.p-bars');
  if(!bars || bars.children.length !== c.parts.length){
    box.innerHTML=`<div class="p-bars">${c.parts.map((p,i)=>`<div class="pb" data-i="${i}" title="P${p.page}"><i></i></div>`).join('')}</div>`;
    bars=box.querySelector('.p-bars');
    bars.querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>loadPart(+b.dataset.i)));
  }
  c.parts.forEach((p,i)=>{
    const el=bars.children[i]; if(!el) return;
    const pct=Math.round((p.progress||0)*100);
    el.querySelector('i').style.height=Math.max(3,pct)+'%';
    el.className='pb'+(p.done?' done':'')+(i===state.activePart?' cur':'');
    el.title=`P${p.page} · ${pct}%`;
  });
  const doneN=c.parts.filter(p=>p.done).length;
  const remN=c.parts.length-doneN;
  const remSec=c.parts.reduce((a,p)=>a+(p.done?0:((p.duration||0)*(1-(p.progress||0)))),0);
  const cp=Math.round(courseProgress(c)*100);
  const s=streakInfo();
  const m=qs('#motivation-line');
  if(m) m.innerHTML=`
    <span class="joy">已学 ${cp}%</span>
    <span>已坚持 ${s.streak} 天</span>
    <span class="press">${remN>0?`还剩 ${remN} 个分 P · 约 ${fmtDur(remSec)}`:'全部完成'}</span>`;
}

/* ============ 渲染：专注播放视图 ============ */
function showView(name){
  document.body.dataset.view = name;
  qs('#view-library').hidden = name!=='library';
  qs('#view-watch').hidden = name!=='watch';
  qs('#view-settings').hidden = name!=='settings';
  qs('#view-stats').hidden = name!=='stats';
  qs('#btn-asst').hidden = name!=='watch';
  if(name!=='watch') closeAssistant();
  if(name==='stats') renderStats();
  if(lenis) lenis.scrollTo(0, { immediate:true });
}
function openCourse(bvid){
  const c = state.courses.find(x=>x.bvid===bvid);
  if(!c) return;
  state.activeCourseId = bvid;
  state.activePart = c.lastPart || 0;
  showView('watch');
  renderWatch();
  toast(c.isSample ? '示例课程已载入（进度为模拟数据，可完整体验所有功能）' : '已进入专注模式 · 无推荐无干扰');
}

function backToLibrary(){
  player && player.unload();
  state.activeCourseId = null;
  showView('library');
  renderLibrary();
}

function renderWatch(){
  const c = activeCourse(); if(!c) return;
  qs('#watch-title').textContent = c.title;
  renderTOC();
  loadPart(state.activePart);
  // 入场（clearProps 清掉残留 transform：恒等 matrix 会让 position:fixed 的后代以它为定位基准）
  if(window.gsap){
    gsap.from('.watch-topbar', { y:-12, opacity:0, duration:0.5, ease:'power2.out', clearProps:'transform,opacity' });
    gsap.from('.player-wrap', { y:18, opacity:0, duration:0.7, ease:'power3.out', clearProps:'transform,opacity' });
    gsap.from('.panel-block', { y:18, opacity:0, duration:0.7, ease:'power3.out', stagger:0.1, delay:0.1, clearProps:'transform,opacity' });
  }
  updateOverall();
}

function renderTOC(){
  const c = activeCourse(); if(!c) return;
  qs('#toc-meta').textContent = `${c.parts.length}P`;
  const list = qs('#toc-list');
  list.innerHTML = c.parts.map((p,i)=>{
    const pct = Math.round((p.progress||0)*100);
    return `<div class="toc-item ${i===state.activePart?'is-current':''} ${p.done?'is-done':''}" data-i="${i}" role="listitem">
      <span class="toc-no">P${p.page}</span>
      <div class="toc-main">
        <div class="toc-title">${escapeHtml(p.part)}</div>
        <div class="toc-mini"><i style="width:${pct}%"></i></div>
      </div>
      <span class="toc-dur">${fmtDur(p.duration)}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.toc-item').forEach(el=>{
    el.addEventListener('click', ()=> loadPart(+el.dataset.i));
  });
}

function updateOverall(){
  const c = activeCourse(); if(!c) return;
  const pct = Math.round(courseProgress(c)*100);
  gsap.to('#wo-fill', { width:pct+'%', duration:0.6, ease:'power2.out' });
  qs('#wo-text').textContent = pct+'%';
}

/* ============ 播放器桥接 ============ */
/* B站 qn → 清晰度名称 */
const QN_LABEL = {127:'8K',126:'杜比视界',125:'HDR',120:'4K',116:'1080P60',112:'1080P+',80:'1080P',74:'720P60',64:'720P',32:'480P',16:'360P'};

/* fMP4 盒子解析（用于定位 init 段与 moof 分片边界） */
function u32be(b,o){ return (b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3]; }
function boxType(b,o){ return String.fromCharCode(b[o+4],b[o+5],b[o+6],b[o+7]); }
function concatU8(a,b){
  const out = new Uint8Array(a.length+b.length);
  out.set(a,0); out.set(b,a.length);
  return out;
}
function findMoof(buf){
  // 先按完整 box 结构走（buf 从 0 开始的情况）
  let pos = 0;
  while(pos+8 <= buf.length){
    const type = boxType(buf,pos);
    if(type === 'moof') return pos;
    const size = u32be(buf,pos);
    if(size < 8 || pos+size > buf.length+8) break;
    pos += size;
  }
  // 兜底：任意偏移原始扫描（中段起点的情况）
  for(let i=0;i+8<=buf.length;i++){
    if(buf[i+4]===0x6d && buf[i+5]===0x6f && buf[i+6]===0x6f && buf[i+7]===0x66){
      const size = u32be(buf,i);
      if(size >= 8 && size < 32*1024*1024) return i;
    }
  }
  return -1;
}

/* 解析 sidx 分片索引 → {segs:[{byte,time,size,dur}], totalByte, totalTime}
   布局（ISO 14496-12 §8.16）：version/flags(4) + reference_ID(4) + timescale(4)
   v0: ept(4) first_offset(4)；v1: ept(8) first_offset(8)；随后 reserved(2) ref_count(2) reference(12×N) */
function parseSidx(buf){
  let pos = 0;
  while(pos+8 <= buf.length){
    const size = u32be(buf,pos);
    const type = boxType(buf,pos);
    if(type === 'sidx' && pos+size <= buf.length){
      const o = pos, end = pos + size;
      const version = buf[o+8];
      const timescale = u32be(buf,o+16) || 1;      // @12 是 reference_ID，timescale 在 @16
      let ept, firstOffset, p;
      if(version === 0){
        ept = u32be(buf,o+20);
        firstOffset = u32be(buf,o+24);
        p = o+28;                                   // reserved(2) + reference_count(2)
      }else{
        ept = u32be(buf,o+20)*4294967296 + u32be(buf,o+24);
        firstOffset = u32be(buf,o+28)*4294967296 + u32be(buf,o+32);
        p = o+36;
      }
      const refCount = (buf[p+2]<<8)|buf[p+3];
      p += 4;                                       // 到第一条 reference
      const segs = [];
      let byte = end + firstOffset;                  // 引用数据相对 sidx 盒结束的偏移
      let time = ept/timescale;
      for(let i=0;i<refCount && p+12<=buf.length;i++){
        const r1 = u32be(buf,p), dur = u32be(buf,p+4); p += 12;
        const sz = r1 & 0x7fffffff;
        if(sz <= 0) break;
        segs.push({ byte, time, size: sz, dur: dur/timescale });
        byte += sz;
        time += dur/timescale;
      }
      if(segs.length) return { segs, totalByte: byte, totalTime: time };
      return null;
    }
    if(size < 8 || pos+size > buf.length) return null;
    pos += size;
  }
  return null;
}

class PlayerBridge{
  constructor(){
    this.video = qs('#player-video');
    this.wrap = qs('#player-frame-wrap');
    this.tip = qs('#player-focus-tip');
    this.loading = qs('#player-loading');
    this.running = false;
    this.timer = null;
    this.trimTimer = null;
    this.cur = { course:null, partIdx:0, bvid:null, cid:null, page:1, duration:0, time:0, done:false, simulate:false };
    // 流状态
    this.mode = null;              // 'dash' | 'mp4'
    this.ms = null; this.msURL = null;
    this.vsb = null; this.asb = null;
    this.runId = 0; this.abortCtl = null;
    this.streamBase = { video:'', audio:'' };
    this.totalSize = { video:0, audio:0 };
    this.initSeg = { video:null, audio:null };
    this.sidx = { video:null, audio:null };
    this.dur = 0;
    this._pendingSeek = null;
    this._retried = false;
    this._errToasted = false;
    this._ctlTimer = null;
    this._tipTimer = null;
    this.stallTimer = null;
    this._lastT = -1;
    this._stallCount = 0;
    this.AHEAD = 15;               // 分片调度：提前缓冲秒数
    this.sched = null;             // 分片调度器状态
    // 学习计时：_started=播过至少一次；watch/think 未刷写秒数；_pauseAt=暂停起点（思考封顶用）
    this._started = false;
    this._watchAcc = 0;
    this._thinkAcc = 0;
    this._pauseAt = null;
    this.trackTimer = null;
    // mp4 分段
    this.segs = []; this.segStart = []; this.segIdx = 0; this.segBase = 0;

    const v = this.video;
    v.addEventListener('timeupdate', ()=> this.onTimeUpdate());
    /* 暂停状态下 seek 不触发 timeupdate，需用 seeked 同步进度条 */
    v.addEventListener('seeked', ()=>{
      const t = this.video.currentTime + (this.mode==='mp4' ? this.segBase : 0);
      this.setTime(t);
    });
    v.addEventListener('ended', ()=> this.onEnded());
    v.addEventListener('play', ()=> { const b=qs('#btn-play'); if(b) b.classList.add('is-playing'); this._started=true; this._pauseAt=null; });
    v.addEventListener('pause', ()=> { const b=qs('#btn-play'); if(b) b.classList.remove('is-playing'); if(this._started && this._pauseAt==null) this._pauseAt = Date.now(); });
    v.addEventListener('progress', ()=> this.updateBuffered());
    v.addEventListener('waiting', ()=> this.showLoading(true));
    v.addEventListener('canplay', ()=> this.showLoading(false));
    v.addEventListener('playing', ()=> { this.showLoading(false); this._retried=false; this._errToasted=false; });
    v.addEventListener('error', ()=> {
      reportDebug('video-error mode=' + this.mode + ' code=' + (this.video.error ? this.video.error.code : '?') + ' src=' + String(this.video.currentSrc||this.video.src||'').slice(0,60));
      // teardown 也会触发 error（清空 src），用 mode 判别真实播放错误
      if(this.mode && this.cur.course && !this.cur.simulate) this.onStreamError(new Error('video element error'));
      else this.showLoading(false);
    });
    v.addEventListener('loadstart', ()=> reportDebug('video-loadstart'));
    v.addEventListener('loadedmetadata', ()=> reportDebug('video-loadedmeta dur=' + (this.video.duration||0)));
    // 触屏（B站式）：单击=即时播放/暂停；300ms 内第二击=撤销单击切换+快进快退10s
    this._touchMode = ('ontouchstart' in window) || (window.matchMedia && window.matchMedia('(hover:none)').matches);
    this._lastTap = 0; this._tapToggleApplied = false; this._wasPlaying = false;
    v.addEventListener('pointerup', e=>{
      if(e.pointerType !== 'touch') return;
      if(e.target.closest('.player-controls')) return;
      const now = Date.now();
      if(now - this._lastTap < 300){
        // 双击：撤销单击造成的播放/暂停切换，然后快进/快退
        this._lastTap = 0;
        if(this._tapToggleApplied){
          try{ this.video[this._wasPlaying ? 'play' : 'pause'](); }catch{}
          this._tapToggleApplied = false;
        }
        const r = this.wrap.getBoundingClientRect();
        const x = e.clientX - r.left;
        const delta = x < r.width/2 ? -10 : 10;
        this.seekTo((this.cur.time||0) + delta);
        this.showSeekFeedback(delta);
        this.flashControls();
        return;
      }
      this._lastTap = now;
      this._wasPlaying = !this.video.paused;
      this._tapToggleApplied = true;
      if(this.mode && !this.cur.simulate) this.togglePlay();
      this.flashControls();
    });
    v.addEventListener('click', e=>{
      if(e.detail > 1) return;
      if(this._touchMode) return;   // 触屏单击已由 pointerup 即时处理
      if(this.mode && !this.cur.simulate) this.togglePlay();
    });
    this.wrap.addEventListener('pointerdown', e=>{ if(e.pointerType==='touch') this.flashControls(); });
  }
  showLoading(on){ if(this.loading) this.loading.hidden = !on; }
  /* 专注模式入场仪式：滑入提示，数秒后自动淡出（不常驻遮挡画面；切 P 时重播） */
  showFocusTip(){
    const tip = this.tip; if(!tip) return;
    tip.classList.remove('tip-gone');
    tip.classList.add('tip-live');
    void tip.offsetWidth;                 // 强制回流，重播入场动画
    clearTimeout(this._tipTimer);
    this._tipTimer = setTimeout(()=>{ tip.classList.add('tip-gone'); }, 3600);
  }
  flashControls(){
    this.wrap.classList.add('show-controls');
    clearTimeout(this._ctlTimer);
    this._ctlTimer = setTimeout(()=> this.wrap.classList.remove('show-controls'), 3000);
  }
  /* 双击快进/快退的 +10s 提示（B站式） */
  showSeekFeedback(delta){
    const el = qs('#seek-feedback');
    if(!el) return;
    el.textContent = (delta > 0 ? '+' : '') + delta + 's';
    el.hidden = false;
    el.classList.remove('anim'); void el.offsetWidth; el.classList.add('anim');
    clearTimeout(this._fbTimer);
    this._fbTimer = setTimeout(()=>{ el.hidden = true; }, 750);
  }
  proxyBase(){ return proxyBase(); }
  cookie(){ return biliCookie(); }
  quality(){ return state.settings.biliQuality || '80'; }

  /* ---------- 清理 ---------- */
  teardown(){
    this.runId++;
    if(this.abortCtl){ try{ this.abortCtl.abort(); }catch{} this.abortCtl=null; }
    this.mode = null;
    this.vsb = null; this.asb = null;
    if(this.ms){ this.ms = null; }
    if(this.msURL){ try{ URL.revokeObjectURL(this.msURL); }catch{} this.msURL = null; }
    this.video.removeAttribute('src');
    try{ this.video.load(); }catch{}
    this.initSeg = { video:null, audio:null };
    this.sidx = { video:null, audio:null };
    this.sched = null;
    this._pendingSeek = null;
    this.segs = []; this.segStart = []; this.segIdx = 0; this.segBase = 0;
    this.showLoading(false);
    if(this.tip) this.tip.classList.add('tip-gone');   // 加载失败/退出时不残留常驻标签
  }

  /* ---------- 加载入口 ---------- */
  async load(c, partIdx){
    const p = c.parts[partIdx];
    this.teardown();
    this.stop();
    this.cur = { course:c, partIdx, bvid:c.bvid, cid:p.cid, page:p.page, duration:p.duration||0, time:p.lastTime||0, done:!!p.done, simulate: !!c.isSample };
    this.wrap.classList.toggle('is-sample', !!c.isSample);
    qs('#pb-no').textContent = 'P'+p.page;
    qs('#pb-title').textContent = p.part;
    this.updateBar();
    if(c.isSample){ this.startPolling(); return; }
    this.showLoading(true);
    this._retried = false;
    this._errToasted = false;
    const resumeAt = Math.max(0, p.lastTime||0);
    try{
      let data = null;
      try { data = await this.fetchPlayurl(c.bvid, p.cid, 16); }
      catch(e){ /* 冷启动首次可能超时/抖动，重试一次（第二次通常很快） */ data = await this.fetchPlayurl(c.bvid, p.cid, 16); }
      this.fillQualityOptions(data);
      const mseOk = !!(window.MediaSource && window.MediaSource.isTypeSupported && data.dash && data.dash.video && data.dash.video.length);
      if(mseOk){
        try{
          await this.setupDash(data, resumeAt);
        }catch(e){
          // MSE/编码不支持 → 退回 MP4（fnval=1）
          reportDebug('dash-fallback: ' + (e.message||e) + ' mse=' + (!!window.MediaSource) + ' typeok=' + (window.MediaSource ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.640032"') : 'n/a'));
          this.teardown();
          data = await this.fetchPlayurl(c.bvid, p.cid, 1);
          this.fillQualityOptions(data);
          await this.setupMp4(data, resumeAt);
        }
      }else if(data.durl){
        await this.setupMp4(data, resumeAt);
      }else{
        // 无 MSE 或无 DASH 视频流 → 直接请求 MP4
        data = await this.fetchPlayurl(c.bvid, p.cid, 1);
        this.fillQualityOptions(data);
        if(data.durl) await this.setupMp4(data, resumeAt);
        else throw new Error('无可用视频流');
      }
    }catch(e){
      this.showLoading(false);
      reportDebug('load-error: ' + (e.message||e));
      toast('视频加载失败：' + (e.message||'') + '。请确认代理已启动、已扫码登录。');
      return;
    }
    const spd = qs('#sel-speed');
    if(spd) this.video.playbackRate = parseFloat(spd.value) || 1;
    if(state.settings.volume != null) this.video.volume = state.settings.volume;
    /* 预取下一分 P 的播放地址：切 P 时秒开 */
    const np = c.parts[idx+1];
    if(np && np.cid) this.fetchPlayurl(c.bvid, np.cid, 16).catch(()=>{});
    this.startPolling();
    this.showFocusTip();
  }

  async fetchPlayurl(bvid, cid, fnval){
    if(!this.playurlCache) this.playurlCache = new Map();
    const key = `${bvid}|${cid}|${this.quality()}|${fnval}`;
    if(this.playurlCache.has(key)) return this.playurlCache.get(key);
    const ctl = new AbortController();
    const timer = setTimeout(()=>ctl.abort(), 20000);   // 拉流地址 20s 超时（冷启动+网络波动）
    try{
      const r = await fetch(`${this.proxyBase()}/bili/playurl?bvid=${bvid}&cid=${cid}&qn=${this.quality()}&fnval=${fnval}&fnver=0&fourk=1`, { headers: { 'X-Bili-Cookie': this.cookie() }, signal: ctl.signal });
      const j = await r.json();
      if(j.code !== 0 || !j.data) throw new Error(j.message || '接口错误');
      this.playurlCache.set(key, j.data);
      return j.data;
    } finally { clearTimeout(timer); }
  }

  /* ---------- DASH（MSE）---------- */
  pickVideoStream(dash){
    const want = parseInt(this.quality(), 10) || 80;
    const list = dash.video || [];
    let pool = list.filter(x=>/^(avc1|avc3)/i.test(x.codecs||''));
    if(!pool.length) pool = list.filter(x=>/^(hvc1|hev1|av01)/i.test(x.codecs||''));
    if(!pool.length) pool = list;
    if(!pool.length) return null;
    /* 从期望清晰度向下逐档尝试，选手机能解码的第一个（如 1080p 不支持则 720p/480p） */
    const ids = [...new Set(pool.map(x=>x.id))].sort((a,b)=>b-a);
    const order = ids.filter(id=>id<=want).concat(ids.filter(id=>id>want).reverse());
    for(const id of order){
      const cand = pool.filter(x=>x.id===id).sort((a,b)=>(b.bandwidth||0)-(a.bandwidth||0))[0];
      if(!cand) continue;
      if(!window.MediaSource || !MediaSource.isTypeSupported || MediaSource.isTypeSupported(`video/mp4; codecs="${cand.codecs}"`)){
        return cand;
      }
    }
    return null;
  }
  pickAudioStream(dash){
    const list = dash.audio || [];
    const mp4a = list.filter(a=>/^mp4a/i.test(a.codecs||''));
    const pool = mp4a.length ? mp4a : list;
    if(!pool.length) return null;
    return pool.slice().sort((a,b)=>(b.bandwidth||0)-(a.bandwidth||0))[0];
  }
  async setupDash(data, resumeAt){
    const vs = this.pickVideoStream(data.dash);
    const as = this.pickAudioStream(data.dash);
    if(!vs) throw new Error('无可用视频流');
    const vMime = `video/mp4; codecs="${vs.codecs}"`;
    if(!window.MediaSource || !MediaSource.isTypeSupported(vMime)) throw new Error('浏览器不支持 ' + vMime);
    let aMime = null;
    if(as){
      const m = `audio/mp4; codecs="${as.codecs}"`;
      if(MediaSource.isTypeSupported(m)) aMime = m;
    }
    this.mode = 'dash';
    this.dur = (data.timelength||0)/1000 || (this.cur.duration||0);
    this.cur.duration = this.cur.duration || this.dur;
    this.streamBase.video = streamUrl(vs.baseUrl || vs.base_url);
    this.streamBase.audio = as ? streamUrl(as.baseUrl || as.base_url) : '';
    this.totalSize = { video:0, audio:0 };
    this.ms = new MediaSource();
    this.msURL = URL.createObjectURL(this.ms);
    await new Promise((resolve, reject)=>{
      const to = setTimeout(()=>reject(new Error('MSE 初始化超时')), 8000);
      this.ms.addEventListener('sourceopen', ()=>{
        clearTimeout(to);
        try{
          this.vsb = this.ms.addSourceBuffer(vMime);
          if(aMime) this.asb = this.ms.addSourceBuffer(aMime);
          if(this.dur > 0){ try{ this.ms.duration = this.dur; }catch{} }
          resolve();
        }catch(e){ reject(e); }
      }, { once:true });
      this.video.src = this.msURL;
      this.video.load();
    });
    const sel = qs('#sel-quality');
    if(sel) sel.value = String(vs.id);
    if(resumeAt > 0 && this.dur > 0) this._pendingSeek = Math.min(resumeAt, this.dur - 1);
    await this.initScheduler(resumeAt);
    // 未登录画质提示（B 站仅下发 360P）
    if(!this.cookie()){
      const maxQn = Math.max(...(data.dash.video||[]).map(v=>v.id||0), 0);
      if(maxQn <= 32) setTimeout(()=>toast('未登录 B 站，当前仅 360P 画质。到「设置 → 扫码登录」可解锁 1080P+。'), 900);
    }
  }

  /* ---------- MP4（durl，可多分段）---------- */
  async setupMp4(data, resumeAt){
    const durl = data.durl || [];
    if(!durl.length) throw new Error('无 MP4 流');
    this.mode = 'mp4';
    this.dur = (data.timelength||0)/1000 || this.cur.duration || 0;
    this.segs = durl.map(d=>({
      url: streamUrl(d.url || (d.backup_url && d.backup_url[0]) || ''),
      dur: (d.length||0)/1000
    }));
    this.segStart = [];
    let acc = 0;
    this.segs.forEach(s=>{ this.segStart.push(acc); acc += s.dur; });
    if(!this.dur) this.dur = acc;
    this.cur.duration = this.cur.duration || this.dur;
    this.segIdx = 0; this.segBase = 0;
    if(resumeAt > 0){
      for(let i=0;i<this.segs.length;i++){
        if(resumeAt < this.segStart[i] + this.segs[i].dur){ this.segIdx = i; this.segBase = this.segStart[i]; break; }
        if(i === this.segs.length-1){ this.segIdx = i; this.segBase = this.segStart[i]; }
      }
    }
    const sel = qs('#sel-quality');
    if(sel && data.quality != null) sel.value = String(data.quality);
    this.attachSeg(resumeAt - this.segBase);
  }
  attachSeg(offset){
    const seg = this.segs[this.segIdx]; if(!seg) return;
    this.video.src = seg.url;
    this.video.load();   // teardown 后显式触发加载，否则可能不发起请求
    reportDebug('mp4-src-set url=' + String(seg.url||'').slice(0,80));
    if(offset > 0){
      const onMeta = ()=>{ try{ this.video.currentTime = offset; }catch{} this.video.removeEventListener('loadedmetadata', onMeta); };
      this.video.addEventListener('loadedmetadata', onMeta);
    }
  }
  switchSeg(i, offset){
    this.segIdx = i; this.segBase = this.segStart[i];
    this.attachSeg(offset);
    this.video.play().catch(()=>{});
  }

  /* ---------- 流引擎（分片按需调度）----------
     B 站 DASH 流带 sidx 索引：按播放位置用 Range 精确拉取单片（~5 秒数据），
     只预取 AHEAD 秒，而不是顺序下载整个文件——长视频秒开、不占内存。 */
  async initScheduler(fromTime){
    this.runId++;
    const rid = this.runId;
    if(this.abortCtl){ try{ this.abortCtl.abort(); }catch{} }
    this.abortCtl = new AbortController();
    this.sched = {
      video:{ next:0, pending:false, retried:false },
      audio:{ next:0, pending:false, retried:false },
    };
    await this.probeInit(this.streamBase.video, rid, 'video');
    if(rid !== this.runId) return;
    if(this.asb && this.streamBase.audio){
      await this.probeInit(this.streamBase.audio, rid, 'audio').catch(()=>{});
      if(rid !== this.runId) return;
    }
    if(!this.initSeg.video) throw new Error('无法读取视频流索引');
    if(!this.sidx.video){
      // 无 sidx 的老流：回退顺序流式（少见）
      this.startSequential(this.streamBase.video, this.vsb, 0, rid, 'video');
      if(this.asb) this.startSequential(this.streamBase.audio, this.asb, 0, rid, 'audio');
      return;
    }
    if(fromTime > 0){
      this.sched.video.next = this.segIdxForTime('video', fromTime);
      this.sched.audio.next = this.segIdxForTime('audio', fromTime);
    }
    this.schedule();
  }
  segIdxForTime(key, t){
    const sdx = this.sidx[key]; if(!sdx || !sdx.segs.length) return 0;
    const segs = sdx.segs;
    let lo = 0, hi = segs.length - 1, hit = 0;
    while(lo <= hi){
      const mid = (lo+hi) >> 1;
      if(segs[mid].time <= t){ hit = mid; lo = mid+1; }
      else hi = mid-1;
    }
    return Math.max(0, hit - 1);   // 回退一片，给解码器余量
  }
  schedule(){
    if(this.mode !== 'dash' || !this.ms || this.ms.readyState !== 'open') return;
    /* seek 待落地时以目标位置为基准判断缓冲，否则 currentTime 还停在旧位置，
       旧 buffer 会被误判为"缓冲充足"而停止拉片 → 永远等不到目标位置的数据 */
    const ct = (this._pendingSeek != null) ? this._pendingSeek : this.video.currentTime;
    for(const key of ['video','audio']){
      const sb = key === 'video' ? this.vsb : this.asb;
      if(!sb) continue;
      const st = this.sched && this.sched[key];
      if(!st || st.pending) continue;
      const sdx = this.sidx[key];
      if(!sdx || !sdx.segs.length || st.next >= sdx.segs.length) continue;
      const b = sb.buffered;
      let end = 0;
      for(let i=0;i<b.length;i++) end = Math.max(end, b.end(i));
      if(end - ct < this.AHEAD){
        const rid = this.runId, idx = st.next;
        st.pending = true;
        this.appendSeg(key, idx, rid).finally(()=>{
          const cur = this.sched && this.sched[key];
          if(cur){ cur.pending = false; }
          if(rid === this.runId) this.schedule();
        });
      }
    }
  }
  async appendSeg(key, idx, rid){
    const sb = key === 'video' ? this.vsb : this.asb;
    if(!sb) return;
    const sdx = this.sidx[key];
    const s = sdx && sdx.segs[idx];
    if(!s) return;
    try{
      const resp = await fetch(this.streamBase[key], {
        headers:{ 'Range':`bytes=${s.byte}-${s.byte + s.size - 1}` },
        signal: this.abortCtl.signal,
      });
      if(!resp.ok && resp.status !== 206) throw new Error('分片请求失败 HTTP ' + resp.status);
      if(rid !== this.runId) return;
      const buf = new Uint8Array(await resp.arrayBuffer());
      if(rid !== this.runId) return;
      if(!sb._initDone && this.initSeg[key]){
        await this.sbAppend(sb, this.initSeg[key]);
        sb._initDone = true;
      }
      await this.sbAppend(sb, buf);
      if(rid === this.runId){
        const st = this.sched[key];
        st.next = Math.max(st.next, idx + 1);
        st.retried = false;
        this.maybePendingSeek();
        this.updateBuffered();
      }
    }catch(e){
      if(rid !== this.runId || !e || e.name === 'AbortError') return;
      const st = this.sched[key];
      if(st && !st.retried){
        // 片级重试一次（网络抖动 / CDN 节点抽风）
        st.retried = true;
        setTimeout(()=>{ if(rid === this.runId) this.appendSeg(key, idx, rid); }, 900);
        return;
      }
      this.onStreamError(e);
    }
  }
  clearBuffers(){
    const jobs = [];
    for(const sb of [this.vsb, this.asb]){
      if(!sb) continue;
      jobs.push(new Promise(res=>{
        try{
          if(sb.updating){ sb.addEventListener('updateend', ()=>res(), { once:true }); return; }
          const b = sb.buffered;
          if(b.length){ sb.addEventListener('updateend', ()=>res(), { once:true }); sb.remove(0, (this.dur||1e7) + 60); }
          else res();
        }catch{ res(); }
      }));
    }
    return Promise.all(jobs);
  }
  async restartAt(t){
    this.runId++;
    const rid = this.runId;
    if(this.abortCtl){ try{ this.abortCtl.abort(); }catch{} }
    this.abortCtl = new AbortController();
    this._pendingSeek = t;
    this.showLoading(true);
    await this.clearBuffers();
    if(rid !== this.runId) return;
    if(this.sched){
      this.sched.video.next = this.segIdxForTime('video', t);
      this.sched.video.pending = false; this.sched.video.retried = false;
      this.sched.audio.next = this.segIdxForTime('audio', t);
      this.sched.audio.pending = false; this.sched.audio.retried = false;
    }
    this.schedule();
  }
  /* 顺序流式兜底（无 sidx 的流） */
  startSequential(url, sb, fromByte, rid, key){
    (async ()=>{
      try{
        const headers = {};
        if(fromByte > 0) headers['Range'] = `bytes=${fromByte}-`;
        const resp = await fetch(url, { headers, signal: this.abortCtl.signal });
        if(!resp.ok && resp.status !== 206) throw new Error('流请求失败 HTTP ' + resp.status);
        const cl = resp.headers.get('content-length');
        if(cl) this.totalSize[key] = parseInt(cl) || this.totalSize[key];
        else{
          const cr = resp.headers.get('content-range');
          const m = cr && cr.match(/\/(\d+)$/);
          if(m) this.totalSize[key] = parseInt(m[1]);
        }
        if(rid !== this.runId) return;
        if(!sb._initDone && this.initSeg[key]){
          await this.sbAppend(sb, this.initSeg[key]);
          sb._initDone = true;
        }
        const reader = resp.body.getReader();
        let carry = new Uint8Array(0);
        let skipping = fromByte > 0;
        while(true){
          if(rid !== this.runId){ try{ reader.cancel(); }catch{} return; }
          const { done, value } = await reader.read();
          if(done) break;
          if(rid !== this.runId){ try{ reader.cancel(); }catch{} return; }
          let chunk = value;
          if(skipping){
            carry = concatU8(carry, chunk);
            const at = findMoof(carry);
            if(at < 0){ carry = carry.slice(Math.max(0, carry.length-16)); continue; }
            chunk = carry.slice(at);
            carry = new Uint8Array(0);
            skipping = false;
          }
          await this.sbAppend(sb, chunk);
        }
      }catch(e){
        if(rid === this.runId && e && e.name !== 'AbortError') this.onStreamError(e);
      }
    })();
  }
  async probeInit(url, rid, key){
    const resp = await fetch(url, { headers:{ 'Range':'bytes=0-262143' }, signal: this.abortCtl.signal });
    if(!resp.ok && resp.status !== 206) throw new Error('流探测失败');
    const cr = resp.headers.get('content-range');
    const m = cr && cr.match(/\/(\d+)$/);
    if(m) this.totalSize[key] = parseInt(m[1]);
    else{
      const cl = resp.headers.get('content-length');
      if(cl) this.totalSize[key] = parseInt(cl);
    }
    if(rid !== this.runId) return;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const at = findMoof(buf);
    if(at > 0){
      this.initSeg[key] = buf.slice(0, at);
      this.sidx[key] = parseSidx(this.initSeg[key]);
    }
  }
  sbAppend(sb, data){
    return new Promise((resolve, reject)=>{
      const doAppend = ()=>{
        const onEnd = ()=>{ cleanup(); resolve(); };
        const onErr = ()=>{ cleanup(); reject(new Error('MSE append 失败')); };
        const cleanup = ()=>{ sb.removeEventListener('updateend', onEnd); sb.removeEventListener('error', onErr); };
        sb.addEventListener('updateend', onEnd);
        sb.addEventListener('error', onErr);
        try{ sb.appendBuffer(data); }catch(e){ cleanup(); reject(e); }
      };
      if(sb.updating){
        const onUpd = ()=>{ sb.removeEventListener('updateend', onUpd); doAppend(); };
        sb.addEventListener('updateend', onUpd);
      }else{
        doAppend();
      }
    });
  }
  onStreamError(e){
    if(!this.cur.course || this.cur.simulate || !this.mode) return;
    if(this._retried){
      // 本轮已自动重试过仍失败：明确告知用户，不再无限转圈
      if(!this._errToasted){
        this._errToasted = true;
        this.showLoading(false);
        this.video.pause();
        toast('视频流中断且自动恢复失败，请稍后点击播放重试或切换清晰度。');
      }
      return;
    }
    this._retried = true;
    console.warn('[deepreel] 流错误，自动刷新一次：', e && e.message);
    this.showLoading(true);
    const c = this.cur.course, idx = this.cur.partIdx;
    setTimeout(()=>{ if(this.cur.course === c && this.cur.partIdx === idx) this.load(c, idx); }, 400);
  }

  /* ---------- 跳转 ---------- */
  seekTo(t){
    const dur = this.cur.duration || this.dur || 0;
    if(dur > 0) t = Math.max(0, Math.min(dur - 0.5, t));
    if(this.mode === 'dash'){
      const b = this.video.buffered;
      for(let i=0;i<b.length;i++){
        if(t >= b.start(i) && t <= b.end(i)){ try{ this.video.currentTime = t; }catch{} return; }
      }
      if(!this.sidx || !this.sidx.video){
        // 无索引的兜底流：从中段字节重启
        this._pendingSeek = t;
        this.showLoading(true);
        return;
      }
      this.restartAt(t);
    }else if(this.mode === 'mp4'){
      for(let i=0;i<this.segs.length;i++){
        if(t < this.segStart[i] + this.segs[i].dur){
          if(i === this.segIdx){ try{ this.video.currentTime = t - this.segBase; }catch{} }
          else this.switchSeg(i, t - this.segStart[i]);
          return;
        }
      }
    }
  }
  maybePendingSeek(){
    const t = this._pendingSeek;
    if(t == null || this.mode !== 'dash') return;
    const b = this.video.buffered;
    for(let i=0;i<b.length;i++){
      if(t >= b.start(i) - 0.5 && t <= b.end(i)){
        try{ this.video.currentTime = t; }catch{}
        this._pendingSeek = null;
        return;
      }
    }
  }

  /* ---------- 进度/状态 ---------- */
  onTimeUpdate(){
    if(this.mode === 'dash' && !this.video.seeking) this.schedule();
    // 进度条/时间必须跟随视频本体，不能受学习统计开关(running)影响：
    // running=false 时视频仍可能正常播放（卸载中/异常路径），此时进度条照常走，仅跳过持久化。
    if(!this.cur || !this.cur.course) return;
    const t = this.video.currentTime + (this.mode === 'mp4' ? this.segBase : 0);
    this.setTime(t, false, this.running);
  }
  onEnded(){
    if(!this.running) return;
    if(this.mode === 'mp4' && this.segIdx < this.segs.length - 1){
      this.switchSeg(this.segIdx + 1, 0);
      return;
    }
    this.markDone();
  }
  updateBuffered(){
    this.maybePendingSeek();
    const b = qs('#pc-buffered'); if(!b) return;
    const buf = this.video.buffered;
    const dur = this.video.duration || this.dur || this.cur.duration;
    if(dur > 0 && buf.length > 0) b.style.width = (buf.end(buf.length-1)/dur*100)+'%';
  }
  fillQualityOptions(data){
    const sel = qs('#sel-quality'); if(!sel) return;
    let ids = [];
    if(data.dash && data.dash.video) ids = [...new Set(data.dash.video.map(v=>v.id))].sort((a,b)=>b-a);
    else if(data.accept_quality) ids = data.accept_quality.slice().sort((a,b)=>b-a);
    if(!ids.length) return;
    const cur = sel.value;
    sel.innerHTML = '';
    for(const id of ids){
      const o = document.createElement('option');
      o.value = String(id);
      o.textContent = QN_LABEL[id] || (id + 'P');
      sel.appendChild(o);
    }
    sel.value = ids.includes(parseInt(cur)) ? cur : String(ids[0]);
  }
  // —— 模拟模式（示例课程）——
  simStep(){
    if(!this.running || !this.cur.simulate) return;
    this.cur.time = Math.min(this.cur.duration, this.cur.time + 20);
    this.setTime(this.cur.time, true);
    if(this.cur.time >= this.cur.duration){ this.markDone(); return; }
    this.timer = setTimeout(()=>this.simStep(), 1000);
  }
  setTime(t, isSim, doPersist){
    const p = this.cur.course && this.cur.course.parts[this.cur.partIdx]; if(!p) return;
    const before = p.progress||0;
    const ratio = this.cur.duration>0 ? t/this.cur.duration : 0;
    this.cur.time = t;
    p.lastTime = t;
    p.progress = Math.max(before, ratio);
    // 示例课程按进度折算记录（真实视频由 trackTick 按实际播放计时）
    if(isSim){
      const delta = Math.max(0, p.progress - before) * (this.cur.duration||0);
      if(delta>0) recordActivity(delta, 0, this.cur.course.bvid);
    }
    this.updateBar();
    if(doPersist !== false) persist();
    if(ratio>=0.999 && !p.done){ this.markDone(); }
  }
  markDone(){
    const p = this.cur.course && this.cur.course.parts[this.cur.partIdx]; if(!p) return;
    p.done = true; p.progress = 1;
    if(!p.completedAt) p.completedAt = Date.now();
    this.cur.done = true;
    // 当日学完 P 数
    const k = todayKey();
    const day = state.activity[k] || (state.activity[k] = { w:0, p:0, c:0, co:{} });
    day.c = (day.c||0) + 1;
    saveCourses(); saveActivity();
    if(document.body.dataset.view==='watch'){ updateOverall(); renderTOCKeep(); renderPartChart(); }
    this.updateBar();
    toast(`P${p.page} 已学完 · 完成度 ${Math.round(courseProgress(this.cur.course)*100)}%`);
  }
  updateBar(){
    const c = this.cur.duration||0;
    const t = this.cur.time||0;
    const ratio = c>0 ? Math.min(1, t/c) : (this.cur.done?1:0);
    qs('#pp-fill').style.width = (ratio*100)+'%';
    const th = qs('#pp-thumb'); if(th) th.style.left = (ratio*100)+'%';
    qs('#pp-time').textContent = `${fmtTime(t)} / ${fmtTime(c)}`;
  }
  play(){ this.video.play(); }
  pause(){ this.video.pause(); }
  togglePlay(){ if(this.video.paused) this.play(); else this.pause(); }
  seek(sec){ this.seekTo(sec); }
  setSpeed(s){ this.video.playbackRate = s; }
  next(){ const c=this.cur.course; if(c && this.cur.partIdx < c.parts.length-1) loadPart(this.cur.partIdx+1); }
  prev(){ if(this.cur.partIdx>0) loadPart(this.cur.partIdx-1); }
  stop(){ this.running=false; if(this.timer){ clearInterval(this.timer); clearTimeout(this.timer); this.timer=null; } if(this.trimTimer){ clearInterval(this.trimTimer); this.trimTimer=null; } if(this.stallTimer){ clearInterval(this.stallTimer); this.stallTimer=null; } if(this.trackTimer){ clearInterval(this.trackTimer); this.trackTimer=null; } this.pause(); }
  startPolling(){
    this.stop();
    this.running = true;
    if(this.cur.simulate){ this.simStep(); return; }
    this.timer = setInterval(()=>{ this.flushActivity(); persist(); }, 3000);
    this.trimTimer = setInterval(()=> this.trimBehind(), 30000);
    this._lastT = -1; this._stallCount = 0;
    this.stallTimer = setInterval(()=> this.checkStall(), 10000);
    this.trackTimer = setInterval(()=> this.trackTick(), 1000);
  }
  /* 每秒计时：播放中计「观看」，暂停后计「思考」（单次封顶 THINK_CAP，防挂机） */
  trackTick(){
    if(!this.running || !this.cur.course || this.cur.simulate) return;
    const v = this.video;
    const p = this.cur.course.parts[this.cur.partIdx];
    if(!p) return;
    if(!v.paused && !v.ended && this._started){
      this._watchAcc++;
      p.watch = (p.watch||0) + 1;
    }else if(v.paused && this._pauseAt != null){
      if(Date.now() - this._pauseAt < THINK_CAP){
        this._thinkAcc++;
        p.think = (p.think||0) + 1;
      }
      // 超过封顶就不再累计，也不重置（恢复播放时 _pauseAt 自然清空）
    }
    this.renderWatchStats();
  }
  /* 刷写累计的观看/思考秒数到当日活动（供 persist 周期调用与卸载前调用） */
  flushActivity(){
    const w = this._watchAcc, th = this._thinkAcc;
    if(w > 0 || th > 0){
      recordActivity(w, th, this.cur.course ? this.cur.course.bvid : null);
      this._watchAcc = 0; this._thinkAcc = 0;
    }
  }
  /* 播放页实时小字：本 P 已看/思考 */
  renderWatchStats(){
    const el = qs('#watch-stats'); if(!el) return;
    const p = this.cur.course && this.cur.course.parts[this.cur.partIdx];
    const k = todayKey(); const day = actDay(k);
    const w = p ? (p.watch||0) : 0, th = p ? (p.think||0) : 0;
    el.innerHTML =
      `<span class="ws-chip"><b>${fmtDur(w)}</b>本P已看</span>` +
      (th>0 ? `<span class="ws-chip think"><b>${fmtDur(th)}</b>本P思考</span>` : '') +
      `<span class="ws-chip"><b>${fmtDur(day.w)}</b>今日观看</span>` +
      (day.p>0 ? `<span class="ws-chip think"><b>${fmtDur(day.p)}</b>今日思考</span>` : '');
  }
  /* 停滞看门狗：播放态但播放头长时间不动且前方无缓冲 → 流断（地址过期 / CDN 挂死），走自动恢复。
     分片调度器仍在下载时（pending）放宽到 60 秒，避免慢网误杀。 */
  checkStall(){
    if(!this.running || this.cur.simulate || !this.mode) return;
    const v = this.video;
    if(v.paused || v.ended){ this._stallCount = 0; this._lastT = v.currentTime; return; }
    if(Math.abs(v.currentTime - this._lastT) < 0.01){
      const b = v.buffered, ct = v.currentTime;
      let ahead = false;
      for(let i=0;i<b.length;i++){ if(ct >= b.start(i)-0.1 && ct < b.end(i)-0.3) ahead = true; }
      if(!ahead){
        const inFlight = this.sched && !!(this.sched.video.pending || (this.sched.audio && this.sched.audio.pending));
        this._stallCount++;
        if(this._stallCount >= (inFlight ? 6 : 3)){
          this._stallCount = 0;
          this.onStreamError(new Error('播放停滞（流地址可能已过期）'));
        }
      }
    }else{
      this._stallCount = 0;
    }
    this._lastT = v.currentTime;
  }
  trimBehind(){
    if(this.mode !== 'dash') return;
    const ct = this.video.currentTime;
    for(const sb of [this.vsb, this.asb]){
      if(!sb) continue;
      try{
        if(sb.updating) continue;
        const b = sb.buffered;
        for(let i=0;i<b.length;i++){
          if(b.end(i) < ct - 120){ sb.remove(b.start(i), b.end(i)); break; }
        }
      }catch{}
    }
  }
  unload(){ this.stop(); this.flushActivity(); saveCourses(); saveActivity(); saveHours(); this.teardown(); }
}
let player;
let prevView = 'library';

function throttle(fn, ms){ let t=null,last=0; return (...a)=>{ const n=Date.now(); if(n-last>ms){ last=n; fn(...a);} else { clearTimeout(t); t=setTimeout(()=>{ last=Date.now(); fn(...a); }, ms-(n-last)); } }; };
const persist = throttle(()=>{
  saveCourses(); saveActivity(); saveHours();
  if(document.body.dataset.view==='watch' && activeCourse()){ updateOverall(); renderTOCKeep(); renderPartChart(); }
}, 1200);
// TOC 局部刷新（不破坏滚动）
function renderTOCKeep(){
  const c=activeCourse(); if(!c) return;
  c.parts.forEach((p,i)=>{
    const el = qs(`.toc-item[data-i="${i}"]`); if(!el) return;
    el.classList.toggle('is-done', !!p.done);
    el.classList.toggle('is-current', i===state.activePart);
    const mini = el.querySelector('.toc-mini i'); if(mini) mini.style.width = Math.round((p.progress||0)*100)+'%';
  });
}

function loadPart(idx){
  const c = activeCourse(); if(!c) return;
  if(idx<0||idx>=c.parts.length) return;
  state.activePart = idx;
  c.lastPart = idx;
  saveCourses();
  renderTOCKeep();
  // 高亮当前
  qsa('.toc-item').forEach(el=>el.classList.toggle('is-current', +el.dataset.i===idx));
  const p = c.parts[idx];
  qs('#pb-no').textContent = 'P'+p.page;
  qs('#pb-title').textContent = p.part;
  const sumBox = qs('#summary-content');
  if(summaryThinking && summaryStreamCtx && summaryStreamCtx.bvid === c.bvid && summaryStreamCtx.partIndex === idx){
    sumBox.innerHTML = `<div class="summary-loading"><span class="sk-loader"></span> 正在生成本 P 摘要…</div>
      <div class="sum-block">
        <div class="sum-label">AI 实时输出</div>
        <p class="sum-text" id="summary-live-text">${escapeHtml(summaryStreamCtx.text || '等待模型响应…')}</p>
      </div>`;
  }else if(p._summary){
    const idxMap = buildKeywordIndex(c);
    const chips = (p._keywords||[]).map(kw=>{
      const dup = idxMap[kw] && idxMap[kw].size>1;
      return `<span class="kw-chip ${dup?'dup':''}">${escapeHtml(kw)}</span>`;
    }).join('');
    sumBox.innerHTML = `
      <div class="sum-block">
        <div class="sum-label">本 P 摘要</div>
        <p class="sum-text">${escapeHtml(p._summary)}</p>
      </div>
      <div class="sum-block">
        <div class="sum-label">知识点 · 跨分 P 去重</div>
        <div class="kw-chips">${chips || '<span class="summary-empty">无</span>'}</div>
      </div>`;
  }else{
    sumBox.innerHTML = `<div class="summary-empty">点击「生成本 P 摘要」，AI 将基于字幕提炼知识点，并与其它分 P 去重。</div>`;
  }
  if(player){ player._started = false; player._pauseAt = null; player.renderWatchStats(); }
  player.load(c, idx);
  renderPartChart();
  // 若助手抽屉开着，刷新当前分 P 的笔记与上下文
  if(qs('#assistant-drawer').classList.contains('open')){ loadNote(); updateAssistantContext(); }
}

/* ============ AI 摘要（提取式 + 可选 LLM + 去重） ============ */
function tokenize(text){
  // CJK 2-gram + 英文词
  const grams = [];
  const clean = (text||'').replace(/\s+/g,' ');
  for(let i=0;i<clean.length-1;i++){
    const a=clean[i], b=clean[i+1];
    if(/[\u4e00-\u9fa5]/.test(a) && /[\u4e00-\u9fa5]/.test(b)){ const g=a+b; if(!STOP.has(a)&&!STOP.has(b)) grams.push(g); }
  }
  const words = (clean.match(/[A-Za-z]{3,}/g)||[]).map(w=>w.toLowerCase());
  return [...grams, ...words];
}
function extractiveSummary(text, maxSents=3){
  const sents = (text||'').split(/(?<=[。！？!?；;])\s*|\n+/).map(s=>s.trim()).filter(s=>s.length>6);
  if(!sents.length) return { summary:text.slice(0,120), keywords:tokenize(text).slice(0,8).map(g=>g) };
  const freq = {};
  tokenize(text).forEach(t=> freq[t]=(freq[t]||0)+1);
  const scored = sents.map(s=>{
    const toks = tokenize(s);
    let sc = toks.reduce((a,t)=>a+(freq[t]||0),0);
    return { s, sc: sc/Math.max(1,toks.length) };
  }).sort((x,y)=>y.sc-x.sc);
  const top = scored.slice(0,maxSents).map(o=>o.s).sort((a,b)=> (text.indexOf(a))-(text.indexOf(b)));
  const kw = Object.keys(freq).sort((a,b)=>freq[b]-freq[a]).slice(0,10);
  return { summary: top.join(''), keywords: kw };
}

async function getPartText(c, p){
  if(c.isSample) return p.text || p.part;
  if(p.cid){
    const sub = await fetchSubtitle(c.bvid, p.cid);
    if(sub && sub.body){
      if(!p._subRaw) p._subRaw = sub;
      return sub.body.map(b=>b.content).join(' ');
    }
  }
  return ''; // 无字幕：由调用方如实告知 AI，避免 AI 臆测视频内容
}
/* 提取「当前播放位置」附近的字幕片段（前后各 90 秒，取最近 12 条） */
function subtitleAround(p, t){
  if(!p._subRaw || !Array.isArray(p._subRaw.body)) return '';
  const seg = p._subRaw.body.filter(b=> b.from <= t + 90 && (b.to||b.from + 8) >= t - 90);
  return seg.slice(-12).map(b=>b.content).join(' ');
}

function buildKeywordIndex(c){
  // 课程内各 P 的关键词 → 出现在哪些 P
  const map = {}; // kw -> Set(pageNo)
  c.parts.forEach((p,i)=>{
    (p._keywords||[]).forEach(kw=>{ (map[kw]=map[kw]||new Set()).add(p.page); });
  });
  return map;
}

let summaryThinking = false;
let summaryStreamCtx = null;

function isCurrentSummaryTarget(courseId, partIndex){
  const c = activeCourse();
  return !!(c && c.bvid === courseId && state.activePart === partIndex);
}

async function summarizeCurrent(){
  const c = activeCourse(); if(!c) return;
  const p = c.parts[state.activePart]; if(!p) return;
  if(summaryThinking) return;
  const box = qs('#summary-content');
  const btn = qs('#btn-summarize');
  const courseId = c.bvid;
  const partIndex = state.activePart;
  summaryThinking = true;
  summaryStreamCtx = { bvid: courseId, partIndex, text:'' };
  if(btn) btn.disabled = true;
  box.innerHTML = `<div class="summary-loading"><span class="sk-loader"></span> 正在${c.isSample?'生成':'抓取字幕并'}摘要…</div>
    <div class="sum-block">
      <div class="sum-label">AI 实时输出</div>
      <p class="sum-text" id="summary-live-text">等待模型响应…</p>
    </div>`;
  try{
    const text = await getPartText(c, p);
    let summaryText, keywords;
    const s = state.settings;
    if(s.endpoint && s.key){
      const llm = await llmSummarize(text, s, chunk => {
        if(!summaryStreamCtx || summaryStreamCtx.bvid !== courseId || summaryStreamCtx.partIndex !== partIndex) return;
        summaryStreamCtx.text += chunk;
        if(isCurrentSummaryTarget(courseId, partIndex)){
          const live = qs('#summary-live-text');
          if(live) live.textContent = summaryStreamCtx.text || '…';
        }
      }).catch(()=>null);
      if(llm){ summaryText = llm; keywords = extractiveSummary(text,3).keywords; }
      else { const r = extractiveSummary(text); summaryText=r.summary; keywords=r.keywords; toast('LLM 调用失败，已用本地摘要兜底'); }
    } else {
      const r = extractiveSummary(text); summaryText=r.summary; keywords=r.keywords;
    }
    p._keywords = keywords;
    p._summary = summaryText;
    const idx = buildKeywordIndex(c);
    const chips = keywords.map(kw=>{
      const dup = idx[kw] && idx[kw].size>1;
      return `<span class="kw-chip ${dup?'dup':''}">${escapeHtml(kw)}</span>`;
    }).join('');
    if(isCurrentSummaryTarget(courseId, partIndex)){
      box.innerHTML = `
        <div class="sum-block">
          <div class="sum-label">本 P 摘要</div>
          <p class="sum-text">${escapeHtml(summaryText)}</p>
        </div>
        <div class="sum-block">
          <div class="sum-label">知识点 · 跨分 P 去重</div>
          <div class="kw-chips">${chips || '<span class="summary-empty">无</span>'}</div>
        </div>`;
    }
    saveCourses();
  }catch(err){
    if(isCurrentSummaryTarget(courseId, partIndex)){
      box.innerHTML = `<div class="summary-empty">摘要失败：${escapeHtml(err.message||'未知错误')}</div>`;
    }
  }finally{
    summaryThinking = false;
    summaryStreamCtx = null;
    if(btn) btn.disabled = false;
  }
}

async function llmSummarize(text, s, onDelta){
  return await requestLLM(s, [
    { role:'system', content:'你是学习助理。用简洁中文提炼视频字幕的知识点，输出 2-3 句摘要，不要寒暄。' },
    { role:'user', content:`请摘要以下字幕内容：\n${text.slice(0,6000)}` }
  ], { temperature:0.3, stream:true, onDelta });
}

/* ============ AI 学习助手 + 笔记 ============ */
let assistantThinking = false;
let assistantStreamCtx = null;
let noteSaveTimer = null;
let asstCtxTimer = null;
let asstImgData = null;   // 待发送的截图 dataURL（vision）

/* 截图上传：压缩为 ≤1280px 的 JPEG dataURL */
function fileToDataURL(file, maxW=1280){
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{
      try{
        const scale = Math.min(1, maxW / (img.width||1));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width*scale));
        cv.height = Math.max(1, Math.round(img.height*scale));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      }catch(e){ URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}
function setAsstImg(dataUrl){
  asstImgData = dataUrl;
  const chip = qs('#asst-img-chip');
  if(chip){
    chip.hidden = !dataUrl;
    chip.querySelector('.asst-img-thumb').style.backgroundImage = dataUrl ? `url('${dataUrl}')` : '';
    chip.querySelector('.asst-img-name').textContent = dataUrl ? '已附加截图，随下一条消息发送' : '';
  }
}
function clearAsstImg(){ setAsstImg(null); }

async function llmChat(messages, onDelta, sOverride){
  const s = sOverride ? Object.assign({}, state.settings, sOverride) : state.settings;
  return await requestLLM(s, messages, { temperature:0.4, stream:true, onDelta });
}

async function buildAssistantMessages(userText, c = activeCourse(), p = c && c.parts[state.activePart], imgData = null){
  if(!c || !p) throw new Error('NO_COURSE');
  let ctx;
  if(p._summary){ ctx = `本 P 摘要：${p._summary}`; }
  else {
    if(p._subText === undefined) p._subText = await getPartText(c, p).catch(()=> '');
    ctx = p._subText
      ? `本 P 字幕摘录：${p._subText.slice(0, 3000)}`
      : '未能获取本 P 字幕（可能原因：未登录 B 站、该视频无可用字幕，或网络异常）。请如实告知学生字幕缺失，基于标题与已有信息谨慎回答，不要臆测视频实际内容。';
  }
  const note = p.note ? `\n学生本 P 笔记：${p.note}` : '';
  /* 位置感知：当前播放时间 + 该时刻附近字幕 + 课程进度 */
  const t = (player && player.cur) ? (player.cur.time||0) : 0;
  const ref = t > 0 ? t : (p.lastTime||0);
  let posCtx;
  if(ref > 0){
    const around = subtitleAround(p, ref);
    posCtx = `\n学生当前位于本 P 的 ${fmtTime(Math.floor(ref))}（本 P 总长 ${fmtDur(p.duration||0)}）${t>0?'':'（当前暂停/未播放，位置为上次停留处）'}`;
    if(around) posCtx += `。此刻附近的内容：${around}`;
  }else{
    posCtx = `\n学生尚未开始播放本 P（本 P 总长 ${fmtDur(p.duration||0)}）。`;
  }
  const doneN = c.parts.filter(x=>x.done).length;
  const progCtx = `\n课程进度：已完成 ${doneN}/${c.parts.length} 个分 P。`;
  const sys = `你是 DEEPREEL 学习助手。学生正在 B 站学习《${c.title}》的第 ${p.page} P《${p.part}》。请基于以下该分 P 的内容回答疑问、校验学生的想法并明确指出哪里想错了；简洁、直接、点到为止，不要寒暄。\n\n${ctx}${posCtx}${progCtx}${note}`;
  const history = (c.chat||[]).slice(-8);
  const userMsg = imgData
    ? { role:'user', content:[ { type:'text', text:userText }, { type:'image_url', image_url:{ url: imgData } } ] }
    : { role:'user', content:userText };
  return [{role:'system', content:sys}, ...history, userMsg];
}

function updateAssistantContext(){
  const c = activeCourse();
  const el = qs('#asst-context');
  if(!c || !c.parts[state.activePart]){ el.innerHTML = '未打开课程'; return; }
  const p = c.parts[state.activePart];
  const ai = (state.settings.endpoint && state.settings.key) ? '<b>AI 已就绪</b>' : '<b style="color:var(--danger)">未配置 AI</b>';
  const t = (player && player.cur && player.cur.time) ? ` · 看到 ${fmtTime(Math.floor(player.cur.time))}` : '';
  el.innerHTML = `${ai} · 课程《${escapeHtml(c.title)}》 · 当前 P${p.page} ${escapeHtml(p.part)}${t}${p.note?' · 有笔记':''}`;
}

function renderAssistant(){
  const c = activeCourse();
  const box = qs('#asst-messages');
  if(!c){ box.innerHTML = '<div class="asst-empty">先在课程库打开一个视频，<br/>再向我提问或记笔记。</div>'; return; }
  const msgs = c.chat || [];
  const qk = qs('#asst-quick');
  if(qk) qk.hidden = !!(msgs && msgs.length);   // 有对话后收起快捷提问
  const msgHtml = m => {
    if(typeof m.content === 'string') return escapeHtml(m.content);
    if(Array.isArray(m.content)){
      return m.content.map(x=>{
        if(x.type==='text') return escapeHtml(x.text);
        if(x.type==='image_url' && x.image_url && x.image_url.url){
          return `<img class="asst-bubble-img" src="${x.image_url.url}" alt="截图" loading="lazy">`;
        }
        return '';
      }).join('');
    }
    return escapeHtml(String(m.content||''));
  };
  const html = msgs.map(m => `<div class="asst-bubble ${m.role}">${msgHtml(m)}</div>`).join('');
  const liveCtx = assistantThinking && assistantStreamCtx && c.bvid === assistantStreamCtx.bvid && state.activePart === assistantStreamCtx.partIndex
    ? assistantStreamCtx
    : null;
  const streaming = liveCtx && liveCtx.reply
    ? `<div class="asst-bubble assistant streaming">${escapeHtml(liveCtx.reply)}</div>`
    : '';
  const typing = liveCtx && !liveCtx.reply ? '<div class="asst-bubble assistant typing"><span class="sk-loader"></span> 思考中…</div>' : '';
  box.innerHTML = (html || '<div class="asst-empty">问我任何关于本 P 的问题，<br/>或写下你的想法让我校验对错。</div>') + streaming + typing;
  box.scrollTop = box.scrollHeight;
}

async function sendAssistant(){
  const input = qs('#asst-input');
  const sendBtn = qs('#btn-asst-send');
  const text = input.value.trim();
  const img = asstImgData;
  if(!text && !img) return;
  if(assistantThinking) return;
  const c = activeCourse();
  if(!c){ toast('请先打开一个课程'); return; }
  if(!state.settings.endpoint || !state.settings.key){ toast('请先在设置里配置 DeepSeek Key / 代理'); openSettings(); return; }
  const partIndex = state.activePart;
  const p = c.parts[partIndex];
  c.chat = c.chat || [];
  c.chat.push({ role:'user', content: img ? [ {type:'text', text}, {type:'image_url', image_url:{url: img}} ] : text });
  input.value = ''; input.disabled = true;
  if(sendBtn) sendBtn.disabled = true;
  assistantThinking = true;
  assistantStreamCtx = { bvid:c.bvid, partIndex, reply:'' };
  renderAssistant();
  try{
    const messages = await buildAssistantMessages(text, c, p, img);
    const vision = img && !/vision/i.test(state.settings.model||'') ? { model:'deepseek-v4-flash-vision-exp' } : null;
    if(vision && qs('#asst-img-chip')) qs('#asst-img-chip').textContent = '（已用视觉模型）';
    const reply = await llmChat(messages, chunk => {
      if(!assistantStreamCtx || assistantStreamCtx.bvid !== c.bvid || assistantStreamCtx.partIndex !== partIndex) return;
      assistantStreamCtx.reply += chunk;
      renderAssistant();
    }, vision);
    c.chat.push({ role:'assistant', content: reply || '(空回复)' });
  }catch(e){
    const msg = e.message === 'NO_KEY' ? '未配置 DeepSeek Key / 代理地址，请到设置填写。' : ('调用失败：'+(e.message||'未知错误')+'。若提示 CORS/网络，请先在 deepreel 目录执行 node proxy.js 启动代理，并把接口地址设为 http://localhost:7392/chat/completions。');
    const partial = assistantStreamCtx && assistantStreamCtx.bvid === c.bvid && assistantStreamCtx.partIndex === partIndex
      ? assistantStreamCtx.reply
      : '';
    c.chat.push({ role:'assistant', content: partial ? `${partial}\n\n（流式输出中断）` : msg });
  }
  assistantThinking = false;
  assistantStreamCtx = null;
  input.disabled = false;
  if(sendBtn) sendBtn.disabled = false;
  clearAsstImg();
  saveCourses();
  renderAssistant();
  input.focus();
}

function loadNote(){
  const c = activeCourse();
  const ta = qs('#note-area');
  if(!c || !c.parts[state.activePart]){ ta.value=''; ta.disabled=true; return; }
  ta.disabled = false;
  ta.value = c.parts[state.activePart].note || '';
}
function saveNote(){
  const c = activeCourse(); if(!c) return; const p = c.parts[state.activePart]; if(!p) return;
  p.note = qs('#note-area').value;
  saveCourses();
  updateAssistantContext();
}
function openAssistant(){
  const drawer = qs('#assistant-drawer');
  /* 应用保存的抽屉宽度（全屏模式由 CSS 控制） */
  if(!document.body.classList.contains('asst-focus')){
    const w = state.settings.drawerWidth;
    if(w) drawer.style.width = w;
  }
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false');
  renderAssistant(); loadNote(); updateAssistantContext();
  if(asstCtxTimer) clearInterval(asstCtxTimer);
  asstCtxTimer = setInterval(()=>{ if(!drawer.classList.contains('open')) return; updateAssistantContext(); }, 2000);
  setTimeout(()=>{ const i=qs('#asst-input'); if(i) i.focus(); }, 320);
}
function closeAssistant(){
  const drawer = qs('#assistant-drawer');
  drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true');
  if(document.body.classList.contains('asst-focus')) toggleAsstFocus(false);
  if(asstCtxTimer){ clearInterval(asstCtxTimer); asstCtxTimer = null; }
}
/* 全屏对话模式：视频缩到左侧小窗继续播放 */
function toggleAsstFocus(force){
  const d = qs('#assistant-drawer');
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('asst-focus');
  document.body.classList.toggle('asst-focus', on);
  if(on) d.style.width = '';
  else { const w = state.settings.drawerWidth; d.style.width = w || ''; }
  const btn = qs('#btn-asst-focus');
  if(btn) btn.classList.toggle('is-on', on);
  const label = qs('#btn-asst-focus-label');
  if(label) label.textContent = on ? '复原' : '全屏';
}
/* 抽屉左边缘拖拽调宽（380-760px），宽度存入设置 */
function initDrawerResize(){
  const handle = qs('#asst-resize');
  const drawer = qs('#assistant-drawer');
  if(!handle || !drawer) return;
  handle.addEventListener('pointerdown', e=>{
    e.preventDefault();
    if(document.body.classList.contains('asst-focus')) return;
    const startX = e.clientX, startW = drawer.offsetWidth;
    const move = ev=>{
      const w = Math.max(380, Math.min(760, startW - (ev.clientX - startX)));
      drawer.style.width = w + 'px';
    };
    const up = ()=>{
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      state.settings.drawerWidth = drawer.style.width;
      saveSettings();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
function toggleAssistant(){
  if(qs('#assistant-drawer').classList.contains('open')) closeAssistant();
  else openAssistant();
}
function switchAsstTab(tab){
  qs('#asst-tab-chat').classList.toggle('is-active', tab==='chat');
  qs('#asst-tab-notes').classList.toggle('is-active', tab==='notes');
  qs('#asst-chat').hidden = tab!=='chat';
  qs('#asst-notes').hidden = tab!=='notes';
  if(tab==='notes'){ const n=qs('#note-area'); if(n) n.focus(); }
}

/* ============ 导入 ============ */
async function doImport(raw){
  const errEl = qs('#import-error');
  errEl.textContent = '';
  const bvid = parseBvid(raw);
  if(!bvid){ errEl.textContent = '无法识别 BV 号或链接，请检查后重试。'; return; }
  if(state.courses.some(c=>c.bvid===bvid)){ errEl.textContent='该课程已在库中。'; openCourse(bvid); return; }

  const btn = qs('#btn-import'); const old = btn.textContent; btn.textContent='导入中…'; btn.disabled=true;
  errEl.classList.add('hint');
  errEl.textContent = '正在获取视频信息…（本地代理未启动时会走公共代理，可能稍慢）';
  try{
    const info = await fetchVideoInfo(bvid);
    errEl.classList.remove('hint');
    if(!info || !info.parts.length){ errEl.textContent='获取失败：可能是接口/代理受限，或视频无分 P。稍后再试，或先「载入示例」。'; return; }
    errEl.textContent = '';
    info.addedAt = Date.now();
    state.courses.push(info);
    saveCourses();
    renderLibrary();
    toast('新书入架，开卷有益，已进入专注模式');
    openCourse(bvid);
  }catch(e){
    errEl.classList.remove('hint');
    errEl.textContent = '导入异常：'+(e.message||'')+'。可先「载入示例」体验。';
  }finally{
    btn.textContent=old; btn.disabled=false;
  }
}

function loadSample(){
  if(state.courses.some(c=>c.isSample)){ openCourse(SAMPLE_COURSE.bvid); return; }
  const c = JSON.parse(JSON.stringify(SAMPLE_COURSE));
  c.parts.forEach(p=>{ p.progress=0; p.done=false; p.lastTime=0; });
  c.addedAt = Date.now();
  state.courses.push(c);
  saveCourses();
  localStorage.setItem(LS_SAMPLE,'1');
  renderLibrary();
  openCourse(c.bvid);
}

/* ============ 设置视图 ============ */
/* 主题化自定义下拉：把原生 select 隐藏，替换为纸面风格的触发器 + 弹出列表 */
function initCSelect(sel){
  if(!sel || sel.dataset.cselect) return;
  sel.dataset.cselect = '1';

  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cselect-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const valueEl = document.createElement('span');
  valueEl.className = 'cselect-value';
  const caret = document.createElement('span');
  caret.className = 'cselect-caret';
  trigger.appendChild(valueEl);
  trigger.appendChild(caret);

  const menu = document.createElement('div');
  menu.className = 'cselect-menu';
  menu.setAttribute('role', 'listbox');

  wrap.appendChild(trigger);
  wrap.appendChild(menu);

  let opts = [];

  function build(){
    opts = [];
    menu.innerHTML = '';
    Array.from(sel.options).forEach(o=>{
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cselect-option';
      b.setAttribute('role', 'option');
      b.dataset.value = o.value;
      const label = document.createElement('span');
      label.textContent = o.textContent;
      b.appendChild(label);
      const tag = o.getAttribute('data-tag');
      if(tag){
        const t = document.createElement('span');
        t.className = 'co-tag';
        t.textContent = tag;
        b.appendChild(t);
      }
      b.addEventListener('click', ()=>{
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles:true }));
        sync();
        close();
      });
      menu.appendChild(b);
      opts.push(b);
    });
    sync();
  }

  function sync(){
    const cur = sel.value;
    valueEl.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : cur;
    opts.forEach(b => b.classList.toggle('is-selected', b.dataset.value === cur));
  }

  function open(){
    wrap.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
  }
  function close(){
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', ()=>{ wrap.classList.contains('is-open') ? close() : open(); });
  wrap.addEventListener('keydown', e=>{
    if(e.key === 'Escape'){ close(); trigger.focus(); }
  });
  document.addEventListener('click', e=>{ if(!wrap.contains(e.target)) close(); });
  document.addEventListener('focusin', e=>{ if(!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', e=>{
    if(e.key !== 'Escape') return;
    if(!wrap.contains(document.activeElement) && wrap.classList.contains('is-open')){ close(); }
  });

  build();
  return { sync };
}

function syncCSelect(sel){
  if(sel && sel.dataset && sel.dataset.cselect){
    const wrap = sel.parentNode;
    const valueEl = wrap.querySelector('.cselect-value');
    const cur = sel.value;
    if(valueEl){
      const o = sel.options[sel.selectedIndex];
      valueEl.textContent = o ? o.textContent : cur;
    }
    wrap.querySelectorAll('.cselect-option').forEach(b=>{
      b.classList.toggle('is-selected', b.dataset.value === cur);
    });
  }
}

function openSettings(){
  prevView = document.body.dataset.view;
  const s = state.settings;
  /* 接口地址不再暴露给用户，内部自动指向本地代理 */
  if(!s.endpoint) s.endpoint = `${proxyBase()}/chat/completions`;
  qs('#llm-key').value = s.key || '';
  qs('#llm-model').value = s.model || 'deepseek-v4-flash';
  const bq = qs('#bili-quality'); if(bq) bq.value = s.biliQuality || '80';
  syncCSelect(qs('#llm-model'));
  syncCSelect(bq);
  /* WebDAV 同步字段 */
  const wd = qs('#wd-url'); if(wd) wd.value = s.webdavUrl || 'https://dav.jianguoyun.com/dav/';
  const wu = qs('#wd-user'); if(wu) wu.value = s.webdavUser || '';
  const wp = qs('#wd-pass'); if(wp) wp.value = s.webdavPass || '';
  const wk = qs('#wd-key'); if(wk) wk.value = s.webdavKey || '';
  updateBiliLoginUI();
  showView('settings');
}
function backFromSettings(){
  const v = prevView || 'library';
  showView(v);
  if(v==='library') renderLibrary();
}
function saveSettingsForm(){
  if(!state.settings.endpoint) state.settings.endpoint = `${proxyBase()}/chat/completions`;
  state.settings.key = qs('#llm-key').value.trim();
  state.settings.model = qs('#llm-model').value.trim();
  saveSettings();
  updateAIStatus();
  toast(state.settings.key ? 'AI 设置已保存' : '已切回本地摘要模式');
}

/* ============ B 站扫码登录 ============ */
let qrPollTimer = null;

async function startBiliLogin(){
  const modal = qs('#qr-modal');
  const img = qs('#qr-img');
  const status = qs('#qr-status');
  const expired = qs('#qr-expired');
  const loading = qs('#qr-loading');
  if(expired) expired.hidden = true;
  if(status) status.textContent = '正在生成二维码…';
  modal.hidden = false;

  /* 重置旧二维码并进入生成态，避免残留上一张图 */
  img.classList.remove('is-loaded');
  img.removeAttribute('src');
  if(loading){ loading.hidden = false; loading.classList.remove('is-done'); }

  try{
    const base = proxyBase();
    const r = await fetch(`${base}/bili/qrcode/generate`);
    const j = await r.json();
    if(j.code !== 0 || !j.data) throw new Error(j.message || 'API error');

    /* 等二维码图片从 CDN 完整加载再淡入 */
    await new Promise((resolve, reject)=>{
      const clean = ()=>{
        img.removeEventListener('load', ok);
        img.removeEventListener('error', bad);
      };
      const ok = ()=>{ clean(); resolve(); };
      const bad = ()=>{ clean(); reject(new Error('二维码图片加载失败')); };
      img.addEventListener('load', ok);
      img.addEventListener('error', bad);
      img.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(j.data.url)}`;
    });
    img.classList.add('is-loaded');
    if(loading) loading.classList.add('is-done');
    if(status) status.textContent = '请使用 B 站手机客户端扫码';
    const key = j.data.qrcode_key;
    qrPollTimer = setInterval(async ()=>{
      try{
        const r2 = await fetch(`${base}/bili/qrcode/poll?key=${encodeURIComponent(key)}`);
        const j2 = await r2.json();
        if(j2.code === 0 && j2.data){
          const code = j2.data.code;
          if(code === 0 && j2._cookie){
            clearInterval(qrPollTimer); qrPollTimer = null;
            state.settings.biliCookie = j2._cookie;
            saveSettings();
            updateBiliLoginUI();
            if(status) status.textContent = '✓ 登录成功';
            setTimeout(()=>{ modal.hidden = true; }, 1200);
            toast('B 站登录成功，高清已解锁');
          } else if(code === 86090){
            if(status) status.textContent = '已扫码，请在手机上确认';
          } else if(code === 86038){
            clearInterval(qrPollTimer); qrPollTimer = null;
            if(status) status.textContent = '二维码已失效';
            if(expired) expired.hidden = false;
          }
        }
      }catch{}
    }, 2000);
  }catch(e){
    if(loading) loading.classList.add('is-done');
    if(status) status.textContent = '生成二维码失败：' + (e.message||'') + '。请确保代理已启动。';
  }
}

function closeQrModal(){
  if(qrPollTimer){ clearInterval(qrPollTimer); qrPollTimer = null; }
  qs('#qr-modal').hidden = true;
}

function biliLogout(){
  state.settings.biliCookie = '';
  saveSettings();
  updateBiliLoginUI();
  toast('已退出 B 站登录');
}

function updateBiliLoginUI(){
  const has = !!state.settings.biliCookie;
  const dot = qs('#bili-dot');
  const text = qs('#bili-status-text');
  const logoutBtn = qs('#btn-bili-logout');
  const qrBtn = qs('#btn-bili-qr');
  if(dot) dot.classList.toggle('on', has);
  if(text) text.textContent = has ? '已登录 · 高清已解锁' : '请扫码登录获取 Cookie';
  if(logoutBtn) logoutBtn.hidden = !has;
  if(qrBtn) qrBtn.textContent = has ? '重新扫码' : '扫码登录';
}
async function testConn(){
  const s = {
    endpoint: state.settings.endpoint || `${proxyBase()}/chat/completions`,
    key: qs('#llm-key').value.trim(),
    model: qs('#llm-model').value.trim() || 'deepseek-v4-flash',
  };
  const out = qs('#conn-result');
  if(!s.key){ out.textContent='请先填入 API Key'; out.className='settings-note err'; return; }
  out.textContent='测试中…'; out.className='settings-note';
  try{
    const r = await fetch(s.endpoint, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${s.key}` },
      body: JSON.stringify({ model:s.model, messages:[{role:'user',content:'回复两个字：连通'}], temperature:0 })
    });
    if(!r.ok){ const t=await r.text().catch(()=> ''); out.textContent='失败 · HTTP '+r.status+(t?(' · '+t.slice(0,90)):''); out.className='settings-note err'; return; }
    const j=await r.json();
    const msg=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content) || '(空)';
    out.textContent='✓ 连接成功 · 模型回复：'+String(msg).slice(0,40);
    out.className='settings-note ok';
  }catch(e){
    out.textContent='连接失败：'+(e&&e.message?e.message:'网络或 CORS 错误')+'（请确认本地代理 7392 已启动）';
    out.className='settings-note err';
  }
}
function reloadPlayer(){
  const c = activeCourse();
  if(!c || !player || !player.cur || !player.cur.bvid){ toast('请先在课程中打开一个视频'); return; }
  player.load(c, state.activePart);
  toast('已重新加载视频流');
}
function updateAIStatus(){
  const on = !!(state.settings.endpoint && state.settings.key);
  qs('#ai-status-dot').classList.toggle('on', on);
  const fd = qs('#asst-fab-dot'); if(fd) fd.classList.toggle('off', !on);
}
function isPlayerFs(){
  const wrap = qs('.player-frame-wrap');
  return !!(document.fullscreenElement || (wrap && wrap.classList.contains('is-fscreen')));
}
function syncFsState(){
  const btn = qs('#btn-fscreen');
  if(btn) btn.textContent = isPlayerFs() ? '退出' : '全屏';
  if(isPlayerFs() && lenis) lenis.stop();
  else if(lenis) lenis.start();
}
async function toggleFakeFullscreen(){
  const wrap = qs('.player-frame-wrap');
  if(!wrap) return;
  if(document.fullscreenElement){
    try{ await document.exitFullscreen(); }catch{}
    return;
  }
  /* 原生 Fullscreen API：不受任何祖先 transform/filter 破坏 fixed 定位的影响 */
  if(wrap.requestFullscreen){
    try{ await wrap.requestFullscreen(); return; }catch(e){ /* 落到伪全屏 */ }
  }
  /* 伪全屏兜底：父级 GSAP 残留的恒等 transform 会让 fixed 以它为基准，
     先清掉再进全屏，否则会渲染成一条长条 */
  const pw = qs('.player-wrap');
  if(pw && pw.style.transform) pw.style.transform = '';
  wrap.classList.toggle('is-fscreen');
  syncFsState();
}

/* ============ 事件绑定 ============ */
function bind(){
  qs('#import-form').addEventListener('submit', e=>{ e.preventDefault(); doImport(qs('#import-input').value); });
  qs('#btn-demo').addEventListener('click', loadSample);

  // 课程库：搜索（防抖）/ 分类 / 分页
  const searchInput = qs('#lib-search-input');
  if(searchInput){
    let st = null;
    searchInput.addEventListener('input', ()=>{
      clearTimeout(st);
      st = setTimeout(()=>{
        state.libFilter.q = searchInput.value;
        state.libFilter.page = 1;
        renderLibrary();
      }, 250);
    });
  }
  const catsBox = qs('#lib-cats');
  if(catsBox) catsBox.addEventListener('click', e=>{
    const chip = e.target.closest('.cat-chip');
    if(chip) switchLibCat(chip.dataset.cat);
  });
  const pagerBox = qs('#lib-pager');
  if(pagerBox) pagerBox.addEventListener('click', e=>{
    const b = e.target.closest('.pg-btn');
    if(!b || b.classList.contains('disabled')) return;
    gotoLibPage(parseInt(b.dataset.p, 10));
  });
  document.addEventListener('keydown', e=>{
    if(e.key === 'Escape' && !qs('#mini-modal').hidden){
      qs('#mini-modal').hidden = true;
      const okBtn = qs('#mm-ok'); okBtn.onclick = null; qs('#mm-cancel').onclick = null; qs('#mini-modal').onclick = null;
    }
  });
  qs('#btn-home').addEventListener('click', ()=>{
    const v = document.body.dataset.view;
    if(v==='settings') backFromSettings();
    else if(v==='watch') backToLibrary();
    else if(v==='stats') showView('library');
  });
  qs('#btn-back').addEventListener('click', backToLibrary);
  qs('#btn-settings').addEventListener('click', openSettings);

  // 学习统计视图
  qs('#btn-stats').addEventListener('click', ()=>{
    if(document.body.dataset.view==='watch') player && player.flushActivity();
    openStats();
  });
  qs('#btn-back-stats').addEventListener('click', ()=>{
    const from = prevStatsFrom || 'library';
    prevStatsFrom = null;
    if(from==='watch' && state.activeCourseId){ showView('watch'); }
    else showView('library');
  });
  const statsBody = qs('#stats-body');
  statsBody.addEventListener('click', e=>{
    const prev = e.target.closest('#cal-prev');
    if(prev){ statsShiftMonth(-1); return; }
    const next = e.target.closest('#cal-next');
    if(next){ statsShiftMonth(1); return; }
    const today = e.target.closest('#cal-today');
    if(today){ statsGoToday(); return; }
    const cell = e.target.closest('.cal-cell');
    if(cell){ statsSelectDay(cell.dataset.k); return; }
    const ddClose = e.target.closest('#dd-close');
    if(ddClose){ state.statsCursor.selKey = null; renderStats(); return; }
    if(e.target.closest('#btn-year-report')){ openYearReport(); return; }
  });
  const yrMask = qs('#year-report');
  yrMask.addEventListener('click', e=>{ if(e.target===yrMask) closeYearReport(); });
  qs('#btn-yr-close').addEventListener('click', closeYearReport);
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape' && !yrMask.hidden) closeYearReport();
  });
  // 离开页面前刷写未落盘的计时
  window.addEventListener('beforeunload', ()=>{
    if(player && document.body.dataset.view==='watch'){ player.flushActivity(); saveCourses(); saveActivity(); saveHours(); }
  });
  qs('#btn-back-settings').addEventListener('click', backFromSettings);
  qs('#btn-save-settings').addEventListener('click', saveSettingsForm);
  qs('#btn-test-conn').addEventListener('click', testConn);
  qs('#btn-bili-qr').addEventListener('click', startBiliLogin);
  qs('#btn-bili-logout').addEventListener('click', biliLogout);
  qs('#bili-quality').addEventListener('change', e=>{
    state.settings.biliQuality = e.target.value;
    saveSettings();
    const label = e.target.selectedOptions[0] ? e.target.selectedOptions[0].textContent : '';
    toast(`默认清晰度已存为 ${label}`);
  });
  qs('#btn-qr-close').addEventListener('click', closeQrModal);
  qs('#btn-qr-renew').addEventListener('click', ()=>{ closeQrModal(); startBiliLogin(); });
  qs('#btn-bili-refresh').addEventListener('click', reloadPlayer);
  qs('#btn-fscreen').addEventListener('click', toggleFakeFullscreen);
  document.addEventListener('fullscreenchange', ()=>syncFsState());

  // 视频播放控制
  qs('#btn-play').addEventListener('click', ()=>player && player.togglePlay());
  qs('#btn-prev').addEventListener('click', ()=>player && player.prev());
  qs('#btn-next').addEventListener('click', ()=>player && player.next());
  qs('#btn-mark-done').addEventListener('click', ()=>player && player.markDone());
  qs('#btn-summarize').addEventListener('click', summarizeCurrent);

  // 倍速 & 清晰度
  qs('#sel-speed').addEventListener('change', e=>{ if(player) player.setSpeed(parseFloat(e.target.value)); });
  qs('#sel-quality').addEventListener('change', e=>{
    state.settings.biliQuality = e.target.value;
    saveSettings();
    const c = activeCourse();
    if(c && player && player.cur && player.cur.bvid){ player.load(c, state.activePart); toast('已切换清晰度，重新加载中…'); }
  });

  // 音量
  qs('#btn-mute').addEventListener('click', ()=>{
    const v = qs('#player-video'); if(!v) return;
    v.muted = !v.muted;
    qs('#btn-mute').classList.toggle('is-muted', v.muted);
  });
  qs('#vol-slider').addEventListener('input', e=>{
    const v = qs('#player-video'); if(!v) return;
    v.volume = e.target.value/100;
    v.muted = false;
    qs('#btn-mute').classList.remove('is-muted');
    state.settings.volume = v.volume;
    saveSettings();
  });

  // AI 助手 / 笔记抽屉
  qs('#btn-asst').addEventListener('click', toggleAssistant);
  qs('#btn-asst-close').addEventListener('click', closeAssistant);
  qs('#btn-asst-send').addEventListener('click', sendAssistant);
  qs('#asst-tab-chat').addEventListener('click', ()=>switchAsstTab('chat'));
  qs('#asst-tab-notes').addEventListener('click', ()=>switchAsstTab('notes'));
  qs('#asst-input').addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendAssistant(); } });
  qs('#note-area').addEventListener('input', ()=>{ clearTimeout(noteSaveTimer); noteSaveTimer = setTimeout(saveNote, 500); });

  // 视频进度条点击/拖动跳转
  const seek = qs('#pc-seek');
  const bubble = qs('#pc-bubble');
  if(seek){
    let dragging = false;
    const ratioAt = e=>{
      const rect = seek.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX-rect.left)/rect.width));
    };
    const seekTo = e=>{
      if(!player || !player.cur.duration) return;
      const r = ratioAt(e);
      player.seekTo(r * player.cur.duration);
    };
    const showBubble = e=>{
      if(!bubble || !player || !player.cur.duration) return;
      const r = ratioAt(e);
      bubble.textContent = fmtTime(Math.floor(r * player.cur.duration));
      bubble.style.left = (r*100)+'%';
      bubble.hidden = false;
    };
    const hideBubble = ()=>{ if(bubble) bubble.hidden = true; };
    seek.addEventListener('pointerdown', e=>{
      dragging=true;
      seek.classList.add('dragging');
      if(player && player.flashControls) player.flashControls();   // 拖动期间不自动隐藏控制条
      seek.setPointerCapture(e.pointerId);
      showBubble(e);
      seekTo(e);
    });
    seek.addEventListener('pointermove', e=>{ if(dragging){ showBubble(e); seekTo(e); } });
    seek.addEventListener('pointerup', ()=>{ dragging=false; seek.classList.remove('dragging'); hideBubble(); });
    seek.addEventListener('pointercancel', ()=>{ dragging=false; seek.classList.remove('dragging'); hideBubble(); });
  }

  // 键盘快捷键
  document.addEventListener('keydown', e=>{
    if(e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA' || e.target.tagName==='SELECT') return;
    if(!qs('#mini-modal').hidden) return;   // 小弹窗打开时接管 Escape，不触发布局快捷键
    const v = document.body.dataset.view;
    if(e.key === 'Escape'){
      if(document.fullscreenElement) return;   // 原生全屏的退出交给浏览器
      const wrap = qs('.player-frame-wrap');
      if(wrap && wrap.classList.contains('is-fscreen')){ toggleFakeFullscreen(); return; }
      if(document.body.classList.contains('asst-focus')){ toggleAsstFocus(false); return; }
      if(v==='settings') backFromSettings();
      else if(v==='watch') backToLibrary();
      return;
    }
    /* A 键：随时呼出/收起 AI 助手 */
    if((e.key==='a' || e.key==='A') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey){
      if(state.courses.length) toggleAssistant();
      return;
    }
    if(v!=='watch') return;
    if(e.key===' ' || e.key==='Spacebar'){ e.preventDefault(); player && player.togglePlay(); }
    if(e.key==='ArrowRight'){
      if(e.shiftKey) player && player.next();
      else if(player){
        player.seekTo((player.cur.time||0) + 5);
        startFF(player, 1);   // 长按 = 2x 连续快进
      }
    }
    if(e.key==='ArrowLeft'){
      if(e.shiftKey) player && player.prev();
      else if(player){
        player.seekTo(Math.max(0, (player.cur.time||0) - 5));
        startFF(player, -1);
      }
    }
  });
  document.addEventListener('keyup', e=>{
    if(e.key==='ArrowRight' || e.key==='ArrowLeft') stopFF();
  });
}

/* 长按方向键：2 倍速连续快进/快退（每 200ms 前进 0.4s） */
let ffTimer = null;
function startFF(pl, dir){
  if(ffTimer) return;
  ffTimer = setInterval(()=>{
    if(document.body.dataset.view!=='watch' || !player){ stopFF(); return; }
    player.seekTo((player.cur.time||0) + 0.4*dir);
  }, 200);
}
function stopFF(){
  if(ffTimer){ clearInterval(ffTimer); ffTimer = null; }
}

/* ============ 本地代理健康检测 ============ */
function proxyHost(){
  const m = proxyBase().match(/^https?:\/\/([^/]+)/);
  return m ? m[1] : '';
}
function checkProxyHealth(){
  // 页面本身由代理托管（http://localhost:7392 打开）→ 已可用，无需提示
  if(location.protocol === 'http:' && proxyHost() && location.host === proxyHost()) return;
  fetchTimeout(`${proxyBase()}/healthz`, {}, 2500)
    .then(r=>{ if(!r.ok) throw new Error('down'); })
    .catch(()=>{
      const b = qs('#proxy-banner');
      if(b) b.hidden = false;
    });
}

/* ============ 主题系统 ============ */
const THEME_NAMES = { light:'宣纸自习室', night:'深夜书房', green:'青绿笔记' };
function applyTheme(name, persist=true){
  const t = THEME_NAMES[name] ? name : 'light';
  const root = document.documentElement;
  root.classList.add('theme-fade');
  root.dataset.theme = t;
  setTimeout(()=>root.classList.remove('theme-fade'), 420);
  state.settings.theme = t;
  if(persist) saveSettings();
  qsa('.theme-chip').forEach(ch=>ch.classList.toggle('is-active', ch.dataset.themeName===t));
}

/* ============ 首次使用引导 ============ */
const LS_ONBOARDED = 'deepreel.onboarded.v1';
let onboardStep = 0;
function maybeShowOnboarding(){
  if(state.courses.length) return;
  try{ if(localStorage.getItem(LS_ONBOARDED)) return; }catch{}
  onboardStep = 0;
  renderOnboardStep();
  qs('#onboard').hidden = false;
}
function renderOnboardStep(){
  qsa('.onboard-step').forEach((el,i)=>{ el.hidden = i!==onboardStep; });
  qsa('.onboard-dots i').forEach((el,i)=>{ el.classList.toggle('on', i===onboardStep); });
  const btn = qs('#btn-onboard-next');
  if(btn) btn.textContent = onboardStep < 2 ? '下一步' : '入馆';
}
function closeOnboarding(){
  qs('#onboard').hidden = true;
  try{ localStorage.setItem(LS_ONBOARDED,'1'); }catch{}
}
function openGuide(){
  onboardStep = 0;
  renderOnboardStep();
  qs('#onboard').hidden = false;
}

/* ============ 数据备份与恢复 ============ */
function exportData(){
  const data = {
    app:'deepreel', version:1, exportedAt:new Date().toISOString(),
    courses:state.courses, settings:state.settings, activity:state.activity, hourDist:state.hourDist,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deepreel-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 3000);
  const note = qs('#data-note');
  if(note){ note.textContent='✓ 已导出。文件含课程、学习记录、API Key 与 B 站 Cookie，请妥善保管。'; note.classList.remove('err'); }
}
function importData(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      if(!data || data.app !== 'deepreel') throw new Error('不是 DEEPREEL 备份文件');
      if(Array.isArray(data.courses)){ state.courses = data.courses; saveCourses(); }
      if(data.settings && typeof data.settings === 'object'){ state.settings = Object.assign(state.settings, data.settings); saveSettings(); }
      if(data.activity && typeof data.activity === 'object'){ state.activity = data.activity; saveActivity(); }
      if(Array.isArray(data.hourDist) && data.hourDist.length === 24){ state.hourDist = data.hourDist; saveHours(); }
      applyTheme(state.settings.theme || 'light', false);
      renderLibrary();
      const note = qs('#data-note');
      if(note){ note.textContent='✓ 导入成功，藏书归位。'; note.classList.remove('err'); }
      toast('数据已恢复');
    }catch(e){
      const note = qs('#data-note');
      if(note){ note.textContent='导入失败：'+(e.message||'文件格式不正确'); note.classList.add('err'); }
    }
  };
  reader.readAsText(file);
}

/* ============ WebDAV 云同步（加密备份到网盘） ============ */
function b64(u8){ let s=''; for(let i=0;i<u8.length;i++) s+=String.fromCharCode(u8[i]); return btoa(s); }
function fromB64(s){ const bin=atob(s); const u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return u8; }
async function wdDeriveKey(pass, salt){
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:150000, hash:'SHA-256' },
    km, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
  );
}
async function wdEncrypt(obj, pass){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await wdDeriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ v:1, salt:b64(salt), iv:b64(iv), data:b64(new Uint8Array(ct)) });
}
async function wdDecrypt(text, pass){
  const j = JSON.parse(text);
  const key = await wdDeriveKey(pass, fromB64(j.salt));
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv:fromB64(j.iv) }, key, fromB64(j.data));
  return JSON.parse(new TextDecoder().decode(pt));
}
/* 经本地代理转发 WebDAV 请求（浏览器直连被 CORS 拦） */
async function wdFetch(method, rel, body){
  const s = state.settings;
  const baseUrl = (s.webdavUrl && /^https?:\/\//.test(s.webdavUrl)) ? s.webdavUrl : 'https://dav.jianguoyun.com/dav/';
  const u = new URL(rel, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const auth = 'Basic ' + btoa(unescape(encodeURIComponent((s.webdavUser||'') + ':' + (s.webdavPass||''))));
  const opt = {
    method,
    headers: { 'X-Webdav-Auth': auth, 'X-Webdav-Host': u.host, 'X-Webdav-Path': u.pathname + u.search, 'X-Webdav-Scheme': u.protocol === 'http:' ? 'http' : 'https' },
  };
  if(body !== undefined){ opt.headers['Content-Type'] = 'application/octet-stream'; opt.body = body; }
  return fetch(`${proxyBase()}/webdav/${rel}`, opt);
}
function wdNote(msg, isErr){
  const el = qs('#wd-note');
  if(!el) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}
/* 从设置表单读取 WebDAV 配置并保存 */
function readWdFields(){
  const s = state.settings;
  const url = qs('#wd-url'), user = qs('#wd-user'), pass = qs('#wd-pass'), key = qs('#wd-key');
  if(url) s.webdavUrl = url.value.trim() || 'https://dav.jianguoyun.com/dav/';
  if(user) s.webdavUser = user.value.trim();
  if(pass) s.webdavPass = pass.value;
  if(key) s.webdavKey = key.value;
  saveSettings();
}
function wdBuildBackup(){
  return {
    app:'deepreel', version:1, exportedAt:new Date().toISOString(),
    courses:state.courses, settings:state.settings, activity:state.activity, hourDist:state.hourDist,
  };
}
async function wdUpload(){
  const s = state.settings;
  if(!s.webdavUser || !s.webdavPass){ wdNote('请先填写 WebDAV 账号与应用密码', true); return; }
  if(!s.webdavKey){ wdNote('请设置加密口令（用于加密备份）', true); return; }
  if(!crypto || !crypto.subtle){ wdNote('当前环境不支持加密（需 https 或本机访问），无法同步', true); return; }
  wdNote('正在加密并上传…');
  try{
    const enc = await wdEncrypt(wdBuildBackup(), s.webdavKey);
    let r = await wdFetch('PUT', 'DeepReel/backup.json', enc);
    if(r.status === 409){
      await wdFetch('MKCOL', 'DeepReel');
      r = await wdFetch('PUT', 'DeepReel/backup.json', enc);
    }
    if(!r.ok && r.status !== 201 && r.status !== 204) throw new Error('HTTP '+r.status);
    s.wdLastSync = new Date().toISOString();
    saveSettings();
    wdNote('✓ 已加密上传到云端（'+s.wdLastSync.slice(0,16).replace('T',' ')+'）');
    toast('云备份已更新');
  }catch(e){
    wdNote('上传失败：'+(e.message||'网络错误')+'。请确认代理已启动、账号密码正确', true);
  }
}
async function wdDownload(){
  const s = state.settings;
  if(!s.webdavUser || !s.webdavPass){ wdNote('请先填写 WebDAV 账号与应用密码', true); return; }
  if(!crypto || !crypto.subtle){ wdNote('当前环境不支持加密（需 https 或本机访问），无法同步', true); return; }
  wdNote('正在下载并解密…');
  try{
    const r = await wdFetch('GET', 'DeepReel/backup.json');
    if(r.status === 404){ wdNote('云端还没有备份，先点「↑ 上传备份」', true); return; }
    if(!r.ok) throw new Error('HTTP '+r.status);
    let backup;
    try{ backup = await wdDecrypt(await r.text(), s.webdavKey); }
    catch(e){ throw new Error('解密失败：加密口令不对或数据已损坏'); }
    if(!backup || backup.app !== 'deepreel') throw new Error('云端文件不是 DEEPREEL 备份');
    /* 保留当前 WebDAV 凭据，避免被云端旧配置覆盖 */
    const keep = { webdavUrl:s.webdavUrl, webdavUser:s.webdavUser, webdavPass:s.webdavPass, webdavKey:s.webdavKey };
    if(Array.isArray(backup.courses)){ state.courses = backup.courses; saveCourses(); }
    if(backup.settings && typeof backup.settings === 'object'){ Object.assign(state.settings, backup.settings); saveSettings(); }
    if(backup.activity && typeof backup.activity === 'object'){ state.activity = backup.activity; saveActivity(); }
    if(Array.isArray(backup.hourDist) && backup.hourDist.length === 24){ state.hourDist = backup.hourDist; saveHours(); }
    Object.assign(state.settings, keep);
    applyTheme(state.settings.theme || 'light', false);
    renderLibrary();
    wdNote('✓ 已从云端恢复（备份时间 '+(backup.exportedAt||'?').slice(0,16).replace('T',' ')+'）');
    toast('云端数据已恢复');
  }catch(e){
    wdNote('下载失败：'+(e.message||'网络错误')+'。请确认代理已启动、账号密码正确', true);
  }
}

/* ============ 学习报告 ============ */
function openLearningReport(){
  const now = new Date();
  const kToday = todayKey();
  const k30 = keyFor(new Date(now.getTime() - 29*864e5));
  let w30=0, p30=0, c30=0, bestK=null, bestW=0, days=0;
  const touched = new Set();
  for(const k of Object.keys(state.activity)){
    if(k < k30 || k > kToday) continue;
    const a = state.activity[k];
    if(!a || typeof a !== 'object') continue;
    w30 += a.w||0; p30 += a.p||0; c30 += a.c||0; days++;
    if((a.w||0) > bestW){ bestW = a.w; bestK = k; }
    if(a.co) Object.keys(a.co).forEach(b=>touched.add(b));
  }
  let streak = 0;
  const d = new Date();
  for(let i=0;i<400;i++){
    if(state.activity[keyFor(d)]) streak++;
    else if(i>0) break;
    d.setDate(d.getDate()-1);
  }
  const hh = Math.floor(w30/3600), mm = Math.round((w30%3600)/60);
  const books = Math.round(w30/3600/6*10)/10;
  const movies = Math.round(w30/3600/1.5*10)/10;
  const bestDay = bestK ? bestK.slice(5).replace('-','月')+'日' : '';
  const bestDur = bestW >= 3600 ? (Math.round(bestW/36)/100)+' 小时' : Math.round(bestW/60)+' 分钟';
  let txt = '【治学札记 · 学习报告】\n';
  txt += '生成于 '+now.getFullYear()+' 年 '+(now.getMonth()+1)+' 月 '+now.getDate()+' 日\n';
  txt += '\n近 30 日，你在这间自习室静坐了 '+hh+' 小时 '+mm+' 分';
  if(p30>0) txt += '（其中 '+Math.round(p30/60)+' 分用于思考）';
  txt += '。\n—— 约等于翻完了 '+books+' 本 300 页的书，或看完 '+movies+' 部 90 分钟的电影。\n';
  txt += '\n· 涉猎藏书 '+touched.size+' 门，习完 '+c30+' 个分 P\n';
  if(streak>1) txt += '· 连续学习打卡 '+streak+' 天\n';
  if(bestK) txt += '· 最勤的一日：'+bestDay+'，专注 '+bestDur+'\n';
  if(days===0) txt += '· 近 30 日尚未留下足迹——今日开卷，正当时。\n';
  txt += '\n书山有路，贵在日拱一卒。下一卷，已在架上等你。';
  window._lastReport = txt;
  qs('#report-body').textContent = txt;
  qs('#report-copied').hidden = true;
  qs('#report-modal').hidden = false;
}
function copyLearningReport(){
  const txt = window._lastReport || '';
  const flash = ()=>{ const el=qs('#report-copied'); if(el){ el.hidden=false; setTimeout(()=>{ el.hidden=true; }, 2200); } };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(flash).catch(()=>{ fallbackCopy(txt); flash(); });
  }else{ fallbackCopy(txt); flash(); }
}
function fallbackCopy(txt){
  const ta = document.createElement('textarea');
  ta.value = txt; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); }catch{}
  ta.remove();
}

/* ============ 升级功能绑定 ============ */
function bindUpgrades(){
  qsa('.theme-chip').forEach(ch=>ch.addEventListener('click', ()=>applyTheme(ch.dataset.themeName)));
  qs('#btn-onboard-next').addEventListener('click', ()=>{
    if(onboardStep < 2){ onboardStep++; renderOnboardStep(); }
    else closeOnboarding();
  });
  qs('#btn-onboard-x').addEventListener('click', closeOnboarding);
  qs('#btn-show-guide').addEventListener('click', openGuide);
  qs('#btn-export-data').addEventListener('click', exportData);
  qs('#btn-import-data').addEventListener('click', ()=>qs('#import-file').click());
  qs('#import-file').addEventListener('change', e=>{
    const f = e.target.files && e.target.files[0];
    if(f) importData(f);
    e.target.value = '';
  });
  qs('#btn-gen-report').addEventListener('click', openLearningReport);
  qs('#btn-report-close').addEventListener('click', ()=>{ qs('#report-modal').hidden = true; });
  qs('#btn-report-done').addEventListener('click', ()=>{ qs('#report-modal').hidden = true; });
  qs('#btn-report-copy').addEventListener('click', copyLearningReport);
  qs('#report-modal').addEventListener('click', e=>{ if(e.target.id==='report-modal') qs('#report-modal').hidden = true; });
  qs('#btn-proxy-banner-close').addEventListener('click', ()=>{ qs('#proxy-banner').hidden = true; });
  /* 截图上传（vision） */
  qs('#btn-asst-img').addEventListener('click', ()=>qs('#asst-img-file').click());
  qs('#asst-img-file').addEventListener('change', e=>{
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if(!f) return;
    fileToDataURL(f).then(setAsstImg).catch(err=>toast('截图读取失败：'+(err.message||'')));
  });
  qs('#btn-asst-img-clear').addEventListener('click', clearAsstImg);
  /* WebDAV 云同步 */
  qs('#btn-wd-upload').addEventListener('click', ()=>{ readWdFields(); wdUpload(); });
  qs('#btn-wd-download').addEventListener('click', ()=>{ readWdFields(); wdDownload(); });
  /* 全屏对话 + 快捷提问 + 抽屉调宽 */
  qs('#btn-asst-focus').addEventListener('click', ()=>toggleAsstFocus());
  qs('#asst-quick').addEventListener('click', e=>{
    const btn = e.target.closest('.asst-q');
    if(!btn || assistantThinking) return;
    const input = qs('#asst-input');
    if(input){ input.value = btn.dataset.q || ''; sendAssistant(); }
  });
  initDrawerResize();
}

/* ============ 启动 ============ */
function boot(){
  loadState();
  console.log(`DEEPREEL ${APP_VERSION} 已启动`);
  /* PWA：Service Worker 注册（file:// 不支持，仅在 http/https 环境生效） */
  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
  applyTheme(state.settings.theme || 'light', false);
  player = new PlayerBridge();
  bind();
  bindUpgrades();
  /* 进度条兜底看门狗：个别移动浏览器/全屏/画中画下 timeupdate 可能不触发，
     每秒按视频真实播放头强制同步一次进度条与时间（不依赖 running / timeupdate）。 */
  setInterval(()=>{
    if(!player || !player.cur || !player.cur.course || player.cur.simulate) return;
    const v = player.video;
    if(!v || v.paused || v.ended) return;
    const t = v.currentTime + (player.mode === 'mp4' ? (player.segBase||0) : 0);
    if(Math.abs(t - (player.cur.time||0)) > 0.25) player.setTime(t, false, player.running);
  }, 1000);
  // 主题化下拉
  initCSelect(qs('#bili-quality'));
  initCSelect(qs('#llm-model'));
  // 恢复音量
  if(state.settings.volume != null){
    try{ player.video.volume = state.settings.volume; }catch{}
    const vs = qs('#vol-slider');
    if(vs) vs.value = Math.round((state.settings.volume||1)*100);
  }
  updateAIStatus();
  initMotion();
  checkProxyHealth();
  renderLibrary();
  maybeShowOnboarding();
  // Hero 入场
  reveal('.hero > *', { stagger:0.08, duration:0.95, ease:'expo.out' });
  reveal('.section-head', { delay:0.2, duration:0.8 });
}
document.addEventListener('DOMContentLoaded', boot);
