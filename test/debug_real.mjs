/**
 * debug_real.mjs —— 用真机 capture（test/fixtures/real_capture_20261010.json）
 * 完整模拟 content.js 的 ingest → rebuildIndex 流程，打印一一没翅膀✨主楼的树。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
(0, eval)(readFileSync(join(here, '..', 'core.js'), 'utf8')); // UMD，挂到 globalThis
const Core = globalThis.XHSTracerCore;

const capture = JSON.parse(readFileSync(join(here, 'fixtures', 'real_capture_20261010.json'), 'utf8'));

// —— 模拟 content.js ——
const store = new Map();
let index = null;

function ingest(json, url) {
  const records = Core.collectFromApiResponse(json || {}, url);
  if (!records.length) return;
  for (const rec of records) if (!store.has(rec.id)) store.set(rec.id, rec);
  rebuildIndex();
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
}

function dumpTree(rootId, label) {
  const tree = Core.getTree(index, rootId);
  console.log(`\n===== ${label}（root=${rootId}，共 ${tree.length} 条）=====`);
  for (const { rec, depth } of tree) {
    console.log(`${'  '.repeat(depth)}[${depth}] ${rec.nickname}: ${rec.content.slice(0, 30)}  (id=${rec.id.slice(-6)}, rootId=${rec.rootId ? rec.rootId.slice(-6) : 'null'})`);
  }
  return tree;
}

// 场景 A：先 page 后 sub/page（真机顺序）
ingest(capture[0].json, capture[0].url);
ingest(capture[1].json, capture[1].url);
const tA = dumpTree('6aaca4bf0000000015012417', '场景A：先 page 后 sub/page');

// 断言关键层级
const findRow = (id) => tA.find((n) => n.rec.id === id);
const heyy = findRow('6ab2475b000000001103121b');
const cookie = findRow('6ab3807f00000000070299df');
const yiyi2 = findRow('6ab39cab0000000008000faa');
console.log('\n关键断言（场景A）:');
console.log('  heyy 深度=1:', heyy && heyy.depth === 1);
console.log('  🍪 深度=1:', cookie && cookie.depth === 1);
console.log('  一一没翅膀(霍建华) 深度=2:', yiyi2 && yiyi2.depth === 2);
const rowOf = (id) => tA.findIndex((n) => n.rec.id === id);
console.log('  一一没翅膀(霍建华) 紧跟在 🍪 后(DFS):', rowOf('6ab39cab0000000008000faa') - rowOf('6ab3807f00000000070299df') === 1);

// 场景 B：先 sub/page 后 page（乱序到达）
store.clear(); index = null;
ingest(capture[1].json, capture[1].url);
ingest(capture[0].json, capture[0].url);
dumpTree('6aaca4bf0000000015012417', '场景B：先 sub/page 后 page');

// 场景 C：只有 sub/page（root 尚未进 store）时点楼中楼
store.clear(); index = null;
ingest(capture[1].json, capture[1].url);
const climb = Core.getThreadRootId(index, '6ab39cab0000000008000faa');
console.log('\n场景C：仅 sub/page，getThreadRootId(一一没翅膀·霍) =', climb);
ingest(capture[0].json, capture[0].url); // root 随后到达
const climb2 = Core.getThreadRootId(index, '6ab39cab0000000008000faa');
console.log('补齐 page 后 getThreadRootId =', climb2);
dumpTree(climb2, '场景C：补齐后重新取树');
