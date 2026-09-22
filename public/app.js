// app.js — 前端：看板 / 新建任务(多图上传+手动发布) / 任务详情(下载+手动发布+提示词可视化) / 配置
const $ = (sel, root = document) => root.querySelector(sel);

const STAGE_ORDER = ['init', 'parse', 'tryon', 'video', 'publish', 'done'];
const PLATFORM_LABEL = { douyin: '抖音', xiaohongshu: '小红书', weixin: '视频号', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' };
const ACCESS_KEY = sessionStorage.getItem('app_access_key') || '';

let configRevealed = false; // 配置页"查看明文"开关

// 模特个人信息可编辑字段（label 用于表单与展示）
const MODEL_INFO_FIELDS = [
  ['gender', '性别'],
  ['age', '年龄'],
  ['height', '身高（cm）'],
  ['weight', '体重（kg）'],
  ['size', '服装尺码'],
  ['bust', '胸围（cm）'],
  ['waist', '腰围（cm）'],
  ['hip', '臀围（cm）'],
  ['shoeSize', '鞋码'],
  ['hairColor', '发色'],
  ['skinTone', '肤色'],
  ['hairstyle', '发型'],
  ['style', '擅长风格'],
  ['phone', '联系电话'],
  ['email', '邮箱'],
  ['wechat', '微信'],
  ['address', '地址'],
  ['notes', '备注'],
];

const CONFIG_FIELDS = [
  ['LOGIN_PASSWORD', '登录密码（默认 123456）'],
  ['DASHSCOPE_API_KEY', '百炼/DashScope API Key'],
  ['TRYON_MODEL', '试穿模型'],
  ['VIDEO_MODEL', '图生视频模型（kling / seedance）'],
  ['IMAGE_TO_VIDEO_ENDPOINT', '图生视频接口地址'],
  ['KOLORS_OR_SEEDANCE_API_KEY', '即梦/可灵 API Key'],
  ['DOUYIN_CLIENT_KEY', '抖音 Client Key'],
  ['DOUYIN_CLIENT_SECRET', '抖音 Client Secret'],
  ['DOUYIN_ACCESS_TOKEN', '抖音 access_token'],
  ['WEIXIN_CHANNELS_APPID', '视频号 AppID'],
  ['WEIXIN_CHANNELS_ACCESS_TOKEN', '视频号 access_token'],
  ['XHS_RPA_WEBHOOK', '小红书 RPA Webhook'],
  ['META_ACCESS_TOKEN', 'Meta access_token'],
  ['META_IG_USER_ID', 'Instagram 用户 ID'],
  ['META_FB_PAGE_ID', 'Facebook 主页 ID'],
  ['TIKTOK_ACCESS_TOKEN', 'TikTok access_token'],
  ['TIKTOK_OPEN_ID', 'TikTok open_id'],
];

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (ACCESS_KEY) headers.authorization = `Bearer ${ACCESS_KEY}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) forceLogout('登录已失效，请重新输入访问密钥');
  return { ok: res.ok, status: res.status, data };
}

function forceLogout(msg) {
  sessionStorage.removeItem('app_access_key');
  if (msg) {
    try { alert(msg); } catch (_) { /* ignore */ }
  }
  location.hash = '#/dashboard';
  location.reload();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) {
  return esc(s);
}
function showToast(msg, type = 'ok') {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.className = type || '';
  t.textContent = msg;
  t.classList.add('show');
  t.style.opacity = '1';
  clearTimeout(t._h);
  t.dataset.hide = String(t._h = setTimeout(() => {
    t.classList.remove('show');
    t.style.opacity = '0';
  }, 2200));
}
function time(s) {
  return (s || '').slice(0, 19).replace('T', ' ');
}
function mediaSrc(ref) {
  return ref?.kind === 'r2' ? `/media/${ref.value}` : ref?.value ?? '';
}
function platformLabel(p) {
  return PLATFORM_LABEL[p] ?? p;
}

/* ---------------- 路由 ---------------- */
const routes = {
  dashboard: renderDashboard,
  models: renderModels,
  new: renderNew,
  config: renderConfig,
  recycle: renderRecycle,
  job: renderJobDetail,
};

window.addEventListener('hashchange', navigate);
bootstrap();

async function bootstrap() {
  const auth = await api('/api/auth/status');
  const enabled = !!auth.data.enabled;
  if (enabled) document.body.classList.add('authed');
  renderAuthBorder(enabled);
  if (enabled && !ACCESS_KEY) {
    renderLogin();
  } else {
    navigate();
  }
}

function renderAuthBorder(enabled) {
  const bar = $('#auth-bar');
  if (bar) bar.remove();
  if (!enabled) return;
  const div = document.createElement('div');
  div.id = 'auth-bar';
  div.className = 'auth-bar';
  const btn = document.createElement('button');
  btn.className = 'btn sm ghost';
  btn.textContent = ACCESS_KEY ? '登出' : '未登录';
  btn.addEventListener('click', () => {
    sessionStorage.removeItem('app_access_key');
    location.reload();
  });
  div.append('已使用密钥访问', btn);
  $('nav.topbar')?.append(div);
}

function renderLogin() {
  const view = $('#view');
  view.innerHTML = `
    <section class="login-wrap">
      <form id="login-form" class="card login-card">
        <h1>🔐 请输入登录密码</h1>
        <p class="sub">默认密码 123456，可在「配置」页修改（存入数据库）</p>
        <input type="password" id="login-key" autocomplete="current-password" placeholder="登录密码" />
        <button type="submit" class="btn primary">进入</button>
        <div id="login-msg" class="msg"></div>
      </form>
    </section>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#login-msg');
    msg.className = 'msg';
    msg.textContent = '验证中…';
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ key: $('#login-key').value }),
    });
    if (!res.ok) {
      msg.className = 'msg err';
      msg.textContent = res.data.error || '验证失败';
      return;
    }
    sessionStorage.setItem('app_access_key', $('#login-key').value);
    location.reload();
  });
}

function navigate() {
  if (document.body.classList.contains('authed') && !ACCESS_KEY) return;
  if (dashTimer) clearInterval(dashTimer); // 离开看板时停止后台轮询并重置
  dashTimer = null; dashSig = null;
  const hash = (location.hash || '#/dashboard').replace(/^#/, '');
  const [path, arg] = hash.slice(1).split('/');
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('active', path === a.dataset.nav);
  }
  updateNavIndicator();
  const handler = routes[path] || renderDashboard;
  handler(arg);
  renderVersion();
}

/** 让顶部导航的高亮"指示条"跟随当前页面（滑动过渡由 CSS 承担） */
function updateNavIndicator() {
  const nav = document.querySelector('#nav-links');
  const ind = document.querySelector('#nav-indicator');
  const active = nav?.querySelector('a.active');
  if (!nav || !ind || !active) { if (ind) ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  ind.style.transform = `translateX(${active.offsetLeft - 2}px)`;
  ind.style.width = `${active.offsetWidth + 4}px`;
}

/** 顶栏展示当前发布版本号（来自 /api/settings 的 RELEASE_VERSION） */
async function renderVersion() {
  const el = document.querySelector('#version-badge');
  if (!el || !ACCESS_KEY) return;
  try {
    const r = await api('/api/settings');
    if (r.ok && r.data?.version) el.textContent = 'v' + r.data.version;
  } catch (_) { /* 忽略展示失败 */ }
}

/* ---------------- 看板 ---------------- */
let dashTimer = null;
let dashSig = null; // 任务状态签名（id→status），用于"状态未变不重刷"

/** 统计数字滚动动画（仅在数值变化时播放） */
function animateStatNums(root) {
  root.querySelectorAll('.stat-num').forEach((n) => {
    const target = parseInt(String(n.textContent).replace(/\D/g, ''), 10) || 0;
    const cur = Number(n.dataset.v || 0);
    if (target === cur) return;
    n.dataset.v = target;
    const dur = 680;
    const start = performance.now();
    const step = (now) => {
      const k = Math.min((now - start) / dur, 1);
      const ease = 1 - Math.pow(1 - k, 3);
      n.textContent = Math.round(cur + (target - cur) * ease);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** 首次进入看板展示一条可关闭的引导条（仅一次，用 localStorage 记录） */
function maybeShowGuide() {
  const root = document.querySelector('#guide-root');
  if (!root) return;
  try {
    if (localStorage.getItem('guide_dashboard_shown')) return;
    localStorage.setItem('guide_dashboard_shown', '1');
  } catch (_) { return; }
  const bar = document.createElement('div');
  bar.id = 'guide-bar';
  bar.innerHTML = `
    <span class="guide-icon">✦</span>
    <div class="guide-text">在<b>新建任务</b>中通过「＋ 添加人物图片」选择模特库照片或直接上传，粘贴商品链接，即可自动生成 15 秒试穿短视频并发布到目标平台。</div>
    <button class="guide-close" aria-label="关闭">×</button>`;
  bar.querySelector('.guide-close').addEventListener('click', () => bar.remove());
  root.appendChild(bar);
}

async function renderDashboard() {
  const view = $('#view');
  view.innerHTML = `<div class="loading">载入中…</div>`;

  const platRes = await api('/api/platforms');
  const pats = (platRes.data.platforms ?? [])
    .map((p) => `<span class="chip ${p.ready ? 'on' : 'off'}">${platformLabel(p.platform)}${p.ready ? '' : '·未配置'}</span>`)
    .join('');

  view.innerHTML = `
    <section class="hero">
      <div>
        <h1>工作台</h1>
        <p class="sub">人物图 × 电商链接 → 15s 试穿短视频 → 多平台发布</p>
      </div>
      <a class="btn primary" href="#/new">＋ 新建任务</a>
    </section>
    ${pats ? `<div class="platforms strip">${pats}</div>` : ''}
    <section class="sk-grid" id="dash-stats">
      <div class="skeleton sk-stat"></div>
      <div class="skeleton sk-stat"></div>
      <div class="skeleton sk-stat"></div>
      <div class="skeleton sk-stat"></div>
    </section>
    <section class="card">
      <header class="list-head">
        <h2>最近任务 <span id="dash-live" class="live"></span></h2>
        <a class="btn ghost" href="#/job">查看全部</a>
      </header>
      <div id="dash-jobs" class="jobs-table">
        <div class="sk-row"><span class="skeleton sk-thumb"></span><div class="jr-main"><span class="skeleton sk-line w60" style="display:block"></span></div><span class="skeleton sk-line" style="width:56px"></span><span class="skeleton sk-line" style="width:70px"></span></div>
        <div class="sk-row"><span class="skeleton sk-thumb"></span><div class="jr-main"><span class="skeleton sk-line w60" style="display:block"></span></div><span class="skeleton sk-line" style="width:56px"></span><span class="skeleton sk-line" style="width:70px"></span></div>
        <div class="sk-row"><span class="skeleton sk-thumb"></span><div class="jr-main"><span class="skeleton sk-line w60" style="display:block"></span></div><span class="skeleton sk-line" style="width:56px"></span><span class="skeleton sk-line" style="width:70px"></span></div>
      </div>
    </section>`;

  renderVersion();
  await refreshDashboardSlice(true);
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = setInterval(() => refreshDashboardSlice(false), 4000);
  maybeShowGuide();
}

/** 后台刷新：仅刷新任务列表（stats=true 时连统计一并首次渲染）；不重建整页，避免任务执行中反复整页刷新 */
async function refreshDashboardSlice(updateStats) {
  const jobsEl = $('#dash-jobs');
  if (!jobsEl) {
    if (dashTimer) clearInterval(dashTimer);
    return; // 已离开看板
  }
  const statsEl = $('#dash-stats');
  const live = $('#dash-live');
  const res = await api('/api/jobs?limit=50');
  const items = res.data?.items ?? [];
  const running = items.filter((j) => j.status === 'running' || j.status === 'queued').length;
  if (updateStats) {
    const statusCount = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
    for (const j of items) statusCount[j.status] = (statusCount[j.status] || 0) + 1;
    const total = items.length || 0;
    const cards = [
      ['总任务', total, 'total'],
      ['进行中', running, 'run'],
      ['已完成', statusCount.succeeded + statusCount.failed + statusCount.canceled, 'ok'],
      ['失败', statusCount.failed, 'err'],
    ]
      .map(([l, v, c]) => `<div class="stat ${c}"><span class="stat-num">${v}</span><span class="stat-label">${l}</span></div>`)
      .join('');
    if (statsEl) { statsEl.innerHTML = cards; animateStatNums(statsEl); }
  }
  // 只刷新状态：整组状态签名未变化时（所有任务都停在终态/未推进）不重刷列表，避免已完成任务反复重渲
  const sig = items.map((j) => j.status).join('|');
  if (!updateStats && sig === dashSig) {
    if (live) live.textContent = running ? `·${running} 个进行中` : '';
    return;
  }
  dashSig = sig;
  if (jobsEl) jobsEl.innerHTML = items.map(jobRow).join('') || '<div class="empty">暂无任务</div>';
  if (live) live.textContent = running ? `·${running} 个进行中` : '';
}

/** 最近任务 → 列表行（缩略图 / 标题+日志 / 状态 / 时间 / 操作） */
function jobRow(job) {
  const last = job.logs?.length ? job.logs[job.logs.length - 1].msg : '';
  const first = job.personImages?.[0] ?? job.personImage;
  const th = job.video?.output
    ? `<video src="${mediaSrc(job.video.output)}" preload="metadata" class="thumb-v"></video>`
    : job.tryOn?.output
      ? `<img class="thumb" src="${mediaSrc(job.tryOn.output)}" />`
      : first?.value
        ? `<img class="thumb" src="${mediaSrc(first)}" />`
        : `<span class="thumb ph"></span>`;
  const canCancel = ['queued', 'running'].includes(job.status);
  const canPublishRow = job.status === 'succeeded' && !!job.video?.output?.value;
  return `
    <div class="job-row job-item" data-id="${job.id}">
      ${th}
      <div class="jr-main">
        <div class="job-title">${esc(job.parsed?.title ?? job.id.slice(0, 8))}</div>
        <div class="sub jr-log">${esc(last) || '…'}</div>
      </div>
      <span class="badge ${job.status}">${job.status}</span>
      <div class="sub jr-time">${time(job.updatedAt || job.createdAt)}</div>
      <div class="jr-ops">
        ${canPublishRow ? `<button class="publish-quick" data-publish="${job.id}" title="发布到平台">发布</button>` : ''}
        ${canCancel ? `<button class="cancel-quick" data-cancel="${job.id}" title="终止任务">✕</button>` : ''}
        <button class="del-quick" data-del="${job.id}" title="删除任务">🗑</button>
      </div>
    </div>`;
}

/* ---------------- 回收站 ---------------- */
async function renderRecycle() {
  const view = $('#view');
  view.innerHTML = `<div class="loading">载入中…</div>`;
  const res = await api('/api/recycle');
  if (!res.ok) {
    view.innerHTML = `<div class="empty">${esc(res.data.error || '加载失败')}</div>`;
    return;
  }
  const items = res.data.items || [];
  if (!items.length) {
    view.innerHTML = `<section class="hero"><div><h1>回收站</h1><p class="sub">软删除的任务在这里，媒体文件已保留</p></div></section><div class="empty">回收站是空的</div>`;
    return;
  }
  view.innerHTML = `
    <section class="hero"><div><h1>回收站</h1><p class="sub">软删除的任务（媒体文件已保留），可恢复或彻底删除</p></div>
      <button class="btn ghost sm" id="empty-bin">清空回收站</button></section>
    <div class="jobs">${items.map(recycleItemHtml).join('')}</div>`;
  view.querySelectorAll('[data-rustore]').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); restoreJob(b.dataset.rustore); }));
  view.querySelectorAll('[data-purge]').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); purgeJob(b.dataset.purge); }));
  const empty = view.querySelector('#empty-bin');
  if (empty) empty.addEventListener('click', () => {
    if (!hardConfirm('clear', `彻底删除回收站中的 ${items.length} 个任务及全部媒体`)) return;
    Promise.all(items.map((j) => api(`/api/jobs/${j.id}/purge`, { method: 'POST', body: '{}' }))).then(renderRecycle);
  });
}

/** 二次确认：先弹确认框，再要求输入关键词「删除」/「清空」才算通过（防误触不可恢复操作） */
function hardConfirm(verb, what) {
  const keyword = verb === 'clear' ? '清空' : '删除';
  if (!confirm(`${what}，此操作不可恢复。是否继续？`)) return false;
  const input = prompt(`请在下框输入「${keyword}」以确认${what}。`);
  return input === keyword;
}

function recycleItemHtml(job) {
  const last = job.logs?.[job.logs.length - 1]?.msg ?? '';
  return `
    <div class="job-item">
      <div class="job-item-body">
        <div class="job-title">${esc(job.parsed?.title ?? job.id.slice(0, 8))}</div>
        <span class="badge ${job.status}">${job.status}</span>
        <div class="sub">${esc(last) || time(job.createdAt)}</div>
      </div>
      <div class="item-ops">
        <button class="del-quick" data-rustore="${job.id}" title="恢复">↩</button>
        <button class="del-quick" data-purge="${job.id}" title="彻底删除">🗑</button>
      </div>
    </div>`;
}

async function restoreJob(id) {
  const res = await api(`/api/jobs/${id}/restore`, { method: 'POST', body: '{}' });
  if (!res.ok) { alert(res.data.error ?? '恢复失败'); return; }
  renderRecycle();
}

async function purgeJob(id) {
  if (!hardConfirm('delete', '彻底删除此任务及全部关联内容')) return;
  const res = await api(`/api/jobs/${id}/purge`, { method: 'POST', body: '{}' });
  if (!res.ok) { alert(res.data.error ?? '删除失败'); return; }
  renderRecycle();
}

/* ---------------- 新建任务 ---------------- */
let newJobState = { personRefs: [] };

/* ---------------- 模特库 ---------------- */
let modelFormRefs = []; // 新建模特表单里已上传的照片 ref
let pendingPersonRefs = null; // 从模特库带到新建任务的照片 ref

async function renderModels() {
  const view = $('#view');
  modelFormRefs = [];
  view.innerHTML = `
    <section class="hero"><div><h1>模特库</h1><p class="sub">维护可复用的模特与照片，创建任务时直接选用</p></div></section>
    <section class="card">
      <header class="list-head"><h2>新建模特</h2></header>
      <div class="field"><label>模特姓名</label><input id="m-name" type="text" placeholder="如：林小雅" /></div>
      <div class="field">
        <label>模特照片 <span class="sub">（多张）</span></label>
        <input id="m-files" type="file" accept="image/*" multiple />
      </div>
      <div id="m-thumbs" class="uploads"></div>
      <div class="actions">
        <button type="button" class="btn primary" id="m-save">保存模特</button>
        <span id="m-msg" class="msg"></span>
      </div>
    </section>
    <section class="card">
      <header class="list-head"><h2>模特列表</h2></header>
      <div id="m-list"><div class="loading sm">载入中…</div></div>
    </section>`;
  $('#m-files').addEventListener('change', async () => {
    for (const file of [...document.querySelector('#m-files').files]) {
      const b64 = await compressImageFile(file);
      const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: 'image/jpeg', data: b64 }) });
      if (res.ok && res.data.ref) modelFormRefs.push(res.data.ref);
    }
    renderModelThumbs();
    document.querySelector('#m-files').value = '';
  });
  $('#m-save').addEventListener('click', saveModel);
  renderModelThumbs();
  loadModels();
}

function renderModelThumbs() {
  const box = $('#m-thumbs');
  if (!box) return;
  box.innerHTML = modelFormRefs
    .map(
      (ref, i) => `
      <div class="upload-thumb">
        <img src="${mediaSrc(ref)}" />
        <button type="button" class="thumb-del" data-mi="${i}">×</button>
      </div>`,
    )
    .join('');
  box.querySelectorAll('.thumb-del').forEach((b) =>
    b.addEventListener('click', () => {
      modelFormRefs.splice(Number(b.dataset.mi), 1);
      renderModelThumbs();
    }),
  );
}

async function saveModel() {
  const name = $('#m-name').value.trim();
  const msg = $('#m-msg');
  if (!name) return (msg.textContent = '请填写模特姓名');
  if (!modelFormRefs.length) return (msg.textContent = '请至少上传一张模特照片');
  msg.textContent = '保存中…';
  const res = await api('/api/models', {
    method: 'POST',
    body: JSON.stringify({ name, photoKeys: modelFormRefs.map((r) => r.value) }),
  });
  if (!res.ok) {
    msg.className = 'msg err';
    return (msg.textContent = res.data.error ?? '保存失败');
  }
  modelFormRefs = [];
  $('#m-name').value = '';
  renderModelThumbs();
  loadModels();
  msg.className = 'msg ok';
  msg.textContent = '已保存';
}

async function loadModels() {
  const box = $('#m-list');
  if (!box) return;
  const res = await api('/api/models');
  const models = res.data?.models ?? [];
  if (!models.length) return (box.innerHTML = '<div class="empty">暂无模特，先新建一个</div>');
  box.innerHTML = models
    .map((m) => {
      const cover = m.photoKeys.length > 0 ? m.photoKeys[Math.floor(Math.random() * m.photoKeys.length)] : null;
      return `
      <div class="model-card" data-open-model="${m.id}">
        ${cover ? `<div class="model-cover"><img src="${mediaSrc({ kind: 'r2', value: cover })}" loading="lazy" /></div>` : '<div class="model-cover empty-cover">暂无照片</div>'}
        <div class="model-name">${esc(m.name)}</div>
        <div class="sub">${m.photoKeys.length} 张照片 · ${esc(m.createdAt.slice(0, 10))}</div>
        <div class="row">
          <button type="button" class="btn primary sm" data-use-model="${m.id}">用于新任务</button>
        </div>
      </div>`;
    })
    .join('');
  // 整卡可点击查看详情（按钮冒泡自行停止）
  box.querySelectorAll('.model-card').forEach((card) =>
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const m = models.find((x) => x.id === card.dataset.openModel);
      if (m) openModelDetailModal(m);
    }),
  );
  box.querySelectorAll('[data-use-model]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = models.find((x) => x.id === b.dataset.useModel);
      if (!m) return;
      pendingPersonRefs = m.photoKeys.map((k) => ({ kind: 'r2', value: k }));
      showToast(`已选用「${m.name}」的照片，去新建任务提交`);
      location.hash = '#/new';
    }),
  );
}

/**
 * 模特详情弹框：九宫格照片 + 个人信息。
 * 三个功能点：补充模特信息、补充照片、删除模特。
 */
function openModelDetailModal(model) {
  closeModal();
  let photoKeys = [...(model.photoKeys || [])];
  const info = model.info ?? {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-lg model-detail-modal">
      <header class="modal-head">
        <h3>模特 — ${esc(model.name)}</h3>
        <button type="button" class="modal-close" data-close>×</button>
      </header>
      <div class="modal-body">
        <div class="field">
          <label>照片 <span class="sub">（点击预览，底部可补充）</span></label>
          <div class="model-grid" id="md-photos"></div>
        </div>
        <div class="md-info-box">
          <div class="md-info-head">
            <h4>个人信息</h4>
            <button type="button" class="btn sm" id="md-toggle-edit">补充 / 编辑信息</button>
          </div>
          <div class="md-info-view" id="md-info-view"></div>
          <div class="md-info-form" id="md-info-form" hidden>
            <div class="field"><label>模特姓名</label><input id="md-name" type="text" value="${escAttr(model.name)}" /></div>
            <div class="model-info-grid">
              ${MODEL_INFO_FIELDS.map(([key, label]) => `<div class="field"><label>${esc(label)}</label><input class="md-f" name="${key}" type="text" value="${escAttr(info[key] ?? '')}" /></div>`).join('')}
            </div>
            <div class="actions">
              <button type="button" class="btn primary" id="md-save">保存信息</button>
              <span id="md-msg" class="msg"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn danger" id="md-del">删除模特</button>
        <label class="btn primary" id="md-add-photo">＋ 补充照片<input id="md-files" type="file" accept="image/*" hidden /></label>
        <button type="button" class="btn ghost" data-close>关闭</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => overlay.remove()));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const renderPhotos = () => {
    const box = overlay.querySelector('#md-photos');
    box.innerHTML = photoKeys.length
      ? photoKeys.map((k) => `<div class="md-photo"><img src="${mediaSrc({ kind: 'r2', value: k })}" loading="lazy" /></div>`).join('')
      : '<div class="empty">暂无照片</div>';
    box.querySelectorAll('.md-photo').forEach((el, i) =>
      el.addEventListener('click', () => showLightbox(mediaSrc({ kind: 'r2', value: photoKeys[i] }))),
    );
  };
  const renderInfoView = () => {
    const box = overlay.querySelector('#md-info-view');
    const filled = MODEL_INFO_FIELDS.map(([key, label]) => {
      const v = (model.info ?? {})[key];
      return v ? `<div class="kv"><span>${esc(label)}</span><b>${esc(v)}</b></div>` : null;
    }).filter(Boolean);
    box.innerHTML = filled.length ? filled.join('') : '<div class="empty">尚无可展示信息，点击“补充 / 编辑信息”填写</div>';
  };
  renderPhotos();
  renderInfoView();

  // 功能点之一：补充照片（label 隐式触发文件选择；上传后即时持久化）
  overlay.querySelector('#md-files').addEventListener('change', async () => {
    const file = overlay.querySelector('#md-files').files[0];
    if (!file) return;
    showToast('上传中…');
    const b64 = await compressImageFile(file);
    const res = await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, contentType: 'image/jpeg', data: b64 }),
    });
    overlay.querySelector('#md-files').value = '';
    if (res.ok && res.data.ref) {
      photoKeys.push(res.data.ref.value);
      renderPhotos();
      const up = await api(`/api/models/${model.id}`, {
        method: 'PUT',
        body: JSON.stringify({ photoKeys }),
      });
      showToast(up.ok ? '已补充一张照片' : (up.data.error || '保存失败'));
    } else {
      showToast(res.data.error || '上传失败');
    }
  });

  // 功能点之一：补充 / 编辑模特信息（查看区 ↔ 表单切换）
  overlay.querySelector('#md-toggle-edit').addEventListener('click', (e) => {
    const form = overlay.querySelector('#md-info-form');
    form.hidden = !form.hidden;
    overlay.querySelector('#md-info-view').hidden = form.hidden;
    e.currentTarget.textContent = form.hidden ? '补充 / 编辑信息' : '收起编辑';
  });
  overlay.querySelector('#md-save').addEventListener('click', async () => {
    const msg = overlay.querySelector('#md-msg');
    const infoObj = {};
    MODEL_INFO_FIELDS.forEach(([key]) => {
      const v = overlay.querySelector(`.md-f[name="${key}"]`).value.trim();
      if (v) infoObj[key] = v;
    });
    msg.className = 'msg';
    msg.textContent = '保存中…';
    const res = await api(`/api/models/${model.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: overlay.querySelector('#md-name').value.trim(), photoKeys, info: infoObj }),
    });
    if (!res.ok) {
      msg.className = 'msg err';
      msg.textContent = res.data.error || '保存失败';
      return;
    }
    msg.className = 'msg ok';
    msg.textContent = '已保存';
    model = { ...model, name: overlay.querySelector('#md-name').value.trim(), photoKeys, info: infoObj };
    renderInfoView();
    loadModels();
  });

  // 功能点之一：删除模特
  overlay.querySelector('#md-del').addEventListener('click', async () => {
    if (!confirm(`确认删除模特「${model.name}」？（照片文件保留于存储）`)) return;
    await api(`/api/models/${model.id}`, { method: 'DELETE' });
    overlay.remove();
    showToast(`已删除「${model.name}」`);
    loadModels();
  });
}

/** 全屏大图预览 */
function showLightbox(src) {
  const ov = document.createElement('div');
  ov.className = 'lightbox';
  ov.innerHTML = `<img src="${src}" /><button type="button" class="modal-close" data-close>×</button>`;
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) ov.remove(); });
  document.body.appendChild(ov);
}

function renderNew() {
  newJobState = { personRefs: pendingPersonRefs || [] };
  pendingPersonRefs = null;
  const view = $('#view');
  view.innerHTML = `
    <section class="hero"><div><h1>新建任务</h1><p class="sub">上传人物图 + 商品，自动生成试穿短视频</p></div></section>
    <section class="card">
      <form id="job-form">
        <div class="field">
          <label>人物图片 <span class="sub">（可多张，第一张作为试穿底图）</span></label>
          <div class="person-picker-row">
            <button type="button" class="btn" id="person-add">＋ 添加人物图片（选模特 / 上传）</button>
          </div>
          <div id="person-thumbs" class="uploads"></div>
        </div>
        <div class="field">
          <label>商品来源</label>
          <select id="garment-type">
            <option value="link" selected>电商链接（自动解析）</option>
            <option value="image">商品图片 URL</option>
          </select>
        </div>
        <div class="field">
          <label>商品图片或电商链接</label>
          <input id="garment-value" type="text" placeholder="https://item.jd.com/… 或商品图链接" />
        </div>
        <div class="row">
          <div class="field">
            <label>分辨率</label>
            <select id="resolution">
              <option value="1080p" selected>1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </select>
          </div>
          <div class="field">
            <label>时长（秒）</label>
            <select id="duration">
              <option value="15" selected>15</option>
              <option value="10">10</option>
              <option value="5">5</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>图生视频提示词</label>
          <div class="radio-row">
            <label class="pill"><input type="radio" name="promptmode" value="auto" checked />自动生成（推荐）</label>
            <label class="pill"><input type="radio" name="promptmode" value="custom" />自定义</label>
          </div>
          <p class="sub" id="prompt-desc">将根据商品标题、品类与所选时长自动生成，例如：</p>
          <div class="prompt-preview" id="prompt-preview"></div>
          <textarea id="prompt-custom" class="hidden" rows="4" placeholder="输入你的图生视频提示词，将替代自动生成的提示词…"></textarea>
        </div>
        <div class="actions">
          <button type="submit" class="btn primary">提交生成</button>
          <div id="form-msg" class="msg"></div>
        </div>
      </form>
    </section>`;

  $('#person-add').addEventListener('click', () => openPersonPicker());
  $('#garment-type').addEventListener('change', (e) => {
    $('#garment-value').placeholder = e.target.value === 'link' ? 'https://item.jd.com/… 或商品图链接' : 'https://…/garment.jpg';
  });
  $('#job-form').addEventListener('submit', onSubmitJob);

  // 图生视频提示词：自动（预览默认） / 自定义（文本域编辑）
  syncPromptPreview();
  const syncPromptMode = () => {
    const custom = document.querySelector('input[name="promptmode"]:checked')?.value === 'custom';
    $('#prompt-custom').classList.toggle('hidden', !custom);
    $('#prompt-desc').classList.toggle('hidden', custom);
    $('#prompt-preview').classList.toggle('hidden', custom);
  };
  document.querySelectorAll('input[name="promptmode"]').forEach((r) => r.addEventListener('change', syncPromptMode));
  $('#duration').addEventListener('change', syncPromptPreview);
  syncPromptMode();

  renderThumbs(); // 展示从模特库带入的照片
}

/** 渲染"自动生成"的图生视频提示词示例（与后端 composePrompt 模板保持一致） */
function syncPromptPreview() {
  const el = $('#prompt-preview');
  if (!el) return;
  const d = $('#duration')?.value || '15';
  el.textContent = `【女装电商展示】模特身着连衣裙（商品：标题，提交后自动填充），自然行走转身展示穿着效果，背景简洁干净，光线均匀，${d}秒运镜流畅，突出服装版型与细节，画面质感真实。`;
}

function renderThumbs() {
  const box = $('#person-thumbs');
  if (!box) return;
  box.innerHTML = newJobState.personRefs
    .map(
      (ref, i) => `
      <div class="upload-thumb">
        <img src="${mediaSrc(ref)}" />
        ${i === 0 ? '<span class="primary-tag">试穿底图</span>' : ''}
        <button type="button" class="thumb-del" data-i="${i}">×</button>
      </div>`,
    )
    .join('');
  box.querySelectorAll('.thumb-del').forEach((b) =>
    b.addEventListener('click', () => {
      newJobState.personRefs.splice(Number(b.dataset.i), 1);
      renderThumbs();
    }),
  );
}

/* ------- 人物图片选择弹框（选模特照片 / 上传单张） ------- */
function openPersonPicker() {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'person-picker';
  overlay.innerHTML = `
    <div class="modal">
      <header class="modal-head">
        <h3>添加人物图片</h3>
        <button type="button" class="modal-close" data-close>×</button>
      </header>
      <div class="modal-tabs">
        <button type="button" class="tab active" data-tab="models">选择模特</button>
        <button type="button" class="tab" data-tab="upload">上传照片</button>
      </div>
      <div class="modal-body">
        <div class="tab-pane" data-pane="models">
          <div class="picker-models"><div class="loading sm">载入模特中…</div></div>
        </div>
        <div class="tab-pane hidden" data-pane="upload">
          <div class="upload-single">
            <input id="picker-upload" type="file" accept="image/*" />
            <p class="sub">选择一张照片加入任务（自动压缩后上传）</p>
            <div id="picker-msg" class="msg"></div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      overlay.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      overlay.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
      if (t.dataset.tab === 'models') loadPickerModels(overlay);
    }),
  );

  const up = overlay.querySelector('#picker-upload');
  up.addEventListener('change', async () => {
    const file = up.files[0];
    if (!file) return;
    const msg = overlay.querySelector('#picker-msg');
    msg.className = 'msg';
    msg.textContent = '上传中…';
    const b64 = await compressImageFile(file);
    const res = await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, contentType: 'image/jpeg', data: b64 }),
    });
    if (res.ok && res.data.ref) {
      newJobState.personRefs.push(res.data.ref);
      renderThumbs();
      msg.className = 'msg ok';
      msg.textContent = '已添加';
      setTimeout(() => overlay.remove(), 600);
    } else {
      msg.className = 'msg err';
      msg.textContent = res.data.error || '上传失败';
    }
    up.value = '';
  });

  loadPickerModels(overlay);
}

async function loadPickerModels(overlay) {
  const box = overlay.querySelector('.picker-models');
  if (!box) return;
  const res = await api('/api/models');
  const models = res.data?.models ?? [];
  if (!models.length) {
    box.innerHTML = '<div class="empty">暂无模特，可切换到「上传照片」直接添加</div>';
    return;
  }
  box.innerHTML = models
    .map(
      (m) => `
      <div class="picker-model" data-id="${esc(m.id)}">
        <div class="picker-model-head">
          ${m.photoKeys[0] ? `<img class="picker-model-avatar" src="${mediaSrc({ kind: 'r2', value: m.photoKeys[0] })}" alt="" />` : '<span class="picker-model-avatar ph"></span>'}
          <div class="picker-model-meta">
            <div class="picker-model-name">${esc(m.name)}</div>
            <div class="sub">${m.photoKeys.length} 张照片</div>
          </div>
          <span class="picker-caret">▸</span>
        </div>
        <div class="picker-model-photos"></div>
      </div>`,
    )
    .join('');

  box.querySelectorAll('.picker-model').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('.picker-photo')) return; // 点击内部照片交给照片处理器
      el.classList.toggle('open');
      renderPickerModelPhotos(el, models.find((m) => m.id === el.dataset.id));
    }),
  );
}

function renderPickerModelPhotos(el, m) {
  const wrap = el.querySelector('.picker-model-photos');
  if (!m) return;
  wrap.innerHTML = m.photoKeys.length
    ? m.photoKeys
        .map((k) => {
          const picked = newJobState.personRefs.some((r) => r.value === k);
          return `<div class="picker-photo ${picked ? 'picked' : ''}" data-k="${esc(k)}">
            <img src="${mediaSrc({ kind: 'r2', value: k })}" />
            ${picked ? '<span class="picked-mark">✔ 已加</span>' : ''}
          </div>`;
        })
        .join('')
    : '<div class="empty">该模特暂无照片</div>';
  wrap.querySelectorAll('.picker-photo').forEach((p) =>
    p.addEventListener('click', (e) => {
      e.stopPropagation();
      const k = p.dataset.k;
      if (newJobState.personRefs.some((r) => r.value === k)) {
        showToast('该照片已在任务中');
        return;
      }
      newJobState.personRefs.push({ kind: 'r2', value: k });
      renderThumbs();
      showToast('已添加「' + m.name + '」的照片');
    }),
  );
}

function closeModal() {
  document.querySelector('.modal-overlay')?.remove();
}

async function onSubmitJob(e) {
  e.preventDefault();
  const msg = $('#form-msg');
  if (!newJobState.personRefs.length) {
    msg.className = 'msg err';
    msg.textContent = '请先上传至少一张人物图片';
    return;
  }
  const promptCustom = $('#prompt-custom').value.trim();
  const body = {
    personImages: newJobState.personRefs,
    garmentType: $('#garment-type').value,
    garmentValue: $('#garment-value').value.trim(),
    resolution: $('#resolution').value,
    duration: Number($('#duration').value),
    manualPublish: true, // 生成后由用户在任务详情页手动发布（发布平台取自全局配置）
  };
  // 仅在"自定义"模式下有非空输入时，才把用户提示词传给后端（否则自动生成）
  if ((document.querySelector('input[name="promptmode"]:checked')?.value ?? 'auto') === 'custom' && promptCustom) {
    body.prompt = promptCustom;
  }
  msg.className = 'msg';
  msg.textContent = '提交中…';
  const res = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    msg.className = 'msg err';
    msg.textContent = '创建失败：' + (res.data.error ?? res.status);
    return;
  }
  msg.className = 'msg';
  msg.textContent = '已提交 Workflow，跳转详情…';
  location.hash = `#/job/${res.data.job.id}`;
}

/* ---------------- 任务详情 ---------------- */
async function renderJobDetail(id) {
  const view = $('#view');
  view.innerHTML = `<div class="loading">载入中…</div>`;
  if (!id) {
    view.innerHTML = `<div class="empty">请从看板选择一个任务</div><a href="#/dashboard">← 返回看板</a>`;
    return;
  }
  let job = null;
  let polling = null;
  const tick = async () => {
    const res = await api(`/api/jobs/${id}`);
    if (res.ok && res.data) {
      job = res.data;
      paintJobDetail(view, job);
    }
    if (!job || !['queued', 'running'].includes(job.status)) {
      if (polling) clearInterval(polling);
    }
  };
  await tick();
  if (job && ['queued', 'running'].includes(job.status)) {
    polling = setInterval(tick, 4000);
  }
}

const STAGE_LABEL = { init: '初始化', parse: '解析', tryon: '试穿', video: '视频', publish: '发布', done: '完成' };

function paintJobDetail(view, job) {
  const idx = STAGE_ORDER.indexOf(job.stage);
  const dots = STAGE_ORDER.map((s, i) => {
    const cls = i < idx ? 'done' : i === idx && (job.status === 'running' || job.status === 'queued') ? 'active' : '';
    return `<span class="dot ${cls}">${STAGE_LABEL[s]}</span>`;
  }).join('<span class="dot-sep">→</span>');
  const canPublish = job.status === 'succeeded' && !!job.video?.output?.value;

  const people = (job.personImages?.length ? job.personImages : [job.personImage])
    .map((p) => (p?.value ? `<div><img class="thumb" src="${mediaSrc(p)}" /><span class="tag">人物</span></div>` : ''))
    .join('');
  const garment = job.parsed?.garmentImage?.value
    ? `<div><img class="thumb" src="${mediaSrc(job.parsed.garmentImage)}" /><span class="tag">商品</span></div>`
    : '';
  const tryon = job.tryOn?.output?.value
    ? `<div><img class="thumb" src="${mediaSrc(job.tryOn.output)}" /><span class="tag">试穿</span></div>`
    : '';
  const video = job.video?.output?.value
    ? `<div><video src="${mediaSrc(job.video.output)}" controls preload="metadata"></video>
        <span class="tag">成品</span>
        <button type="button" class="btn ghost sm" data-dl="${job.video.output.value}">下载视频</button></div>`
    : '';

  const pubRom =
    canPublish
      ? `<div class="pub-pick">
            <label class="field-t">选择发布平台</label>
            <div class="radio-row" id="pub-platforms">
              ${Object.keys(PLATFORM_LABEL)
                .map(
                  (pl) =>
                    `<label class="pill pub-check"><input type="checkbox" value="${pl}" />${platformLabel(pl)}</label>`,
                )
                .join('')}
            </div>
          </div>
          <div class="pub-edit">
            <div class="field"><label>标题</label><input class="pet" id="pp-title" value="${escAttr(job.parsed?.title ?? '')}" placeholder="默认用商品标题" /></div>
            <div class="field"><label>文案</label><textarea class="pet" id="pp-desc" rows="2" placeholder="视频正文 / 评论区引导文案"></textarea></div>
            <div class="field"><label>标签（逗号分隔）</label><input class="pet" id="pp-tags" placeholder="#穿搭 #试穿" /></div>
            <div class="row">
              <div class="field"><label>挂车商品 ID</label><input class="pet" id="pp-productId" placeholder="抖音/视频号带货商品ID" /></div>
              <div class="field"><label>账号（open_id）</label><input class="pet" id="pp-accountId" placeholder="留空用默认账号" /></div>
            </div>
          </div>
          <div class="rows-actions">
            <button type="button" class="btn primary" id="pub-go">发布到所选平台</button>
            <span class="puberr" id="puberr"></span>
          </div>
          <div class="pub-counts" id="pub-counts"></div>
          <table class="pub-table"><caption>发布记录</caption><thead><tr><th>平台</th><th>状态</th><th>时间</th><th>结果</th></tr></thead><tbody id="pub-logs"></tbody></table>`
      : '<div class="empty">任务生成完成后即可自由选择平台发布</div>';

  const prompt = job.video?.prompt;

  const canCancel = ['queued', 'running'].includes(job.status);

  view.innerHTML = `
    <a class="back" href="#/dashboard">← 返回看板</a>
    <section class="hero">
      <div><h1>${esc(job.parsed?.title ?? job.id.slice(0, 8))}</h1><p class="sub">${time(job.createdAt)} · ${esc(job.id.slice(0, 8))}</p></div>
      <div class="hero-actions">
        <span class="badge big ${job.status}">${job.status}</span>
        ${canCancel ? '<button class="btn ghost sm" id="cancel-job">终止任务</button>' : ''}
        <button class="btn danger sm" id="del-job">删除任务</button>
      </div>
    </section>
    <section class="card">
      <div class="stage-dots">${dots}</div>
      ${job.error ? `<div class="msg err">错误：${esc(job.error)}</div>` : ''}
      <div class="job-log">${esc(job.logs?.at(-1)?.msg ?? '')}</div>
    </section>
    <section class="card">
      <h2>素材与成品</h2>
      <div class="media">${people}${garment}${tryon}${video}</div>
    </section>
    ${prompt ? `
    <section class="card">
      <h2>生成提示词</h2>
      <div class="prompt-card"><span class="prompt-tag">电商展示</span><div class="prompt-text">${esc(prompt)}</div></div>
    </section>` : ''}
    <section class="card">
      <header class="list-head"><h2>发布</h2></header>
      <div class="pub-list">${pubRom}</div>
    </section>`;

  const goBtn = view.querySelector('#pub-go');
  if (goBtn) goBtn.addEventListener('click', () => publishSelected(job.id, view));
  loadPublishPanel(job.id, view);
  const cancelBtn = view.querySelector('#cancel-job');
  if (cancelBtn) cancelBtn.addEventListener('click', () => confirmCancel(job.id));
  const delBtn = view.querySelector('#del-job');
  if (delBtn) delBtn.addEventListener('click', () => confirmDelete(job.id));
}

/** 加载并渲染发布历史 + 各平台计数 */
async function loadPublishPanel(id, view) {
  const res = await api(`/api/jobs/${id}/publish`);
  const logsEl = view.querySelector('#pub-logs');
  const countsEl = view.querySelector('#pub-counts');
  if (!logsEl) return;
  const counts = res.data?.counts ?? {};
  const keyed = Object.fromEntries(
    Object.entries(counts).map(([p, c]) => [p, `${c.published} 成功 / ${c.failed} 失败`]),
  );
  if (countsEl) {
    countsEl.innerHTML = Object.keys(keyed).length
      ? Object.entries(keyed).map(([p, c]) => `<span class="pubcount-chip"><b>${platformLabel(p)}</b>${c}</span>`).join('')
      : '';
  }
  const logs = res.data?.logs ?? [];
  logsEl.innerHTML =
    logs
      .map(
        (l) =>
          `<tr>
            <td>${platformLabel(l.platform)}</td>
            <td><span class="badge ${l.status}">${l.status}</span></td>
            <td>${time(l.createdAt)}</td>
            <td class="sub">${l.url ? `<a href="${escAttr(l.url)}" target="_blank" rel="noopener">链接</a>` : ''}${l.error ? esc(l.error) : ''}</td>
          </tr>`,
      )
      .join('') || '<tr><td colspan="4" class="empty">暂无发布记录</td></tr>';
}

/** 发布到所选平台（可多次，同平台可重复发） */
async function publishSelected(id, view) {
  const errEl = view.querySelector('#puberr');
  const platforms = [...view.querySelectorAll('#pub-platforms input:checked')].map((c) => c.value);
  if (!platforms.length) {
    errEl.className = 'puberr';
    errEl.textContent = '请先勾选要发布的平台';
    return;
  }
  const content = {
    title: view.querySelector('#pp-title').value.trim() || undefined,
    desc: view.querySelector('#pp-desc').value.trim() || undefined,
    tags: tagsToArr(view.querySelector('#pp-tags').value),
    productId: view.querySelector('#pp-productId').value.trim() || undefined,
    accountId: view.querySelector('#pp-accountId').value.trim() || undefined,
  };
  errEl.className = 'puberr';
  errEl.textContent = '发布中…';
  const goBtn = view.querySelector('#pub-go');
  goBtn.disabled = true;
  const res = await api(`/api/jobs/${id}/publish`, { method: 'POST', body: JSON.stringify({ platforms, content }) });
  goBtn.disabled = false;
  if (!res.ok) {
    errEl.className = 'puberr';
    errEl.textContent = res.data.error ?? '发布失败';
    return;
  }
  const failed = (res.data.results ?? []).filter((r) => r.status === 'failed').map((r) => platformLabel(r.platform)).join('、');
  errEl.className = failed ? 'puberr' : 'puberr ok';
  errEl.textContent = failed ? `发布失败：${failed}` : '发布完成';
  loadPublishPanel(id, view);
}

function tagsToArr(v) {
  return v ? v.split(/[,，\s#]+/).map((x) => x.trim()).filter(Boolean) : undefined;
}

async function confirmDelete(id) {
  if (!confirm('将任务移入回收站？媒体文件会保留，可在回收站恢复或彻底删除。')) return;
  const res = await api(`/api/jobs/${id}`, { method: 'DELETE', body: '{}' });
  if (!res.ok) {
    alert(res.data.error ?? '删除失败');
    return;
  }
  const route = (location.hash || '#/dashboard').split('?')[0];
  if (route === '#/dashboard' || route === '#/jobs') {
    renderDashboard();
  } else {
    location.hash = '#/dashboard';
  }
}

async function confirmCancel(id) {
  if (!confirm('确定终止此任务？正在进行的生成/发布将被中断，且无法恢复。')) return;
  const res = await api(`/api/jobs/${id}/cancel`, { method: 'POST', body: '{}' });
  if (!res.ok) {
    alert(res.data.error ?? '终止失败');
    return;
  }
  const route = (location.hash || '#/dashboard').split('?')[0];
  if (route === '#/dashboard' || route === '#/jobs') renderDashboard();
  else renderJobDetail(id);
}

/* ---------------- 配置 ---------------- */
function renderConfig() {
  const view = $('#view');
  view.innerHTML = `
    <section class="hero"><div><h1>第三方 Key 配置</h1><p class="sub">写入数据库（D1），运行优先于环境变量</p></div></section>
    <a class="back" href="#/dashboard">← 返回看板</a>
    <section class="card config-card">
      <form id="config-form" class="config-grid"></form>
    </section>`;

  const form = $('#config-form');
  form.innerHTML =
    CONFIG_FIELDS.map(
      ([key, label]) => `
      <label class="cfg-item">
        <span>${esc(label)} <code>${key}</code></span>
        <div class="cfg-row">
          <input type="password" name="${key}" autocomplete="new-password" placeholder="未配置" />
          <button type="button" class="cfg-clear" data-key="${key}">清除</button>
        </div>
      </label>`,
    ).join('') +
    `<div class="cfg-actions"><button type="submit" class="btn primary">保存配置</button><button type="button" id="cfg-reveal" class="btn">查看明文</button><span id="config-msg" class="msg"></span></div>`;

  api('/api/config').then((r) => applyConfigState(form, r.data, false));

  form.addEventListener('click', (e) => {
    const btn = e.target.closest('.cfg-clear');
    if (btn) {
      form.querySelector(`input[name="${btn.dataset.key}"]`).value = '__CLEAR__';
      configRevealed = false;
      saveConfig();
    }
  });
  const revealBtn = form.querySelector('#cfg-reveal');
  if (revealBtn) {
    revealBtn.addEventListener('click', () => {
      configRevealed = !configRevealed;
      revealBtn.textContent = configRevealed ? '隐藏明文' : '查看明文';
      api('/api/config' + (configRevealed ? '?reveal=1' : '')).then((r) => applyConfigState(form, r.data, configRevealed));
    });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveConfig();
  });
}

function applyConfigState(form, data, reveal) {
  for (const k of data.keys || []) {
    const inp = form.querySelector(`input[name="${k.key}"]`);
    if (!inp) continue;
    if (inp.value === '__CLEAR__') inp.value = '';
    if (reveal && k.set) {
      inp.type = 'text';
      inp.value = k.masked; // 后端 reveal=1 时 masked 字段即为明文
      inp.placeholder = '已配置';
    } else {
      inp.type = 'password';
      inp.value = '';
      inp.placeholder = k.set ? '已配置（留空不变）' : '未配置';
    }
    inp.classList.toggle('set', !!k.set);
  }
}

async function saveConfig() {
  const form = $('#config-form');
  if (!form) return;
  const values = {};
  for (const [key] of CONFIG_FIELDS) {
    const v = form.querySelector(`input[name="${key}"]`)?.value ?? '';
    if (v === '__CLEAR__') values[key] = '';
    else if (v) values[key] = v;
  }
  const msg = $('#config-msg');
  msg.className = 'msg';
  msg.textContent = '保存中…';
  const res = await api('/api/config', { method: 'POST', body: JSON.stringify({ values }) });
  msg.className = res.ok ? 'msg' : 'msg err';
  msg.textContent = res.ok ? '已保存到数据库。' : '保存失败：' + (res.data.error ?? res.status);
  setTimeout(() => (msg.textContent = ''), 3000);
  if (res.ok) {
    const s = await api('/api/config');
    applyConfigState(form, s.data);
  }
}

/* ---------------- 工具 ---------------- */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// 压缩图片为 JPEG dataURL：最长边 ≤1600px、质量 0.85，确保试穿接口图片 ≤5MB
async function compressImageFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const MAX = 1600;
    let { width, height } = img;
    if (width > MAX || height > MAX) {
      const scale = Math.min(MAX / width, MAX / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 挂全局，供 hashchange 之前的首个渲染使用
document.querySelectorAll('.job-item')?.forEach((el) => el.addEventListener('click', () => (location.hash = `#/job/${el.dataset.id}`)));
document.addEventListener('click', (e) => {
  const delBtn = e.target.closest('.del-quick');
  if (delBtn && delBtn.dataset.del) {
    e.preventDefault();
    e.stopPropagation();
    confirmDelete(delBtn.dataset.del);
    return;
  }
  const cancelBtn = e.target.closest('.cancel-quick');
  if (cancelBtn) {
    e.preventDefault();
    e.stopPropagation();
    confirmCancel(cancelBtn.dataset.cancel);
    return;
  }
  const publishBtn = e.target.closest('.publish-quick');
  if (publishBtn) {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `#/job/${publishBtn.dataset.publish}`;
    return;
  }
  const item = e.target.closest('.job-item');
  if (item) location.hash = `#/job/${item.dataset.id}`;

  // 视频/图片下载：前端 fetch 二进制流 → blob 下载，绕开浏览器 download 属性/WebView 拦成 HTML 的问题
  const dlBtn = e.target.closest('[data-dl]');
  if (dlBtn && dlBtn.dataset.dl) {
    e.preventDefault();
    e.stopPropagation();
    forceDownload(dlBtn);
  }
});

/** 强制下载：取得原始字节后以 blob 保存，保证文件为视频/图片二进制而非 HTML */
async function forceDownload(btn) {
  const key = btn.dataset.dl;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    const res = await fetch(`/media/${key}?download=1`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = key.split('/').pop() || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert('下载失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}