// app.js — 前端逻辑：新建任务 + 任务列表轮询（对接 Worker /api/ 接口）
const $ = (sel) => document.querySelector(sel);

const STAGE_ORDER = ['init', 'parse', 'tryon', 'video', 'publish', 'done'];

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

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok && res.status !== 500) return { error: res.statusText };
  return res.json().catch(() => ({}));
}

function stageIndex(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i < 0 ? 0 : i;
}

function renderPlatforms(list) {
  const box = $('#platforms');
  box.innerHTML = list
    .map(
      (p) =>
        `<span class="chip ${p.ready ? 'on' : 'off'}">${label(p.platform)}${p.ready ? '·就绪' : '·未配置'}</span>`,
    )
    .join('');
}

function label(p) {
  return { douyin: '抖音', xiaohongshu: '小红书', weixin: '视频号' }[p] ?? p;
}

function mediaHTML(job) {
  const thumbs = [];
  if (job.personImage?.value) {
    thumbs.push({ tag: '人物', src: mediaSrc(job.personImage) });
  }
  if (job.parsed?.garmentImage) {
    thumbs.push({ tag: '商品', src: mediaSrc(job.parsed.garmentImage) });
  }
  if (job.tryOn?.output) {
    thumbs.push({ tag: '试穿', src: mediaSrc(job.tryOn.output) });
  }
  const cards = thumbs
    .map((t) => `<div><img class="thumb" src="${t.src}" loading="lazy" /><span class="tag">${t.tag}</span></div>`)
    .join('');
  const video = job.video?.output
    ? `<div><video src="${mediaSrc(job.video.output)}" controls preload="metadata"></video><span class="tag">成品视频</span></div>`
    : '';
  return `<div class="media">${cards}${video}</div>`;
}

function mediaSrc(ref) {
  return ref?.kind === 'r2' ? `/media/${ref.value}` : ref?.value ?? '';
}

function renderJob(job) {
  const idx = stageIndex(job.stage);
  const dots = STAGE_ORDER.map(
    (s, i) =>
      `<span class="dot ${i < idx ? 'done' : i === idx && (job.status === 'running' || job.status === 'queued') ? 'active' : ''}">${s}</span>`,
  ).join('');

  const pub = (job.publish || [])
    .map((t) => `<span class="${t.status}">${label(t.platform)}·${t.status}</span>`)
    .join('');

  const lastLog = job.logs?.length ? job.logs[job.logs.length - 1].msg : '';
  const err = job.error ? `<div class="job-log">错误：${job.error}</div>` : '';

  const el = document.createElement('div');
  el.className = 'job';
  el.dataset.id = job.id;
  el.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title">${escapeHtml(job.parsed?.title ?? job.id)}</div>
        <div class="job-meta"><code>${job.id.slice(0, 8)}</code> · 创建 ${(job.createdAt || '').slice(0, 19).replace('T', ' ')} · 状态 <b>${job.status}</b></div>
      </div>
      <div class="job-actions">
        <span class="badge ${job.status}">${job.status}</span>
        <button data-act="cancel">取消</button>
        <button data-act="delete">删除</button>
      </div>
    </div>
    <div class="stage-dots" title="流程阶段：${STAGE_ORDER.join(' > ')}">${dots}</div>
    <div class="job-log">${escapeHtml(lastLog)}</div>
    ${err}
    ${mediaHTML(job)}
    ${pub ? `<div class="pub">${pub}</div>` : ''}
  `;
  el.querySelector('[data-act="cancel"]').addEventListener('click', () => cancelJob(job.id));
  el.querySelector('[data-act="delete"]').addEventListener('click', () => deleteJob(job.id));
  return el;
}

async function loadJobs() {
  const status = $('#status-filter').value;
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await api(`/api/jobs${q}`);
  const box = $('#jobs');
  if (data.error) {
    box.innerHTML = `<div class="empty">加载失败：${data.error}</div>`;
    return;
  }
  if (!data.items?.length) {
    box.innerHTML = '<div class="empty">暂无任务</div>';
    return;
  }
  box.innerHTML = '';
  for (const j of data.items) box.appendChild(renderJob(j));
}

async function cancelJob(id) {
  await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
  loadJobs();
}
async function deleteJob(id) {
  await api(`/api/jobs/${id}`, { method: 'DELETE' });
  loadJobs();
}

function initForm() {
  $('#garment-type').addEventListener('change', (e) => {
    const isLink = e.target.value === 'link';
    const ph = isLink
      ? 'https://item.jd.com/… 或直接商品图链接，支持京东/淘宝/拼多多等'
      : 'https://…/garment.jpg';
    $('input[name="garment_value"]').placeholder = ph;
  });

  $('#job-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      personImageURL: fd.get('person_image_url'),
      garmentType: fd.get('garment_type'),
      garmentValue: fd.get('garment_value'),
      resolution: fd.get('resolution'),
      duration: Number(fd.get('duration')),
      withSound: fd.get('with_sound') === 'on',
      publish: fd.getAll('publish'),
    };
    const msgEl = $('#form-msg');
    msgEl.className = 'msg';
    msgEl.textContent = '提交中…';
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      msgEl.className = 'msg err';
      msgEl.textContent = '创建失败：' + (data.error ?? res.status);
      return;
    }
    msgEl.className = 'msg';
    msgEl.textContent = '已提交，Workflow 已启动。';
    e.target.reset();
    loadJobs();
    setTimeout(() => (msgEl.textContent = ''), 4000);
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initConfig() {
  const form = $('#config-form');
  const grid = CONFIG_FIELDS.map(
    ([key, labelTxt]) => `
    <label class="cfg-item">
      <span>${esc(labelTxt)} <code>${key}</code></span>
      <div class="cfg-row">
        <input type="password" name="${key}" autocomplete="new-password" placeholder="未配置" />
        <button type="button" class="cfg-clear" data-key="${key}" title="从数据库清除该 key">清除</button>
      </div>
    </label>`,
  ).join('');
  const tokenRow = `
    <label class="cfg-item">
      <span>配置访问令牌 <code>CONFIG_TOKEN</code>（可选）</span>
      <input type="password" name="config_token" autocomplete="new-password" placeholder="仅当 Worker 设了 CONFIG_TOKEN 时填写" />
    </label>`;
  form.innerHTML =
    grid +
    tokenRow +
    `<div class="cfg-actions"><button type="submit" class="primary">保存配置</button><span id="config-msg" class="msg"></span></div>`;

  api('/api/config').then((data) => loadConfigState(form, data));

  form.addEventListener('click', (e) => {
    const btn = e.target.closest('.cfg-clear');
    if (btn) {
      const inp = form.querySelector(`input[name="${btn.dataset.key}"]`);
      inp.value = '__CLEAR__';
      saveConfigValues();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveConfigValues();
  });
}

function loadConfigState(form, data) {
  for (const k of data.keys || []) {
    const inp = form.querySelector(`input[name="${k.key}"]`);
    if (!inp) continue;
    if (inp.value === '__CLEAR__') inp.value = '';
    inp.placeholder = k.set ? '已配置（留空则不变）' : '未配置';
    inp.classList.toggle('set', !!k.set);
  }
}

async function saveConfigValues() {
  const form = $('#config-form');
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
  const res = await fetch('/api/config', { method: 'POST', headers, body: JSON.stringify({ values }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    msg.className = 'msg err';
    msg.textContent = '保存失败：' + (data.error ?? res.status);
    return;
  }
  msg.className = 'msg';
  msg.textContent = '已保存到数据库。';
  setTimeout(() => (msg.textContent = ''), 3000);
  form.querySelector('input[name="config_token"]').value = '';
  const s = await api('/api/config');
  loadConfigState(form, s);
  const platforms = await api('/api/platforms');
  if (platforms.platforms) renderPlatforms(platforms.platforms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function boot() {
  initForm();
  initConfig();
  $('#refresh').addEventListener('click', loadJobs);
  $('#status-filter').addEventListener('change', loadJobs);
  const s = await api('/api/settings');
  if (!s.error) {
    // 可选：用 /api/settings 填充分辨率/时长选项（此处保持静态即可）
  }
  loadJobs();
  const platforms = await api('/api/platforms');
  if (platforms.platforms) renderPlatforms(platforms.platforms);
  setInterval(loadJobs, 6000);
}

boot();