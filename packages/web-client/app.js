/**
 * ZCode Remote Web 客户端（模拟手机端；与未来 Android 使用同一 /v1 API）。
 * 状态机对齐 PRD §6.1：连接状态与任务运行状态分离；SSE 断线补发 + resync。
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = {
  token: localStorage.getItem('zr-token') || '',
  baseUrl: localStorage.getItem('zr-base') || location.origin,

  async req(path, opts = {}) {
    const res = await fetch(this.baseUrl + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(body?.message || `HTTP ${res.status}`);
      err.code = body?.code;
      err.status = res.status;
      throw err;
    }
    return body;
  },
  get(p) { return this.req(p); },
  post(p, body) { return this.req(p, { method: 'POST', body: JSON.stringify(body) }); },
};

const state = {
  view: 'host',
  projectId: null,
  taskId: null,
  tasks: [],
  projects: [],
  sse: null,
  sseCursor: 0,
  backoffMs: 1000,
  draftKey: 'zr-draft-',
};

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function setConn(cls, text) {
  const el = $('#conn-state');
  el.className = `badge ${cls}`;
  el.textContent = text;
}

function setCtx(host, project) {
  $('#ctx-host').textContent = host || '';
  $('#ctx-project').textContent = project || '';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

async function checkConnection() {
  try {
    const h = await fetch(`${api.baseUrl}/v1/health`).then((r) => r.json());
    if (!h.ok) {
      setConn('offline', '引擎离线');
      return false;
    }
    await api.get('/v1/capabilities');
    setConn('online', '在线');
    state.backoffMs = 1000;
    return true;
  } catch (e) {
    if (e.status === 401) {
      setConn('unauthorized', '未配对/已撤销');
      localStorage.removeItem('zr-token');
      api.token = '';
      renderPair();
    } else {
      setConn('offline', '主机不可达');
    }
    return false;
  }
}

function connectSse() {
  if (state.sse) state.sse.close();
  if (!api.token) return;
  const es = new EventSource(`${api.baseUrl}/v1/events?after=${state.sseCursor}&token=${encodeURIComponent(api.token)}`);
  es.addEventListener('gateway', (ev) => {
    const data = JSON.parse(ev.data);
    if (data.streamSeq > state.sseCursor) state.sseCursor = data.streamSeq;
    onGatewayEvent(data);
  });
  es.addEventListener('resync', () => {
    // 游标超出保留窗口：全量校准（PRD §7.3）
    refreshCurrentView();
  });
  es.addEventListener('synced', () => setConn('online', '在线'));
  es.onerror = () => {
    setConn('reconnecting', '重连中…');
    es.close();
    setTimeout(connectSse, state.backoffMs);
    state.backoffMs = Math.min(state.backoffMs * 2, 15000);
  };
  state.sse = es;
}

function onGatewayEvent(e) {
  // 只刷新当前视图相关数据；会话页实时追加
  if (state.view === 'session' && e.taskId === state.taskId) {
    if (e.kind === 'assistant_delta') {
      const box = $('#stream-tail');
      if (box) box.textContent += e.payload.delta ?? '';
      return;
    }
    if (e.kind === 'user_message' || e.kind === 'assistant_message' || e.kind === 'run_succeeded' ||
        e.kind === 'run_failed' || e.kind === 'turn_complete' || e.kind === 'approval_requested') {
      loadSession(state.taskId, { silent: true });
      return;
    }
  }
  if (state.view === 'tasks' || state.view === 'projects') refreshCurrentView();
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

function renderPair() {
  $('#view').innerHTML = `
    <div class="card">
      <h3>配对设备</h3>
      <p class="meta">在 Mac 上运行 <code>zremote pair</code> 获取一次性配对码（5 分钟内有效）。</p>
      <input id="pair-code" placeholder="配对码（8 位）" autocomplete="off">
      <input id="pair-name" placeholder="设备名称（如 我的手机）" autocomplete="off">
      <div class="row" style="margin-top:10px">
        <button id="pair-go">配对</button>
        <span id="pair-msg" class="err-text"></span>
      </div>
    </div>`;
  $('#pair-go').onclick = async () => {
    try {
      const r = await fetch(`${api.baseUrl}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: $('#pair-code').value.trim(), deviceName: $('#pair-name').value.trim() || 'web-client' }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.message);
      api.token = body.token;
      localStorage.setItem('zr-token', body.token);
      boot();
    } catch (e) {
      $('#pair-msg').textContent = e.message;
    }
  };
}

async function renderHost() {
  setCtx(api.baseUrl, '');
  let caps = null;
  try { caps = await api.get('/v1/capabilities'); } catch { /* 显示离线 */ }
  $('#view').innerHTML = `
    <div class="card">
      <h3>主机</h3>
      <div class="meta">${esc(api.baseUrl)}</div>
      ${caps ? `<div class="row" style="margin-top:8px">
        <span class="pill">后端 ${esc(caps.backendId)}</span>
        <span class="pill">${caps.compatible ? '版本兼容' : '不兼容：' + esc(caps.compatibleDetail || '')}</span>
      </div>
      <div class="meta" style="margin-top:8px">
        续聊 ${caps.supportsSessionResume ? '✓' : '✗'} · 审批 ${caps.supportsApproval ? '✓' : '✗'} ·
        停止 ${caps.supportsCancel ? '✓' : '✗'} · 追加 ${caps.supportsQueue ? '排队' : '✗'}
      </div>` : ''}
      <div class="row" style="margin-top:10px">
        <button class="secondary" id="go-projects">项目 →</button>
        <button class="danger" id="unpair">清除本机凭据</button>
      </div>
    </div>`;
  $('#go-projects').onclick = () => nav('projects');
  $('#unpair').onclick = () => {
    localStorage.removeItem('zr-token');
    api.token = '';
    renderPair();
  };
}

async function renderProjects() {
  let projects = [];
  try { ({ projects } = await api.get('/v1/projects')); } catch (e) { /* offline notice */ }
  state.projects = projects;
  $('#view').innerHTML = `
    <button class="back" id="back">← 主机</button>
    ${projects.length === 0 ? '<div class="empty">暂无已授权项目</div>' : projects.map((p) => `
      <div class="card clickable" data-id="${esc(p.nativeWorkspaceId)}">
        <h3>${esc(p.name)}</h3>
        <div class="meta">${esc(p.rootDir)}</div>
        ${p.accessible ? '' : `<div class="err-text">不可接入：${esc(p.inaccessibleReason || '未知原因')}</div>`}
        <div class="meta">同步于 ${fmtTime(p.lastSyncedAt)}</div>
      </div>`).join('')}`;
  $('#back').onclick = () => nav('host');
  document.querySelectorAll('[data-id]').forEach((el) => {
    el.onclick = () => {
      const p = projects.find((x) => x.nativeWorkspaceId === el.dataset.id);
      if (!p?.accessible) return;
      state.projectId = p.nativeWorkspaceId;
      nav('tasks');
    };
  });
  if (state.projectId) {
    const cur = projects.find((p) => p.nativeWorkspaceId === state.projectId);
    if (cur) setCtx(api.baseUrl, cur.name);
  }
}

async function renderTasks() {
  const proj = state.projects.find((p) => p.nativeWorkspaceId === state.projectId);
  let tasks = [];
  try { ({ tasks } = await api.get(`/v1/projects/${encodeURIComponent(state.projectId)}/tasks`)); } catch { /* offline */ }
  state.tasks = tasks;
  const draft = localStorage.getItem(state.draftKey + state.projectId) || '';
  $('#view').innerHTML = `
    <button class="back" id="back">← 项目</button>
    <div class="card">
      <h3>新建任务</h3>
      <input id="nt-title" placeholder="任务目标（标题）" value="${esc(draft.split('\n', 1)[0] || '')}">
      <textarea id="nt-msg" placeholder="验收要求、说明…">${esc(draft.includes('\n') ? draft.split('\n').slice(1).join('\n') : '')}</textarea>
      <div class="row" style="margin-top:8px">
        <button id="nt-go">发送</button>
        <span id="nt-state" class="meta"></span>
        <span id="nt-err" class="err-text"></span>
      </div>
    </div>
    ${tasks.length === 0 ? '<div class="empty">该项目暂无任务</div>' : tasks.map((t) => `
      <div class="card clickable" data-task="${esc(t.nativeTaskId)}">
        <div class="row"><h3 style="flex:1">${esc(t.title)}</h3><span class="pill ${esc(t.status.status)}">${statusText(t.status)}</span></div>
        <div class="meta">最近活动 ${fmtTime(t.lastActivityAt)}</div>
      </div>`).join('')}`;
  $('#back').onclick = () => nav('projects');
  const saveDraft = () => localStorage.setItem(state.draftKey + state.projectId, $('#nt-title').value + '\n' + $('#nt-msg').value);
  $('#nt-title').oninput = saveDraft;
  $('#nt-msg').oninput = saveDraft;
  $('#nt-go').onclick = createTask;
  document.querySelectorAll('[data-task]').forEach((el) => {
    el.onclick = () => {
      state.taskId = el.dataset.task;
      nav('session');
    };
  });
}

async function createTask() {
  const title = $('#nt-title').value.trim();
  const message = $('#nt-msg').value.trim();
  if (!title || !message) return;
  const btn = $('#nt-go');
  const cmdId = uuid();
  localStorage.setItem('zr-cmd-' + cmdId, title);
  btn.disabled = true;
  $('#nt-state').textContent = '发送中…';
  try {
    const r = await api.post(`/v1/projects/${encodeURIComponent(state.projectId)}/tasks`, {
      clientCommandId: cmdId, title, message,
    });
    $('#nt-state').textContent = '已接收，等待引擎确认…';
    localStorage.removeItem(state.draftKey + state.projectId);
    // 轮询命令状态直至引擎受理（PRD §3.2）
    const deadline = Date.now() + 30000;
    for (;;) {
      const cmd = await api.get(`/v1/commands/${r.commandId}`);
      if (cmd.status === 'completed') { $('#nt-state').textContent = '运行中'; break; }
      if (cmd.status === 'pending_verify') { $('#nt-state').textContent = '提交结果待确认（不自动重发）'; break; }
      if (cmd.status === 'failed') { $('#nt-err').textContent = cmd.errorDetail || '创建失败'; break; }
      if (Date.now() > deadline) { $('#nt-state').textContent = '提交超时，可稍后刷新查看'; break; }
      await new Promise((res) => setTimeout(res, 800));
    }
    renderTasks();
  } catch (e) {
    if (e.status === undefined) {
      $('#nt-state').textContent = '';
      $('#nt-err').textContent = '网络异常，草稿已保存，恢复后重试';
    } else {
      $('#nt-err').textContent = e.message;
    }
  } finally {
    btn.disabled = false;
  }
}

function statusText(st) {
  const map = {
    queued: '排队中', running: '运行中', waiting_input: '等待输入', waiting_approval: '待审批',
    cancel_requested: '停止中', succeeded: '已完成', failed: '失败', cancelled: '已取消', unknown: '状态未知',
  };
  const raw = st.source === 'inferred' ? '' : '';
  return map[st.status] + (st.status === 'unknown' && st.nativeRaw ? `（原生 ${esc(st.nativeRaw)}）` : '') + raw;
}

async function renderSession() {
  const task = state.tasks.find((t) => t.nativeTaskId === state.taskId);
  $('#view').innerHTML = `
    <button class="back" id="back">← 任务</button>
    <div class="card" id="task-head"><span class="meta">加载中…</span></div>
    <div id="approvals"></div>
    <div id="messages"></div>
    <div class="card">
      <textarea id="append-msg" placeholder="追加消息…（运行中将排队等待本轮结束）"></textarea>
      <div class="row" style="margin-top:8px">
        <button id="append-go">发送</button>
        <button class="danger" id="stop-go">停止任务</button>
        <span id="append-state" class="meta"></span>
        <span id="append-err" class="err-text"></span>
      </div>
    </div>`;
  $('#back').onclick = () => nav('tasks');
  $('#append-go').onclick = appendMessage;
  $('#stop-go').onclick = stopTask;
  await loadSession(state.taskId);
}

async function loadSession(taskId, opts = {}) {
  try {
    const snap = await api.get(`/v1/tasks/${encodeURIComponent(taskId)}`);
    const { task, pendingApprovals } = snap;
    const head = $('#task-head');
    if (!head) return;
    head.innerHTML = `<div class="row"><h3 style="flex:1">${esc(task.title)}</h3>
      <span class="pill ${esc(task.status.status)}">${statusText(task.status)}</span></div>
      <div class="meta">revision ${task.revision} · 最近活动 ${fmtTime(task.lastActivityAt)}</div>`;
    // 审批卡（绑定 nativeRequestId；处理后另一端失效）
    $('#approvals').innerHTML = pendingApprovals.map((a) => `
      <div class="card approval" data-apr="${esc(a.nativeRequestId)}">
        <h3>待审批</h3>
        <pre>${esc(a.summary)}</pre>
        <div class="actions">
          <button data-decision="approve">批准</button>
          <button class="danger" data-decision="deny">拒绝</button>
        </div>
      </div>`).join('');
    document.querySelectorAll('[data-apr]').forEach((el) => {
      el.querySelectorAll('[data-decision]').forEach((btn) => {
        btn.onclick = () => resolveApproval(el.dataset.apr, btn.dataset.decision);
      });
    });
    // 消息
    const msgs = await api.get(`/v1/tasks/${encodeURIComponent(taskId)}/messages`);
    const box = $('#messages');
    if (!box) return;
    box.innerHTML = msgs.messages.map((m) => `
      <div class="msg ${esc(m.role === 'user' ? 'user' : 'assistant')}">
        <div class="role">${m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Agent' : esc(m.role)} · ${fmtTime(m.createdAt)}</div>
        <pre>${esc(m.content)}</pre>
      </div>`).join('');
    if (!opts.silent) box.scrollIntoView({ block: 'end' });
  } catch (e) {
    const head = $('#task-head');
    if (head) head.innerHTML = `<div class="err-text">加载失败：${esc(e.message)}</div>`;
  }
}

async function appendMessage() {
  const input = $('#append-msg');
  const text = input.value.trim();
  if (!text) return;
  $('#append-err').textContent = '';
  $('#append-state').textContent = '发送中…';
  try {
    const snap = await api.get(`/v1/tasks/${encodeURIComponent(state.taskId)}`);
    await api.post(`/v1/tasks/${encodeURIComponent(state.taskId)}/messages`, {
      clientCommandId: uuid(),
      message: text,
      expectedRevision: snap.task.revision, // 乐观并发（PRD §6.2）
    });
    input.value = '';
    $('#append-state').textContent = '已受理';
    await loadSession(state.taskId);
  } catch (e) {
    if (e.code === 'revision_conflict') {
      $('#append-err').textContent = '版本冲突：任务已有更新，已刷新，请重发';
      await loadSession(state.taskId, { silent: true });
    } else if (e.code === 'engine_offline') {
      $('#append-err').textContent = '引擎不可达，草稿已保存';
      localStorage.setItem(state.draftKey + 'session-' + state.taskId, text);
    } else {
      $('#append-err').textContent = e.message;
    }
    $('#append-state').textContent = '';
  }
}

async function resolveApproval(requestId, decision) {
  try {
    await api.post(`/v1/approvals/${encodeURIComponent(requestId)}/resolve`, {
      clientCommandId: uuid(), decision,
    });
    await loadSession(state.taskId, { silent: true });
  } catch (e) {
    if (e.status === 409) {
      alert('该审批已被另一端处理（' + e.message + '），已刷新。');
      await loadSession(state.taskId, { silent: true });
    } else {
      alert('审批失败：' + e.message);
    }
  }
}

async function stopTask() {
  if (!confirm('请求停止该任务？已有变更会保留显示。')) return;
  try {
    await api.post(`/v1/tasks/${encodeURIComponent(state.taskId)}/cancel`, { clientCommandId: uuid() });
    $('#append-state').textContent = '停止请求已送达，等待引擎确认…';
    await loadSession(state.taskId, { silent: true });
  } catch (e) {
    $('#append-err').textContent = '停止失败：' + e.message;
  }
}

function refreshCurrentView() {
  if (state.view === 'projects') renderProjects();
  else if (state.view === 'tasks') renderTasks();
  else if (state.view === 'session') loadSession(state.taskId, { silent: true });
}

function nav(view) {
  state.view = view;
  if (view === 'host') renderHost();
  else if (view === 'projects') renderProjects();
  else if (view === 'tasks') renderTasks();
  else if (view === 'session') renderSession();
}

async function boot() {
  const ok = await checkConnection();
  if (!api.token) {
    renderPair();
    return;
  }
  connectSse();
  nav('host');
  if (!ok) setTimeout(refreshCurrentView, 3000);
  setInterval(checkConnection, 15000);
}

boot();
