'use strict';

const TEACHER_PAGE_TITLES = { config: '实验配置', data: '过程数据' };

Object.assign(state, {
  view: 'config',
  dataTab: 'tasks',
  filters: { class_id: '', round_id: '' },
  anonymous: false,
  surveyMeta: null,
  taskStats: [],
});

/* ------------------------------------------------------------ 登录 */

function renderTeacherLogin() {
  $('#appRoot').hidden = true;
  $('#loginRoot').hidden = false;
  $('#loginRoot').innerHTML = `
    <div class="login-page">
      <section class="card login-card">
        <div class="login-brand">
          <div class="brand-mark">${icons('video', 'i-lg')}</div>
          <div>
            <div class="login-title">映思</div>
            <div class="login-sub">微课视频反思实验系统 · 教师端</div>
          </div>
        </div>
        <form id="teacherLoginForm" autocomplete="off">
          <div class="form-field"><label for="loginUser">教师账号</label>
            <input class="input" id="loginUser" placeholder="请输入教师账号" required></div>
          <div class="form-field"><label for="loginPass">密码</label>
            <input class="input" id="loginPass" type="password" placeholder="请输入密码" required></div>
          <button class="btn primary login-submit" type="submit">进入教师端</button>
          <div class="login-error" id="loginError"></div>
          <p class="login-hint">演示账号：admin / admin123</p>
          <p class="login-hint"><a href="/student">学生入口 →</a></p>
        </form>
      </section>
    </div>`;
  const form = $('#teacherLoginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginError');
    err.textContent = '';
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api('/api/login/teacher', {
        method: 'POST',
        body: { username: $('#loginUser').value.trim(), password: $('#loginPass').value },
      });
      const me = await api('/api/me');
      if (!me.user || me.user.role !== 'teacher') { location.href = '/student'; return; }
      state.me = me.user;
      state.view = 'config';
      showTeacherApp();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  });
  const first = form.querySelector('input');
  if (first) first.focus();
}

function showTeacherLogin() {
  state.taskStats = [];
  renderTeacherLogin();
}

/* ------------------------------------------------------------ 应用框架 */

function showTeacherApp() {
  $('#loginRoot').hidden = true;
  $('#appRoot').hidden = false;
  renderTeacherNav();
  renderTeacher();
}

function teacherNavItems() {
  return [['config', 'settings', '实验配置'], ['data', 'chart', '过程数据']];
}

function renderTeacherNav() {
  const active = state.view;
  $('#navigation').innerHTML = teacherNavItems().map(([key, icon, label]) => `
    <button type="button" data-view="${key}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>
      ${icons(icon)}<span>${label}</span>
    </button>`).join('');
  $$('#navigation [data-view]').forEach((btn) => {
    btn.addEventListener('click', () => goTeacherView(btn.dataset.view));
  });
  $('#navLabel').textContent = '研究管理';
  $('#crumbSpace').textContent = '研究管理';
  $('#crumbPage').textContent = TEACHER_PAGE_TITLES[state.view] || '';
  $('#avatar').textContent = '研';
  $('#profileText').innerHTML = '研究人员<small class="profile-code">实验管理员</small>';
}

function goTeacherView(view) {
  if (view === state.view) return;
  state.view = view;
  renderTeacherNav();
  renderTeacher();
  window.scrollTo(0, 0);
}

function renderTeacher() {
  if (!state.me) { showTeacherLogin(); return; }
  if (state.view === 'data') renderData();
  else renderConfig();
}

/* ------------------------------------------------------------ 实验配置 */

async function renderConfig() {
  $('#main').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const data = await api('/api/teacher/config');
    const settings = data.settings || {};
    const settingRow = (key, title, desc, checked) => `
      <div class="setting-row">
        <div><strong>${title}</strong><div class="settings-desc">${desc}</div></div>
        <label class="switch"><input type="checkbox" data-setting="${key}" ${checked ? 'checked' : ''}><span></span></label>
      </div>`;
    const settingsCard = `
      <section class="card settings-card" style="margin-bottom:22px">
        <h3>实验流程与问卷</h3>
        ${settingRow('fixed_sequence', '固定任务顺序', '课堂练习提交后才能进入课后反思', settings.fixed_sequence)}
        ${settingRow('survey_pre', '启用实验前问卷', '学生进入任务前必须完成，未完成时任务锁定', settings.survey_pre)}
        ${settingRow('survey_post', '启用实验后问卷', '两个任务都提交后开放填写', settings.survey_post)}
      </section>`;
    const roundsHtml = data.rounds.map((round) => `
      <section class="round-config">
        <div class="section-heading">
          <h2>${esc(round.name)}</h2>
          <span class="tag">配置作用于之后新建的任务</span>
        </div>
        <div class="group-grid">
          ${data.classes.map((c) => {
            const cfg = data.configs[`${c.id}:${round.id}`] || { flow: 'none', scaffold: false };
            return `<section class="card group-card">
              <div class="row between"><div class="group-letter">${c.id}</div><span class="tag">${esc(c.name)}</span></div>
              <div class="config-name">${esc(c.name)}</div>
              <label for="flow-${c.id}-${round.id}">AI 介入流程</label>
              <select class="field" id="flow-${c.id}-${round.id}" data-flow="${c.id}-${round.id}">
                ${Object.entries(FLOW_LABEL).map(([k, v]) => `<option value="${k}" ${cfg.flow === k ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
              <div class="switch-row">
                <span>显示三阶段支架</span>
                <label class="switch"><input type="checkbox" data-scaffold="${c.id}-${round.id}" ${cfg.scaffold ? 'checked' : ''}><span></span></label>
              </div>
              <p class="config-note">${cfg.flow === 'first' ? '视频就绪后开放 AI 反馈' : cfg.flow === 'later' ? '提交初稿后才显示 AI 建议' : '关闭 AI 调用与反馈面板'}</p>
            </section>`;
          }).join('')}
        </div>
      </section>`).join('');
    $('#main').innerHTML = `
      <div class="page-head">
        <div>
          <div class="eyebrow">EXPERIMENT DESIGN</div>
          <h1>实验配置</h1>
          <p>设置各班级的 AI 介入流程、反思支架，以及实验流程与前后测问卷。</p>
        </div>
        <button class="btn primary" type="button" id="saveConfigBtn">${icons('save', 'i-sm')} 保存实验配置</button>
      </div>
      <div class="notice" style="margin-bottom:18px">班级配置只影响之后新建的任务；已经开始的任务沿用创建时的配置。流程与问卷设置即时作用于学生端。</div>
      ${settingsCard}
      ${roundsHtml}`;
    $('#saveConfigBtn').addEventListener('click', saveConfig);
  } catch (ex) {
    $('#main').innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
  }
}

async function saveConfig() {
  const configs = [];
  $$('[data-flow]').forEach((sel) => {
    const [classId, roundId] = sel.dataset.flow.split('-').map(Number);
    const toggle = document.querySelector(`[data-scaffold="${sel.dataset.flow}"]`);
    configs.push({ class_id: classId, round_id: roundId, flow: sel.value, scaffold: toggle && toggle.checked });
  });
  const settings = {};
  $$('[data-setting]').forEach((input) => { settings[input.dataset.setting] = input.checked; });
  try {
    await api('/api/teacher/config', { method: 'PUT', body: { configs, settings } });
    toast('实验配置已保存');
  } catch (ex) {
    toast(ex.message);
  }
}

/* ------------------------------------------------------------ 过程数据 */

function renderData() {
  $('#main').innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">RESEARCH DATA</div>
        <h1>过程数据</h1>
        <p>按班级和任务查看提交情况、文本版本、AI 反馈、行为事件与问卷。</p>
      </div>
      <div class="export-row">
        <label class="anon-label"><input type="checkbox" id="anonExport" ${state.anonymous ? 'checked' : ''}> 匿名导出</label>
        <a class="btn" id="participantsLink" href="#">参与者名单</a>
        <a class="btn" id="exportLink" href="#">导出当前数据</a>
      </div>
    </div>
    <div class="source-line">被试编号用于匿名分析；数据保存在本机 SQLite。CSV 可按 task_id / participant_id 关联。</div>
    <div class="data-inline four" id="dataStats"></div>
    <div class="filters">
      <select class="field" id="filterClass">
        <option value="">全部班级</option>
        ${state.meta.classes.map((c) => `<option value="${c.id}" ${String(state.filters.class_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <select class="field" id="filterRound">
        <option value="">全部任务</option>
        ${state.meta.rounds.map((r) => `<option value="${r.id}" ${String(state.filters.round_id) === String(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <button class="btn small" type="button" id="refreshData">刷新</button>
    </div>
    <div class="tabs">
      ${[['tasks', '任务记录'], ['versions', '文本版本'], ['feedback', 'AI 反馈'], ['events', '行为事件'], ['surveys', '问卷']]
        .map(([k, label]) => `<button type="button" data-tab="${k}" class="${state.dataTab === k ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="dataContent"><div class="empty">加载中…</div></div>`;
  $('#filterClass').addEventListener('change', (e) => { state.filters.class_id = e.target.value; loadData(); });
  $('#filterRound').addEventListener('change', (e) => { state.filters.round_id = e.target.value; loadData(); });
  $('#refreshData').addEventListener('click', loadData);
  $('#anonExport').addEventListener('change', (e) => { state.anonymous = e.target.checked; updateExportLinks(); });
  $$('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.dataTab = btn.dataset.tab;
      $$('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      loadData();
    });
  });
  loadData();
}

function dataQuery() {
  const params = new URLSearchParams();
  if (state.filters.class_id) params.set('class_id', state.filters.class_id);
  if (state.filters.round_id) params.set('round_id', state.filters.round_id);
  return params.toString();
}

function exportHref(type, includeRound = true) {
  const params = new URLSearchParams();
  if (state.filters.class_id) params.set('class_id', state.filters.class_id);
  if (includeRound && state.filters.round_id) params.set('round_id', state.filters.round_id);
  if (state.anonymous) params.set('anonymous', '1');
  const qs = params.toString();
  return `/api/teacher/export?type=${type}${qs ? `&${qs}` : ''}`;
}

function updateExportLinks() {
  const exportLink = $('#exportLink');
  if (exportLink) exportLink.href = exportHref(state.dataTab);
  const participantsLink = $('#participantsLink');
  if (participantsLink) participantsLink.href = exportHref('participants', false);
}

async function loadData() {
  updateExportLinks();
  const box = $('#dataContent');
  if (!box) return;
  box.innerHTML = '<div class="empty">加载中…</div>';
  const qs = dataQuery();
  try {
    const taskData = await api(`/api/teacher/monitor/tasks${qs ? `?${qs}` : ''}`);
    state.taskStats = taskData.rows || [];
    let rows = state.taskStats;
    if (state.dataTab !== 'tasks') {
      const data = await api(`/api/teacher/monitor/${state.dataTab}${qs ? `?${qs}` : ''}`);
      rows = data.rows || [];
      state.surveyMeta = data.items ? { items: data.items, scale: data.scale } : null;
    } else {
      state.surveyMeta = null;
    }
    renderStats();
    box.innerHTML = renderDataTable(state.dataTab, rows);
  } catch (ex) {
    box.innerHTML = `<div class="empty">${esc(ex.message)}</div>`;
  }
}

function renderStats() {
  const rows = state.taskStats || [];
  const submitted = rows.filter((r) => r.status === 'submitted').length;
  const doing = rows.filter((r) => r.status === 'in_progress').length;
  const idle = rows.filter((r) => r.status === 'not_started').length;
  const students = new Set(rows.map((r) => r.student_no)).size;
  const box = $('#dataStats');
  if (!box) return;
  box.innerHTML = `
    <div class="card stat"><span>参与学生</span><strong>${students}</strong><small>已登录学生</small></div>
    <div class="card stat"><span>已提交</span><strong>${submitted}</strong><small>任务实例</small></div>
    <div class="card stat"><span>进行中</span><strong>${doing}</strong><small>尚未提交</small></div>
    <div class="card stat"><span>未开始</span><strong>${idle}</strong><small>尚未进入任务</small></div>`;
}

function preview(text, time) {
  const t = String(text || '').trim();
  if (!t) return '—';
  if (t.length <= 60) return `${esc(t)}${time ? `<br><span class="muted">${fmtTime(time)}</span>` : ''}`;
  return `<details><summary>${esc(t.slice(0, 30))}…</summary><pre>${esc(t)}</pre></details>`;
}

function renderDataTable(tab, rows) {
  if (!rows.length) return '<div class="card"><div class="empty">暂无数据。学生登录并开始任务后，这里会出现记录。</div></div>';
  if (tab === 'tasks') {
    return `<div class="card table-card"><table class="table">
      <thead><tr><th>编号</th><th>学生</th><th>学号</th><th>班级</th><th>任务</th><th>流程</th><th>视频</th><th>状态</th><th>提交时间</th><th>用时</th><th>顺序偏离</th><th>下载</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${esc(r.participant_id || '—')}</strong></td>
        <td>${esc(r.student_name)}</td>
        <td>${esc(r.student_no)}</td>
        <td>${esc(r.class_name)}</td>
        <td>${esc(r.round_name)}</td>
        <td>${esc(r.flow || '—')}</td>
        <td>${r.video_status ? esc(VIDEO_LABEL[r.video_status] || r.video_status) : '—'}</td>
        <td><span class="tag ${r.status === 'submitted' ? 'green' : r.status === 'in_progress' ? 'amber' : ''}">${TASK_LABEL[r.status] || r.status}</span></td>
        <td>${r.submitted_at ? fmtTime(r.submitted_at) : '—'}</td>
        <td>${r.duration_seconds != null ? fmtDur(r.duration_seconds) : '—'}</td>
        <td>${r.order_deviation ? '<span class="tag amber">已记录</span>' : '无'}</td>
        <td>${r.task_id ? `<a href="/api/teacher/task/${r.task_id}/text" download>文本</a>${r.flow && r.flow !== '无 AI' ? ` · <a href="/api/teacher/task/${r.task_id}/ai" download>AI</a>` : ''} · <a href="/api/teacher/task/${r.task_id}/events" download>事件</a>` : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }
  if (tab === 'versions') {
    return `<div class="card table-card"><table class="table">
      <thead><tr><th>编号</th><th>学生</th><th>班级</th><th>任务</th><th>阶段</th><th>当前草稿</th><th>已提交初稿</th><th>最终稿</th><th>下载</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${esc(r.participant_id || '—')}</strong></td>
        <td>${esc(r.student_name)}</td>
        <td>${esc(r.class_name)}</td>
        <td>${esc(r.round_name)}</td>
        <td>${esc(r.stage)}</td>
        <td class="wrap-cell">${preview(r.draft_text, r.draft_saved_at)}</td>
        <td class="wrap-cell">${r.initial_text && r.initial_text.trim() ? preview(r.initial_text, r.initial_at) : '—'}</td>
        <td class="wrap-cell">${r.final_text && r.final_text.trim() ? preview(r.final_text, r.final_at) : '—'}</td>
        <td><a href="/api/teacher/task/${r.task_id}/text" download>全文</a></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }
  if (tab === 'feedback') {
    return `<div class="card table-card"><table class="table">
      <thead><tr><th>编号</th><th>学生</th><th>班级</th><th>任务</th><th>状态</th><th>模型</th><th>请求时间</th><th>生成时间</th><th>首次呈现</th><th>内容</th><th>下载</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${esc(r.participant_id || '—')}</strong></td>
        <td>${esc(r.student_name)}</td>
        <td>${esc(r.class_name)}</td>
        <td>${esc(r.round_name)}</td>
        <td><span class="tag ${r.status === 'ready' ? 'green' : ''}">${AI_LABEL[r.status] || r.status}</span></td>
        <td>${esc(r.model || '—')} / ${esc(r.prompt_version || '—')}</td>
        <td>${fmtTime(r.requested_at)}</td>
        <td>${fmtTime(r.generated_at)}</td>
        <td>${fmtTime(r.presented_at)}</td>
        <td class="wrap-cell">${r.items.length ? `<details><summary>查看反馈</summary><pre>${esc(r.items.map((i) => `[${i.stage}] ${i.title}\n${i.observation}\n建议：${i.suggestion}`).join('\n\n'))}</pre></details>` : '—'}</td>
        <td><a href="/api/teacher/task/${r.task_id}/ai" download>下载</a></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }
  if (tab === 'surveys') {
    const meta = state.surveyMeta || { items: {}, scale: {} };
    const block = (obj, kind) => {
      if (!obj) return '';
      const answers = obj.answers || {};
      const lines = (meta.items[kind] || []).map((item) => {
        const score = answers[item.id];
        return `${item.text}\n  ${score ?? '—'} · ${meta.scale[String(score)] || ''}`;
      }).join('\n');
      const comment = answers.comment ? `\n其他想法：${answers.comment}` : '';
      return `<details><summary>${kind === 'pre' ? '前测答卷' : '后测答卷'}</summary><pre>${esc(lines + comment)}</pre></details>`;
    };
    return `<div class="card table-card"><table class="table">
      <thead><tr><th>编号</th><th>学生</th><th>学号</th><th>班级</th><th>前测</th><th>后测</th><th>答卷</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${esc(r.participant_id || '—')}</strong></td>
        <td>${esc(r.student_name)}</td>
        <td>${esc(r.student_no)}</td>
        <td>${esc(r.class_name)}</td>
        <td>${r.pre ? `<span class="tag green">已填写</span><br><span class="muted">${fmtTime(r.pre.submitted_at)}</span>` : '<span class="tag">未填写</span>'}</td>
        <td>${r.post ? `<span class="tag green">已填写</span><br><span class="muted">${fmtTime(r.post.submitted_at)}</span>` : '<span class="tag">未填写</span>'}</td>
        <td class="wrap-cell">${r.pre || r.post ? `${block(r.pre, 'pre')}${block(r.post, 'post')}` : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }
  return `<div class="card table-card"><table class="table">
    <thead><tr><th>时间</th><th>编号</th><th>学生</th><th>班级</th><th>任务</th><th>事件</th><th>详情</th><th>视频位置</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${fmtTime(r.occurred_at)}</td>
      <td><strong>${esc(r.participant_id || '—')}</strong></td>
      <td>${esc(r.student_name)}</td>
      <td>${esc(r.class_name)}</td>
      <td>${esc(r.round_name)}</td>
      <td>${esc(r.type)}</td>
      <td class="wrap-cell">${esc(r.detail || '—')}</td>
      <td>${r.position !== null && typeof r.position !== 'undefined' ? fmtDur(r.position) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

/* ------------------------------------------------------------ 启动 */

function openTeacherMobileNav() {
  openModal('页面导航', `<div class="nav">${teacherNavItems().map(([key, icon, label]) => `
    <button type="button" data-mobile-view="${key}" style="text-align:left">${icons(icon)}<span>${label}</span></button>`).join('')}</div>`);
  $$('[data-mobile-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeModal();
      goTeacherView(btn.dataset.mobileView);
    });
  });
}

async function bootTeacher() {
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/teacher';
  });
  $('#mobileNavBtn').addEventListener('click', openTeacherMobileNav);
  try {
    const me = await loadMetaAndMe();
    if (me && me.role !== 'teacher') { location.href = '/student'; return; }
    if (me) {
      state.view = 'config';
      showTeacherApp();
    } else {
      showTeacherLogin();
    }
  } catch (ex) {
    $('#loginRoot').hidden = false;
    $('#loginRoot').innerHTML = `<div class="login-page"><div class="card login-card"><p>无法连接服务：${esc(ex.message)}</p></div></div>`;
  }
}

bootTeacher();
