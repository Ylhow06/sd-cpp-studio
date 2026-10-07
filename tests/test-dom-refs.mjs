/**
 * 静态一致性检查：验证 ui/index.html 里
 *  1) 代码引用的所有 #id 都真实存在于 HTML
 *  2) 所有 data-pane / data-f 引用都有效
 *  3) HTML 标签基本闭合
 * 用法：node _test-dom-refs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ★ 路径定位：本文件在 <root>\tests\ 下，UI 在 <root>\app\ui\ 下。
   用 import.meta.url 推导，因此从任何工作目录执行都能找到文件。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const UI_DIR = path.join(ROOT, 'app', 'ui');
const UI_HTML = path.join(UI_DIR, 'index.html');
const UI_CFG = path.join(UI_DIR, 'config.json');
const CFG_SERVICE = path.join(ROOT, 'config-service', 'serve-config.mjs');

const html = fs.readFileSync(UI_HTML, 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const markup = html.slice(0, html.indexOf('<script>'));

let pass = 0, fail = 0;
const problems = [];

function ok(name){ pass++; console.log('  ✓ ' + name); }
function bad(name, detail){ fail++; problems.push(name + (detail ? ': ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }

/* ── 1. 收集 HTML 里定义的所有 id ── */
const definedIds = new Set();
for (const m of markup.matchAll(/\bid="([^"]+)"/g)) definedIds.add(m[1]);

console.log(`\n=== HTML 里定义的 id 共 ${definedIds.size} 个 ===`);

/* ── 2. 收集 JS 里引用的 #id ── */
const refIds = new Set();
for (const m of js.matchAll(/\$\$?\(\s*['"]#([A-Za-z0-9_\-]+)['"]/g)) refIds.add(m[1]);
// 也抓 querySelector('#x')
for (const m of js.matchAll(/querySelector\(\s*['"]#([A-Za-z0-9_\-]+)['"]/g)) refIds.add(m[1]);

console.log(`=== JS 里引用的 #id 共 ${refIds.size} 个 ===\n`);

console.log('--- 引用的 id 是否都存在 ---');
const missing = [...refIds].filter(id => !definedIds.has(id));
if (missing.length) bad('存在未定义的 id 引用', missing.join(', '));
else ok(`全部 ${refIds.size} 个 id 引用都能在 HTML 里找到`);

/* ── 3. data-pane 检查 ── */
console.log('\n--- data-pane 与 tab 是否配对 ---');
const panes = new Set();
for (const m of markup.matchAll(/data-pane="([^"]+)"/g)) panes.add(m[1]);
const tabs = new Set();
for (const m of markup.matchAll(/data-mode="([^"]+)"/g)) tabs.add(m[1]);

console.log(`  pane: ${[...panes].join(', ')}`);
console.log(`  tab : ${[...tabs].join(', ')}`);

const tabNoPane = [...tabs].filter(t => !panes.has(t));
const paneNoTab = [...panes].filter(p => !tabs.has(p));
if (tabNoPane.length) bad('有 tab 但没有对应 pane', tabNoPane.join(', '));
else ok('每个 tab 都有对应的 pane');
if (paneNoTab.length) bad('有 pane 但没有对应 tab', paneNoTab.join(', '));
else ok('每个 pane 都有对应的 tab');

/* ── 4. 模式集合与 S.m 的键是否一致 ── */
console.log('\n--- S.m 的键与 tab 集合是否一致 ---');
const smBlock = js.slice(js.indexOf('m: {'), js.indexOf('// ── 批量模块专属运行时状态'));
const smKeys = new Set();
for (const m of smBlock.matchAll(/^\s{4}(\w+):\s*\{/gm)) smKeys.add(m[1]);
console.log(`  S.m 键: ${[...smKeys].join(', ')}`);
const onlyTab = [...tabs].filter(t => !smKeys.has(t));
const onlySm = [...smKeys].filter(k => !tabs.has(k));
if (onlyTab.length) bad('tab 没有对应的 S.m 条目', onlyTab.join(', '));
else ok('每个 tab 都在 S.m 里有条目');
if (onlySm.length) bad('S.m 有条目但没有对应 tab', onlySm.join(', '));
else ok('S.m 每个条目都有对应 tab');

/* ── 5. MODE_NAME 覆盖所有模式 ── */
console.log('\n--- MODE_NAME 是否覆盖所有模式 ---');
const mnMatch = js.match(/const MODE_NAME = \{([^}]+)\}/);
if (!mnMatch) bad('找不到 MODE_NAME');
else {
  const mnKeys = new Set([...mnMatch[1].matchAll(/(\w+):/g)].map(x => x[1]));
  const miss = [...tabs].filter(t => !mnKeys.has(t));
  if (miss.length) bad('MODE_NAME 缺少模式', miss.join(', '));
  else ok('MODE_NAME 覆盖全部 ' + tabs.size + ' 个模式');
}

/* ── 6. 批量面板关键控件是否存在 ── */
console.log('\n--- 批量面板必需控件 ---');
const needIds = ['cfgBar','cfgTxt','cfgPath','planCard','planTitle','planDesc','planResume',
                 'planAbandon','tplBox','tplErr','tplTags','tplStat','tplInsert','tplReset',
                 'slotList','slotAdd','slotStat','comboLine','comboNum','comboHint',
                 'countWarn','skipDup','comboPrev','prevStat','frozenInfo',
                 // 我的模板（用户模板库）
                 'tplLibStat','tplLibList','tplSaveAs','tplUndo'];
const missCtl = needIds.filter(id => !definedIds.has(id));
if (missCtl.length) bad('批量面板缺少控件', missCtl.join(', '));
else ok(`批量面板 ${needIds.length} 个必需控件齐全`);

/* ── 7. batch pane 里的 data-f 字段 ── */
console.log('\n--- batch pane 的 data-f 字段 ---');
const batchPaneMatch = markup.match(/data-pane="batch"[\s\S]*?\n      <\/div>\n\n    <\/div>/);
if (!batchPaneMatch){
  // 退而求其次：从 data-pane="batch" 到下一个 pane 或 </div> 结束
  const i = markup.indexOf('data-pane="batch"');
  const seg = markup.slice(i, i + 6000);
  const fields = [...seg.matchAll(/data-f="([^"]+)"/g)].map(x => x[1]);
  console.log('  字段: ' + fields.join(', '));
  const need = ['template','count','skipDup'];
  const miss = need.filter(f => !fields.includes(f));
  if (miss.length) bad('batch pane 缺 data-f 字段', miss.join(', '));
  else ok('batch pane 三个 data-f 字段齐全（template/count/skipDup）');
} else {
  const fields = [...batchPaneMatch[0].matchAll(/data-f="([^"]+)"/g)].map(x => x[1]);
  console.log('  字段: ' + fields.join(', '));
  ok('batch pane 已定位');
}

/* ── 8. 函数定义检查 ── */
console.log('\n--- 批量模块函数是否都已定义 ---');
const needFns = ['scanSlots','validateTemplate','slotValues','comboCount','renderPrompt',
                 'pickCombo','buildCombo','cfgLoad','cfgSaveNow','cfgSaveDebounced','planSave',
                 'templateHash','loadBatchPane','saveBatchPane','renderSlotEditor','onSlotEdit',
                 'slotIsUsed','renderTplTags','validateBatch','escapeHtml','syncBatchLabels',
                 'renderComboPreview','renderFrozenInfo','renderPlanCard','planAbandon',
                 'batchParams','batchBody','generateBatch','resumeBatch','runBatchLoop',
                 'bootConfig','cloneFactorySlots'];
const missFn = needFns.filter(fn => !new RegExp(`function ${fn}\\s*\\(`).test(js));
if (missFn.length) bad('缺少函数定义', missFn.join(', '));
else ok(`全部 ${needFns.length} 个函数都已定义`);

/* ── 9. 启动默认值：2:3（512×768）与 10 步 ──
   用户最常用这套，要求每次打开页面就是这个状态。
   HTML 控件默认值与 JS 状态默认值必须一致，否则会出现
   「滑块显示 8、实际按 10 跑」这种静默错位。 */
console.log('\n--- 启动默认值：2:3 / 10 步 ---');

// 9a. RATIOS 里 2:3 必须存在，且像素为 512×768
const ratioM = js.match(/const RATIOS = \[([\s\S]*?)\];/);
if (!ratioM) bad('找不到 RATIOS');
else {
  const m23 = ratioM[1].match(/\['2:3',\s*(\d+),\s*(\d+)\]/);
  if (!m23) bad('RATIOS 里没有 2:3');
  else if (+m23[1] !== 512 || +m23[2] !== 768) bad('2:3 的像素不是 512×768', m23[1] + '×' + m23[2]);
  else ok('RATIOS 定义 2:3 = 512×768');
}

// 9b. JS 状态里 txt2img 默认必须是 512×768 / 10 步
const t2i = js.match(/txt2img:\s*\{([\s\S]*?)\n\s{4}\}/);
if (!t2i) bad('找不到 S.m.txt2img');
else {
  const wm = t2i[1].match(/\bw:\s*(\d+)/), hm = t2i[1].match(/\bh:\s*(\d+)/), sm2 = t2i[1].match(/\bsteps:\s*(\d+)/);
  if (!wm || !hm || !sm2) bad('txt2img 默认值解析失败');
  else {
    if (+wm[1] !== 512 || +hm[1] !== 768) bad('txt2img 默认尺寸不是 512×768', wm[1] + '×' + hm[1]);
    else ok('txt2img 默认尺寸 512×768（对应 2:3）');
    if (+sm2[1] !== 10) bad('txt2img 默认步数不是 10', sm2[1]);
    else ok('txt2img 默认步数 10');
  }
}

// 9c. 三个模式的默认步数都应是 10
console.log('  ── 各模式默认步数 ──');
for (const mode of ['txt2img','img2img','inpaint']){
  const blk = js.match(new RegExp(mode + ':\\s*\\{([\\s\\S]*?)\\n\\s{4}\\}'));
  if (!blk){ bad('找不到 S.m.' + mode); continue; }
  const sm2 = blk[1].match(/\bsteps:\s*(\d+)/);
  if (!sm2){ bad(mode + ' 没有 steps 默认值'); continue; }
  if (+sm2[1] !== 10) bad(mode + ' 默认步数不是 10', sm2[1]);
  else ok(mode + ' 默认步数 10');
}

// 9d. HTML 里三个面板的滑块与标签也必须是 10
const sliderVals = [...markup.matchAll(/data-f="steps"[^>]*value="(\d+)"/g)].map(m => m[1]);
const labelVals  = [...markup.matchAll(/data-v="steps">(\d+)</g)].map(m => m[1]);
console.log(`  HTML 滑块 value: ${sliderVals.join(', ')}`);
console.log(`  HTML 标签文字  : ${labelVals.join(', ')}`);
if (sliderVals.length !== 3) bad('steps 滑块数量不是 3', String(sliderVals.length));
else if (sliderVals.some(v => v !== '10')) bad('有 steps 滑块不是 10', sliderVals.join(','));
else ok('三个面板的 steps 滑块都是 10');

if (labelVals.length !== 3) bad('steps 标签数量不是 3', String(labelVals.length));
else if (labelVals.some(v => v !== '10')) bad('有 steps 标签不是 10', labelVals.join(','));
else ok('三个面板的 steps 标签都是 10');

// 9e. 没有 localStorage 之类的持久化会覆盖启动默认值
if (/localStorage/.test(js)) bad('存在 localStorage 持久化，可能覆盖启动默认值');
else ok('无 localStorage 覆盖，默认值每次打开都生效');

/* ── 10. 标签闭合粗查 ── */
console.log('\n--- 标签闭合粗查 ---');
for (const tag of ['div','section','aside','main','header','textarea','button']){
  const open = (markup.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (markup.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (tag === 'button' || tag === 'textarea'){
    // 这些可能有自闭合写法的变体，只提示
    console.log(`  ${tag}: 开 ${open} / 闭 ${close}${open !== close ? '  ⚠ 不匹配' : ''}`);
  } else if (open !== close){
    bad(`${tag} 标签不匹配`, `开 ${open} / 闭 ${close}`);
  } else {
    ok(`${tag} 标签匹配（${open} 对）`);
  }
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (problems.length){
  console.log('\n问题清单：');
  problems.forEach(p => console.log('  · ' + p));
}
process.exit(fail ? 1 : 0);
