'use strict';

const STAGES = ['片头', '片中', '片尾'];
const STAGE_PROMPTS = {
  片头: '导入是否吸引注意？学习主题与目标是否清晰，并与已有经验衔接？',
  片中: '讲解是否清楚、重点是否突出？提问、示范与练习是否支持理解？',
  片尾: '总结是否回扣学习目标？是否通过巩固或延伸帮助学生梳理所学？',
};
const STAGE_ICONS = { 片头: 'target', 片中: 'book', 片尾: 'check' };
const STUDENT_PAGE_TITLES = { tasks: '任务选取', workspace: '反思工作台', records: '反思记录', survey: '问卷' };

Object.assign(state, {
  view: 'tasks',
  roundId: 1,
  task: null,
  stage: '片头',
  saveTimer: null,
  saveChain: Promise.resolve(),
  pollTimer: null,
  surveyKind: 'pre',
  surveyData: null,
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
      state.view = 'tasks';
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
  return [['tasks', 'grid', '任务选取'], ['records', 'file', '反思记录']];
}

function renderStudentNav() {
  const active = state.view === 'workspace' || state.view === 'survey' ? 'tasks' : state.view;
  $('#navigation').innerHTML = studentNavItems().map(([key, icon, label]) => `
    <button type="button" data-view="${key}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>
      ${icons(icon)}<span>${label}</span>
    </button>`).join('');
  $$('#navigation [data-view]').forEach((btn) => {
    btn.addEventListener('click', () => goStudentView(btn.dataset.view));
  });
  $('#navLabel').textContent = '学习空间';
  $('#crumbSpace').textContent = '学习空间';
  $('#crumbPage').textContent = STUDENT_PAGE_TITLES[state.view] || '';
  $('#avatar').textContent = (state.me.name || '学').slice(0, 1);
  $('#profileText').innerHTML = `${esc(state.me.name)}<small class="profile-code">${esc(state.me.participant_code || '')} · ${esc(state.me.class_name || '')}</small>`;
}

async function goStudentView(view) {
  if (view === state.view) return;
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
  if (state.view === 'workspace') renderWorkspace();
  else if (state.view === 'survey') renderSurvey();
  else if (state.view === 'records') renderRecords();
  else renderTasks();
}

/* ------------------------------------------------------------ 任务选取 */

async function renderTasks() {
  $('#main').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const data = await api('/api/student/overview');
    const pre = data.surveys.pre;
    const post = data.surveys.post;
    const cards = data.tasks.map((t) => {
      const locked = Boolean(t.locked);
      let statusTag;
      if (locked) statusTag = `<span class="tag amber">${esc(t.lock_reason || '未解锁')}</span>`;
      else if (t.status === 'submitted') statusTag = '<span class="tag green">已提交</span>';
      else if (t.exists) statusTag = '<span class="tag amber">进行中</span>';
      else statusTag = '<span class="tag">未开始</span>';
      const label = locked ? '未解锁' : t.status === 'submitted' ? '查看任务' : t.exists ? '继续任务' : '开始任务';
      return `
        <section class="card task-card ${locked ? 'locked' : ''}">
          <div class="row between"><h2>${esc(t.round_name)}</h2>${statusTag}</div>
          <p class="task-desc">${t.round_id === 1
            ? '结合课堂实录片段，完成片头、片中、片尾的反思记录，形成课堂练习反馈。'
            : '回看整节微课，分阶段记录观察、判断与改进想法，完成课后反思。'}</p>
          <div class="task-meta">
            <span class="tag">${t.scaffold ? '三阶段支架' : '自由反思'}</span>
            <span class="tag">${VIDEO_LABEL[t.video_status] || ''}</span>
          </div>
          <div class="task-foot">
            <span class="task-status">${t.submitted_at ? `提交于 ${fmtTime(t.submitted_at)}` : (locked ? esc(t.lock_reason) : '每个任务独立保存')}</span>
            <button class="btn ${t.status === 'submitted' ? '' : 'primary'}" data-open-task="${t.round_id}" ${locked ? 'disabled' : ''}>${label}</button>
          </div>
        </section>`;
    }).join('');
    const preNotice = pre.enabled && !pre.submitted
      ? `<div class="notice blue task-notice" style="margin-bottom:14px">
          <span>进入任务前，请先完成实验前问卷（约 1 分钟）。</span>
          <button class="btn small" type="button" data-survey="pre">填写前测问卷</button>
        </div>` : '';
    const postNotice = post.enabled && post.unlocked && !post.submitted
      ? `<div class="notice green task-notice" style="margin-bottom:14px">
          <span>两个任务已完成，请填写实验后问卷。</span>
          <button class="btn small" type="button" data-survey="post">填写后测问卷</button>
        </div>` : '';
    $('#main').innerHTML = `
      <div class="page-head">
        <div>
          <div class="eyebrow">STUDENT WORKSPACE</div>
          <h1>任务选取</h1>
          <p>被试编号 ${esc(data.user.participant_code || '—')} · ${esc(data.user.name)} · ${esc(data.user.class_name)}。请选择一个任务进入反思工作台。</p>
        </div>
      </div>
      <div class="notice blue" style="margin-bottom:16px">
        实验说明：本平台用于微课反思实验。请独立完成两个任务，按自己的判断撰写反思，AI 建议仅供参考；
        提交后不可修改。数据以被试编号保存，仅用于研究分析。
      </div>
      ${preNotice}${postNotice}
      <div class="task-grid">${cards}</div>`;
    $$('[data-open-task]').forEach((btn) => {
      btn.addEventListener('click', () => openTask(Number(btn.dataset.openTask)));
    });
    $$('[data-survey]').forEach((btn) => {
      btn.addEventListener('click', () => openSurvey(btn.dataset.survey));
    });
  } catch (ex) {
    $('#main').innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
  }
}

/* ------------------------------------------------------------ 问卷 */

async function openSurvey(kind) {
  state.view = 'survey';
  state.surveyKind = kind;
  renderStudentNav();
  $('#main').innerHTML = '<div class="empty">加载问卷…</div>';
  try {
    state.surveyData = await api('/api/student/surveys');
    renderSurvey();
    window.scrollTo(0, 0);
  } catch (ex) {
    toast(ex.message);
    state.view = 'tasks';
    renderStudentNav();
    renderStudent();
  }
}

function renderSurvey() {
  const data = state.surveyData;
  if (!data) return;
  const kind = state.surveyKind;
  const meta = data[kind];
  const items = data.items[kind];
  const scale = data.scale;
  const submitted = Boolean(meta.submitted);
  const answers = meta.answers || {};
  const title = kind === 'pre' ? '实验前问卷' : '实验后问卷';
  const desc = kind === 'pre'
    ? '请根据你目前的教学反思经验作答，答案没有对错。'
    : '请根据本次任务的真实体验作答，答案没有对错。';
  $('#main').innerHTML = `
    <div class="page-head">
      <div><div class="eyebrow">SURVEY</div><h1>${title}</h1><p>${desc}</p></div>
      <button class="btn" type="button" id="backToTasks">返回任务</button>
    </div>
    ${submitted ? `<div class="notice green" style="margin-bottom:16px">该问卷已于 ${fmtTime(meta.submitted_at)} 提交，不能重复填写。</div>` : ''}
    <section class="card survey-card">
      <form id="surveyForm">
        ${items.map((item, idx) => `
          <div class="survey-item">
            <h3>${idx + 1}. ${esc(item.text)}</h3>
            <div class="scale">
              ${[1, 2, 3, 4, 5].map((v) => `
                <label>
                  <input type="radio" name="q-${item.id}" value="${v}" ${submitted ? 'disabled' : ''} ${Number(answers[item.id]) === v ? 'checked' : ''}>
                  <span>${v}<small>${esc(scale[String(v)] || '')}</small></span>
                </label>`).join('')}
            </div>
          </div>`).join('')}
        ${kind === 'post' ? `
          <div class="survey-item">
            <h3>其他想法（选填）</h3>
            <textarea class="survey-comment" id="surveyComment" maxlength="1000" ${submitted ? 'disabled' : ''} placeholder="可以写下你对本次任务或 AI 建议的其他看法。">${esc(answers.comment || '')}</textarea>
          </div>` : ''}
        ${submitted ? '' : `<div class="survey-actions">
          <span class="small" id="surveyError" style="color:var(--red)"></span>
          <button class="btn primary" type="submit">提交问卷</button>
        </div>`}
      </form>
    </section>`;
  $('#backToTasks').addEventListener('click', () => {
    state.view = 'tasks';
    renderStudentNav();
    renderStudent();
  });
  const form = $('#surveyForm');
  if (!form || submitted) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ans = {};
    for (const item of items) {
      const selected = form.querySelector(`input[name="q-${item.id}"]:checked`);
      if (selected) ans[item.id] = Number(selected.value);
    }
    if (Object.keys(ans).length < items.length) {
      $('#surveyError').textContent = '请完成所有题目后再提交';
      return;
    }
    const comment = $('#surveyComment') ? $('#surveyComment').value.trim() : '';
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api(`/api/student/survey/${kind}`, { method: 'POST', body: { answers: ans, comment } });
      toast('问卷已提交');
      state.view = 'tasks';
      renderStudentNav();
      renderStudent();
    } catch (ex) {
      $('#surveyError').textContent = ex.message;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------ 工作台 */

async function openTask(roundId) {
  stopPolling();
  flushSave();
  await state.saveChain.catch(() => {});
  state.roundId = roundId;
  state.view = 'workspace';
  renderStudentNav();
  $('#main').innerHTML = '<div class="empty">加载任务中…</div>';
  try {
    const task = await api(`/api/student/task/${roundId}`);
    state.task = task;
    const filled = STAGES.find((s) => (task.stages[s] || '').trim());
    state.stage = filled || '片头';
    renderWorkspace();
    window.scrollTo(0, 0);
  } catch (ex) {
    toast(ex.message);
    state.task = null;
    state.view = 'tasks';
    renderStudentNav();
    renderStudent();
  }
}

function renderWorkspace() {
  const task = state.task;
  if (!task) return;
  const round2Locked = task.round_id === 1 && task.fixed_sequence && task.status !== 'submitted';
  $('#main').innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">REFLECTION WORKSPACE</div>
        <h1>${esc(task.round_name)} · 反思工作台</h1>
        <p>${esc(state.me.class_name)} · ${task.scaffold ? '三阶段反思支架' : '自由反思'}</p>
      </div>
      <div class="ws-switch">
        <button type="button" data-round="1" class="${task.round_id === 1 ? 'active' : ''}">课堂练习</button>
        <button type="button" data-round="2" class="${task.round_id === 2 ? 'active' : ''}" ${round2Locked ? 'disabled title="请先完成课堂练习并提交"' : ''}>课后反思</button>
      </div>
    </div>
    <div id="deviationBanner"></div>
    <div class="workspace-grid">
      <div>
        <section class="card video-card" id="videoCard">${videoCardHtml()}</section>
        <div id="aiArea">${task.flow === 'none' ? '' : aiCardHtml()}</div>
      </div>
      <section class="card reflection-card" id="reflectionCard">${reflectionCardHtml()}</section>
    </div>`;
  $$('[data-round]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rid = Number(btn.dataset.round);
      if (!btn.disabled && rid !== state.roundId) openTask(rid);
    });
  });
  bindVideo();
  bindAi();
  bindReflection();
  updateDeviationBanner();
  if (task.ai.status === 'ready') markAiPresented();
  schedulePollIfNeeded();
}

function videoCardHtml() {
  const task = state.task;
  const submitted = task.status === 'submitted';
  const vs = task.video_status;
  let stage;
  if (vs === 'ready') {
    const src = `/media/video/${task.id}?v=${encodeURIComponent(task.video_name || task.id)}`;
    stage = `<div class="video-stage"><video id="videoEl" src="${src}" controls preload="metadata" playsinline></video></div>`;
  } else if (vs === 'processing') {
    stage = `<div class="video-stage"><div class="video-placeholder">${icons('reset', 'i-lg spin')}<div>正在统一转码为 720p MP4，请稍候</div><div class="small">处理期间可以先撰写反思</div></div></div>`;
  } else if (vs === 'failed') {
    stage = `<div class="video-stage"><div class="video-placeholder"><div class="big">!</div><div>视频处理失败</div>
      <div class="small">反思草稿不受影响，可重试转码或重新上传</div>
      ${task.can_retry_video ? '<button class="btn tiny" type="button" id="retryVideoBtn">重试转码</button>' : ''}</div></div>`;
  } else {
    stage = `<div class="video-stage"><div class="video-placeholder"><div class="big">▷</div><div>还没有上传微课视频</div><div class="small">上传后可在这里预览，并插入视频时间点</div></div></div>`;
  }
  return `
    <div class="panel-head">
      <h2>${icons('video', 'i-sm')} 我的微课视频</h2>
      <span class="tag ${vs === 'ready' ? 'green' : vs === 'failed' ? 'red' : 'amber'}">${VIDEO_LABEL[vs]}</span>
    </div>
    <div class="video-name"><span>${esc(task.video_name || '尚未上传视频')}</span><span>MP4 · H.264</span></div>
    ${stage}
    <div id="uploadProgress"></div>
    <div class="video-actions">
      <button class="btn ghost tiny" type="button" id="uploadBtn" ${submitted || vs === 'processing' ? 'disabled' : ''}>
        ${icons('upload', 'i-sm')} ${vs === 'ready' ? '更换视频' : '上传视频'}
      </button>
      <span class="muted">${submitted ? '本轮已提交，视频锁定' : '支持 mp4 / mov / webm 等格式，500MB 以内'}</span>
    </div>`;
}

function aiCardHtml() {
  const task = state.task;
  const ai = task.ai;
  let body = '';
  if (task.flow === 'later' && !task.initial) {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('lock')}</div>
      <h3>先留下你的观察，再听听 AI 的建议</h3>
      <p>填写反思后，点击「提交初稿并查看 AI 反馈」。<br>提交的初稿会单独保留，之后仍可继续修改正文。</p></div>`;
  } else if (ai.status === 'waiting') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('clock')}</div>
      <h3>视频就绪后，AI 将提供观察与建议</h3>
      <p>请先上传微课视频，等待期间仍可撰写反思。</p></div>`;
  } else if (ai.status === 'generating') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('reset', 'spin')}</div>
      <h3>正在生成视频观察与建议</h3>
      <p>约几秒后自动显示，你可以继续播放视频和编辑反思。</p></div>`;
  } else if (ai.status === 'failed') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('info')}</div>
      <h3>AI 分析暂时失败</h3>
      <p>你的反思仍可继续编辑，可以重试分析。</p>
      <button class="btn tiny ai-retry" type="button" id="aiRetryBtn">${icons('reset', 'i-sm')} 重试分析</button></div>`;
  } else if (ai.status === 'ready') {
    body = ai.items.map((item) => `
      <article class="feedback-item">
        <h3>${esc(item.title)}
          <button class="ai-time" type="button" data-seek="${item.time}">${icons('play', 'i-sm')} ${fmtDur(item.time)}</button>
        </h3>
        <p>${esc(item.observation)}</p>
        <div class="suggestion">建议：${esc(item.suggestion)}</div>
      </article>`).join('');
  } else {
    body = '<div class="ai-lock"><p>等待任务开始。</p></div>';
  }
  return `
    <section class="card ai-card">
      <div class="panel-head">
        <h2><span class="ai-symbol">${icons('spark', 'i-sm')}</span> AI 观察与建议</h2>
        <span class="tag ${ai.status === 'ready' ? 'green' : ''}">${AI_LABEL[ai.status] || ''}</span>
      </div>
      ${body}
      <div class="ai-bottom">${icons('info', 'i-sm')} 反馈为演示内容，仅供参考。请依据视频形成自己的判断。</div>
    </section>`;
}

function scaffoldHtml() {
  const task = state.task;
  return `
    <div class="scaffold">
      <div class="scaffold-title">
        <span>${task.scaffold ? '按视频阶段，回看你的课堂' : '选择反思阶段'}</span>
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
  const current = task.stages[state.stage] || '';
  return `
    ${submitted ? `<div class="submitted-banner">${icons('check', 'i-sm')} 已于 ${fmtTime(task.submitted_at)} 提交，本轮反思已完成。</div>` : ''}
    <div class="panel-head">
      <h2>${icons('edit', 'i-sm')} 我的反思</h2>
      <div class="meta"><span class="tag">${task.scaffold ? '三阶段反思支架' : '自由反思'}</span></div>
    </div>
    ${scaffoldHtml()}
    <div class="editor-label">
      <label id="reflectionLabel" for="reflection">${state.stage}反思内容</label>
      <span class="small muted">各阶段分别保存</span>
    </div>
    <div class="editor-wrap">
      <textarea id="reflection" class="reflection" ${submitted ? 'readonly' : ''}
        placeholder="${task.scaffold ? '结合本阶段画面，记录你的观察、判断与改进想法。' : '记录你认为值得反思的观察、依据或改进想法。'}">${esc(current)}</textarea>
      <div class="editor-tools">
        <span id="wordCount">${words(current)} 字</span>
        <span id="saveStatus" class="save-state">${icons('check')} 草稿自动保存在此浏览器</span>
      </div>
    </div>
    <div class="editor-actions">
      <button class="btn ghost" type="button" data-act="timestamp" ${submitted ? 'disabled' : ''}>${icons('clock', 'i-sm')} 插入当前时间点</button>
      <div class="row">
        <button class="btn" type="button" data-act="save" ${submitted ? 'disabled' : ''}>保存草稿</button>
        <button class="btn primary" id="primaryBtn" type="button" data-act="primary" ${primaryDisabled() ? 'disabled' : ''}>${primaryLabel()}</button>
      </div>
    </div>
    <div class="submit-hint" id="submitHint">${submitHint()}</div>`;
}

function primaryLabel() {
  const task = state.task;
  if (task.status === 'submitted') return '已提交';
  if (task.flow === 'later' && !task.initial) return '提交初稿并查看 AI 反馈';
  return '提交最终稿';
}
function primaryDisabled() {
  const task = state.task;
  if (task.status === 'submitted') return true;
  if (task.video_status !== 'ready') return true;
  if (task.flow !== 'none' && task.ai.status === 'generating') return true;
  return !STAGES.some((s) => (task.stages[s] || '').trim());
}
function submitHint() {
  const task = state.task;
  if (task.status === 'submitted') return '本轮已结束，可在「反思记录」查看保存与提交内容。';
  if (task.video_status !== 'ready') return '请先上传视频并等待处理完成。';
  if (task.flow === 'later' && !task.initial) return '提交初稿后会固定保存，并显示 AI 建议；之后仍可继续修改正文。';
  if (task.flow !== 'none' && task.ai.status === 'generating') return 'AI 反馈生成中，请稍候再提交。';
  return '提交后保存最终稿，本轮任务结束。';
}

function bindVideo() {
  const uploadBtn = $('#uploadBtn');
  if (uploadBtn) {
    uploadBtn.addEventListener('click', () => {
      const input = $('#fileInput');
      input.value = '';
      input.click();
    });
  }
  const retry = $('#retryVideoBtn');
  if (retry) {
    retry.addEventListener('click', async () => {
      try {
        await api(`/api/student/task/${state.roundId}/video/retry`, { method: 'POST' });
        toast('已重新开始转码');
        await refreshTask(true);
      } catch (ex) { toast(ex.message); }
    });
  }
  const video = $('#videoEl');
  if (!video) return;
  const report = (type, detail) => logEvent(type, detail, video.currentTime);
  video.addEventListener('play', () => report('播放'));
  video.addEventListener('pause', () => report('暂停'));
  video.addEventListener('seeked', () => report('视频跳转', `定位至 ${fmtDur(video.currentTime)}`));
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
      video.play().catch(() => {});
    });
  });
}

function bindReflection() {
  const input = $('#reflection');
  if (!input) return;
  input.addEventListener('input', () => {
    const text = input.value;
    state.task.stages[state.stage] = text;
    $('#wordCount').textContent = `${words(text)} 字`;
    $('#saveStatus').textContent = '正在保存…';
    if (text.trim() && state.task.flow === 'first' && !state.task.ai.presented_at) {
      state.task.order_deviation = true;
      updateDeviationBanner();
    }
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
  state.saveChain = state.saveChain.then(() => api(`/api/student/task/${state.roundId}/reflection`, {
    method: 'PUT', body: { stage, text },
  })).then((res) => {
    if ($('#saveStatus') && state.stage === stage) {
      $('#saveStatus').textContent = `已保存 ${fmtClock(res.saved_at)}`;
    }
    if (typeof res.order_deviation !== 'undefined') {
      state.task.order_deviation = Boolean(res.order_deviation);
      updateDeviationBanner();
    }
  }).catch((ex) => {
    if ($('#saveStatus')) $('#saveStatus').textContent = '保存失败';
    toast(ex.message);
  });
  return state.saveChain;
}

function flushSave() {
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
  $('#saveStatus').textContent = '草稿自动保存在此浏览器';
  $('#reflectionLabel').textContent = `${stage}反思内容`;
  logEvent('切换反思阶段', stage);
}

async function saveDraft(manual) {
  flushSave();
  try {
    const res = await api(`/api/student/task/${state.roundId}/save-draft`, {
      method: 'POST', body: { stage: state.stage },
    });
    state.task.stage_meta = state.task.stage_meta || {};
    state.task.stage_meta[state.stage] = { version: res.version, saved_at: res.saved_at };
    $('#saveStatus').textContent = `草稿已保存 v${res.version}`;
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
  $('#submitHint').textContent = submitHint();
}

function updateDeviationBanner() {
  const box = $('#deviationBanner');
  if (!box) return;
  box.innerHTML = state.task && state.task.order_deviation
    ? '<div class="notice" style="margin-bottom:16px">已记录实际介入顺序：你在 AI 反馈首次呈现前开始了写作，草稿已保留，研究端可查看该标记。</div>'
    : '';
}

function taskContent() {
  return STAGES.filter((s) => (state.task.stages[s] || '').trim())
    .map((s) => `【${s}】\n${state.task.stages[s]}`).join('\n\n');
}

async function primaryAction() {
  const task = state.task;
  if (task.status === 'submitted') { toast('本轮已提交'); return; }
  flushSave();
  await state.saveChain.catch(() => {});
  if (task.flow === 'later' && !task.initial) {
    openModal('提交初稿，查看 AI 反馈', `
      <p>当前正文将作为<strong>已提交初稿</strong>固定保存，用于保留接触 AI 建议前的教学判断。提交后仍可继续修改正文。</p>
      <div class="snapshot">${esc(taskContent())}</div>`,
      [
        { label: '继续修改' },
        {
          label: '提交初稿并生成反馈', primary: true, onClick: async () => {
            try {
              await api(`/api/student/task/${state.roundId}/initial`, { method: 'POST' });
              await refreshTask(true);
              toast('初稿已提交，AI 反馈生成中');
            } catch (ex) { toast(ex.message); }
          },
        },
      ]);
    return;
  }
  openModal('提交本轮最终反思', `
    <p>提交后将保存最终稿快照，并结束本轮任务。请确认观察、依据与改进想法已记录完整。</p>
    <div class="snapshot">${esc(taskContent())}</div>`,
    [
      { label: '返回检查' },
      {
        label: '确认提交', primary: true, onClick: async () => {
          try {
            await api(`/api/student/task/${state.roundId}/submit`, { method: 'POST' });
            await refreshTask(true);
            toast('本轮反思已提交');
          } catch (ex) { toast(ex.message); }
        },
      },
    ]);
}

/* ------------------------------------------------------------ 刷新与轮询 */

async function refreshTask(full = false) {
  const roundId = state.roundId;
  try {
    const task = await api(`/api/student/task/${roundId}`);
    if (state.view !== 'workspace' || state.roundId !== roundId) return;
    const prev = state.task;
    state.task = task;
    const structural = !prev || full || prev.status !== task.status
      || Boolean(prev.initial) !== Boolean(task.initial)
      || prev.video_status !== task.video_status;
    if (structural) {
      renderWorkspace();
    } else {
      const aiArea = $('#aiArea');
      if (aiArea) { aiArea.innerHTML = aiCardHtml(); bindAi(); }
      updateDeviationBanner();
      updatePrimaryState();
      if (task.ai.status === 'ready') markAiPresented();
    }
    schedulePollIfNeeded();
  } catch (ex) { /* 轮询期间忽略短暂错误 */ }
}

function schedulePollIfNeeded() {
  stopPolling();
  const task = state.task;
  if (!task) return;
  const need = task.video_status === 'processing' || task.ai.status === 'generating';
  if (!need) return;
  state.pollTimer = setTimeout(async () => {
    const prevAi = state.task.ai.status;
    await refreshTask();
    if (state.task && prevAi !== 'ready' && state.task.ai.status === 'ready') {
      toast('AI 观察与建议已生成');
    }
  }, 1800);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function markAiPresented() {
  const task = state.task;
  if (!task || task.ai.status !== 'ready' || task.ai.presented_at) return;
  try {
    await api(`/api/student/task/${state.roundId}/ai/present`, { method: 'POST' });
    task.ai.presented_at = new Date().toISOString();
  } catch (ex) { /* 忽略 */ }
}

function logEvent(type, detail = '', position = null) {
  if (!state.task) return;
  api(`/api/student/task/${state.roundId}/event`, {
    method: 'POST', body: { type, detail, position },
  }).catch(() => {});
}

/* ------------------------------------------------------------ 视频上传 */

function bindFileInput() {
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !state.task) return;
    if (file.size > 500 * 1024 * 1024) { toast('文件超过 500MB'); return; }
    uploadVideo(file);
  });
}

function uploadVideo(file) {
  const roundId = state.roundId;
  const form = new FormData();
  form.append('video', file);
  const wrap = $('#uploadProgress');
  if (wrap) {
    wrap.className = 'video-progress';
    wrap.innerHTML = `<div class="progress"><div style="width:0%"></div></div><div class="small">正在上传 ${esc(file.name)}</div>`;
  }
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/student/task/${roundId}/video`);
  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) return;
    const pct = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
    const bar = wrap && wrap.querySelector('.progress>div');
    if (bar) bar.style.width = `${pct}%`;
    const hint = wrap && wrap.querySelector('.small');
    if (hint) hint.textContent = `正在上传 ${file.name} · ${pct}%`;
  };
  xhr.onload = async () => {
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
    if (xhr.status >= 400) {
      toast((data && data.error) || '上传失败');
      if (wrap) wrap.innerHTML = '';
      return;
    }
    toast('上传完成，正在统一转码');
    await refreshTask(true);
  };
  xhr.onerror = () => {
    toast('网络中断，上传失败');
    if (wrap) wrap.innerHTML = '';
  };
  xhr.send(form);
}

/* ------------------------------------------------------------ 反思记录 */

async function renderRecords() {
  $('#main').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const data = await api('/api/student/records');
    const blocks = data.records.map((r) => {
      if (!r.exists) {
        return `<section class="card archive-stage" style="margin-bottom:16px">
          <h2>${esc(r.round_name)}</h2>
          <div class="archive-empty" style="padding:18px 22px">还没有开始该任务。</div>
        </section>`;
      }
      const stages = STAGES.map((stage) => {
        const draft = r.stages[stage] || '';
        const initial = r.initial ? (r.initial.stages[stage] || '') : '';
        const final = r.final ? (r.final.stages[stage] || '') : '';
        return `<section class="card archive-stage" style="margin-bottom:16px">
          <h2>${stage}</h2>
          <div class="archive-versions">
            <div class="archive-version">
              <div class="archive-version-head"><h3>已保存草稿</h3>${r.stage_meta && r.stage_meta[stage] ? `<span class="archive-time">${fmtTime(r.stage_meta[stage].saved_at)}</span>` : ''}</div>
              ${draft.trim() ? `<div class="archive-text">${esc(draft)}</div>` : '<p class="archive-empty">暂无已保存的草稿</p>'}
            </div>
            <div class="archive-version">
              <div class="archive-version-head"><h3>已提交最终稿</h3>${r.final ? `<span class="archive-time">${fmtTime(r.final.time)}</span>` : ''}</div>
              ${final.trim() ? `<div class="archive-text">${esc(final)}</div>` : '<p class="archive-empty">暂无已提交内容</p>'}
            </div>
          </div>
          ${initial.trim() ? `<div class="archive-initial"><div class="archive-version-head"><h3>已提交初稿</h3><span class="archive-time">${fmtTime(r.initial.time)}</span></div><div class="archive-text">${esc(initial)}</div></div>` : ''}
        </section>`;
      }).join('');
      return `<div class="archive-round">
        <div class="section-heading"><h2>${esc(r.round_name)}</h2><span class="tag ${r.status === 'submitted' ? 'green' : 'amber'}">${TASK_LABEL[r.status]}</span></div>
        ${stages}
      </div>`;
    }).join('');
    $('#main').innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">MY RECORDS</div><h1>反思记录</h1>
        <p>被试编号 ${esc(state.me.participant_code || '—')} · 查看当前任务保存的草稿和已提交内容。</p></div>
      </div>
      <div class="reflection-archive">${blocks}</div>`;
  } catch (ex) {
    $('#main').innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
  }
}

/* ------------------------------------------------------------ 启动 */

function openStudentMobileNav() {
  openModal('页面导航', `<div class="nav">${studentNavItems().map(([key, icon, label]) => `
    <button type="button" data-mobile-view="${key}" style="text-align:left">${icons(icon)}<span>${label}</span></button>`).join('')}</div>`);
  $$('[data-mobile-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeModal();
      goStudentView(btn.dataset.mobileView);
    });
  });
}

async function bootStudent() {
  bindFileInput();
  $('#logoutBtn').addEventListener('click', async () => {
    flushSave();
    await state.saveChain.catch(() => {});
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/student';
  });
  $('#mobileNavBtn').addEventListener('click', openStudentMobileNav);
  try {
    const me = await loadMetaAndMe();
    if (me && me.role !== 'student') { location.href = '/teacher'; return; }
    if (me) {
      state.view = 'tasks';
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
