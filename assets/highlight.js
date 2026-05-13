// AI Digest highlight engine
// - Selection → popup (comment + #tags + public/private toggle) → save
// - localStorage for offline + private; Supabase for public + cross-device read
// - Restores highlights on load; export-to-Markdown for Obsidian
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CFG = window.AI_DIGEST_CONFIG || {};
const supa = (CFG.supabaseUrl && CFG.supabaseKey)
  ? createClient(CFG.supabaseUrl, CFG.supabaseKey)
  : null;

const LS_KEY = 'ai-digest-highlights-v1';
const LS_TOKEN_KEY = 'ai-digest-owner-token';
const LS_NAME_KEY = 'ai-digest-display-name';

function getDisplayName() {
  return (localStorage.getItem(LS_NAME_KEY) || '').trim();
}

const OWNER_TOKEN = (() => {
  let t = localStorage.getItem(LS_TOKEN_KEY);
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    localStorage.setItem(LS_TOKEN_KEY, t);
  }
  return t;
})();

const PAGE_URL = window.location.href.split('?')[0].split('#')[0];

// ── localStorage helpers ─────────────────────────────────────────
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
  catch { return []; }
}
function saveLocal(arr) {
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
}
function upsertLocal(entry) {
  const arr = loadLocal();
  const i = arr.findIndex(x => x.id === entry.id);
  if (i >= 0) arr[i] = entry; else arr.unshift(entry);
  saveLocal(arr);
}
function removeLocal(id) {
  saveLocal(loadLocal().filter(x => x.id !== id));
}

// ── Toast ────────────────────────────────────────────────────────
function toast(msg) {
  let el = document.querySelector('.ai-digest-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'ai-digest-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

// ── DOM highlighting (wrap matched text in <mark>) ───────────────
// Naive single-occurrence match. Stores text + neighboring context for re-find.
function findRangeForText(text, prefix, suffix) {
  if (!text) return null;
  const body = document.querySelector('.container') || document.body;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.parentNode && n.parentNode.closest('.ai-digest-nav, .ai-digest-popup, .ai-digest-toast, script, style')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  // Build flat string + node map
  const nodes = [];
  const offsets = [];
  let total = '';
  let n;
  while ((n = walker.nextNode())) {
    offsets.push(total.length);
    nodes.push(n);
    total += n.nodeValue;
  }
  // Find best match using prefix+text+suffix anchor; fallback to text only
  const anchor = (prefix || '') + text + (suffix || '');
  let idx = anchor ? total.indexOf(anchor) : -1;
  let startInText;
  if (idx >= 0) {
    startInText = idx + (prefix || '').length;
  } else {
    idx = total.indexOf(text);
    if (idx < 0) return null;
    startInText = idx;
  }
  const endInText = startInText + text.length;

  function nodeAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (offsets[i] <= pos) return { node: nodes[i], offset: pos - offsets[i] };
    }
    return null;
  }
  const a = nodeAt(startInText);
  const b = nodeAt(endInText);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

function wrapRange(range, entry) {
  try {
    const mark = document.createElement('mark');
    mark.className = 'ai-digest-mark';
    mark.dataset.id = entry.id;
    mark.dataset.private = String(!entry.isPublic);
    if (entry.comment && entry.comment.trim()) mark.classList.add('has-comment');
    mark.title = entry.comment || (entry.tags?.length ? entry.tags.map(t=>'#'+t).join(' ') : '');
    range.surroundContents(mark);
    mark.addEventListener('click', e => {
      e.stopPropagation();
      openEditPopupForEntry(entry, mark);
    });
    return mark;
  } catch (err) {
    // surroundContents can fail if range spans non-text boundaries
    return null;
  }
}

function applyEntry(entry) {
  if (document.querySelector(`mark.ai-digest-mark[data-id="${entry.id}"]`)) return;
  const range = findRangeForText(entry.textContent, entry.contextBefore, entry.contextAfter);
  if (!range) return;
  wrapRange(range, entry);
}

function restoreAllForPage() {
  const local = loadLocal().filter(h => h.digestUrl === PAGE_URL);
  for (const h of local) applyEntry(h);
}

// ── Popup ────────────────────────────────────────────────────────
let popup = null;
function closePopup() {
  if (popup) { popup.remove(); popup = null; }
}
document.addEventListener('click', e => {
  if (popup && !popup.contains(e.target) && !e.target.closest('mark.ai-digest-mark')) {
    closePopup();
  }
});

function positionPopup(rect) {
  popup.style.top = `${window.scrollY + rect.bottom + 10}px`;
  const popupWidth = 320;
  let left = rect.left;
  const max = window.innerWidth - popupWidth - 16;
  if (left > max) left = max;
  if (left < 16) left = 16;
  popup.style.left = `${left}px`;
}

function parseTagsInput(s) {
  return (s || '')
    .split(/[\s,，]+/)
    .map(t => t.replace(/^#/, '').trim())
    .filter(Boolean);
}

function openCreatePopup(range, text) {
  closePopup();
  const rect = range.getBoundingClientRect();
  popup = document.createElement('div');
  popup.className = 'ai-digest-popup';
  popup.innerHTML = `
    <div class="ai-digest-quote">${escapeHtml(text.slice(0, 200))}${text.length > 200 ? '…' : ''}</div>
    <textarea class="hp-comment" placeholder="评论（可选）" rows="2"></textarea>
    <input type="text" class="hp-tags" placeholder="#标签 #投资视角 #ai-roll-up（空格分隔）" />
    <div class="ai-digest-hint">用 # 开头打标签；多个标签用空格分隔</div>
    <div class="ai-digest-row">
      <label><input type="checkbox" class="hp-private" /> 仅自己可见</label>
      <div>
        <button class="hp-cancel">取消</button>
        <button class="hp-save primary">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(popup);
  positionPopup(rect);
  popup.querySelector('.hp-comment').focus();

  popup.querySelector('.hp-cancel').onclick = () => {
    closePopup();
    window.getSelection().removeAllRanges();
  };
  popup.querySelector('.hp-save').onclick = async () => {
    const comment = popup.querySelector('.hp-comment').value.trim();
    const tags = parseTagsInput(popup.querySelector('.hp-tags').value);
    const isPrivate = popup.querySelector('.hp-private').checked;
    await createHighlight(range, text, { comment, tags, isPublic: !isPrivate });
    closePopup();
    window.getSelection().removeAllRanges();
  };
}

function openEditPopupForEntry(entry, markEl) {
  closePopup();
  const rect = markEl.getBoundingClientRect();
  popup = document.createElement('div');
  popup.className = 'ai-digest-popup';
  popup.innerHTML = `
    <div class="ai-digest-quote">${escapeHtml(entry.textContent.slice(0, 200))}${entry.textContent.length > 200 ? '…' : ''}</div>
    <textarea class="hp-comment" placeholder="评论（可选）" rows="2">${escapeHtml(entry.comment || '')}</textarea>
    <input type="text" class="hp-tags" placeholder="#标签" value="${(entry.tags || []).map(t=>'#'+t).join(' ')}" />
    <div class="ai-digest-row">
      <label><input type="checkbox" class="hp-private" ${entry.isPublic ? '' : 'checked'} /> 仅自己可见</label>
      <div>
        <button class="hp-delete danger">删除</button>
        <button class="hp-save primary">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(popup);
  positionPopup(rect);

  const isOwner = entry.ownerToken === OWNER_TOKEN;
  if (!isOwner) {
    popup.querySelectorAll('textarea, input, button.hp-save, button.hp-delete').forEach(el => el.disabled = true);
    const note = document.createElement('div');
    note.className = 'ai-digest-hint';
    note.style.marginTop = '4px';
    note.textContent = '这条划线不是你创建的，无法编辑';
    popup.appendChild(note);
  }

  popup.querySelector('.hp-delete').onclick = async () => {
    if (!confirm('确定删除这条划线？')) return;
    await deleteHighlight(entry, markEl);
    closePopup();
  };
  popup.querySelector('.hp-save').onclick = async () => {
    const comment = popup.querySelector('.hp-comment').value.trim();
    const tags = parseTagsInput(popup.querySelector('.hp-tags').value);
    const wasPublic = entry.isPublic;
    const isPrivate = popup.querySelector('.hp-private').checked;
    await updateHighlight(entry, markEl, { comment, tags, isPublic: !isPrivate, wasPublic });
    closePopup();
  };
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

// ── CRUD ─────────────────────────────────────────────────────────
function rangeContext(range) {
  // Capture ~30 chars before and after for re-anchoring on reload
  const before = (range.startContainer.nodeValue || '').slice(Math.max(0, range.startOffset - 30), range.startOffset);
  const after = (range.endContainer.nodeValue || '').slice(range.endOffset, range.endOffset + 30);
  return { before, after };
}

async function createHighlight(range, text, { comment, tags, isPublic }) {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  const { before, after } = rangeContext(range);
  const entry = {
    id,
    digestDate: CFG.digestDate || null,
    digestUrl: PAGE_URL,
    digestTitle: document.title || '',
    textContent: text,
    contextBefore: before,
    contextAfter: after,
    comment, tags, isPublic,
    ownerToken: OWNER_TOKEN,
    createdAt: new Date().toISOString()
  };
  upsertLocal(entry);
  wrapRange(range, entry);

  if (isPublic && supa) {
    const name = getDisplayName();
    entry.authorName = name || null;
    upsertLocal(entry);
    const { error } = await supa.from('highlights').insert({
      id,
      digest_date: entry.digestDate,
      digest_url: entry.digestUrl,
      digest_title: entry.digestTitle,
      text_content: entry.textContent,
      comment: entry.comment || '',
      tags: entry.tags || [],
      owner_token: OWNER_TOKEN,
      author_name: name || null
    });
    if (error) toast('已保存本地，云端失败：' + error.message);
    else toast('已保存（公开）' + (name ? ' · ' + name : ' · 匿名'));
  } else {
    toast(isPublic ? '已保存（公开 · 匿名）' : '已保存（私密）');
  }
}

async function updateHighlight(entry, markEl, { comment, tags, isPublic, wasPublic }) {
  const updated = { ...entry, comment, tags, isPublic };
  upsertLocal(updated);
  markEl.dataset.private = String(!isPublic);
  markEl.classList.toggle('has-comment', !!(comment && comment.trim()));
  markEl.title = comment || (tags?.length ? tags.map(t=>'#'+t).join(' ') : '');

  if (supa) {
    if (wasPublic && isPublic) {
      const { error } = await supa.rpc('update_highlight', {
        p_id: entry.id, p_token: OWNER_TOKEN,
        p_comment: comment || '', p_tags: tags || []
      });
      if (error) toast('云端更新失败：' + error.message);
      else toast('已更新');
    } else if (wasPublic && !isPublic) {
      // Was public → now private: remove from cloud
      const { error } = await supa.rpc('delete_highlight', { p_id: entry.id, p_token: OWNER_TOKEN });
      if (error) toast('云端删除失败：' + error.message);
      else toast('已改为私密（云端已清除）');
    } else if (!wasPublic && isPublic) {
      // Was private → now public: insert to cloud
      const { error } = await supa.from('highlights').insert({
        id: entry.id, digest_date: entry.digestDate, digest_url: entry.digestUrl,
        digest_title: entry.digestTitle, text_content: entry.textContent,
        comment: comment || '', tags: tags || [], owner_token: OWNER_TOKEN
      });
      if (error) toast('云端上传失败：' + error.message);
      else toast('已改为公开（已上传）');
    } else {
      toast('已更新（私密）');
    }
  } else {
    toast('已更新');
  }
}

async function deleteHighlight(entry, markEl) {
  removeLocal(entry.id);
  // Unwrap the mark element back to its text
  const parent = markEl.parentNode;
  while (markEl.firstChild) parent.insertBefore(markEl.firstChild, markEl);
  parent.removeChild(markEl);
  parent.normalize();

  if (entry.isPublic && supa) {
    const { error } = await supa.rpc('delete_highlight', { p_id: entry.id, p_token: OWNER_TOKEN });
    if (error) toast('云端删除失败：' + error.message);
    else toast('已删除');
  } else {
    toast('已删除');
  }
}

// ── Selection listener ───────────────────────────────────────────
document.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;
    // Don't trigger if selection is inside a popup or nav
    const range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const ancestorEl = ancestor.nodeType === 1 ? ancestor : ancestor.parentNode;
    if (ancestorEl.closest && ancestorEl.closest('.ai-digest-popup, .ai-digest-nav, .ai-digest-toast')) return;
    // Don't re-trigger on existing marks (let the click handler take over)
    if (ancestorEl.closest && ancestorEl.closest('mark.ai-digest-mark')) return;
    openCreatePopup(range, text);
  }, 10);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePopup();
});

// ── Export to Markdown (download .md, drop into Obsidian) ────────
window.exportHighlightsAsMarkdown = function() {
  const all = loadLocal();
  if (!all.length) { toast('还没有划线'); return; }
  const byTag = {};
  for (const h of all) {
    const tags = (h.tags && h.tags.length) ? h.tags : ['untagged'];
    for (const t of tags) (byTag[t] = byTag[t] || []).push(h);
  }
  const today = new Date().toISOString().slice(0, 10);
  let md = `# AI Digest Highlights\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n共 ${all.length} 条划线\n\n---\n\n`;
  for (const tag of Object.keys(byTag).sort()) {
    md += `## #${tag}\n\n`;
    for (const h of byTag[tag]) {
      md += `> ${h.textContent}\n>\n`;
      if (h.comment) md += `> **评论：** ${h.comment}\n>\n`;
      md += `> *${h.digestTitle || h.digestDate || ''} · ${h.isPublic ? '公开' : '私密'}*\n>\n`;
      md += `> [来源](${h.digestUrl}) · ${new Date(h.createdAt).toLocaleString('zh-CN')}\n\n`;
    }
  }
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-digest-highlights-${today}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`已导出 ${all.length} 条到 Markdown`);
};

window.AI_DIGEST = {
  ownerToken: OWNER_TOKEN,
  supabase: supa,
  loadLocal,
  saveLocal,
  exportMarkdown: window.exportHighlightsAsMarkdown
};

// ── Init ─────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restoreAllForPage);
} else {
  restoreAllForPage();
}
