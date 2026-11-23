'use strict';

const ROLE = document.body.dataset.role || '';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const icons = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const FLOW_LABEL = { none: '无 AI', first: 'AI 先介入', later: 'AI 后介入' };
const VIDEO_LABEL = { empty: '未上传', processing: '处理中', ready: '已就绪', failed: '处理失败' };
const TASK_LABEL = { not_started: '未开始', in_progress: '进行中', submitted: '已提交' };
const AI_LABEL = { locked: '待初稿', waiting: '等待视频', generating: '生成中', ready: '已生成', failed: '失败' };

const state = {
  me: null,
  meta: null,
  modalActions: [],
};

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
function fmtDur(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function words(text) {
  return String(text || '').replace(/\s/g, '').length;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    if (res.status === 401) {
      location.href = ROLE === 'teacher' ? '/teacher' : '/student';
    }
    throw new Error((data && data.error) || `请求失败（${res.status}）`);
  }
  return data;
}

function openModal(title, bodyHtml, actions = []) {
  state.modalActions = actions;
  const footer = actions.length
    ? `<div class="modal-footer">${actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''}" type="button" data-modal-action="${i}">${esc(a.label)}</button>`).join('')}</div>`
    : '';
  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop">
      <section class="modal" role="dialog" aria-modal="true">
        <div class="modal-header"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-modal-close aria-label="关闭">${icons('close')}</button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footer}
      </section>
    </div>`;
  $('#modalRoot').querySelector('[data-modal-close]').addEventListener('click', closeModal);
  $('#modalRoot').querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  $('#modalRoot').querySelectorAll('[data-modal-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = state.modalActions[Number(btn.dataset.modalAction)];
      if (!action) return;
      if (action.onClick) {
        btn.disabled = true;
        try { await action.onClick(); } finally { btn.disabled = false; }
      }
      closeModal();
    });
  });
  setTimeout(() => $('#modalRoot button')?.focus(), 0);
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
  state.modalActions = [];
}

async function loadMetaAndMe() {
  state.meta = await api('/api/meta');
  const me = await api('/api/me');
  state.me = me.user;
  return state.me;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
