'use strict';

const STAGES = ['片头', '片中', '片尾'];
const STAGE_PROMPTS = {
  片头: '导入是否吸引注意？学习主题与目标是否清晰，并与已有经验衔接？',
  片中: '讲解是否清楚、重点是否突出？提问、示范与练习是否支持理解？',
  片尾: '总结是否回扣学习目标？是否通过巩固或延伸帮助学生梳理所学？',
};
const STAGE_ICONS = { 片头: 'target', 片中: 'book', 片尾: 'check' };
const STUDENT_PAGE_TITLES = { workspace: '反思工作台', records: '反思记录' };
const STUDENT_VIDEO_LABEL = { ...VIDEO_LABEL, empty: '待教师设置', ready: '视频就绪' };

Object.assign(state, {
  view: 'workspace',
  roundId: 1,
  task: null,
  overview: null,
  workspaceRequest: 0,
  taskRefresh: 0,
  stage: '片头',
  saveTimer: null,
  saveChain: Promise.resolve(),
  pollTimer: null,
  presentingAi: null,
  typing: {},
  lastReflectionLength: 0,
});

/* ------------------------------------------------------------ 登录 */

function renderStudentLogin() {
  $('#appRoot').hidden = true;
  $('#loginRoot').hidden = false;
  const classes = (state.meta && state.meta.classes) || [];
  $('#loginRoot').innerHTML = `
    <div class="login-page">
      <section class="card login-card">
        <div class="login-brand">
          <div class="brand-mark">${icons('video', 'i-lg')}</div>
          <div>
            <div class="login-title">映思</div>
            <div class="login-sub">微课视频反思实验系统 · 学生端</div>
          </div>
        </div>
        <form id="studentLoginForm" autocomplete="off">
          <div class="form-field"><label for="loginName">姓名</label>
            <input class="input" id="loginName" placeholder="请输入姓名" required></div>
          <div class="form-field"><label for="loginNo">学号（同时作为密码）</label>
            <input class="input" id="loginNo" placeholder="请输入学号" required></div>
          <div class="form-field"><label for="loginClass">班级</label>
            <select class="input" id="loginClass" required>
              ${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select></div>
          <button class="btn primary login-submit" type="submit">进入学生端</button>
          <div class="login-error" id="loginError"></div>
          <p class="login-hint">账号为姓名，密码为学号；首次登录将自动创建账号并分配被试编号。</p>
          <p class="login-hint"><a href="/teacher">教师入口 →</a></p>
        </form>
      </section>
    </div>`;
  const form = $('#studentLoginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginError');
    err.textContent = '';
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api('/api/login/student', {
        method: 'POST',
        body: {
          name: $('#loginName').value.trim(),
          student_no: $('#loginNo').value.trim(),
          class_id: Number($('#loginClass').value),
        },
      });
      const me = await api('/api/me');
      if (!me.user || me.user.role !== 'student') { location.href = '/teacher'; return; }
      state.me = me.user;
      state.view = 'workspace';
      showStudentApp();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  });
  const first = form.querySelector('input');
  if (first) first.focus();
}

function showStudentLogin() {
  stopPolling();
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  state.task = null;
  state.overview = null;
  renderStudentLogin();
}

/* ------------------------------------------------------------ 应用框架 */

function showStudentApp() {
  $('#loginRoot').hidden = true;
  $('#appRoot').hidden = false;
  renderStudentNav();
  renderStudent();
}

function studentNavItems() {
  return [['workspace', 'edit', '反思工作台'], ['records', 'file', '反思记录']];
}

function renderStudentNav() {
  const active = state.view;
  $('#navigation').innerHTML = studentNavItems().map(([key, icon, label]) => `
    <button type="button" data-view="${key}" title="${label}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>
      ${icons(icon)}<span>${label}</span>
    </button>`).join('');
  $$('#navigation [data-view]').forEach((btn) => {
    btn.addEventListener('click', () => goStudentView(btn.dataset.view));
  });
  $('#navLabel').textContent = '学习空间';
  $('#crumbSpace').textContent = '学习空间';
  $('#crumbPage').textContent = STUDENT_PAGE_TITLES[state.view] || '';
  $('#avatar').textContent = (state.me.name || '学').slice(0, 1);
  $('#profileText').innerHTML = `${esc(state.me.name)}<small>参与者 ${esc(state.me.participant_code || '—')}</small>`;
}

async function goStudentView(view) {
  if (view === state.view) return;
  $('#videoEl')?.pause();
  stopPolling();
  flushSave();
  await state.saveChain.catch(() => {});
  state.view = view;
  renderStudentNav();
  renderStudent();
  window.scrollTo(0, 0);
}

function renderStudent() {
  if (!state.me) { showStudentLogin(); return; }
  $('#roundBar').hidden = true;
  if (state.view === 'workspace') enterWorkspace();
  else if (state.view === 'records') renderRecords();
}

/* ------------------------------------------------------------ 进入工作台 */

async function enterWorkspace() {
  const request = ++state.workspaceRequest;
  $('#main').innerHTML = '<div class="empty">加载任务中…</div>';
  try {
    const overview = await api('/api/student/overview');
    if (state.view !== 'workspace' || request !== state.workspaceRequest) return;
    state.overview = overview;
    const available = overview.tasks.filter((task) => !task.locked);
    const selected = available.find((task) => task.round_id === state.roundId) || available[0];
    if (!selected) {
      $('#main').innerHTML = '<div class="empty">当前没有开放的任务。</div>';
      return;
    }
    await openTask(selected.round_id);
  } catch (ex) {
    if (state.view === 'workspace' && request === state.workspaceRequest) {
      $('#main').innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
    }
  }
}

/* ------------------------------------------------------------ 工作台 */

async function openTask(roundId) {
  $('#videoEl')?.pause();
  stopPolling();
  flushSave();
  await state.saveChain.catch(() => {});
  state.roundId = roundId;
  state.view = 'workspace';
  state.task = null;
  renderStudentNav();
  $('#roundBar').hidden = true;
  $('#main').innerHTML = '<div class="empty">加载任务中…</div>';
  try {
    const task = await api(`/api/student/task/${roundId}`);
    if (state.view !== 'workspace' || state.roundId !== roundId) return;
    state.task = task;
    const filled = STAGES.find((s) => (task.stages[s] || '').trim());
    state.stage = filled || '片头';
    renderWorkspace();
    window.scrollTo(0, 0);
  } catch (ex) {
    if (state.view !== 'workspace' || state.roundId !== roundId) return;
    toast(ex.message);
    state.task = null;
    renderRoundBar(state.roundId);
    $('#main').innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
  }
}

function renderRoundBar(roundId, lockedRound = null) {
  const bar = $('#roundBar');
  const task = state.task?.round_id === roundId ? state.task
    : state.overview?.tasks.find((entry) => entry.round_id === roundId);
  const className = state.me.class_name || '—';
  const classDetails = task
    ? `${className} · ${task.flow === 'none' ? '无 AI 介入' : FLOW_LABEL[task.flow]} · ${task.scaffold ? '支架开启' : '无支架'}`
    : className;
  bar.hidden = false;
  bar.innerHTML = `
    <div class="row">
      ${icons('info', 'i-sm')}
      <span>微课反思实验<span class="prototype-desc"> · 草稿与记录按轮次保存</span></span>
      <span class="prototype-separator" aria-hidden="true">│</span>
      <label for="currentRound">任务轮次</label>
      <select id="currentRound">
        ${state.meta.rounds.map((round) => `<option value="${round.id}" ${round.id === roundId ? 'selected' : ''} ${round.id === lockedRound ? 'disabled' : ''}>第 ${round.id} 轮 · ${esc(round.name)}</option>`).join('')}
      </select>
      <label for="currentClass">当前班级</label>
      <select id="currentClass" disabled><option>${esc(classDetails)}</option></select>
    </div>
    <button type="button" id="roundAction">任务说明 ${icons('chevron', 'i-sm')}</button>`;
  $('#currentRound').addEventListener('change', (event) => openTask(Number(event.target.value)));
  $('#roundAction').addEventListener('click', showTaskHelp);
}

function showTaskHelp() {
  openStudentModal('任务说明', `
    <p>从顶栏选择课堂练习或课后反思。观看教师为本组设置的微课视频，并记录片头、片中和片尾的反思。</p>
    <p>确认最终稿后，本轮反思即锁定，可在「反思记录」查看已保存的内容。</p>`, [{ label: '关闭' }]);
}

function renderWorkspace() {
  const task = state.task;
  if (!task) return;
  renderWorkspaceRoundBar();
  $('#main').innerHTML = `
    <div id="deviationBanner"></div>
    <div class="workspace-grid">
      <div>
        <section class="card video-card" id="videoCard">${videoCardHtml()}</section>
        <div id="aiArea">${aiCardHtml()}</div>
      </div>
      <div>
        <section class="card reflection-card" id="reflectionCard">${reflectionCardHtml()}</section>
        <div class="submit-note" id="submitHint">${icons('lock', 'i-sm')} ${submitHint()}</div>
        <div id="taskFinalFeedback"></div>
      </div>
    </div>`;
  bindVideo();
  bindAi();
  bindReflection();
  updateDeviationBanner();
  markAiPresented();
  updateWorkspaceFeedback(task);
  schedulePollIfNeeded();
}

function renderWorkspaceRoundBar() {
  const task = state.task;
  const nextRoundLocked = task.round_id === 1 && task.fixed_sequence && task.status !== 'submitted';
  renderRoundBar(task.round_id, nextRoundLocked ? 2 : null);
}

function videoCardHtml() {
  const task = state.task;
  const vs = task.video_status;
  const ready = vs === 'ready';
  let stage;
  if (ready) {
    const src = `/media/video/${task.id}?v=${encodeURIComponent(task.video_version)}`;
    stage = `<video id="videoEl" src="${src}" preload="metadata" playsinline></video>
      <button class="play-big" type="button" id="bigPlay" aria-label="播放视频">${icons('play')}</button>`;
  } else if (vs === 'processing') {
    stage = `<div class="video-placeholder">${icons('reset', 'i-lg spin')}<div>小组视频正在处理，请稍候。</div></div>`;
  } else if (vs === 'failed') {
    stage = '<div class="video-placeholder">小组视频处理失败，请联系教师。</div>';
  } else {
    stage = '<div class="video-placeholder">请等待教师为本组设置视频。</div>';
  }
  return `
    <div class="panel-head">
      <h2>${icons('video', 'i-sm')} 小组微课视频</h2>
      <span class="tag ${vs === 'ready' ? 'green' : vs === 'failed' ? 'red' : 'amber'}">${STUDENT_VIDEO_LABEL[vs]}</span>
    </div>
    ${ready ? `<div class="video-name"><span>${esc(task.video_name)}</span><span>MP4 · H.264</span></div>` : ''}
    <div class="video-stage" id="videoStage">${stage}</div>
    ${ready ? `<div class="controls">
      <input type="range" min="0" max="${task.duration || 0}" value="0" class="seek" id="seek" aria-label="视频进度">
      <div class="row between">
        <div class="row player-time">
          <button class="icon-btn" type="button" id="playButton" aria-label="播放视频">${icons('play', 'i-sm')}</button>
          <div class="time" id="timeDisplay">00:00 <span>/ ${fmtDur(task.duration)}</span></div>
        </div>
        <div class="row player-options">
          <button class="icon-btn" type="button" id="volumeButton" aria-label="静音" aria-pressed="false">${icons('volume', 'i-sm')}</button>
          <select class="player-select" id="playSpeed" aria-label="播放速度">
            <option value="1">1.0×</option><option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option><option value="2">2.0×</option>
          </select>
          <button class="icon-btn" type="button" id="fullscreenButton" aria-label="全屏播放">${icons('expand', 'i-sm')}</button>
        </div>
      </div>
    </div>` : ''}`;
}

function aiCardHtml() {
  const task = state.task;
  if (task.flow === 'none' || (task.flow === 'later' && task.status === 'submitted')) return '';
  const ai = task.ai;
  let body = '';
  if (task.flow === 'later') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('lock')}</div>
      <h3>先完成反思，再查看建议</h3>
      <p>先独立撰写各阶段的反思。<br>提交最终稿后生成改进建议。</p></div>`;
  } else if (ai.status === 'waiting') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('clock')}</div>
      <h3>视频就绪后，AI 将先提供观察与建议</h3>
      <p>AI 建议呈现后即可开始撰写反思。</p></div>`;
  } else if (ai.status === 'generating') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('reset', 'spin')}</div>
      <h3>正在生成视频观察与建议</h3>
      <p>等待期间，你可以播放视频。建议呈现后会开放反思编辑。</p></div>`;
  } else if (ai.status === 'failed') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('info')}</div>
      <h3>AI 分析暂时失败</h3>
      <p>请重试，建议就绪后即可编辑反思。已有草稿会保留。</p>
      <button class="btn tiny ai-retry" type="button" id="aiRetryBtn">${icons('reset', 'i-sm')} 重试分析</button></div>`;
  } else if (ai.status === 'ready') {
    body = `<div id="feedbackBody">${ai.items.map((item) => `
      <article class="feedback-item">
        <h3>${esc(item.title)}
          <button class="time-link" type="button" data-seek="${Number(item.time) || 0}">${icons('play', 'i-sm')} ${fmtDur(item.time)}</button>
        </h3>
        <p>${esc(item.observation)}</p>
        <div class="suggestion">建议：${esc(item.suggestion)}</div>
      </article>`).join('')}</div>`;
  } else {
    body = '<div class="ai-lock"><p>等待任务开始。</p></div>';
  }
  return `
    <section class="card ai-card">
      <div class="panel-head">
        <h2><span class="ai-symbol">${icons('spark', 'i-sm')}</span> AI 观察与建议</h2>
        <span class="tag ${ai.status === 'ready' ? 'green' : ''}">${task.flow === 'later' ? '待最终稿提交' : { ready: '演示反馈', generating: '正在分析', failed: '分析失败', waiting: '等待视频' }[ai.status] || ''}</span>
      </div>
      ${body}
      <div class="ai-bottom">${icons('info', 'i-sm')} 反馈仅供参考，请依据视频形成自己的判断。</div>
    </section>`;
}

function scaffoldHtml() {
  const task = state.task;
  return `
    <div class="scaffold">
      <div class="scaffold-title">
        <span>${task.scaffold ? '按视频阶段回看本组视频' : '选择反思阶段'}</span>
        <small>各阶段内容分别保存</small>
      </div>
      <div class="prompts">
        ${STAGES.map((stage) => `
          <button class="prompt ${state.stage === stage ? 'selected' : ''}" type="button" data-stage="${stage}" aria-pressed="${state.stage === stage}">
            <span class="prompt-symbol">${icons(STAGE_ICONS[stage], 'i-sm')}</span>
            <span><strong>${stage}</strong>${task.scaffold ? `<p>${STAGE_PROMPTS[stage]}</p>` : ''}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

function reflectionCardHtml() {
  const task = state.task;
  const submitted = task.status === 'submitted';
  const locked = submitted || awaitingFirstFeedback(task);
  const current = task.stages[state.stage] || '';
  return `
    ${submitted ? `<div class="submitted-banner">${icons('check', 'i-sm')} 已于 ${fmtClock(task.submitted_at)} 提交，本轮反思已完成。</div>` : ''}
    <div class="panel-head">
      <h2>${icons('edit', 'i-sm')} 我的反思</h2>
      <div class="meta"><span class="tag">${task.scaffold ? '三阶段反思支架' : '自由反思'}</span><span>自主记录 · 自由组织</span></div>
    </div>
    ${scaffoldHtml()}
    <div class="editor-label">
      <label id="reflectionLabel" for="reflection">${state.stage}反思内容</label>
    </div>
    <div class="editor-wrap">
      <textarea id="reflection" class="reflection" ${locked ? 'readonly' : ''}
        placeholder="${reflectionPlaceholder(task)}">${esc(current)}</textarea>
      <div class="editor-tools">
        <span id="wordCount">${words(current)} 字</span>
        <span id="saveStatus" class="save-state" role="status">${saveStatusHtml()}</span>
      </div>
    </div>
    <div class="editor-actions">
      <button class="btn ghost" type="button" data-act="timestamp" ${locked ? 'disabled' : ''}>${icons('clock', 'i-sm')} 插入当前时间点</button>
      <div class="row">
        <button class="btn" type="button" data-act="save" ${locked ? 'disabled' : ''}>保存草稿</button>
        <button class="btn primary" id="primaryBtn" type="button" data-act="primary" title="${submitHint()}" ${primaryDisabled() ? 'disabled' : ''}>${primaryLabel()}</button>
      </div>
    </div>`;
}

function awaitingFirstFeedback(task) {
  return task.flow === 'first' && (task.ai.status !== 'ready' || !task.ai.presented_at);
}

function reflectionPlaceholder(task) {
  if (task.status !== 'submitted' && awaitingFirstFeedback(task)) return 'AI 建议呈现后可开始撰写反思。';
  return task.scaffold
    ? '可结合片头、片中、片尾，记录你的观察、判断与改进想法。'
    : '记录你认为值得反思的观察、依据或改进想法。';
}

function updateReflectionState(task) {
  const input = $('#reflection');
  const locked = task.status === 'submitted' || awaitingFirstFeedback(task);
  input.readOnly = locked;
  input.placeholder = reflectionPlaceholder(task);
  $('[data-act="timestamp"]').disabled = locked;
  $('[data-act="save"]').disabled = locked;
  updatePrimaryState();
}

function saveStatusHtml() {
  const time = state.task.stage_meta?.[state.stage]?.saved_at;
  return `${icons('check')} ${time ? `已保存 ${fmtClock(time)}` : '草稿自动保存'}`;
}

function primaryLabel() {
  return state.task.status === 'submitted' ? '查看最终稿' : '提交最终稿';
}
function primaryDisabled() {
  const task = state.task;
  if (task.status === 'submitted') return false;
  if (task.video_status !== 'ready') return true;
  if (awaitingFirstFeedback(task)) return true;
  return !STAGES.some((s) => (task.stages[s] || '').trim());
}
function submitHint() {
  const task = state.task;
  if (task.status === 'submitted') return '本轮任务已提交';
  if (task.video_status !== 'ready') return '请等待小组视频就绪';
  if (awaitingFirstFeedback(task)) return '请等待 AI 建议首次呈现';
  if (!STAGES.some((stage) => task.stages[stage]?.trim())) return '请先填写反思正文';
  if (task.flow === 'later') return '提交后保存最终稿并生成一条改进建议';
  return '提交后保存最终稿快照并结束本轮任务';
}

function bindVideo() {
  const video = $('#videoEl');
  if (!video) return;
  const stage = $('#videoStage');
  const play = $('#playButton');
  const bigPlay = $('#bigPlay');
  const seek = $('#seek');
  const volume = $('#volumeButton');
  const timeDisplay = $('#timeDisplay');
  const { duration: savedDuration, round_id: roundId } = state.task;
  const syncPlayback = () => {
    const playing = !video.paused;
    stage.classList.toggle('playing', playing);
    for (const button of [play, bigPlay]) {
      button.innerHTML = icons(playing ? 'pause' : 'play', button === play ? 'i-sm' : '');
      button.setAttribute('aria-label', playing ? '暂停视频' : '播放视频');
    }
  };
  const syncPosition = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : savedDuration;
    seek.max = duration || 0;
    seek.value = video.currentTime;
    timeDisplay.innerHTML = `${fmtDur(video.currentTime)} <span>/ ${fmtDur(duration)}</span>`;
  };
  const report = (type, detail) => logEvent(type, detail, video.currentTime, roundId);
  const togglePlayback = () => {
    if (video.paused) {
      report('播放');
      video.play().catch(() => toast('视频暂时无法播放'));
    } else {
      report('暂停');
      video.pause();
    }
  };
  play.addEventListener('click', togglePlayback);
  bigPlay.addEventListener('click', togglePlayback);
  video.addEventListener('click', togglePlayback);
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate']) {
    video.addEventListener(event, syncPosition);
  }
  for (const event of ['play', 'pause', 'ended']) video.addEventListener(event, syncPlayback);
  let seekStart = null;
  seek.addEventListener('pointerdown', () => { seekStart = video.currentTime; });
  seek.addEventListener('input', () => {
    if (seekStart === null) seekStart = video.currentTime;
    if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value);
  });
  seek.addEventListener('change', () => {
    const to = Number(seek.value);
    const from = seekStart ?? video.currentTime;
    report('调整进度条', `从 ${fmtDur(from)} 到 ${fmtDur(to)}`);
    seekStart = null;
  });
  volume.addEventListener('click', () => {
    video.muted = !video.muted;
    volume.setAttribute('aria-pressed', String(video.muted));
  });
  $('#playSpeed').addEventListener('change', (event) => {
    video.playbackRate = Number(event.target.value);
  });
  $('#fullscreenButton').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.requestFullscreen) await stage.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else toast('当前浏览器不支持全屏播放');
    } catch (ex) { toast('当前浏览器无法进入全屏'); }
  });
}

function bindAi() {
  const retry = $('#aiRetryBtn');
  if (retry) {
    retry.addEventListener('click', async () => {
      try {
        await api(`/api/student/task/${state.roundId}/ai/retry`, { method: 'POST' });
        await refreshTask();
      } catch (ex) { toast(ex.message); }
    });
  }
  $$('[data-seek]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const video = $('#videoEl');
      if (!video) { toast('视频就绪后可跳转'); return; }
      video.currentTime = Number(btn.dataset.seek) || 0;
      logEvent('调整进度条', `定位至 ${fmtDur(video.currentTime)}`, video.currentTime);
      video.play().catch(() => {});
    });
  });
}

function currentVideoPosition() {
  const video = $('#videoEl');
  return video && Number.isFinite(video.currentTime) ? video.currentTime : null;
}

function flushTyping(stage = state.stage) {
  const stats = state.typing[stage];
  if (!stats) return;
  clearTimeout(stats.timer);
  stats.timer = null;
  if (!stats.added && !stats.removed) return;
  const parts = [];
  if (stats.added) parts.push(`输入 ${stats.added} 字`);
  if (stats.removed) parts.push(`删除 ${stats.removed} 字`);
  const text = state.task?.stages?.[stage] || '';
  logEvent('内容编辑', `${stage}：${parts.join('，')}；当前 ${words(text)} 字`, currentVideoPosition());
  stats.added = 0;
  stats.removed = 0;
}

function bindReflection() {
  const input = $('#reflection');
  if (!input) return;
  state.lastReflectionLength = input.value.length;
  input.addEventListener('input', () => {
    if (input.readOnly) return;
    const text = input.value;
    const stage = state.stage;
    const previousLength = state.lastReflectionLength ?? text.length;
    const delta = text.length - previousLength;
    state.lastReflectionLength = text.length;
    state.task.stages[stage] = text;
    if (delta !== 0) {
      const stats = state.typing[stage] || (state.typing[stage] = { added: 0, removed: 0, timer: null });
      if (delta > 0) stats.added += delta;
      else stats.removed += -delta;
      clearTimeout(stats.timer);
      stats.timer = setTimeout(() => flushTyping(stage), 1200);
    }
    $('#wordCount').textContent = `${words(text)} 字`;
    $('#saveStatus').textContent = '正在保存…';
    updatePrimaryState();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveReflection(text), 900);
  });

  $$('[data-stage]').forEach((btn) => {
    btn.addEventListener('click', () => switchStage(btn.dataset.stage));
  });

  $$('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'timestamp') insertTimestamp();
      else if (act === 'save') saveDraft(true);
      else if (act === 'primary') primaryAction();
    });
  });
}

async function saveReflection(text) {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  const stage = state.stage;
  const task = state.task;
  state.saveChain = state.saveChain.then(() => api(`/api/student/task/${task.round_id}/reflection`, {
    method: 'PUT', body: { stage, text },
  })).then((res) => {
    task.stage_meta[stage] = { ...task.stage_meta[stage], saved_at: res.saved_at };
    if ($('#saveStatus') && state.task === task && state.stage === stage && task.stages[stage] === text) {
      $('#saveStatus').innerHTML = saveStatusHtml();
    }
    if (typeof res.order_deviation !== 'undefined') {
      task.order_deviation = Boolean(res.order_deviation);
      if (state.task === task) updateDeviationBanner();
    }
  }).catch((ex) => {
    if ($('#saveStatus') && state.task === task && state.stage === stage) $('#saveStatus').textContent = '保存失败';
    toast(ex.message);
  });
  return state.saveChain;
}

function flushSave() {
  flushTyping();
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (state.task && state.view === 'workspace') {
      saveReflection(state.task.stages[state.stage] || '');
    }
  }
}

function switchStage(stage) {
  if (stage === state.stage) return;
  flushSave();
  state.stage = stage;
  $$('[data-stage]').forEach((btn) => {
    const selected = btn.dataset.stage === stage;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
  const input = $('#reflection');
  const text = state.task.stages[stage] || '';
  input.value = text;
  $('#wordCount').textContent = `${words(text)} 字`;
  $('#saveStatus').innerHTML = saveStatusHtml();
  $('#reflectionLabel').textContent = `${stage}反思内容`;
  state.lastReflectionLength = text.length;
}

async function saveDraft(manual) {
  const task = state.task;
  const stage = state.stage;
  flushSave();
  try {
    await state.saveChain;
    const res = await api(`/api/student/task/${task.round_id}/save-draft`, {
      method: 'POST', body: { stage },
    });
    task.stage_meta[stage] = { version: res.version, saved_at: res.saved_at };
    if ($('#saveStatus') && state.task === task && state.stage === stage && !state.saveTimer) {
      $('#saveStatus').innerHTML = saveStatusHtml();
    }
    if (manual) toast('草稿已保存');
  } catch (ex) {
    toast(ex.message);
  }
}

function insertTimestamp() {
  const input = $('#reflection');
  if (!input || input.readOnly) return;
  const video = $('#videoEl');
  const mark = `[${fmtDur(video ? video.currentTime : 0)}] `;
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  input.setRangeText(mark, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function updatePrimaryState() {
  const btn = $('#primaryBtn');
  if (!btn) return;
  btn.textContent = primaryLabel();
  btn.disabled = primaryDisabled();
  btn.title = submitHint();
  $('#submitHint').innerHTML = `${icons('lock', 'i-sm')} ${submitHint()}`;
}

function updateDeviationBanner() {
  const box = $('#deviationBanner');
  if (!box) return;
  box.innerHTML = state.task && state.task.order_deviation
    ? `<div class="notice">${icons('info')}<span>已记录实际介入顺序：你在 AI 反馈首次显示前开始了写作。草稿已保留，研究端可查看该标记。</span></div>`
    : '';
}

function taskContent(stages) {
  return STAGES.filter((stage) => stages[stage]?.trim())
    .map((stage) => `【${stage}】\n${stages[stage]}`).join('\n\n');
}

function showFinalSnapshot(task) {
  const final = task.final;
  if (!final) { toast('暂时无法读取最终稿，请在反思记录中查看'); return; }
  openStudentModal('最终稿', `
    <p>提交于 ${fmtTime(final.time)}</p>
    <div class="snapshot">${esc(taskContent(final.stages))}</div>`,
  [{ label: '关闭' }]);
}

function showSubmissionSuccess(task) {
  if (state.view !== 'workspace' || state.task !== task) return;
  openStudentModal('本轮反思已提交', `
    <div class="success-content">
      <div class="success-symbol">${icons('check', 'i-lg')}</div>
      <h3>让今天的发现，走向下一次课堂。</h3>
      <p>你的最终反思已保存。</p>
    </div>
    <div id="submissionFinalFeedback"></div>`, [
    { label: '查看最终稿', onClick: () => { setTimeout(() => showFinalSnapshot(task), 0); } },
    { label: '完成', primary: true },
  ]);
  updateWorkspaceFeedback(task);
}

function mountFinalFeedback(container, record, onUpdate) {
  if (!container) return;
  if (record.flow !== 'later' || !record.final) { container.innerHTML = ''; return; }
  const feedback = record.final_feedback;
  let content;
  if (feedback?.status === 'ready') {
    content = `<p class="suggestion-text">${esc(feedback.suggestion)}</p>
      <small>${feedback.model === '本地规则' ? '本地规则建议' : 'AI 生成 · 仅供参考'}</small>`;
  } else if (feedback?.status === 'generating') {
    content = '<p role="status">正在根据最终稿生成一条改进建议…</p>';
  } else {
    content = feedback
      ? '<p role="status">建议暂时未能生成。最终稿已保存。</p><button class="btn tiny" type="button">重试生成</button>'
      : '<button class="btn tiny" type="button">根据最终稿生成建议</button>';
  }
  container.innerHTML = `
    <section class="card final-feedback">
      <h3>${icons('spark', 'i-sm')} 最终稿反馈建议</h3>
      ${content}
    </section>`;
  container.querySelector('button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      record.final_feedback = await api(`/api/student/task/${record.round_id}/final-feedback`, { method: 'POST' });
      onUpdate();
    } catch (ex) {
      button.disabled = false;
      toast(ex.message);
    }
  });
  if (feedback?.status === 'ready' && !feedback.presented_at) {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.target.isConnected) { observer.disconnect(); return; }
      if (!entry.isIntersecting) return;
      observer.disconnect();
      api(`/api/student/task/${record.round_id}/final-feedback/present`, { method: 'POST' })
        .then(() => { feedback.presented_at = new Date().toISOString(); })
        .catch(() => {});
    });
    observer.observe(container.querySelector('.final-feedback'));
  }
}

function updateWorkspaceFeedback(task) {
  const onUpdate = () => {
    if (state.view !== 'workspace' || state.task !== task) return;
    updateWorkspaceFeedback(task);
    schedulePollIfNeeded();
  };
  mountFinalFeedback($('#taskFinalFeedback'), task, onUpdate);
  mountFinalFeedback($('#submissionFinalFeedback'), task, onUpdate);
}

async function primaryAction() {
  const task = state.task;
  if (task.status === 'submitted') { showFinalSnapshot(task); return; }
  flushSave();
  await state.saveChain.catch(() => {});
  if (state.view !== 'workspace' || state.task !== task || primaryDisabled()) return;
  const videoVersion = task.video_version;
  const message = task.flow === 'later'
    ? '提交后将保存最终稿并结束本轮任务，随后根据正文生成一条改进建议。'
    : '提交后将保存最终稿并结束本轮任务。';
  openStudentModal('提交本轮最终反思', `
    <p>${message}请确认反思内容已记录完整。</p>
    <div class="snapshot">${esc(taskContent(task.stages))}</div>
    <div class="snapshot-meta">${STAGES.reduce((count, stage) => count + words(task.stages[stage]), 0)} 字 · 任务 ${task.id}</div>`,
    [
      { label: '返回检查' },
      {
        label: '确认提交', primary: true, onClick: async () => {
          try {
            await api(`/api/student/task/${task.round_id}/submit`, {
              method: 'POST', body: { video_version: videoVersion },
            });
            await refreshTask();
            if (state.view !== 'workspace' || state.task !== task) return;
            setTimeout(() => showSubmissionSuccess(task), 0);
          } catch (ex) { toast(ex.message); }
        },
      },
    ]);
}

/* ------------------------------------------------------------ 刷新与轮询 */

async function refreshTask() {
  const previous = state.task;
  if (state.view !== 'workspace' || !previous) return;
  const refresh = ++state.taskRefresh;
  try {
    const task = await api(`/api/student/task/${previous.round_id}`);
    if (state.view !== 'workspace' || state.task !== previous || refresh !== state.taskRefresh) return;
    const statusChanged = previous.status !== task.status;
    const feedbackChanged = previous.final_feedback?.status !== task.final_feedback?.status;
    const videoChanged = previous.video_status !== task.video_status
      || previous.video_version !== task.video_version;
    const aiChanged = previous.ai.status !== task.ai.status || videoChanged;
    if (task.status !== 'submitted') {
      task.stages = previous.stages;
      task.stage_meta = previous.stage_meta;
      task.order_deviation ||= previous.order_deviation;
    }
    if (task.ai.status === 'ready' && !videoChanged) task.ai.presented_at ||= previous.ai.presented_at;
    Object.assign(previous, task);
    if (videoChanged) {
      $('#videoEl')?.pause();
      $('#videoCard').innerHTML = videoCardHtml();
      bindVideo();
    }
    if (aiChanged || statusChanged) {
      $('#aiArea').innerHTML = aiCardHtml();
      bindAi();
    }
    if (statusChanged) {
      const overviewTask = state.overview?.tasks.find((item) => item.round_id === task.round_id);
      if (overviewTask) overviewTask.status = task.status;
      $('#reflectionCard').innerHTML = reflectionCardHtml();
      bindReflection();
      renderWorkspaceRoundBar();
    }
    if (statusChanged || feedbackChanged) updateWorkspaceFeedback(previous);
    updateDeviationBanner();
    updateReflectionState(previous);
    markAiPresented();
  } catch (ex) { /* 轮询期间忽略短暂错误 */ }
  finally {
    if (state.view === 'workspace' && state.task === previous && refresh === state.taskRefresh) {
      schedulePollIfNeeded();
    }
  }
}

function schedulePollIfNeeded() {
  stopPolling();
  const task = state.task;
  if (!task) return;
  const processing = task.video_status === 'processing' || task.ai.status === 'generating'
    || (task.flow === 'first' && task.status !== 'submitted' && task.video_status === 'ready'
      && (task.ai.status === 'waiting' || (task.ai.status === 'ready' && !task.ai.presented_at)))
    || task.final_feedback?.status === 'generating';
  if (!processing && task.status === 'submitted') return;
  state.pollTimer = setTimeout(async () => {
    const prevAi = task.ai.status;
    await refreshTask();
    if (state.task === task && prevAi !== 'ready' && task.ai.status === 'ready') {
      toast('AI 观察与建议已生成');
    }
  }, processing ? 1800 : 5000);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function markAiPresented() {
  const task = state.task;
  if (!task || task.flow !== 'first' || !$('#feedbackBody') || task.ai.status !== 'ready'
    || task.ai.presented_at || state.presentingAi === task) return;
  const videoVersion = task.video_version;
  state.presentingAi = task;
  try {
    const result = await api(`/api/student/task/${task.round_id}/ai/present`, {
      method: 'POST', body: { video_version: videoVersion },
    });
    if (task.video_version !== videoVersion) return;
    task.ai.presented_at = result.presented_at;
    if (state.view === 'workspace' && state.task === task) updateReflectionState(task);
  } catch (ex) { /* 忽略 */ }
  finally {
    if (state.presentingAi === task) state.presentingAi = null;
  }
}

function logEvent(type, detail = '', position = null, roundId = state.task?.round_id) {
  if (!roundId) return;
  api(`/api/student/task/${roundId}/event`, {
    method: 'POST', body: { type, detail, position },
  }).catch(() => {});
}

/* ------------------------------------------------------------ 反思记录 */

async function renderRecords() {
  $('#main').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const data = await api('/api/student/records');
    if (state.view !== 'records') return;
    const showRound = (roundId) => {
      stopPolling();
      const record = data.records.find((item) => item.round_id === roundId);
      if (!record) return;
      state.roundId = roundId;
      renderRoundBar(roundId, showRound);
      $('#main').innerHTML = `
        <div class="page-head">
          <h1>反思记录</h1>
          ${record.initial ? '<button class="btn" type="button" id="viewInitial">查看已确认初稿</button>' : ''}
        </div>
        <div class="reflection-archive">${STAGES.map((stage) => recordStageHtml(record, stage)).join('')}</div>
        <div id="recordFinalFeedback"></div>`;
      updateRecordFeedback(record, $('#recordFinalFeedback'));
      $('#viewInitial')?.addEventListener('click', () => {
        openStudentModal('已确认初稿', `
          <p>确认于 ${fmtTime(record.initial.time)}</p>
          <div class="snapshot">${esc(taskContent(record.initial.stages))}</div>`, [{ label: '关闭' }]);
      });
    };
    showRound(state.roundId);
  } catch (ex) {
    if (state.view === 'records') $('#main').innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
  }
}

function updateRecordFeedback(record, container) {
  if (!container.isConnected) return;
  const update = () => updateRecordFeedback(record, container);
  mountFinalFeedback(container, record, update);
  if (record.final_feedback?.status !== 'generating') return;
  state.pollTimer = setTimeout(async () => {
    try {
      const data = await api('/api/student/records');
      record.final_feedback = data.records.find((item) => item.round_id === record.round_id)?.final_feedback;
    } catch (ex) { /* 轮询期间忽略短暂错误 */ }
    update();
  }, 1800);
}

function recordStageHtml(record, stage) {
  const version = (title, text, time, emptyLabel) => `
    <div class="archive-version">
      <div class="archive-version-head">
        <h3>${title}</h3>
        ${text?.trim() && time ? `<span class="archive-time">${fmtClock(time)}</span>` : ''}
      </div>
      ${text?.trim() ? `<div class="archive-text">${esc(text)}</div>` : `<p class="archive-empty">${emptyLabel}</p>`}
    </div>`;
  return `
    <section class="card archive-stage" aria-label="${stage}反思记录">
      <h2>${stage}</h2>
      <div class="archive-versions">
        ${version('已保存草稿', record.stages?.[stage], record.stage_meta?.[stage]?.saved_at, '暂无已保存的反思草稿')}
        ${version('已提交反思', record.final?.stages?.[stage], record.final?.time, '暂无已提交的反思内容')}
      </div>
    </section>`;
}

/* ------------------------------------------------------------ 启动 */

function openStudentModal(title, body, actions = []) {
  openModal(title, body, actions);
  $('#modalRoot .modal').setAttribute('aria-label', title);
}

async function logoutTo(path) {
  $('#videoEl')?.pause();
  flushSave();
  await state.saveChain.catch(() => {});
  try {
    await api('/api/logout', { method: 'POST' });
    location.href = path;
  } catch (ex) { toast(ex.message); }
}

function openStudentAccount() {
  openStudentModal('学生账户', `
    <p>${esc(state.me.name)} · ${esc(state.me.class_name || '')}</p>
    <p>参与者 ${esc(state.me.participant_code || '—')}</p>`, [
    { label: '返回' },
    { label: '退出登录', primary: true, onClick: () => logoutTo('/student') },
  ]);
}

function switchToResearch() {
  openStudentModal('切换到研究端', '<p>退出学生账户后，使用教师账号登录研究端。</p>', [
    { label: '取消' },
    { label: '退出并前往', primary: true, onClick: () => logoutTo('/teacher') },
  ]);
}

function openStudentMobileNav() {
  openStudentModal('页面导航', `<div class="nav">${studentNavItems().map(([key, icon, label]) => `
    <button type="button" data-mobile-view="${key}">${icons(icon)}<span>${label}</span></button>`).join('')}</div>`, [
    { label: '退出登录', onClick: () => logoutTo('/student') },
  ]);
  $$('[data-mobile-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeModal();
      goStudentView(btn.dataset.mobileView);
    });
  });
}

async function bootStudent() {
  $('#studentRole').addEventListener('click', () => goStudentView('workspace'));
  $('#researchRole').addEventListener('click', switchToResearch);
  $('#studentProfile').addEventListener('click', openStudentAccount);
  $('#mobileNavBtn').addEventListener('click', openStudentMobileNav);
  try {
    const me = await loadMetaAndMe();
    if (me && me.role !== 'student') { location.href = '/teacher'; return; }
    if (me) {
      state.view = 'workspace';
      showStudentApp();
    } else {
      showStudentLogin();
    }
  } catch (ex) {
    $('#loginRoot').hidden = false;
    $('#loginRoot').innerHTML = `<div class="login-page"><div class="card login-card"><p>无法连接服务：${esc(ex.message)}</p></div></div>`;
  }
}

bootStudent();
