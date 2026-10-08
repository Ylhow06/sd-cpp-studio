/* 终端标签摘要（tools/batch-run.mjs）· 正确性验证
 *
 *  规则只有一条：每个占位符选中的值取前 LABEL_CHARS(5) 个字，超长补「…」。
 *  这里锁住三件事：
 *    1) 截断行为本身（含 emoji 不切碎、非字符串不炸、空白折叠）
 *    2) 列对齐宽度（含「槽名比标签长」时表头不顶开）
 *    3) 关键不变量：标签只用于显示，出图仍走完整提示词
 *
 *  用法：node tests\test-cli-label.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SRC = path.join(ROOT, 'tools', 'batch-run.mjs');
const src = fs.readFileSync(SRC, 'utf8');

/* 从脚本里抠出纯函数段（LABEL_CHARS 起，到 decodeIdxs 之前） */
const from = src.indexOf('const LABEL_CHARS');
const to = src.indexOf('/** 线性索引 → 各槽下标');
if (from < 0 || to < 0 || to <= from){
  console.error('无法定位标签函数段，脚本结构可能已变。');
  process.exit(1);
}
const mod = new Function(`
${src.slice(from, to)}
return { LABEL_CHARS, LABEL_SEP, labelOf, dwidth, dpad, labelWidths, comboLabels };
`)();
const { LABEL_CHARS, LABEL_SEP, labelOf, dwidth, dpad, labelWidths, comboLabels } = mod;

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : ''))); };

console.log('\n=== 1. 取前 5 个字（唯一规则）===');
{
  ok('LABEL_CHARS 就是 5', LABEL_CHARS === 5, 'LABEL_CHARS=' + LABEL_CHARS);
  ok('短值原样返回', labelOf('短发') === '短发', labelOf('短发'));
  ok('恰好 5 字不截断', labelOf('一二三四五') === '一二三四五', labelOf('一二三四五'));
  ok('6 字截成 5 字 + …', labelOf('一二三四五六') === '一二三四五…', labelOf('一二三四五六'));
  ok('长句截成 5 字 + …', labelOf('黑色长发披肩，中分，自然垂落') === '黑色长发披…',
     labelOf('黑色长发披肩，中分，自然垂落'));
  ok('英文按字符计', labelOf('cyberpunk girl') === 'cyber…', labelOf('cyberpunk girl'));
  ok('emoji 按码点计（不切碎代理对）', labelOf('🌸🌸🌸🌸🌸🌸') === '🌸🌸🌸🌸🌸…',
     labelOf('🌸🌸🌸🌸🌸🌸'));
  ok('换行被折叠成空格', labelOf('a\nb') === 'a b', JSON.stringify(labelOf('a\nb')));
  ok('制表符/多空格被折叠', labelOf('a\t\t  b') === 'a b', JSON.stringify(labelOf('a\t\t  b')));
  ok('首尾空白被去掉', labelOf('  短发  ') === '短发', JSON.stringify(labelOf('  短发  ')));
  ok('空串不炸', labelOf('') === '', JSON.stringify(labelOf('')));
  ok('非字符串不炸（数字）', labelOf(123) === '123', labelOf(123));
  ok('非字符串不炸（null）', labelOf(null) === 'null', labelOf(null));
  ok('自定义 n 生效', labelOf('一二三四五六七八', 3) === '一二三…', labelOf('一二三四五六七八', 3));
}

console.log('\n=== 2. 显示宽度与对齐（仅用于排版）===');
{
  ok('ASCII 每个 1 格', dwidth('abc') === 3, dwidth('abc'));
  ok('中文每个 2 格', dwidth('赛博朋克') === 8, dwidth('赛博朋克'));
  ok('中英混排相加', dwidth('a赛b') === 4, dwidth('a赛b'));
  ok('emoji 占 2 格', dwidth('🌸') === 2, dwidth('🌸'));
  ok('空串 0 格', dwidth('') === 0);
  ok('右补到指定宽度', dpad('短发', 6) === '短发  ', JSON.stringify(dpad('短发', 6)));
  ok('已够宽不补', dpad('赛博朋克', 6) === '赛博朋克', JSON.stringify(dpad('赛博朋克', 6)));
  ok('超宽不截断（由 labelOf 负责）', dpad('赛博朋克', 4) === '赛博朋克', JSON.stringify(dpad('赛博朋克', 4)));
}

console.log('\n=== 3. 列宽与组合摘要 ===');
{
  const pools = [['短发', '长发'], ['黄昏', '清晨'], ['项链']];
  const names = ['发型', '氛围', '饰品'];
  const w = labelWidths(pools, names);
  ok('列宽取池内最长标签', w[0] === 4, JSON.stringify(w));
  ok('单值池列宽=该值宽度', w[2] === dwidth('项链'), 'w=' + w[2]);

  const s0 = comboLabels([0, 0, 0], pools, w);
  const s1 = comboLabels([1, 1, 0], pools, w);
  ok('槽间用 · 分隔', s0.includes(LABEL_SEP), JSON.stringify(s0));
  ok('不同组合摘要不同', s0 !== s1, JSON.stringify([s0, s1]));
  ok('末尾不留补位空格', s0 === s0.replace(/\s+$/, ''), JSON.stringify(s0));
  ok('不含换行（单行输出）', !/[\r\n]/.test(s0));
}
{
  // 槽名比 5 字长时，列宽必须把槽名算进去，否则表头会顶开标签列
  const pools = [['短发']];
  const names = ['非常长的占位符名称'];
  const w = labelWidths(pools, names);
  ok('列宽覆盖槽名', w[0] >= dwidth(labelOf(names[0])), 'w=' + w[0]);
  ok('列宽恰为槽名截断宽度', w[0] === dwidth(labelOf(names[0])), 'w=' + w[0]);
}
{
  // 不传 names 时退化为只看池内标签
  const pools = [['短发', '长发']];
  ok('names 可选', labelWidths(pools)[0] === 4, JSON.stringify(labelWidths(pools)));
}

console.log('\n=== 4. 真实规模：5 槽长句必须单行放得下 ===');
{
  const pools = [
    ['黑色长发披肩，中分，自然垂落', '黑色长发半扎，两侧留出碎发'],
    ['室内暖色灯光，光线柔和', '阴天漫射光，清冷中性'],
    ['脖子上一条细珍珠项链，手腕系粉色丝带', '只穿一双白色细带玛丽珍鞋'],
    ['空无一人的教室，课桌椅整齐排列', '校园操场中央的草坪'],
    ['正面直立站姿，双臂自然垂在身体两侧', '双手轻轻交叠放在身前']
  ];
  const names = ['发型', '氛围', '饰品', '场景', '动作'];
  const w = labelWidths(pools, names);
  const s = comboLabels([0, 0, 0, 0, 0], pools, w);
  ok('5 槽摘要含 8 格缩进仍 ≤ 80 列', 8 + dwidth(s) <= 80, (8 + dwidth(s)) + ' 格');
  ok('每个标签 ≤ 5 字 + 省略号（≤12 格）', w.every(x => x <= 12), JSON.stringify(w));
  ok('标签数与槽数一致', s.split(LABEL_SEP).length === 5, s.split(LABEL_SEP).length);
  console.log('        样例：' + s);
}

console.log('\n=== 5. 不变量：标签 ≠ 提示词 ===');
{
  // 出图走 renderPrompt（完整），标签只截前 5 字；两者必须不同
  const long = '黑色长发披肩，中分，自然垂落';
  ok('长值标签明显短于原值', labelOf(long).length < long.length, labelOf(long).length + ' < ' + long.length);
  ok('标签是原值的前缀（+省略号）', long.startsWith(labelOf(long).replace('…', '')), labelOf(long));
  // 脚本里必须仍把 renderPrompt 的结果作为 prompt 发送
  ok('脚本仍用 p.text 作为 prompt', /prompt:\s*p\.text/.test(src));
  ok('脚本仍保留 renderPrompt', /function renderPrompt/.test(src));
  ok('脚本不再残留旧截断函数', !/function clipWTail|function iterSkip|function labelPlan/.test(src));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);