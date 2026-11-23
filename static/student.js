'use strict';

const STAGES = ['片头', '片中', '片尾'];
const STAGE_PROMPTS = {
  片头: '导入是否吸引注意？学习主题与目标是否清晰，并与已有经验衔接？',
  片中: '讲解是否清楚、重点是否突出？提问、示范与练习是否支持理解？',
  片尾: '总结是否回扣学习目标？是否通过巩固或延伸帮助学生梳理所学？',
};
const STAGE_ICONS = { 片头: 'target', 片中: 'book', 片尾: 'check' };
const STUDENT_PAGE_TITLES = { workspace: '反思工作台', records: '反思记录', survey: '问卷' };
const STUDENT_VIDEO_LABEL = { ...VIDEO_LABEL, empty: '待上传视频', ready: '标准视频就绪' };

Object.assign(state, {
  view: 'workspace',
  roundId: 1,
  task: null,
  overview: null,
  workspaceRequest: 0,
  stage: '片头',
  saveTimer: null,
  saveChain: Promise.resolve(),
  pollTimer: null,
  uploadingRounds: new Set(),
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
  const active = state.view === 'survey' ? 'workspace' : state.view;
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
  else if (state.view === 'survey') renderSurvey();
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
    const pre = overview.surveys.pre;
    if (pre.enabled && !pre.submitted) {
      renderRoundBar(state.roundId, null);
      $('#main').innerHTML = `
        <div class="notice task-notice">
          <div class="row">${icons('info')}<span>进入反思工作台前，请先完成实验前问卷。</span></div>
          <button class="btn small" type="button" id="startPreSurvey">填写前测问卷</button>
        </div>`;
      $('#startPreSurvey').addEventListener('click', () => openSurvey('pre'));
      return;
    }
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

/* ------------------------------------------------------------ 问卷 */

async function openSurvey(kind) {
  $('#videoEl')?.pause();
  stopPolling();
  flushSave();
  state.view = 'survey';
  state.surveyKind = kind;
  renderStudentNav();
  $('#roundBar').hidden = true;
  $('#main').innerHTML = '<div class="empty">加载问卷…</div>';
  try {
    const data = await api('/api/student/surveys');
    if (state.view !== 'survey' || state.surveyKind !== kind) return;
    state.surveyData = data;
    renderSurvey();
    window.scrollTo(0, 0);
  } catch (ex) {
    if (state.view !== 'survey' || state.surveyKind !== kind) return;
    toast(ex.message);
    state.view = 'workspace';
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
      <button class="btn" type="button" id="backToWorkspace">返回工作台</button>
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
  $('#backToWorkspace').addEventListener('click', () => {
    state.view = 'workspace';
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
      state.view = 'workspace';
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
    renderRoundBar(state.roundId, openTask);
    $('#main').innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
  }
}

function renderRoundBar(roundId, onChange, lockedRound = null) {
  const bar = $('#roundBar');
  const post = state.overview?.surveys.post;
  const offerPostSurvey = post?.enabled && !post.submitted
    && (post.unlocked || state.overview.tasks.every((task) => task.status === 'submitted'));
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
      <select id="currentRound" ${onChange ? '' : 'disabled'}>
        ${state.meta.rounds.map((round) => `<option value="${round.id}" ${round.id === roundId ? 'selected' : ''} ${round.id === lockedRound ? 'disabled' : ''}>第 ${round.id} 轮 · ${esc(round.name)}</option>`).join('')}
      </select>
      <label for="currentClass">当前班级</label>
      <select id="currentClass" disabled><option>${esc(classDetails)}</option></select>
    </div>
    <button type="button" id="roundAction">${offerPostSurvey ? '填写后测问卷' : '任务说明'} ${icons('chevron', 'i-sm')}</button>`;
  if (onChange) {
    $('#currentRound').addEventListener('change', (event) => onChange(Number(event.target.value)));
  }
  $('#roundAction').addEventListener('click', offerPostSurvey ? () => openSurvey('post') : showTaskHelp);
}

function showTaskHelp() {
  openStudentModal('任务说明', `
    <p>从顶栏选择课堂练习或课后反思。每轮分别上传一段微课视频，并保存片头、片中和片尾的反思。</p>
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
        <div id="aiArea">${task.flow === 'none' ? '' : aiCardHtml()}</div>
      </div>
      <div>
        <section class="card reflection-card" id="reflectionCard">${reflectionCardHtml()}</section>
        <div class="submit-note" id="submitHint">${icons('lock', 'i-sm')} ${submitHint()}</div>
      </div>
    </div>`;
  bindVideo();
  bindAi();
  bindReflection();
  updateDeviationBanner();
  markAiPresented();
  schedulePollIfNeeded();
}

function renderWorkspaceRoundBar() {
  const task = state.task;
  const nextRoundLocked = task.round_id === 1 && task.fixed_sequence && task.status !== 'submitted';
  renderRoundBar(task.round_id, openTask, nextRoundLocked ? 2 : null);
}

function exampleSlideHtml() {
  return `
    <div class="slide">
      <div class="slide-left">
        <div class="slide-kicker">小学数学 · 三年级上册</div>
        <div class="slide-heading">分数的初步认识</div>
        <div class="slide-desc">从生活出发，认识二分之一</div>
        <div class="fraction-demo">
          <div class="fraction-circle"></div><span class="fraction-eq">＝</span>
          <div class="fraction-number"><span>1</span><span>2</span></div>
          <div class="fraction-note">把一个整体平均分成两份<br>每份是它的二分之一</div>
        </div>
        <div class="chalk-line"></div>
      </div>
      <div class="camera"><div class="camera-bg"></div><div class="teacher-hair"></div><div class="teacher-face"></div><div class="teacher-body"></div><div class="teacher-shirt"></div></div>
      <div class="demo-watermark">演示画面 · 非真实录像</div>
      <div class="slide-page">认识分数 / 03</div>
    </div>`;
}

function videoCardHtml() {
  const task = state.task;
  const submitted = task.status === 'submitted';
  const vs = task.video_status;
  const ready = vs === 'ready';
  const disabled = ready ? '' : 'disabled';
  let stage;
  if (ready) {
    const src = `/media/video/${task.id}?v=${encodeURIComponent(task.video_name || task.id)}`;
    stage = `<video id="videoEl" src="${src}" preload="metadata" playsinline></video>
      <button class="play-big" type="button" id="bigPlay" aria-label="播放视频">${icons('play')}</button>`;
  } else if (vs === 'processing') {
    stage = `<div class="video-placeholder">${icons('reset', 'i-lg spin')}<div>正在统一转码为 720p MP4，请稍候</div><div class="small">处理期间可以先撰写反思</div></div>`;
  } else if (vs === 'failed') {
    stage = `<div class="video-placeholder"><div class="big">!</div><div>视频处理失败</div>
      <div class="small">反思草稿不受影响，可重试转码或重新上传</div>
      ${task.can_retry_video ? '<button class="btn tiny" type="button" id="retryVideoBtn">重试转码</button>' : ''}</div>`;
  } else {
    stage = `${exampleSlideHtml()}
      <button class="play-big" type="button" id="exampleUpload" aria-label="上传微课视频" ${submitted ? 'disabled' : ''}>${icons('play')}</button>`;
  }
  return `
    <div class="panel-head">
      <h2>${icons('video', 'i-sm')} 我的微课视频</h2>
      <span class="tag ${vs === 'ready' ? 'green' : vs === 'failed' ? 'red' : 'amber'}">${STUDENT_VIDEO_LABEL[vs]}</span>
    </div>
    <div class="video-name"><span>${esc(task.video_name || '尚未上传微课视频')}</span><span>${ready ? 'MP4 · H.264' : '微课视频'}</span></div>
    <div class="video-stage" id="videoStage">${stage}</div>
    <div class="controls">
      <input type="range" min="0" max="${task.duration || 0}" value="0" class="seek" id="seek" aria-label="视频进度" ${disabled}>
      <div class="row between">
        <div class="row player-time">
          <button class="icon-btn" type="button" id="playButton" aria-label="播放视频" ${disabled}>${icons('play', 'i-sm')}</button>
          <div class="time" id="timeDisplay">00:00 <span>/ ${fmtDur(task.duration)}</span></div>
        </div>
        <div class="row player-options">
          <button class="icon-btn" type="button" id="volumeButton" aria-label="静音" aria-pressed="false" ${disabled}>${icons('volume', 'i-sm')}</button>
          <select class="player-select" id="playSpeed" aria-label="播放速度" ${disabled}>
            <option value="1">1.0×</option><option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option><option value="2">2.0×</option>
          </select>
          <button class="icon-btn" type="button" id="fullscreenButton" aria-label="全屏播放" ${disabled}>${icons('expand', 'i-sm')}</button>
        </div>
      </div>
    </div>
    <div class="video-footer">
      <button class="btn ghost tiny" type="button" id="uploadBtn" ${submitted || vs === 'processing' || state.uploadingRounds.has(task.round_id) ? 'disabled' : ''}>
        ${icons('upload', 'i-sm')} 上传 / 更换视频
      </button>
      <small id="videoMeta">${submitted ? '本轮已提交，视频锁定' : vs === 'empty' ? '当前为示例画面 · 请上传你的微课视频' : '支持 mp4 / mov / webm 等格式，500MB 以内'}</small>
    </div>
    <div id="uploadProgress"></div>`;
}

function aiCardHtml() {
  const task = state.task;
  const ai = task.ai;
  let body = '';
  if (task.flow === 'later' && !task.initial) {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('lock')}</div>
      <h3>先留下你的观察，再听听 AI 的建议</h3>
      <p>填写反思后，点击「保存初稿并查看 AI 反馈」。<br>你的初稿将单独保留，之后仍可继续修改正文。</p></div>`;
  } else if (ai.status === 'waiting') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('clock')}</div>
      <h3>视频就绪后，AI 将先提供观察与建议</h3>
      <p>请选择微课视频并完成处理。等待期间，你仍可播放已就绪的视频和编辑反思。</p></div>`;
  } else if (ai.status === 'generating') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('reset', 'spin')}</div>
      <h3>正在生成视频观察与建议</h3>
      <p>请稍候，你可以继续播放视频和编辑反思。反馈就绪后将在这里自动展开。</p></div>`;
  } else if (ai.status === 'failed') {
    body = `<div class="ai-lock"><div class="lock-visual">${icons('info')}</div>
      <h3>AI 分析暂时失败</h3>
      <p>你的反思仍可继续编辑。重试会沿用本次视频${task.initial ? '与已确认初稿' : ''}。</p>
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
        <span class="tag ${ai.status === 'ready' ? 'green' : ''}">${{ ready: '演示反馈', generating: '正在分析', failed: '分析失败', waiting: task.flow === 'later' && !task.initial ? '待初稿确认' : '等待视频', locked: '待初稿确认' }[ai.status] || ''}</span>
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
      <textarea id="reflection" class="reflection" ${submitted ? 'readonly' : ''}
        placeholder="${task.scaffold ? '可结合片头、片中、片尾，记录你的观察、判断与改进想法。' : '记录你认为值得反思的观察、依据或改进想法。'}">${esc(current)}</textarea>
      <div class="editor-tools">
        <span id="wordCount">${words(current)} 字</span>
        <span id="saveStatus" class="save-state" role="status">${saveStatusHtml()}</span>
      </div>
    </div>
    <div class="editor-actions">
      <button class="btn ghost" type="button" data-act="timestamp" ${submitted ? 'disabled' : ''}>${icons('clock', 'i-sm')} 插入当前时间点</button>
      <div class="row">
        <button class="btn" type="button" data-act="save" ${submitted ? 'disabled' : ''}>保存草稿</button>
        <button class="btn primary" id="primaryBtn" type="button" data-act="primary" title="${submitHint()}" ${primaryDisabled() ? 'disabled' : ''}>${primaryLabel()}</button>
      </div>
    </div>`;
}

function saveStatusHtml() {
  const time = state.task.stage_meta?.[state.stage]?.saved_at;
  return `${icons('check')} ${time ? `已保存 ${fmtClock(time)}` : '草稿自动保存'}`;
}

function primaryLabel() {
  const task = state.task;
  if (task.status === 'submitted') return '查看最终稿';
  if (task.flow === 'later' && !task.initial) return '保存初稿并查看 AI 反馈';
  return '提交最终稿';
}
function primaryDisabled() {
  const task = state.task;
  if (task.status === 'submitted') return false;
  if (task.video_status !== 'ready') return true;
  if (task.flow !== 'none' && task.ai.status === 'generating') return true;
  return !STAGES.some((s) => (task.stages[s] || '').trim());
}
function submitHint() {
  const task = state.task;
  if (task.status === 'submitted') return '本轮任务已提交';
  if (task.video_status !== 'ready') return '请等待标准视频就绪';
  if (!STAGES.some((stage) => task.stages[stage]?.trim())) return '请先填写反思正文';
  if (task.flow === 'later' && !task.initial) return '请先确认初稿并查看 AI 反馈';
  if (task.flow !== 'none' && task.ai.status === 'generating') return '请等待 AI 反馈首次呈现';
  return '提交后保存最终稿快照并结束本轮任务';
}

function bindVideo() {
  const uploadBtn = $('#uploadBtn');
  if (uploadBtn) {
    uploadBtn.addEventListener('click', () => {
      openStudentModal('准备你的微课视频', `
        <p>上传后统一处理为标准视频，视频播放、时间点和 AI 分析将使用同一素材。处理期间你可以继续编辑反思。</p>
        <div class="upload-zone">
          ${icons('upload')}
          <button class="btn" id="chooseVideoBtn" type="button">选择本地视频</button>
          <p>支持 mp4 / mov / webm 等格式，500MB 以内</p>
        </div>`, [{ label: '返回工作台' }]);
      $('#chooseVideoBtn').addEventListener('click', () => {
        const input = $('#fileInput');
        input.value = '';
        input.click();
      });
    });
    $('#exampleUpload')?.addEventListener('click', () => uploadBtn.click());
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
  const togglePlayback = () => {
    if (video.paused) video.play().catch(() => toast('视频暂时无法播放'));
    else video.pause();
  };
  play.addEventListener('click', togglePlayback);
  bigPlay.addEventListener('click', togglePlayback);
  video.addEventListener('click', togglePlayback);
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate']) {
    video.addEventListener(event, syncPosition);
  }
  for (const event of ['play', 'pause', 'ended']) video.addEventListener(event, syncPlayback);
  seek.addEventListener('input', () => {
    if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value);
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
  const report = (type, detail) => logEvent(type, detail, video.currentTime, roundId);
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
  logEvent('切换反思阶段', stage);
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
  openStudentModal('本轮反思已提交', `
    <div class="success-content">
      <div class="success-symbol">${icons('check', 'i-lg')}</div>
      <h3>让今天的发现，走向下一次课堂。</h3>
      <p>你的最终反思已保存。<br>本轮的正文版本与过程记录可在研究端查看。</p>
    </div>`, [
    { label: '查看最终稿', onClick: () => { setTimeout(() => showFinalSnapshot(task), 0); } },
    { label: '完成', primary: true },
  ]);
}

async function primaryAction() {
  const task = state.task;
  if (task.status === 'submitted') { showFinalSnapshot(task); return; }
  flushSave();
  await state.saveChain.catch(() => {});
  if (state.view !== 'workspace' || state.task !== task) return;
  if (task.flow === 'later' && !task.initial) {
    openStudentModal('确认初稿，查看 AI 反馈', `
      <p>当前正文将固定为你的<strong>已确认初稿</strong>，用于保留接触 AI 反馈前的教学判断。确认后，你仍可继续编辑正文。</p>
      <div class="snapshot">${esc(taskContent(task.stages))}</div>
      <div class="snapshot-meta">${STAGES.reduce((count, stage) => count + words(task.stages[stage]), 0)} 字 · 初稿只确认一次</div>`,
      [
        { label: '继续修改' },
        {
          label: '确认初稿并生成反馈', primary: true, onClick: async () => {
            try {
              await api(`/api/student/task/${task.round_id}/initial`, { method: 'POST' });
              await refreshTask();
              toast('初稿已提交，AI 反馈生成中');
            } catch (ex) { toast(ex.message); }
          },
        },
      ]);
    return;
  }
  openStudentModal('提交本轮最终反思', `
    <p>提交后将保存最终稿快照，并结束本轮任务。请确认观察、依据与改进想法已记录完整。</p>
    <div class="snapshot">${esc(taskContent(task.stages))}</div>
    <div class="snapshot-meta">${STAGES.reduce((count, stage) => count + words(task.stages[stage]), 0)} 字 · 任务 ${task.id}</div>`,
    [
      { label: '返回检查' },
      {
        label: '确认提交', primary: true, onClick: async () => {
          try {
            await api(`/api/student/task/${task.round_id}/submit`, { method: 'POST' });
            await refreshTask();
            if (state.view !== 'workspace' || state.task !== task) return;
            setTimeout(() => showSubmissionSuccess(task), 0);
          } catch (ex) { toast(ex.message); }
        },
      },
    ]);
}

/* ------------------------------------------------------------ 刷新与轮询 */

async function refreshTask(reloadVideo = false) {
  const previous = state.task;
  if (state.view !== 'workspace' || !previous) return;
  try {
    const task = await api(`/api/student/task/${previous.round_id}`);
    if (state.view !== 'workspace' || state.task !== previous) return;
    const statusChanged = previous.status !== task.status;
    const videoChanged = reloadVideo || previous.video_status !== task.video_status
      || previous.video_name !== task.video_name;
    const aiChanged = previous.ai.status !== task.ai.status || Boolean(previous.initial) !== Boolean(task.initial) || videoChanged;
    if (task.status !== 'submitted') {
      task.stages = previous.stages;
      task.stage_meta = previous.stage_meta;
      task.order_deviation ||= previous.order_deviation;
    }
    Object.assign(previous, task);
    if (videoChanged) {
      $('#videoEl')?.pause();
      $('#videoCard').innerHTML = videoCardHtml();
      bindVideo();
    }
    if (aiChanged) {
      $('#aiArea').innerHTML = task.flow === 'none' ? '' : aiCardHtml();
      bindAi();
    }
    if (statusChanged) {
      const overviewTask = state.overview?.tasks.find((item) => item.round_id === task.round_id);
      if (overviewTask) overviewTask.status = task.status;
      $('#reflectionCard').innerHTML = reflectionCardHtml();
      bindReflection();
      $('#uploadBtn').disabled = task.status === 'submitted';
      $('#videoMeta').textContent = '本轮已提交，视频锁定';
      renderWorkspaceRoundBar();
    }
    updateDeviationBanner();
    updatePrimaryState();
    markAiPresented();
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
  if (!task || !$('#feedbackBody') || task.ai.status !== 'ready' || task.ai.presented_at) return;
  try {
    await api(`/api/student/task/${state.roundId}/ai/present`, { method: 'POST' });
    task.ai.presented_at = new Date().toISOString();
  } catch (ex) { /* 忽略 */ }
}

function logEvent(type, detail = '', position = null, roundId = state.task?.round_id) {
  if (!roundId) return;
  api(`/api/student/task/${roundId}/event`, {
    method: 'POST', body: { type, detail, position },
  }).catch(() => {});
}

/* ------------------------------------------------------------ 视频上传 */

function bindFileInput() {
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || state.view !== 'workspace' || !state.task || state.uploadingRounds.has(state.roundId)) return;
    if (file.size === 0) { toast('所选文件为空，请重新选择视频'); return; }
    if (file.size > 500 * 1024 * 1024) { toast('文件超过 500MB'); return; }
    closeModal();
    uploadVideo(file);
  });
}

function uploadVideo(file) {
  const roundId = state.roundId;
  state.uploadingRounds.add(roundId);
  $('#uploadBtn').disabled = true;
  const form = new FormData();
  form.append('video', file);
  const wrap = $('#uploadProgress');
  if (wrap) {
    wrap.className = 'video-progress';
    wrap.innerHTML = `<div class="progress"><div style="width:0%"></div></div><div class="small">正在上传 ${esc(file.name)}</div>`;
  }
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/student/task/${roundId}/video`);
  const finishUpload = () => {
    state.uploadingRounds.delete(roundId);
    if (state.view === 'workspace' && state.task?.round_id === roundId) {
      $('#uploadBtn').disabled = state.task.status === 'submitted' || state.task.video_status === 'processing';
    }
    if (wrap) wrap.innerHTML = '';
  };
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
    finishUpload();
    if (xhr.status < 200 || xhr.status >= 300) {
      toast((data && data.error) || '上传失败');
      return;
    }
    toast('上传完成，正在统一转码');
    if (state.task?.round_id === roundId) await refreshTask(true);
  };
  xhr.onerror = () => {
    finishUpload();
    toast('网络中断，上传失败');
  };
  xhr.send(form);
}

/* ------------------------------------------------------------ 反思记录 */

async function renderRecords() {
  $('#main').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const data = await api('/api/student/records');
    if (state.view !== 'records') return;
    const showRound = (roundId) => {
      const record = data.records.find((item) => item.round_id === roundId);
      if (!record) return;
      state.roundId = roundId;
      renderRoundBar(roundId, showRound);
      $('#main').innerHTML = `
        <div class="page-head">
          <h1>反思记录</h1>
          ${record.initial ? '<button class="btn" type="button" id="viewInitial">查看已确认初稿</button>' : ''}
        </div>
        <div class="reflection-archive">${STAGES.map((stage) => recordStageHtml(record, stage)).join('')}</div>`;
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
  bindFileInput();
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
