/**
 * 占位符引擎离线自测。
 * 从 ui/index.html 里抽出纯函数逻辑（不依赖 DOM），验证核心行为。
 * 用法：node _test-slot-engine.mjs
 */

/* ── 从 index.html 抠出需要的常量与函数 ── */
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

// 只取「批量生图 · 出厂默认」到「耗时预估」之间的纯逻辑段
// （这段里已包含 BATCH_FACTORY、SLOT_NAME_RE、CFG_URL 与占位符引擎）
const from = js.indexOf('const BATCH_FACTORY');
const to = js.indexOf('/* ══════════════ 耗时预估');
const engine = js.slice(from, to);

const mod = new Function(`
${engine}
return { BATCH_FACTORY, scanSlots, validateTemplate, slotValues, comboCount, renderPrompt, pickCombo };
`)();

const { BATCH_FACTORY, scanSlots, validateTemplate, slotValues, comboCount, renderPrompt, pickCombo } = mod;

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n=== 1. 出厂默认自洽性（关键：不能一打开就报错）===');
{
  const v = validateTemplate(BATCH_FACTORY.template, BATCH_FACTORY.slots);
  ok('出厂模板零错误', v.errors.length === 0, JSON.stringify(v.errors));
  ok('组合数 = 6×6×8 = 288', comboCount(BATCH_FACTORY.slots, BATCH_FACTORY.template) === 288,
     '实际 ' + comboCount(BATCH_FACTORY.slots, BATCH_FACTORY.template));
  const { found } = scanSlots(BATCH_FACTORY.template);
  const names = [...new Set(found.map(f => f.name.trim()))];
  ok('识别出 3 个占位符', names.length === 3, names.join(','));
}

console.log('\n=== 2. 扫描与未闭合检测 ===');
{
  const r1 = scanSlots('穿{{服装}}在{{场景}}');
  ok('识别 2 个占位符', r1.found.length === 2);
  ok('无未闭合', r1.unclosed.length === 0);

  const r2 = scanSlots('穿{{服装}在{{场景}}');
  ok('未闭合被检出', r2.unclosed.length === 1, JSON.stringify(r2.unclosed));
  ok('已配对的仍被识别', r2.found.length === 1 && r2.found[0].name === '场景');

  const r3 = scanSlots('{{}}空名');
  ok('空名被识别', r3.found.length === 1 && r3.found[0].name === '');

  const r4 = scanSlots('{{ 带空格 }}');
  ok('带空格名称被识别', r4.found.length === 1 && r4.found[0].name === ' 带空格 ');
}

console.log('\n=== 3. 校验：缺失 / 空数组 / 非法名 ===');
{
  const slots = [{ name: '服装', values: ['A', 'B'] }, { name: '场景', values: [] }];

  const v1 = validateTemplate('{{服装}}和{{不存在}}', slots);
  ok('缺失数组被报错', v1.errors.some(e => e.kind === 'missing'));

  const v2 = validateTemplate('{{服装}}和{{场景}}', slots);
  ok('空数组被报错', v2.errors.some(e => e.kind === 'emptyarr'));

  const v3 = validateTemplate('{{服 装}}', slots);
  ok('含空格名被报错', v3.errors.some(e => e.kind === 'badname'));

  const v4 = validateTemplate('{{服装}}', slots);
  ok('正常模板零错误', v4.errors.length === 0);

  const v5 = validateTemplate('{{服装}}', [...slots, { name: '未使用', values: ['x'] }]);
  ok('未使用的数组被列为 unused（非错误）', v5.unused.includes('未使用') && v5.errors.length === 0);

  // 全是空白的数组也算空
  const v6 = validateTemplate('{{场景}}', [{ name: '场景', values: ['  ', '', '\n'] }]);
  ok('全空白数组被报错', v6.errors.some(e => e.kind === 'emptyarr'));
}

console.log('\n=== 4. 组合数与渲染 ===');
{
  const slots = [
    { name: '服装', values: ['A1', 'A2', 'A3'] },
    { name: '场景', values: ['B1', 'B2'] }
  ];
  ok('3×2 = 6', comboCount(slots, '{{服装}}{{场景}}') === 6);
  ok('空数组 → 0', comboCount([{ name: 'x', values: [] }], '{{x}}') === 0);
  ok('无占位符 → 0', comboCount(slots, '没有占位符') === 0);

  const out = renderPrompt('穿{{服装}}去{{场景}}，{{服装}}很好看', { 服装: '夹克', 场景: '夜市' });
  ok('同名占位符取同一个值',
     out === '穿夹克去夜市，夹克很好看', out);

  const out2 = renderPrompt('{{未定义}}', {});
  ok('未定义占位符保持原样', out2 === '{{未定义}}', out2);
}

console.log('\n=== 5. 同名占位符一致性（硬要求）===');
{
  const slots = [{ name: '发型', values: ['双马尾', '短发'] }];
  const tpl = '一位{{发型}}的女孩，{{发型}}随风飘动';
  let allSame = true;
  for (let i = 0; i < 50; i++){
    const c = pickCombo(slots, tpl, null, false);
    const r = renderPrompt(tpl, c.map);
    const m = r.match(/一位(.+?)的女孩，(.+?)随风飘动/);
    if (!m || m[1] !== m[2]) { allSame = false; break; }
  }
  ok('50 次随机，同名占位符始终一致', allSame);
}

console.log('\n=== 6. 跳过重复组合 ===');
{
  const slots = [
    { name: '服装', values: ['A1', 'A2'] },
    { name: '场景', values: ['B1', 'B2'] }
  ];
  const tpl = '{{服装}}{{场景}}';   // 组合空间 4

  // 不跳过：可能重复
  const used1 = [];
  for (let i = 0; i < 4; i++){
    const c = pickCombo(slots, tpl, used1, false);
    used1.push(c.key);
  }
  const uniq1 = new Set(used1).size;
  ok('不跳过时允许重复（4 次抽到 ≤4 种）', uniq1 <= 4, '唯一数 ' + uniq1);

  // 跳过：4 张必须全部不同
  const used2 = [];
  for (let i = 0; i < 4; i++){
    const c = pickCombo(slots, tpl, used2, true);
    if (!c) break;
    used2.push(c.key);
  }
  ok('跳过时 4 张互不重复', new Set(used2).size === 4, used2.join(' | '));

  // 用尽后返回 null
  const c5 = pickCombo(slots, tpl, used2, true);
  ok('组合用尽后返回 null', c5 === null);

  // 大空间下不重复性
  const big = [{ name: 'a', values: Array.from({length: 6}, (_, i) => 'a' + i) },
               { name: 'b', values: Array.from({length: 6}, (_, i) => 'b' + i) },
               { name: 'c', values: Array.from({length: 6}, (_, i) => 'c' + i) }];
  const tplBig = '{{a}}{{b}}{{c}}';   // 216
  const used3 = [];
  let allUniq = true;
  for (let i = 0; i < 60; i++){
    const c = pickCombo(big, tplBig, used3, true);
    if (!c){ allUniq = false; break; }
    if (used3.includes(c.key)){ allUniq = false; break; }
    used3.push(c.key);
  }
  ok('216 空间中连抽 60 次全不重复', allUniq && used3.length === 60, '抽到 ' + used3.length);
}

console.log('\n=== 7. 边界 ===');
{
  ok('无占位符时 pickCombo 返回 null', pickCombo([], '纯文本', [], false) === null);
  ok('数组为空时返回 null', pickCombo([{name:'x',values:[]}], '{{x}}', [], false) === null);

  const one = [{ name: 'x', values: ['唯一值'] }];
  const c = pickCombo(one, '{{x}}', [], true);
  ok('单值数组可用', c && c.map.x === '唯一值');
  ok('单值数组第二次返回 null', pickCombo(one, '{{x}}', [c.key], true) === null);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
