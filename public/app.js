// app.js — 前端：看板 / 新建任务(多图上传+手动发布) / 任务详情(下载+手动发布+提示词可视化) / 配置
const $ = (sel, root = document) => root.querySelector(sel);

const STAGE_ORDER = ['init', 'parse', 'tryon', 'video', 'publish', 'done'];
const PLATFORM_LABEL = { douyin: '抖音', xiaohongshu: '小红书', weixin: '视频号' };
const ACCESS_KEY = sessionStorage.getItem('app_access_key') || '';

const CONFIG_FIELDS = [
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
        <h1>🔐 请输入访问密钥</h1>
        <p class="sub">密钥配置在 Cloudflare 参数（APP_ACCESS_KEY）中，验证通过后才能使用系统</p>
        <input type="password" id="login-key" autocomplete="current-password" placeholder="访问密钥" />
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
  const hash = (location.hash || '#/dashboard').replace(/^#/, '');
  const [path, arg] = hash.slice(1).split('/');
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('active', path === a.dataset.nav);
  }
  const handler = routes[path] || renderDashboard;
  handler(arg);
}

/* ---------------- 看板 ---------------- */
async function renderDashboard() {
  const view = $('#view');
  view.innerHTML = `<div class="loading">载入中…</div>`;
  const [jobsRes, platRes] = await Promise.all([api('/api/jobs?limit=100'), api('/api/platforms')]);
  const items = jobsRes.data.items ?? [];
  const statusCount = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const j of items) statusCount[j.status] = (statusCount[j.status] || 0) + 1;
  const total = items.length || 0;
  const running = statusCount.running + statusCount.queued;

  const pats = (platRes.data.platforms ?? [])
    .map((p) => `<span class="chip ${p.ready ? 'on' : 'off'}">${platformLabel(p.platform)}${p.ready ? '' : '·未配置'}</span>`)
    .join('');

  const cards = [
    ['总任务', total, 'total'],
    ['进行中', running, 'run'],
    ['已完成', statusCount.succeeded + statusCount.failed + statusCount.canceled, 'ok'],
    ['失败', statusCount.failed, 'err'],
  ]
    .map(([l, v, c]) => `<div class="stat ${c}"><span class="stat-num">${v}</span><span class="stat-label">${l}</span></div>`)
    .join('');

  const recent =
    items.slice(0, 8).map(jobCard).join('') || '<div class="empty">暂无任务</div>';

  view.innerHTML = `
    <section class="hero">
      <div>
        <h1>工作台</h1>
        <p class="sub">人物图 × 电商链接 → 15s 试穿短视频 → 多平台发布</p>
      </div>
      <a class="btn primary" href="#/new">＋ 新建任务</a>
    </section>
    <section class="stats">${cards}</section>
    <section class="pipeline-note">
      <div>
        <h3>生成流程</h3>
        <p class="sub">解析商品 → 虚拟试穿 → 图生视频 → 发布</p>
      </div>
      <div class="platforms">${pats}</div>
    </section>
    <section class="card">
      <header class="list-head">
        <h2>最近任务</h2>
        <a class="btn ghost" href="#/job">查看全部</a>
      </header>
      <div class="jobs">${recent}</div>
    </section>`;
}

function jobCard(job) {
  const last = job.logs?.length ? job.logs[job.logs.length - 1].msg : '';
  const first = job.personImages?.[0] ?? job.personImage;
  const th = job.video?.output
    ? `<video src="${mediaSrc(job.video.output)}" preload="metadata" class="thumb-v"></video>`
    : job.tryOn?.output
      ? `<img class="thumb" src="${mediaSrc(job.tryOn.output)}" />`
      : first?.value
        ? `<img class="thumb" src="${mediaSrc(first)}" />`
        : '';
  const canCancel = ['queued', 'running'].includes(job.status);
  return `
    <div class="job-item" data-id="${job.id}">
      ${th}
      <div class="job-item-body">
        <div class="job-title">${esc(job.parsed?.title ?? job.id.slice(0, 8))}</div>
        <span class="badge ${job.status}">${job.status}</span>
        <div class="sub">${esc(last) || time(job.createdAt)}</div>
      </div>
      <div class="item-ops">
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
    if (!confirm(`确定彻底删除回收站中的 ${items.length} 个任务？将同时清理其媒体文件，不可恢复。`)) return;
    Promise.all(items.map((j) => api(`/api/jobs/${j.id}/purge`, { method: 'POST', body: '{}' }))).then(renderRecycle);
  });
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
  if (!confirm('彻底删除此任务？将同时清理其媒体文件，不可恢复。')) return;
  const res = await api(`/api/jobs/${id}/purge`, { method: 'POST', body: '{}' });
  if (!res.ok) { alert(res.data.error ?? '删除失败'); return; }
  renderRecycle();
}

/* ---------------- 新建任务 ---------------- */
let newJobState = { personRefs: [] };

function renderNew() {
  newJobState = { personRefs: [] };
  const view = $('#view');
  view.innerHTML = `
    <section class="hero"><div><h1>新建任务</h1><p class="sub">上传人物图 + 商品，自动生成试穿短视频</p></div></section>
    <section class="card">
      <form id="job-form">
        <div class="field">
          <label>人物图片 <span class="sub">（支持多张，第一张作为试穿底图）</span></label>
          <input id="person-files" type="file" accept="image/*" multiple />
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
          <label>发布方式</label>
          <div class="radio-row">
            <label class="pill"><input type="radio" name="pubmode" value="auto" />生成后自动发布</label>
            <label class="pill"><input type="radio" name="pubmode" value="manual" checked />生成后手动发布（推荐）</label>
          </div>
        </div>
        <div class="field">
          <label>发布到</label>
          <div class="radio-row">
            <label class="pill"><input type="checkbox" class="pub-check" value="douyin" checked />抖音（挂车）</label>
            <label class="pill"><input type="checkbox" class="pub-check" value="xiaohongshu" />小红书</label>
            <label class="pill"><input type="checkbox" class="pub-check" value="weixin" />视频号</label>
          </div>
        </div>
        <div class="actions">
          <button type="submit" class="btn primary">提交生成</button>
          <div id="form-msg" class="msg"></div>
        </div>
      </form>
    </section>`;

  const files = $('#person-files');
  files.addEventListener('change', async () => {
    const errBox = $('#upload-error');
    if (errBox) errBox.remove();
    const pending = [...files.files];
    for (const file of pending) {
      const b64 = await readAsDataURL(file);
      const res = await api('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, contentType: file.type, data: b64 }),
      });
      if (res.ok && res.data.ref) {
        newJobState.personRefs.push(res.data.ref);
      } else {
        if (res.status === 401) {
          forceLogout('登录已失效，请重新输入访问密钥');
          return;
        }
        const err = document.createElement('div');
        err.id = 'upload-error';
        err.className = 'msg err';
        err.textContent = `「${file.name}」上传失败：${res.data.error || '服务端错误'}`;
        $('#person-thumbs').parentElement.appendChild(err);
      }
    }
    renderThumbs();
    files.value = '';
  });
  $('#garment-type').addEventListener('change', (e) => {
    $('#garment-value').placeholder = e.target.value === 'link' ? 'https://item.jd.com/… 或商品图链接' : 'https://…/garment.jpg';
  });
  $('#job-form').addEventListener('submit', onSubmitJob);
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

async function onSubmitJob(e) {
  e.preventDefault();
  const msg = $('#form-msg');
  if (!newJobState.personRefs.length) {
    msg.className = 'msg err';
    msg.textContent = '请先上传至少一张人物图片';
    return;
  }
  const publish = [...document.querySelectorAll('.pub-check:checked')].map((c) => c.value);
  const manual = (document.querySelector('input[name="pubmode"]:checked')?.value ?? 'manual') === 'manual';
  const body = {
    personImages: newJobState.personRefs,
    garmentType: $('#garment-type').value,
    garmentValue: $('#garment-value').value.trim(),
    resolution: $('#resolution').value,
    duration: Number($('#duration').value),
    manualPublish: manual,
    publish,
  };
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
        <a class="btn ghost sm" href="/media/${job.video.output.value}?download=1" download>下载视频</a></div>`
    : '';

  const pubRom =
    (job.publish || [])
      .map((t) => {
        const can = canPublish && t.status !== 'published';
        return `
        <div class="pub-row">
          <div><div class="pub-name">${platformLabel(t.platform)}</div>
            <div class="sub">${t.error ? esc(t.error) : ''}</div></div>
          <span class="badge ${t.status}">${t.status}</span>
          ${can ? `<button class="btn sm" data-pub="${t.platform}">发布</button>` : ''}
        </div>`;
      })
      .join('') || '<div class="empty">未选择发布平台</div>';

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
      <header class="list-head"><h2>发布</h2>
        ${canPublish ? '<button class="btn primary sm" id="pub-all">发布待发布项</button>' : ''}
      </header>
      <div class="pub-list">${pubRom}</div>
    </section>`;

  view.querySelectorAll('[data-pub]').forEach((b) => b.addEventListener('click', () => triggerPublish(job.id, b.dataset.pub)));
  const pubAll = view.querySelector('#pub-all');
  if (pubAll) pubAll.addEventListener('click', () => triggerPublish(job.id));
  const cancelBtn = view.querySelector('#cancel-job');
  if (cancelBtn) cancelBtn.addEventListener('click', () => confirmCancel(job.id));
  const delBtn = view.querySelector('#del-job');
  if (delBtn) delBtn.addEventListener('click', () => confirmDelete(job.id));
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

async function triggerPublish(id, onlyPlatform) {
  const res = await api(`/api/jobs/${id}/publish`, {
    method: 'POST',
    body: onlyPlatform ? JSON.stringify({ platform: onlyPlatform }) : '{}',
  });
  if (!res.ok) {
    alert(res.data.error ?? '发布失败');
    return;
  }
  renderJobDetail(id);
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
    `<label class="cfg-item">
      <span>写保护令牌 <code>CONFIG_TOKEN</code>（可选）</span>
      <input type="password" name="config_token" autocomplete="new-password" placeholder="仅当设了 CONFIG_TOKEN 时填写" />
    </label>` +
    `<div class="cfg-actions"><button type="submit" class="btn primary">保存配置</button><span id="config-msg" class="msg"></span></div>`;

  api('/api/config').then((r) => applyConfigState(form, r.data));

  form.addEventListener('click', (e) => {
    const btn = e.target.closest('.cfg-clear');
    if (btn) {
      form.querySelector(`input[name="${btn.dataset.key}"]`).value = '__CLEAR__';
      saveConfig();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveConfig();
  });
}

function applyConfigState(form, data) {
  for (const k of data.keys || []) {
    const inp = form.querySelector(`input[name="${k.key}"]`);
    if (!inp) continue;
    if (inp.value === '__CLEAR__') inp.value = '';
    inp.placeholder = k.set ? '已配置（留空不变）' : '未配置';
    inp.classList.toggle('set', !!k.set);
  }
}

async function saveConfig() {
  const form = $('#config-form');
  if (!form) return;
  const token = form.querySelector('input[name="config_token"]')?.value || '';
  const values = {};
  for (const [key] of CONFIG_FIELDS) {
    const v = form.querySelector(`input[name="${key}"]`)?.value ?? '';
    if (v === '__CLEAR__') values[key] = '';
    else if (v) values[key] = v;
  }
  const msg = $('#config-msg');
  msg.className = 'msg';
  msg.textContent = '保存中…';
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await api('/api/config', { method: 'POST', headers, body: JSON.stringify({ values }) });
  msg.className = res.ok ? 'msg' : 'msg err';
  msg.textContent = res.ok ? '已保存到数据库。' : '保存失败：' + (res.data.error ?? res.status);
  setTimeout(() => (msg.textContent = ''), 3000);
  if (res.ok) {
    form.querySelector('input[name="config_token"]').value = '';
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
  const item = e.target.closest('.job-item');
  if (item) location.hash = `#/job/${item.dataset.id}`;
});