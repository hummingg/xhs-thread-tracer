// Node 冒烟测试：验证 core.js 的对话链还原逻辑
// 运行：node test/run_test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const code = readFileSync(fileURLToPath(new URL('../core.js', import.meta.url)), 'utf8');
(0, eval)(code); // UMD，挂到 globalThis
const Core = globalThis.XHSTracerCore;

let passed = 0;
let failed = 0;
function assert(cond, name, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' | ' + JSON.stringify(extra) : ''}`); }
}

// ---------- fixture：模拟 XHS comment/page API 响应 ----------
// 主楼 A 提问；B 回答；C 回复 B（带 target_comment）；B 再回复 C（无 target，靠启发式）；
// B 自己补充回复自己（无 target，靠时间序应挂到自己上一条 d1 而不是 b1）
const apiJson = {
  data: {
    comments: [
      {
        id: 'a1',
        user_info: { user_id: 'uA', nickname: '楼主A' },
        content: '有人知道这个怎么配置吗？',
        create_time: 1760000000000,
        sub_comments: [
          { id: 'b1', user_info: { user_id: 'uB', nickname: 'B哥' }, content: '我觉得是这样', create_time: 1760000100000 },
          {
            id: 'c1', user_info: { user_id: 'uC', nickname: '小C' }, content: '回复 @B哥：具体哪里', create_time: 1760000200000,
            target_comment: { id: 'b1' }
          },
          { id: 'd1', user_info: { user_id: 'uB', nickname: 'B哥' }, content: '回复 @小C：就是那里', create_time: 1760000300000 },
          { id: 'e1', user_info: { user_id: 'uB', nickname: 'B哥' }, content: '回复 @B哥：我补充一下', create_time: 1760000400000 }
        ]
      }
    ]
  }
};

console.log('\n[1] collectFromApiResponse 抽取');
const records = Core.collectFromApiResponse(apiJson);
assert(records.length === 5, '应抽取 5 条记录', records.length);
const a1 = records.find(r => r.id === 'a1');
const e1 = records.find(r => r.id === 'e1');
assert(a1.rootId === null, '一级评论 rootId 为 null');
assert(e1.rootId === 'a1', '楼中楼 rootId 归到主楼 a1');

console.log('\n[2] extractReplyTarget');
const t1 = Core.extractReplyTarget('回复 @小C：就是那里');
assert(t1.nickname === '小C' && t1.content === '就是那里', '标准前缀解析', t1);
const t2 = Core.extractReplyTarget('回复 @小C 就是那里');
assert(t2.nickname === '小C' && t2.content === '就是那里', '无冒号前缀解析', t2);
const t3 = Core.extractReplyTarget('正常评论不带前缀');
assert(t3.nickname === null, '无前缀返回 null', t3);

console.log('\n[3] 索引构建与父子解析');
const byRoot = new Map();
for (const rec of records) {
  const key = rec.rootId || rec.id;
  if (!byRoot.has(key)) byRoot.set(key, []);
  byRoot.get(key).push(rec);
}
const index = Core.buildIndex(records);
Core.resolveParents(index, byRoot);

const c1 = index.byId.get('c1');
const d1 = index.byId.get('d1');
assert(c1.parentId === 'b1', 'c1 显式 target_comment → b1', c1.parentId);
assert(d1.parentId === 'c1', 'd1 启发式（同昵称小C最近一条）→ c1', d1.parentId);
assert(e1.parentId === 'd1', 'e1 启发式（同昵称B哥按时间最近）→ d1（非更早的b1）', e1.parentId);

console.log('\n[4] 完整对话链');
const chainE = Core.getChain(index, 'e1');
assert(chainE.map(r => r.id).join(',') === 'a1,b1,c1,d1,e1', 'e1 的链路 a1→b1→c1→d1→e1', chainE.map(r => r.id));
const chainC = Core.getChain(index, 'c1');
assert(chainC.map(r => r.id).join(',') === 'a1,b1,c1', 'c1 的链路 a1→b1→c1', chainC.map(r => r.id));
const chainB = Core.getChain(index, 'b1');
assert(chainB.map(r => r.id).join(',') === 'a1,b1', 'b1 无显式父节点时挂到主楼', chainB.map(r => r.id));

console.log('\n[5] sub/page 平铺接口 + root_comment_id 归组');
const subPageJson = {
  data: {
    root_comment_id: 'a1',
    comments: [
      { id: 's1', user_info: { user_id: 'uB', nickname: 'B哥' }, content: '平铺回复1' },
      { id: 's2', user_info: { user_id: 'uC', nickname: '小C' }, content: '回复 @B哥：好的', target_comment: { id: 's1' } }
    ]
  }
};
const subRecords = Core.collectFromApiResponse(subPageJson, 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page?note_id=x');
assert(subRecords.length === 2, '抽取 2 条平铺楼中楼', subRecords.length);
assert(subRecords.every(r => r.rootId === 'a1'), 'root_comment_id 归组生效');
const subIndex = Core.buildIndex(subRecords);
Core.resolveParents(subIndex, new Map([['a1', subRecords]]));
assert(subIndex.byId.get('s2').parentId === 's1', '平铺模式 s2→s1');

console.log('\n[6] 环防护');
index.byId.get('b1').parentId = 'c1'; // 人为制造环
const chainCycle = Core.getChain(index, 'b1');
assert(chainCycle.length < 5, '链路有环时正常终止不死循环');

console.log('\n[7] 防御性处理（参考 starseeker 实现校准）');
// 秒级时间戳 → 毫秒
const secJson = { data: { comments: [{ id: 'x1', user_info: { nickname: '秒级' }, content: 'hi', create_time: 1760000100 }] } };
const secRec = Core.collectFromApiResponse(secJson)[0];
assert(secRec.createTime === 1760000100000, '秒级 create_time 自动 ×1000', secRec.createTime);
// sub_comments 形状（sub/page 部分版本）
const subShapeJson = { data: { sub_comments: [{ id: 'y1', user_info: { nickname: '甲' }, content: 'a' }] } };
assert(Core.collectFromApiResponse(subShapeJson).length === 1, 'data.sub_comments 形状可抽取');
// avatar 字段
const avJson = { data: { comments: [{ id: 'z1', user_info: { nickname: '乙', image: 'http://x/a.jpg' }, content: 'b' }] } };
assert(Core.collectFromApiResponse(avJson)[0].avatar === 'http://x/a.jpg', 'avatar 字段归一化');

// pictures 字段归一化（url_pre 缩略 / url_default 原图）
const picJson = { data: { comments: [{
  id: 'p1', user_info: { nickname: '有图' }, content: '看图',
  pictures: [
    { url_pre: 'http://x/pre.jpg', url_default: 'http://x/full.jpg' },
    { url_default: 'http://x/only.jpg' },
    null,
    { url_pre: '' }
  ]
}] } };
const picRecs = Core.collectFromApiResponse(picJson);
assert(picRecs[0].pictures.length === 2, 'pictures 过滤空项后剩 2 张', picRecs[0].pictures.length);
assert(picRecs[0].pictures[0].thumb === 'http://x/pre.jpg' && picRecs[0].pictures[0].full === 'http://x/full.jpg', 'thumb/full 提取');
assert(picRecs[0].pictures[1].full === 'http://x/only.jpg', '仅 url_default 时 full 兜底');
const noPic = Core.collectFromApiResponse({ data: { comments: [{ id: 'p2', user_info: { nickname: '无图' }, content: '纯文字' }] } });
assert(Array.isArray(noPic[0].pictures) && noPic[0].pictures.length === 0, '无图评论 pictures 为空数组');

console.log('\n[8] 对话树（getTree / getThreadRootId）');
// 先恢复 [6] 里被人为改成环的 b1 父节点（resolveParents 的 root 兜底挂到 a1）
index.byId.get('b1').parentId = 'a1';
const rootId = Core.getThreadRootId(index, 'e1');
assert(rootId === 'a1', 'e1 向上爬到线程顶层 a1', rootId);
const tree = Core.getTree(index, rootId);
const treeStr = tree.map(n => `${n.rec.id}@${n.depth}`).join(',');
assert(treeStr === 'a1@0,b1@1,c1@2,d1@3,e1@4', 'DFS 树含全部节点且深度正确', treeStr);
// 点一级评论本身也应返回整棵树
const rootTree = Core.getTree(index, Core.getThreadRootId(index, 'a1'));
assert(rootTree.length === 5, '点主楼本身返回整棵树', rootTree.length);
// 层级子树：以 c1 为根只含其后代
const subTree = Core.getTree(index, 'c1');
assert(subTree.map(n => n.rec.id).join(',') === 'c1,d1,e1', '以 c1 为根的子树', subTree.map(n => n.rec.id));

console.log('\n[9] 真实 bug 复现：无 @ 前缀 + 分组缺失的三层楼');
// 场景：heyy(顶层) → 🍪(子回复) → 一一(回复 🍪 但 API 缺 target_comment 且没归组)
// 注意「一一」的 content 是 DOM 风格「回复 🍪 : ...」——无 @、空格冒号
const bugJson = {
  data: {
    comments: [
      { id: 'heyy', user_info: { nickname: 'heyy' }, content: '我觉得画画那一段超级有感觉啊', create_time: 1760000000000,
        sub_comments: [
          { id: 'cookie', user_info: { nickname: '🍪' }, content: '对呀，几段恋情我都能磕到', create_time: 1760000100000 },
          { id: 'yiyi', user_info: { nickname: '一一没翅膀✨' }, content: '回复 🍪 : 霍建华还是老了', create_time: 1760000200000, target_comment: { id: 'cookie' } }
        ] }
    ]
  }
};
const bugRecords = Core.collectFromApiResponse(bugJson);
const bugByRoot = new Map();
for (const rec of bugRecords) {
  const key = rec.rootId || rec.id;
  if (!bugByRoot.has(key)) bugByRoot.set(key, []);
  bugByRoot.get(key).push(rec);
}
const bugIndex = Core.buildIndex(bugRecords);
Core.resolveParents(bugIndex, bugByRoot);
assert(bugIndex.byId.get('yiyi').parentId === 'cookie', 'yiyi → 🍪（精确 target）', bugIndex.byId.get('yiyi').parentId);
const bugTree = Core.getTree(bugIndex, 'heyy');
const bugStr = bugTree.map(n => `${n.rec.id}@${n.depth}`).join(',');
assert(bugStr === 'heyy@0,cookie@1,yiyi@2', '三层楼深度正确', bugStr);
// yiyi 的正文前缀应被剥掉
assert(bugIndex.byId.get('yiyi').content.includes('霍建华') && Core.extractReplyTarget(bugIndex.byId.get('yiyi').content).nickname === '🍪', '无 @ 的「回复 🍪 :」前缀可解析');

console.log('\n[10] 孤儿跨组解析（响应缺分组 / 缺 target_comment）');
// yiyi 单独一条记录到达（如 sub/page 没带 root_comment_id），与 heyy 楼不同组
const orphanJson = {
  data: {
    comments: [
      { id: 'heyy2', user_info: { nickname: 'heyy' }, content: '我觉得画画那一段超级有感觉啊', create_time: 1760000000000,
        sub_comments: [
          { id: 'cookie2', user_info: { nickname: '🍪' }, content: '对呀，几段恋情我都能磕到', create_time: 1760000100000 }
        ] }
    ]
  }
};
const allRecords = [...Core.collectFromApiResponse(orphanJson)];
allRecords.push(Core.normalizeComment({ id: 'yiyi2', user_info: { nickname: '一一没翅膀✨' }, content: '回复 🍪 : 霍建华还是老了', create_time: 1760000200000 }, null));
const orphanIndex = Core.buildIndex(allRecords);
const orphanByRoot = new Map();
for (const rec of allRecords) {
  const key = rec.rootId || rec.id;
  if (!orphanByRoot.has(key)) orphanByRoot.set(key, []);
  orphanByRoot.get(key).push(rec);
}
Core.resolveParents(orphanIndex, orphanByRoot);
assert(orphanIndex.byId.get('yiyi2').parentId === 'cookie2', '孤儿跨组找到 🍪 作为父节点', orphanIndex.byId.get('yiyi2').parentId);
assert(orphanIndex.byId.get('yiyi2').rootId === 'heyy2', '跟随父节点归组到 heyy2', orphanIndex.byId.get('yiyi2').rootId);

console.log('\n[11] 回归：page 响应回显 root_comment_id 不得错挂（2026-10-10 真机 bug）');
// 真机场景：/comment/page 响应也带了 root_comment_id（指向某条顶层评论），
// 若无条件采信，整个响应里的顶层评论会被全挂到那一条名下（7 条塌平成 1 层）
const pageEchoJson = {
  data: {
    root_comment_id: 'yiyiTop',
    comments: [
      { id: 'yiyiTop', user_info: { nickname: '一一没翅膀✨' }, content: '傅家明那一段太仓促了', create_time: 1760000000000 },
      { id: 'ai', user_info: { nickname: '艾谁谁' }, content: '我觉得主要是演员的演技那啥', create_time: 1760000005000 },
      { id: 'heyy3', user_info: { nickname: 'heyy' }, content: '我觉得画画那一段超级有感觉啊', create_time: 1760000010000 },
      { id: 'banmian', user_info: { nickname: '半眠日记' }, content: '原著好像是个小提琴家', create_time: 1760000015000 }
    ]
  }
};
const pageRecs1 = Core.collectFromApiResponse(pageEchoJson, 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=x');
assert(pageRecs1.every(r => r.rootId === null), 'page 接口：顶层评论不被 root_comment_id 错挂');
const pageRecs2 = Core.collectFromApiResponse(pageEchoJson);
assert(pageRecs2.every(r => r.rootId === null), '无 URL 时同样不采信（保守）');
// sub/page 仍然正常归组
const subRecs2 = Core.collectFromApiResponse({
  data: { root_comment_id: 'heyy3', comments: [{ id: 'ck', user_info: { nickname: '🍪' }, content: '对呀' }] }
}, 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page?note_id=x');
assert(subRecs2[0].rootId === 'heyy3', 'sub/page 接口 root_comment_id 归组不受影响');

console.log('\n[12] 回归：target_comment 回指主楼时按内容前缀纠正（2026-10-10 真机 bug#3）');
// 真机场景：一一回复 🍪（楼中楼互回复），但 API 的 target_comment 回指主楼 heyy，
// 采信显式字段会导致一一和 🍪 同层。应以内容前缀「回复 🍪 :」为准纠正到 cookie 下一层。
const conflictJson = {
  data: {
    comments: [
      { id: 'heyy4', user_info: { nickname: 'heyy' }, content: '我觉得画画那一段超级有感觉啊', create_time: 1760000000000,
        sub_comments: [
          { id: 'cookie4', user_info: { nickname: '🍪' }, content: '对呀，几段恋情我都能磕到', create_time: 1760000100000 },
          { id: 'yiyi4', user_info: { nickname: '一一没翅膀✨' }, content: '回复 🍪 : 霍建华还是老了', create_time: 1760000200000,
            target_comment: { id: 'heyy4' } }
        ] }
    ]
  }
};
const cfRecords = Core.collectFromApiResponse(conflictJson);
const cfByRoot = new Map();
for (const rec of cfRecords) {
  const key = rec.rootId || rec.id;
  if (!cfByRoot.has(key)) cfByRoot.set(key, []);
  cfByRoot.get(key).push(rec);
}
const cfIndex = Core.buildIndex(cfRecords);
Core.resolveParents(cfIndex, cfByRoot);
assert(cfIndex.byId.get('yiyi4').parentId === 'cookie4', '冲突时按前缀纠正 yiyi4 → cookie4', cfIndex.byId.get('yiyi4').parentId);
const cfTree = Core.getTree(cfIndex, 'heyy4');
const cfStr = cfTree.map(n => `${n.rec.id}@${n.depth}`).join(',');
assert(cfStr === 'heyy4@0,cookie4@1,yiyi4@2', '三层深度正确（yiyi4 在 🍪 下一层）', cfStr);
// 一致的情况不受影响：target 与前缀指向同一个人
const okJson = {
  data: { comments: [
    { id: 'r1', user_info: { nickname: 'A' }, content: '主楼', create_time: 1000,
      sub_comments: [
        { id: 'r2', user_info: { nickname: 'B' }, content: '沙发', create_time: 2000 },
        { id: 'r3', user_info: { nickname: 'C' }, content: '回复 @B：好的', create_time: 3000, target_comment: { id: 'r2' } }
      ] }
  ] }
};
const okRecords = Core.collectFromApiResponse(okJson);
const okByRoot = new Map();
for (const rec of okRecords) {
  const key = rec.rootId || rec.id;
  if (!okByRoot.has(key)) okByRoot.set(key, []);
  okByRoot.get(key).push(rec);
}
const okIndex = Core.buildIndex(okRecords);
Core.resolveParents(okIndex, okByRoot);
assert(okIndex.byId.get('r3').parentId === 'r2', 'target 与前缀一致时不折腾');

console.log('\n[13] 真机 capture 回归（test/fixtures/real_capture_20261010.json）');
// 用户提供的完整 __xhsTracerRaw 抓包：一一没翅膀✨主楼 + sub/page 楼中楼。
// 两个真机事实：① sub/page 的 root_comment_id 只在 URL query 里，响应体 data 没有；
//             ② 一一(霍) 的 target_comment 正确指向 🍪，树应为 主楼@0 → 🍪@1 → 一一(霍)@2
const cap = JSON.parse(readFileSync(new URL('./fixtures/real_capture_20261010.json', import.meta.url), 'utf8'));
const capStore = new Map();
let capIndex = null;
function capIngest(entry) {
  const records = Core.collectFromApiResponse(entry.json, entry.url);
  for (const rec of records) if (!capStore.has(rec.id)) capStore.set(rec.id, rec);
  const byRoot = new Map();
  for (const rec of capStore.values()) {
    const key = rec.rootId || rec.id;
    if (!byRoot.has(key)) byRoot.set(key, []);
    byRoot.get(key).push(rec);
  }
  capIndex = Core.buildIndex(Array.from(capStore.values()));
  Core.resolveParents(capIndex, byRoot);
}
// 乱序：先 sub/page 后 page（真实浏览时随时可能发生）
capIngest(cap[1]);
capIngest(cap[0]);
const capRoot = Core.getThreadRootId(capIndex, '6ab39cab0000000008000faa');
assert(capRoot === '6aaca4bf0000000015012417', '一一(霍) 爬到主楼 一一没翅膀✨', capRoot);
const capTree = Core.getTree(capIndex, capRoot);
const capStr = capTree.map(n => `${n.rec.id.slice(-6)}@${n.depth}`).join(',');
// 乱序场景下 depth-1 行的先后随摄入顺序变化（艾谁谁来自 page 预览，此处最后入店），
// 关键不变量：一一(霍)@2 且紧跟 🍪@1
assert(capStr === '012417@0,00d45c@1,03121b@1,0299df@1,000faa@2,03cb04@1,01a274@1', '真机树 DFS 结构（一一(霍) 紧跟 🍪 且 @2）', capStr);
const cookiePos = capTree.findIndex(n => n.rec.id === '6ab3807f00000000070299df');
const yiyiPos = capTree.findIndex(n => n.rec.id === '6ab39cab0000000008000faa');
assert(yiyiPos - cookiePos === 1, '一一(霍) 在面板中紧跟 🍪 下一条', `${cookiePos}->${yiyiPos}`);
// sub/page 的 URL 参数归组
const capSub = capStore.get('6ab3807f00000000070299df');
assert(capSub.rootId === '6aaca4bf0000000015012417', 'sub/page 记录从 URL 参数归组到主楼', capSub.rootId);
// sub_comment_count 归一化（自动展开依据）
const capRootRec = capStore.get('6aaca4bf0000000015012417');
assert(capRootRec.subCount === 19, 'sub_comment_count 字符串转数字', capRootRec.subCount);
assert(capStore.get('6ac98c63000000001103a146').subCount === 0, 'sub_comment_count=0 正常解析');

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
