/**
 * content.js —— 隔离世界内容脚本
 * 职责：
 *  1. 接收 hook_main.js 转发的评论 API JSON，用 core.js 建立评论索引
 *  2. 扫描 DOM，给每条评论注入「🔗对话链」按钮
 *  3. 点击按钮 → 还原完整对话链（API 精确模式 / DOM 启发式兜底）→ 侧边面板展示
 */
(function () {
  'use strict';

  const Core = window.XHSTracerCore;
  if (!Core) {
    console.warn('[xhs-tracer] core.js 未加载，插件退出');
    return;
  }

  // 选择器依据 2026-10 真实小红书页面 DOM 校准（用户存档页面实测）：
  // 一级评论 <div id="comment-{id}" class="comment-item">，楼中楼 class="comment-item comment-item-sub"
  // 昵称 .author a.name，正文 .content .note-text
  const SELECTORS = {
    commentItem: '.comment-item',
    authorName: '.author a.name, a.name, .author .name',
    content: '.content .note-text, .note-text, .content'
  };
  const COMMENT_ID_RE = /^comment-([0-9a-f]+)$/;

  const store = new Map(); // id -> record
  let index = null;
  const byTextKey = new Map(); // nickname|content -> id
  let scanTimer = null;

  // ---------------- API 数据接入 ----------------
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.source !== 'xhs-thread-tracer' || msg.type !== 'comments') return;
    try { ingest(msg.payload && msg.payload.json, msg.payload && msg.payload.url); } catch (err) {
      console.warn('[xhs-tracer] ingest error', err);
    }
  });

  function ingest(json, url) {
    const records = Core.collectFromApiResponse(json || {}, url);
    if (!records.length) return;
    for (const rec of records) if (!store.has(rec.id)) store.set(rec.id, rec);
    rebuildIndex();
    scheduleScan();
    if (panelCtx) renderPanel(); // 面板打开时，新数据（含自动展开的楼中楼）到达即刷新
  }

  function rebuildIndex() {
    const byRoot = new Map();
    for (const rec of store.values()) {
      const key = rec.rootId || rec.id;
      if (!byRoot.has(key)) byRoot.set(key, []);
      byRoot.get(key).push(rec);
    }
    index = Core.buildIndex(Array.from(store.values()));
    Core.resolveParents(index, byRoot);
    byTextKey.clear();
    for (const rec of index.byId.values()) {
      const k = textKey(rec.nickname, rec.content);
      if (!byTextKey.has(k)) byTextKey.set(k, rec.id);
    }
  }

  function textKey(nick, text) {
    const clean = (s) => String(s || '').replace(/\s+/g, '');
    return clean(nick) + '|' + clean(text).slice(0, 80);
  }

  // ---------------- DOM 扫描与按钮注入 ----------------
  function extractItem(el) {
    const nickEl = el.querySelector(SELECTORS.authorName);
    const contentEl = el.querySelector(SELECTORS.content);
    return {
      nick: nickEl ? nickEl.textContent.trim() : '',
      text: contentEl ? contentEl.textContent.trim() : ''
    };
  }

  function scan() {
    let items;
    try { items = document.querySelectorAll(SELECTORS.commentItem); } catch (e) { return; }
    let firstLog = scan.__logged;
    for (const el of items) {
      // 真实 DOM 的评论节点自带 id="comment-{id}"，先标记，精确链路直接可用
      if (!el.dataset.xhsTraced) {
        const idEl = el.id && COMMENT_ID_RE.test(el.id) ? el : el.closest('[id^="comment-"]');
        if (idEl) el.dataset.xhsTraced = idEl.id.replace(/^comment-/, '');
      }
      addChainButton(el);
    }
    if (!firstLog) {
      scan.__logged = true;
      console.info(`[xhs-tracer] 已注入 ${items.length} 个对话链按钮；API 数据 ${store.size} 条`);
    }
  }

  function addChainButton(el) {
    // 只查直接子级，避免楼中楼的按钮被误判成父评论已注入
    if (el.querySelector(':scope > .xhs-tracer-btn-host > .xhs-tracer-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xhs-tracer-btn';
    btn.textContent = '🔗对话链';
    btn.title = '查看这条评论的完整对话链（XHS Thread Tracer）';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const resolved = resolveTree(el);
      if (!resolved) {
        showToast('未能解析对话树（可看 README 调整选择器）');
        return;
      }
      openPanelCtx(resolved);
    });
    const host = document.createElement('span');
    host.className = 'xhs-tracer-btn-host';
    host.appendChild(btn);
    // 绝对定位到评论右下角：真实 DOM 的 .comment-item 也是 flex 布局，
    // 内联 append 会被挤到最右裁剪成竖排（2026-10-10 真机截图反馈），故不参与 flex 布局
    try {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    } catch (e) { /* ignore */ }
    el.appendChild(host);
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
  }

  const mo = new MutationObserver(scheduleScan);
  function startObserver() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      return;
    }
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
  }
  startObserver();

  // ---------------- 对话树解析 ----------------
  /**
   * 返回点击评论所属主楼线程的整棵树：
   * { rootId, selfId, mode }
   * API 模式：父子关系来自 target_comment 字段；DOM 模式：启发式推断
   */
  function resolveTree(el) {
    // 1) 已标记过 id / DOM 节点自带 comment-{id}
    let id = el.dataset.xhsTraced;
    if (!id) {
      const idEl = el.id && COMMENT_ID_RE.test(el.id) ? el : el.closest('[id^="comment-"]');
      if (idEl) id = idEl.id.replace(/^comment-/, '');
      if (id) el.dataset.xhsTraced = id;
    }
    if (id && index && index.byId.has(id)) {
      const rootId = Core.getThreadRootId(index, id);
      return { rootId, selfId: id, mode: 'api', treeIndex: index };
    }

    const { nick, text } = extractItem(el);

    // 2) 用「昵称+正文」匹配 API 数据（未展开楼中楼时 DOM 常常拿不到 id）
    const k = textKey(nick, text);
    if (index && byTextKey.has(k)) {
      const matchedId = byTextKey.get(k);
      el.dataset.xhsTraced = matchedId;
      const rootId = Core.getThreadRootId(index, matchedId);
      return { rootId, selfId: matchedId, mode: 'api', treeIndex: index };
    }

    // 3) DOM 启发式兜底：在同一主楼容器内按 DOM 顺序重建
    const container = el.closest('.parent-comment') || el.closest('.comment-item') || el;
    const items = Array.from(container.querySelectorAll(SELECTORS.commentItem));
    const recs = [];
    let selfRec = null;
    items.forEach((item, i) => {
      const info = extractItem(item);
      if (!info.nick && !info.text) return;
      const rec = {
        id: 'dom' + i,
        rootId: 'domroot',
        parentId: null,
        nickname: info.nick || '(未知用户)',
        content: info.text,
        pictures: Array.from(item.querySelectorAll('.note-text img, .content img'))
          .map((im) => ({ thumb: im.src, full: im.src }))
          .filter((p) => p.thumb),
        createTime: null,
        el: item
      };
      recs.push(rec);
      if (item === el) selfRec = rec;
    });
    if (!selfRec || !recs.length) return null;
    // 容器内第一条一级评论是主楼；无「回复 @」指向的子回复默认挂主楼
    const rootRec = recs[0];
    for (const rec of recs) {
      if (rec !== rootRec && !Core.extractReplyTarget(rec.content).nickname) {
        rec.parentId = rootRec.id;
      }
    }
    const domIndex = Core.buildIndex(recs);
    Core.resolveParents(domIndex, new Map([['domroot', recs]]));
    const rootId = Core.getThreadRootId(domIndex, selfRec.id);
    return { rootId, selfId: selfRec.id, mode: 'dom', treeIndex: domIndex };
  }

// ---------------- 侧边面板 ----------------
let panel = null;
let panelCtx = null; // { rootId, selfId, mode }
// 手风琴树：记录「已展开（子节点可见）」的节点 id。
// 规则：除顶层（楼主）外每层默认收起，用户点击展开；同层互斥——展开一个收起兄弟。
let panelExpanded = new Set();

function formatTime(t) {
  const n = Number(t);
  if (!n || !isFinite(n) || n < 1e11) return ''; // core 已统一为毫秒
  try {
    const d = new Date(n);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return ''; }
}

// 「展开 N 条回复 / 更多回复」按钮（真实 DOM：div.show-more，2026-10-10 存档页核实）
// 文字过滤只要求含「回复」：XHS 首次展开后按钮文字会变（展开更多/共 N 条回复 等），
// 锚定模式会漏掉后续分页按钮导致展开停滞；「展开全文」（笔记正文）不含「回复」，天然排除
function findExpandButtons(scope) {
  return Array.from(scope.querySelectorAll('.show-more'))
    .filter((el) => /回复/.test(el.textContent || ''));
}

/** 该主楼的楼中楼是否已全部加载（对比 API 的 sub_comment_count 与已收集的子孙数） */
function threadComplete(rootRec) {
  if (!rootRec || rootRec.subCount == null) return true;
  const have = Core.getSubtree(index, rootRec.id).length - 1;
  return have >= rootRec.subCount;
}

/**
 * 自动展开某主楼的楼中楼：替用户点击容器内展开按钮（页面自己发签名请求，hook 捕获），
 * 数据经 ingest 到达后 renderPanel 自动刷新。
 * 鲁棒性（修「重试才能展开」）：
 *  - 自适应等待：点击后轮询 store 增长（每 300ms，最多 3s），数据一到立即下一轮——
 *    替代固定 900ms（XHS 渲染/API 经常更慢，导致循环误判无进展提前退出）
 *  - 按钮未渲染时先等一拍再找，不立即退出
 *  - 无进展检测：连续 3 轮点击无新数据才放弃；停滞时打印容器内候选元素辅助诊断
 */
function autoExpandThread(rootId, maxRounds = 20) {
  let noProgress = 0;
  const step = (round) => {
    if (!panelCtx || panelCtx.rootId !== rootId) { renderPanel(); return; }
    const rootRec = index && index.byId.get(rootId);
    const rootEl = document.getElementById('comment-' + rootId);
    const container = rootEl && (rootEl.closest('.parent-comment') || rootEl);
    if (!rootRec || !container) { renderPanel(); return; }
    if (threadComplete(rootRec)) { renderPanel(); return; }
    if (round <= 0 || noProgress >= 3) {
      const btnsNow = findExpandButtons(container);
      if (btnsNow.length && !threadComplete(rootRec)) {
        console.info('[xhs-tracer] 展开中止（轮数/无进展上限），按钮仍在，可点面板进度条重试');
      } else if (!btnsNow.length) {
        const cands = Array.from(container.querySelectorAll('div,span,button'))
          .filter((el) => el.children.length === 0 && /展开|更多|回复/.test(el.textContent || ''))
          .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}"> ${(el.textContent || '').trim().slice(0, 24)}`);
        console.info('[xhs-tracer] 展开停滞：数据未齐但容器内未找到 .show-more。候选元素：', cands.slice(0, 10));
      }
      renderPanel();
      return;
    }
    const btns = findExpandButtons(container);
    if (!btns.length) {
      // 按钮尚未渲染出来（Vue 重渲染 / API 未返回）：等一拍再找，不消耗点击判定
      setTimeout(() => step(round - 1), 800);
      return;
    }
    const sizeBefore = store.size;
    for (const b of btns) {
      try {
        b.scrollIntoView({ behavior: 'instant', block: 'center' });
        b.click();
      } catch (e) { /* ignore */ }
    }
    // 自适应等待：轮询数据增长，最多 3s
    let waited = 0;
    const poll = () => {
      if (!panelCtx || panelCtx.rootId !== rootId) { renderPanel(); return; }
      if (store.size > sizeBefore) { noProgress = 0; step(round - 1); return; }
      waited += 300;
      if (waited >= 3000) { noProgress++; step(round - 1); return; }
      setTimeout(poll, 300);
    };
    setTimeout(poll, 300);
  };
  step(maxRounds);
}

/** 面板头部「展开全部」：点击全页所有展开按钮，数据到一批立刻点下一批（自适应等待） */
function expandAllComments() {
  let noProgress = 0;
  let round = 20;
  const step = () => {
    const btns = findExpandButtons(document.body);
    if (!btns.length || round-- <= 0 || noProgress >= 3) { renderPanel(); return; }
    const sizeBefore = store.size;
    for (const b of btns) {
      try {
        b.scrollIntoView({ behavior: 'instant', block: 'center' });
        b.click();
      } catch (e) { /* ignore */ }
    }
    let waited = 0;
    const poll = () => {
      if (store.size > sizeBefore) { noProgress = 0; step(); return; }
      waited += 300;
      if (waited >= 3000) { noProgress++; step(); return; }
      setTimeout(poll, 300);
    };
    setTimeout(poll, 300);
  };
  step();
}

/**
 * 打开面板：重置展开状态。
 * 默认只展开「顶层（楼主）」+ 通往用户所点评论的祖先路径（每层仅一条，符合同层互斥），
 * 其余分支全部收起，由用户逐层点击展开。
 */
function openPanelCtx(resolved) {
  panelCtx = {
    rootId: resolved.rootId,
    selfId: resolved.selfId,
    mode: resolved.mode,
    // 仅 DOM 启发式模式捕获临时 domIndex；API 模式置 null，
    // 渲染时读全局 index（rebuildIndex 每次新建对象，捕获旧引用会看不到新数据）
    treeIndex: resolved.mode === 'dom' ? resolved.treeIndex : null
  };
  panelExpanded = new Set([resolved.rootId]);
  const tIdx = panelCtx.treeIndex || index;
  if (tIdx) {
    let cur = resolved.selfId;
    while (cur && cur !== resolved.rootId) {
      const rec = tIdx.byId.get(cur);
      if (!rec || !rec.parentId) break;
      if (rec.parentId !== resolved.rootId) panelExpanded.add(rec.parentId);
      cur = rec.parentId;
    }
  }
  renderPanel();
  // 精确模式下自动替用户点「展开 N 条回复」，楼中楼数据到齐后面板自动刷新
  if (resolved.mode === 'api') autoExpandThread(resolved.rootId);
}

/** 展开/收起某节点；展开时同层互斥（收起兄弟节点的展开状态） */
function toggleExpand(id) {
  const tIdx = panelCtx ? (panelCtx.treeIndex || index) : index;
  if (!tIdx) return;
  if (panelExpanded.has(id)) {
    panelExpanded.delete(id);
  } else {
    panelExpanded.add(id);
    const rec = tIdx.byId.get(id);
    if (rec && rec.parentId) {
      for (const sib of tIdx.children.get(rec.parentId) || []) {
        if (sib.id !== id) panelExpanded.delete(sib.id);
      }
    }
  }
  renderPanel();
}

function renderPanel() {
  if (!panelCtx) return;
  const tIdx = panelCtx.treeIndex || index;
  if (!tIdx || !tIdx.byId.has(panelCtx.rootId)) return;
  const rootRec = tIdx.byId.get(panelCtx.rootId);
  const totalLoaded = Core.getSubtree(tIdx, panelCtx.rootId).length - 1;
  if (panel) { panel.remove(); panel = null; }
  panel = document.createElement('div');
  panel.id = 'xhs-tracer-panel';

  const header = document.createElement('div');
  header.className = 'xhs-tracer-header';
  const title = document.createElement('span');
  title.textContent = `对话树（已加载 ${totalLoaded} 条 · ${panelCtx.mode === 'api' ? '精确' : '启发式'}）`;
  const expandAllBtn = document.createElement('button');
  expandAllBtn.className = 'xhs-tracer-expand-all';
  expandAllBtn.type = 'button';
  expandAllBtn.textContent = '⤵ 展开全部';
  expandAllBtn.title = '自动点击页面上所有「展开 N 条回复」加载数据（面板内仍需逐层点击展开）';
  expandAllBtn.addEventListener('click', expandAllComments);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'xhs-tracer-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closePanel);
  header.appendChild(title);
  header.appendChild(expandAllBtn);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const listEl = document.createElement('div');
  listEl.className = 'xhs-tracer-list';
  renderChildren(rootRec.id, 0, listEl);
  panel.appendChild(listEl);

  // 楼中楼尚未加载完时的进度提示（自动展开进行中）
  if (rootRec.subCount != null && panelCtx.mode === 'api' && totalLoaded < rootRec.subCount) {
    const tip = document.createElement('div');
    tip.className = 'xhs-tracer-loading';
    tip.textContent = `正在自动展开楼中楼…（已 ${totalLoaded}/${rootRec.subCount} 条）｜点此重试`;
    tip.style.cursor = 'pointer';
    tip.title = '若长时间无进展可点击重试；无进展详情见控制台 [xhs-tracer] 日志';
    tip.addEventListener('click', () => autoExpandThread(panelCtx.rootId));
    panel.appendChild(tip);
  }

  const footer = document.createElement('div');
  footer.className = 'xhs-tracer-footer';
  footer.textContent = panelCtx.mode === 'dom'
    ? '启发式模式：基于 DOM 顺序推断，可能与实际回复目标有出入'
    : '精确模式：基于小红书评论 API 的回复目标字段（点击 ▸ 逐层展开，同层互斥）';
  panel.appendChild(footer);

  document.documentElement.appendChild(panel);
}

/** 递归渲染：父节点已展开时才渲染其子节点（手风琴树） */
function renderChildren(parentId, depth, container) {
  const tIdx = panelCtx.treeIndex || index;
  for (const rec of tIdx.children.get(parentId) || []) {
    container.appendChild(buildRow(rec, depth));
    if (panelExpanded.has(rec.id)) renderChildren(rec.id, depth + 1, container);
  }
}

function buildRow(rec, depth) {
  const tIdx = panelCtx.treeIndex || index;
  const row = document.createElement('div');
  row.className = 'xhs-tracer-row' + (rec.id === panelCtx.selfId ? ' xhs-tracer-self' : '');
  row.style.paddingLeft = (10 + depth * 18) + 'px';
  if (depth > 0) row.classList.add('xhs-tracer-child');

  const nick = document.createElement('div');
  nick.className = 'xhs-tracer-nick';
  if (rec.avatar) {
    const av = document.createElement('img');
    av.className = 'xhs-tracer-avatar';
    av.src = rec.avatar;
    av.referrerPolicy = 'no-referrer';
    av.onerror = () => av.remove();
    nick.appendChild(av);
  }
  nick.appendChild(document.createTextNode(rec.nickname));

  const body = document.createElement('div');
  body.className = 'xhs-tracer-text';
  const meta = Core.extractReplyTarget(rec.content);
  body.textContent = meta.content || rec.content;
  row.appendChild(nick); row.appendChild(body);

  // 评论配图：缩略图展示，点击新标签打开原图
  if (Array.isArray(rec.pictures) && rec.pictures.length) {
    const pics = document.createElement('div');
    pics.className = 'xhs-tracer-pics';
    for (const p of rec.pictures.slice(0, 9)) {
      const img = document.createElement('img');
      img.className = 'xhs-tracer-pic';
      img.src = p.thumb || p.full;
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.title = '点击查看原图';
      if (p.full) {
        img.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try { window.open(p.full, '_blank', 'noopener'); } catch (e) { /* ignore */ }
        });
      }
      pics.appendChild(img);
    }
    row.appendChild(pics);
  }

  const metaLine = [formatTime(rec.createTime), rec.ipLocation].filter(Boolean).join(' · ');
  if (metaLine) {
    const metaEl = document.createElement('div');
    metaEl.className = 'xhs-tracer-meta';
    metaEl.textContent = metaLine;
    row.appendChild(metaEl);
  }

  // 逐层展开开关：有已加载子节点，或 API 报告的楼中楼总数 > 0
  const kidCount = (tIdx.children.get(rec.id) || []).length;
  const totalKids = rec.subCount != null ? rec.subCount : kidCount;
  if (kidCount > 0 || (panelCtx.mode === 'api' && totalKids > 0)) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'xhs-tracer-toggle';
    const expanded = panelExpanded.has(rec.id);
    toggle.textContent = expanded
      ? '▾ 收起'
      : `▸ 展开 ${totalKids > kidCount ? `${totalKids} 条回复` : `${kidCount} 条回复`}`;
    if (!expanded && totalKids > kidCount) toggle.title = `已加载 ${kidCount}/${totalKids} 条，数据仍在自动加载`;
    toggle.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleExpand(rec.id);
    });
    row.appendChild(toggle);
  }

  row.addEventListener('click', () => {
    // 真实 DOM 评论节点自带 id="comment-{id}"，可直接定位
    const target = rec.el || document.getElementById('comment-' + rec.id);
    if (target && target.isConnected) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(target);
    }
  });
  return row;
}

function closePanel() {
  if (panel) { panel.remove(); panel = null; }
  panelCtx = null;
}

  function flash(el) {
    el.classList.add('xhs-tracer-flash');
    setTimeout(() => el.classList.remove('xhs-tracer-flash'), 2000);
  }

  let toast = null;
  function showToast(msg) {
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.id = 'xhs-tracer-toast';
    toast.textContent = msg;
    document.documentElement.appendChild(toast);
    setTimeout(() => { toast && toast.remove(); toast = null; }, 2500);
  }

  // 调试入口（隔离世界）：console 里用 __xhsTracer.store / rebuildScan()
  window.__xhsTracer = {
    get store() { return store; },
    get index() { return index; },
    rescan: scheduleScan
  };
})();
