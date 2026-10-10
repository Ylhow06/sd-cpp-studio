/* ══════════════════════════════════════════════════════════════
   CLI 接模板库（--template / --list-templates）

   覆盖：
     A. --list-templates 列出模板库（不需要保存目录）
     B. --template 按 id 选模板
     C. --template 按名字（含唯一前缀）选模板
     D. 找不到 / 前缀不唯一 → 明确报错，不静默用别的模板
     E. --template 与 --job 互斥，且报错原因正确
     F. 模板自带的 count / skipDup 生效，命令行显式值优先
     G. 无概率模板（走线性抽样）不崩 —— 回归 idxRows 类型统一
     H. --tpl-dir 可指定模板目录

   用法：node tests/test-cli-template.mjs
   ══════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CLI = path.join(ROOT, 'tools', 'batch-run.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-tpl-'));
const CFG = path.join(TMP, 'config.json');
const TPLDIR = path.join(TMP, 'templates');
const OUT = path.join(TMP, 'out');
fs.mkdirSync(TPLDIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// 一个「无概率」模板（走线性抽样，曾经必崩）
const T_PLAIN = {
  id: 'tpl_plain', name: '普通模板', at: 1000,
  template: '一个{{发型}}的少女，在{{场景}}',
  slots: [
    { name: '发型', values: ['黑色长发', '双马尾', '短发'] },
    { name: '场景', values: ['教室', '天台'] }
  ],
  count: 2, skipDup: true
};
// 一个「带概率」模板
const T_PROB = {
  id: 'tpl_prob', name: '概率模板', at: 2000,
  template: '基础。{{#帽子}}帽子：{{帽子}}；{{/帽子}}鞋子：{{鞋子}}',
  slots: [
    { name: '帽子', values: ['红帽', '蓝帽'], p: 0.5 },
    { name: '鞋子', values: ['运动鞋', '皮鞋'] }
  ],
  count: 4, skipDup: true
};
// 同名前缀，用来测「前缀不唯一」
const T_A1 = { id: 'tpl_same_1', name: '同款A', at: 3000, template: 'A {{x}}', slots: [{ name: 'x', values: ['1'] }], count: 1, skipDup: true };
const T_A2 = { id: 'tpl_same_2', name: '同款B', at: 3000, template: 'B {{x}}', slots: [{ name: 'x', values: ['2'] }], count: 1, skipDup: true };

for (const t of [T_PLAIN, T_PROB, T_A1, T_A2]){
  fs.writeFileSync(path.join(TPLDIR, t.id + '.json'), JSON.stringify(t, null, 2), 'utf8');
}
fs.writeFileSync(CFG, JSON.stringify({
  version: 1,
  batch: { template: '来自config {{x}}', slots: [{ name: 'x', values: ['cfg'] }], skipDup: true, count: 9 },
  saveDir: OUT
}, null, 2), 'utf8');

const run = (args) => {
  try {
    return { out: execFileSync(process.execPath, [CLI, '--config', CFG, '--out-dir', OUT, ...args], { encoding: 'utf8', cwd: ROOT }), code: 0 };
  } catch (e){
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 };
  }
};

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : ''))); };
const line = (o, kw) => (o.split('\n').find(l => l.includes(kw)) || '').trim();

console.log('\n=== A. --list-templates ===');
{
  const r = run(['--list-templates']);
  ok('退出码 0', r.code === 0, 'code=' + r.code);
  ok('列出模板库目录', r.out.includes(TPLDIR), line(r.out, '模板库'));
  ok('列出 4 个模板', ['tpl_plain', 'tpl_prob', 'tpl_same_1', 'tpl_same_2'].every(id => r.out.includes(id)));
  ok('显示模板名', r.out.includes('普通模板') && r.out.includes('概率模板'));
  ok('不需要保存目录也能跑', !r.out.includes('没有保存目录'));
}

console.log('\n=== B. --template 按 id ===');
{
  const r = run(['--template', 'tpl_plain', '--list']);
  ok('退出码 0', r.code === 0, 'code=' + r.code);
  ok('提示使用了哪个模板', r.out.includes('普通模板'), line(r.out, '[模板]'));
  ok('用的是模板正文（不是 config 的）', !r.out.includes('来自config'), line(r.out, '模板指纹'));
  ok('槽位来自模板', /占位符.*发型.*场景/.test(r.out), line(r.out, '占位符'));
}

console.log('\n=== C. --template 按名字 / 唯一前缀 ===');
{
  const r1 = run(['--template', '概率模板', '--list']);
  ok('按完整名字命中', r1.code === 0 && r1.out.includes('概率模板'), 'code=' + r1.code);
  const r2 = run(['--template', '普通', '--list']);
  ok('按唯一前缀命中', r2.code === 0 && r2.out.includes('普通模板'), 'code=' + r2.code);
}

console.log('\n=== D. 找不到 / 前缀不唯一 → 报错 ===');
{
  const r1 = run(['--template', '不存在的模板', '--list']);
  ok('找不到时非 0 退出', r1.code !== 0, 'code=' + r1.code);
  ok('报错说明找不到', r1.out.includes('找不到'), line(r1.out, '找不到'));
  ok('提示用 --list-templates', r1.out.includes('--list-templates'));
  ok('不静默改用 config 模板', !r1.out.includes('来自config'));

  const r2 = run(['--template', '同款', '--list']);
  ok('前缀不唯一时非 0 退出', r2.code !== 0, 'code=' + r2.code);
  ok('列出候选', r2.out.includes('tpl_same_1') && r2.out.includes('tpl_same_2'));
}

console.log('\n=== E. --template 与 --job 互斥 ===');
{
  const r = run(['--template', 'tpl_plain', '--job', path.join(TMP, 'nope.json'), '--list']);
  ok('非 0 退出', r.code !== 0, 'code=' + r.code);
  ok('报的是互斥原因（不是「读不到任务文件」）', r.out.includes('不能同时用'), line(r.out, '[错误]'));
  ok('没有答非所问的 ENOENT', !r.out.includes('读不到任务文件'));
}

console.log('\n=== F. 模板自带 count / skipDup；命令行优先 ===');
{
  const r1 = run(['--template', 'tpl_plain', '--list']);
  ok('用模板的 count=2', /本批张数.*2/.test(r1.out), line(r1.out, '本批张数'));
  ok('用模板的 skipDup=true → 不重复', r1.out.includes('不重复'), line(r1.out, '本批张数'));

  const r2 = run(['--template', 'tpl_plain', '--list', '--count', '1']);
  ok('--count 覆盖模板值', /本批张数.*1/.test(r2.out), line(r2.out, '本批张数'));
}

console.log('\n=== G. 无概率模板不崩（idxRows 类型统一回归）===');
{
  const r = run(['--template', 'tpl_plain', '--list']);
  ok('不抛异常', !r.out.includes('[异常]'), r.out.split('\n').find(l => l.includes('异常')));
  ok('不出现 idxs.map is not a function', !r.out.includes('idxs.map'));
  ok('打印出计划行', /\[待生成\]/.test(r.out));
  ok('组合总数 6（3×2）', r.out.includes('6'), line(r.out, '组合总数'));
}

console.log('\n=== H. 带概率模板：去重禁用 + 缺席渲染 ===');
{
  const r = run(['--template', 'tpl_prob', '--list']);
  ok('退出码 0', r.code === 0, 'code=' + r.code);
  ok('去重被自动禁用', r.out.includes('去重已自动禁用'), line(r.out, '[提示]'));
  ok('概率显示为百分比', /帽子\(50%\)/.test(r.out), line(r.out, '占位符'));
  ok('条件块模板能通过校验', !r.out.includes('[错误]'));
}

console.log('\n=== I. --tpl-dir 指定模板目录 ===');
{
  const other = path.join(TMP, 'other-tpl');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'tpl_x.json'), JSON.stringify({
    id: 'tpl_x', name: '另一个目录', at: 1, template: 'X {{y}}',
    slots: [{ name: 'y', values: ['1'] }], count: 1, skipDup: true
  }), 'utf8');
  const r1 = run(['--list-templates', '--tpl-dir', other]);
  ok('列出指定目录', r1.out.includes('另一个目录') && r1.out.includes(other), line(r1.out, '模板库'));
  ok('不含默认目录的模板', !r1.out.includes('普通模板'));
  const r2 = run(['--template', 'tpl_x', '--list', '--tpl-dir', other]);
  ok('从指定目录取模板', r2.code === 0 && r2.out.includes('另一个目录'), 'code=' + r2.code);
}

console.log('\n=== J. 空模板目录不崩 ===');
{
  const empty = path.join(TMP, 'empty-tpl');
  fs.mkdirSync(empty, { recursive: true });
  const r = run(['--list-templates', '--tpl-dir', empty]);
  ok('退出码 0', r.code === 0, 'code=' + r.code);
  ok('提示为空', r.out.includes('空'), line(r.out, '（空'));
  const r2 = run(['--template', 'tpl_plain', '--list', '--tpl-dir', empty]);
  ok('指定不存在的模板时报错', r2.code !== 0);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log('\n' + '─'.repeat(50));
console.log(fail ? `结果：${pass} 通过 / ${fail} 失败` : `结果：${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);