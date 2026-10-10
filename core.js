(function (root) {
  'use strict';

  const Core = {};

  /** 时间戳统一为毫秒（XHS API 可能返回秒级，参考 starseeker 的防御处理） */
  function toMs(t) {
    const n = Number(t);
    if (!n || !isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }

  /**
   * 归一化一条评论（来自 XHS API 或 DOM）为扁平记录
   */
  Core.normalizeComment = function (raw, rootId) {
    const user = raw.user_info || raw.user || {};
    let content = '';
    if (typeof raw.content === 'string') content = raw.content;
    else if (raw.content && typeof raw.content.message === 'string') content = raw.content.message;
    else if (typeof raw.text === 'string') content = raw.text;
    // 评论配图（真机核实：pictures[].url_pre 缩略 / url_default 原图 / info_list 分场景）
    const pictures = Array.isArray(raw.pictures)
      ? raw.pictures
          .map((p) => ({
            thumb: (p && (p.url_pre || p.url_default)) || '',
            full: (p && (p.url_default || p.url_pre)) || ''
          }))
          .filter((p) => p.thumb || p.full)
      : [];
    return {
      id: String(raw.id),
      rootId: rootId != null ? String(rootId) : null,
      // API v2 的楼中楼回复里，若回复的是楼中楼其他评论，会带 target_comment
      parentId:
        (raw.target_comment && raw.target_comment.id && String(raw.target_comment.id)) ||
        (raw.parent_id != null ? String(raw.parent_id) : null),
      userId: user.user_id || user.userid || user.id || null,
      nickname: user.nickname || user.nick_name || user.name || '(未知用户)',
      avatar: user.image || user.avatar || '',
      content: content,
      pictures: pictures,
      createTime: toMs(raw.create_time),
      subCount: raw.sub_comment_count != null && raw.sub_comment_count !== '' ? Number(raw.sub_comment_count) : null,
      likeCount: raw.like_count != null ? raw.like_count : raw.likes != null ? raw.likes : 0,
      ipLocation: raw.ip_location || ''
    };
  };

  /**
   * 构建索引：byId / byRoot(rootId -> [records, 按插入序]) / children(parentId -> [records])
   */
  Core.buildIndex = function (records) {
    const index = { byId: new Map(), byRoot: new Map(), children: new Map() };
    for (const rec of records) {
      index.byId.set(rec.id, rec);
      if (!index.byRoot.has(rec.rootId)) index.byRoot.set(rec.rootId, []);
      index.byRoot.get(rec.rootId).push(rec);
    }
    return index;
  };

  // 有 @：「回复 @昵称：内容」，冒号可省；无 @：「回复 昵称：内容」，必须有冒号防误伤
  const REPLY_AT_RE = /^回复\s*[@＠]\s*([^\s：:@＠]+)\s*(?:[：:])?\s*/;
  const REPLY_PLAIN_RE = /^回复\s*([^\s：:@＠]{1,30})\s*[：:]\s*/;

  /** 从文本中提取「回复 @昵称」/「回复 昵称：」目标，并返回去掉前缀后的正文 */
  Core.extractReplyTarget = function (text) {
    if (!text) return { nickname: null, content: text || '' };
    const s = String(text).trim();
    let m = s.match(REPLY_AT_RE);
    if (!m) m = s.match(REPLY_PLAIN_RE);
    if (!m) return { nickname: null, content: s };
    return { nickname: m[1].trim(), content: s.slice(m[0].length).trim() };
  };

  /**
   * 启发式猜父节点：同一条主楼线程内，找「同昵称、时间/顺序早于自己且最近」的那条；
   * 找不到则认为回复的是楼主（rootId）。
   */
  Core.guessParent = function (rec, index, siblings) {
    if (rec.parentId && index.byId.has(rec.parentId)) return rec.parentId;
    const { nickname } = Core.extractReplyTarget(rec.content);
    if (!nickname) return null; // 不带「回复 @」的就是一级评论，父为 null（本身是 root）

    const pool = (siblings || []).filter(
      (c) => c.id !== rec.id && c.nickname === nickname
    );
    // 优先时间序：createTime 更早的最近一条
    let best = null;
    for (const c of pool) {
      if (rec.createTime && c.createTime) {
        if (c.createTime <= rec.createTime && (!best || c.createTime > best.createTime)) best = c;
      }
    }
    // 没有可靠时间戳时退化为插入序（DOM 顺序 / API 返回顺序）
    if (!best && siblings) {
      const idx = siblings.indexOf(rec);
      for (let i = idx - 1; i >= 0; i--) {
        if (siblings[i].nickname === nickname) { best = siblings[i]; break; }
      }
    }
    return best ? best.id : null;
  };

  /**
   * 批量解析父子关系：对每条记录补全 parentId（显式 target 优先，启发式兜底）
   * siblingsByRoot: Map(rootId -> 按顺序的记录数组) —— 由调用方按展示顺序传入
   */
  Core.resolveParents = function (index, siblingsByRoot) {
    // 第一遍：组内解析（显式 target_comment 优先，组内同昵称启发式兜底）
    for (const [rootId, list] of (siblingsByRoot || index.byRoot).entries()) {
      for (const rec of list) {
        if (!rec.parentId) {
          const guessed = Core.guessParent(rec, index, list);
          if (guessed) rec.parentId = guessed;
        }
      }
    }
    // 第二遍：按内容前缀校准/解析回复目标
    // 「回复 @X」/「回复 X：」前缀给出用户真实回复对象。两种情况需要处理：
    //   a) 显式 target_comment 缺失或指向不在索引里的 id（孤儿）
    //   b) 显式 target 与前缀冲突——XHS 对「回复楼中楼」的 target_comment 有时回指主楼，
    //      若采信会把本应缩进一层的回复塌到主楼直下（真机 bug：应该在 🍪 下一层却和它同层）
    // 规则：组内找「同昵称、时间最近且早于自己」；组内没有再全局找；无时间戳退化为顺序最近的前一条
    for (const [rootId, list] of (siblingsByRoot || index.byRoot).entries()) {
      const posOf = new Map(list.map((r, i) => [r, i]));
      for (const rec of list) {
        const { nickname } = Core.extractReplyTarget(rec.content);
        if (!nickname) continue;
        const parent = rec.parentId ? index.byId.get(rec.parentId) : null;
        if (parent && parent.nickname === nickname) continue; // 显式 target 与前缀一致，无需处理
        let best = null;
        let posBest = null;
        const recPos = posOf.get(rec);
        for (const cand of list) {
          if (cand.id === rec.id || cand.nickname !== nickname) continue;
          if (rec.createTime && cand.createTime) {
            if (cand.createTime <= rec.createTime && (!best || cand.createTime > best.createTime)) best = cand;
          }
          const cPos = posOf.get(cand);
          if (cPos != null && recPos != null && cPos < recPos && (!posBest || cPos > posOf.get(posBest))) posBest = cand;
        }
        best = best || posBest;
        if (!best) {
          // 组内没有：全局找（时间可比时）
          for (const cand of index.byId.values()) {
            if (cand.id === rec.id || cand.nickname !== nickname) continue;
            if (rec.createTime && cand.createTime) {
              if (cand.createTime <= rec.createTime && (!best || cand.createTime > best.createTime)) best = cand;
            }
          }
        }
        if (best) {
          rec.parentId = best.id;
          rec.rootId = best.rootId || best.id; // 跟随父节点归组（父是顶层评论时以其为根）
        }
      }
    }
    // 第三遍：兜底——楼中楼回复始终没有父节点的挂到所属主楼（保证链路不断）
    for (const rec of index.byId.values()) {
      if (!rec.parentId && rec.rootId && index.byId.has(rec.rootId) && rec.id !== rec.rootId) {
        rec.parentId = rec.rootId;
      }
    }
    // 重建 children
    index.children = new Map();
    for (const rec of index.byId.values()) {
      if (!rec.parentId) continue;
      if (!index.children.has(rec.parentId)) index.children.set(rec.parentId, []);
      index.children.get(rec.parentId).push(rec);
    }
    return index;
  };

  /** 从某条评论向上追溯完整祖先链（返回 root -> ... -> 自身 的数组） */
  Core.getChain = function (index, id) {
    const chain = [];
    let cur = index.byId.get(String(id));
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId ? index.byId.get(cur.parentId) : null;
    }
    return chain;
  };

  /** 某节点的全部后代（含自身） */
  Core.getSubtree = function (index, id) {
    const out = [];
    const stack = [String(id)];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      const kids = index.children.get(cur) || [];
      for (const k of kids) stack.push(k.id);
    }
    return out.map((cid) => index.byId.get(cid));
  };

  /**
   * 以 rootId 为根的整棵对话树，DFS 前序遍历，返回 [{rec, depth}]
   * depth 为相对根的层级：根=0，直接回复=1，以此类推。
   * 用 DFS 而非 BFS：每条回复紧跟在其父节点后下一行缩进展示（符合「谁回复谁」的阅读直觉）
   */
  Core.getTree = function (index, rootId) {
    const out = [];
    if (!index.byId.has(String(rootId))) return out;
    const seen = new Set();
    const dfs = (id, depth) => {
      if (seen.has(id)) return;
      seen.add(id);
      const rec = index.byId.get(id);
      if (!rec) return;
      out.push({ rec, depth });
      for (const k of index.children.get(id) || []) dfs(k.id, depth + 1);
    };
    dfs(String(rootId), 0);
    return out;
  };

  /** 从某条评论向上爬到所属线程的顶层评论 id */
  Core.getThreadRootId = function (index, id) {
    let cur = index.byId.get(String(id));
    const seen = new Set();
    while (cur && cur.parentId && index.byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = index.byId.get(cur.parentId);
    }
    return cur ? cur.id : String(id);
  };

  /**
   * 从 XHS API 响应 JSON 中抽取全部评论记录
   * 兼容 /comment/page（含 sub_comments 嵌套）与 /comment/sub/page（平铺楼中楼）
   * @param url 响应对应的请求 URL：root_comment_id 归组只对 /comment/sub/page 生效——
   *            /comment/page 响应也可能回显该字段，若采信会把整个响应的顶层评论全错挂到一个 root 下
   */
  Core.collectFromApiResponse = function (json, url) {
    const records = [];
    const walk = (comments, rootId) => {
      if (!Array.isArray(comments)) return;
      for (const c of comments) {
        if (!c || c.id == null) continue;
        const rec = Core.normalizeComment(c, rootId);
        records.push(rec);
        if (Array.isArray(c.sub_comments) && c.sub_comments.length) {
          walk(c.sub_comments, rootId != null ? rootId : rec.id);
        }
      }
    };
    const data = (json && json.data) || {};
    // 响应形状防御：不同接口/版本评论数组位置可能不同（参考 starseeker extractComments）
    const candidates = [
      data.comments,
      data.sub_comments,
      data.subComments,
      data.reply_comments,
      data.list,
      data.items,
      json && json.comments
    ];
    const rootComments = candidates.find(Array.isArray) || [];
    walk(rootComments, null);
    // 仅 sub/page（平铺楼中楼）响应可归组到 root_comment_id——
    // 真机核实（2026-10-10 capture）：该字段只在请求 URL 的 query 参数里，响应体 data 中没有
    const isSubPage = typeof url === 'string' && url.includes('/comment/sub/page');
    if (isSubPage) {
      let rcId = data.root_comment_id || (json && json.root_comment_id);
      if (!rcId) {
        try {
          rcId = new URLSearchParams(String(url).split('?')[1] || '').get('root_comment_id');
        } catch (e) { /* ignore */ }
      }
      if (rcId) {
        for (const rec of records) {
          if (rec.rootId == null) rec.rootId = String(rcId);
        }
      }
    }
    return records;
  };

  root.XHSTracerCore = Core;
})(typeof self !== 'undefined' ? self : globalThis);
