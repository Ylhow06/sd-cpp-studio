/* ══════════════════════════════════════════════════════════════
   终端脚本 tools/batch-run.mjs：续跑/开新批 模式决策
   ──────────────────────────────────────────────────────────────
   这次改动把「检测到就自动续跑」改成「默认开新批，加 --resume 才续」。
   核心不变量：
     A. 默认（无状态 / 状态已完成）→ 直接开新批，批次模式显示「开新批次」
     B. 存在未完成批次、但不加 --resume → 明确提示 + 仍开新批
     C. 存在未完成批次、加 --resume → 续跑（沿用旧批次）
     D. 已完成批次 + --resume → 提示无需续 + 开新批
     E. 批次不匹配（模板/张数变了）+ --resume → 提示无法续 + 开新批
     F. UI 下发的 job 带 mode=resume → 等价于 --resume
  用法：node tests\test-cli-resume.mjs   （会写临时目录到 %TEMP%\sd-resume-*，跑完自删）
   ══════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CLI = path.join(ROOT, 'tools', 'batch-run.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-resume-'));
const CFG = path.join(TMP, 'config.json');
const STATE = path.join(TMP, '.batch-cli-state.json');

const SRC = fs.readFileSync(CLI, 'utf8');

/* 复刻脚本里的 templateHash 与 tsStamp（用于造假状态文件） */
function templateHash(tpl, slots){
  const s = tpl + '##' + (slots || []).map(x => (x.name || '') + ':' + (x.values || []).join(',')).join(';');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

const TEMPLATE = '一个{{发型}}的{{氛围}}少女，在{{场景}}，{{动作}}';
const SLOTS = [
  { name: '发型', values: ['黑色长发', '双马尾'] },
  { name: '氛围', values: ['黄昏', '清晨'] },
  { name: '场景', values: ['教室', '天台'] },
  { name: '动作', values: ['站立', '回眸'] }
];
const HASH = templateHash(TEMPLATE, SLOTS);

const cfg = {
  version: 1,
  batch: { template: TEMPLATE, slots: SLOTS, skipDup: true, count: 3 },
  saveDir: TMP
};
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), 'utf8');

function baseState(over){
  return Object.assign({
    version: 2, stamp: '20261008_999999', templateHash: HASH,
    template: TEMPLATE, slots: SLOTS,
    seedBase: 111, count: 3, skipDup: true,
    params: { w:128, h:128, steps:2, cfg:1, sampler:'euler', scheduler:'discrete' },
    neg: 'lowres', linears: [7, 11, 15], done: []
  }, over || {});
}
function writeState(s){ fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8'); }
function rmState(){ try { fs.unlinkSync(STATE); } catch {} }

function runCli(extra){
  const args = [process.execPath, CLI, '--config', CFG, '--list', '--w', '128', '--h', '128', '--steps', '2', ...extra];
  const out = execFileSync(process.execPath, args.slice(1), { encoding: 'utf8', cwd: ROOT });
  return out;
}

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? ' → ' + e : ''))); };

console.log('\n=== A. 无状态 → 直接开新批，不提示 ===');
{
  rmState();
  const out = runCli([]);
  ok('批次模式=开新批次', /批次模式.*开新批次/.test(out), out.split('\n').find(l=>l.includes('批次模式')));
  ok('不出现「检测到」', !out.includes('检测到'));
}

console.log('\n=== B. 有未完成批次 + 不加 --resume → 提示 + 仍开新批 ===');
{
  writeState(baseState({ done: [0] }));
  const out = runCli([]);
  ok('检测到未完成批次（1/3）', /检测到未完成批次 [^（]*（1\/3）/.test(out));
  ok('提示用 --resume 续', out.includes('--resume') || out.includes('继续未完成批次'));
  ok('本次仍开新批次', /批次模式.*开新批次/.test(out));
}

console.log('\n=== C. 有未完成批次 + --resume → 按快照续跑 ===');
{
  writeState(baseState({ done: [0] }));
  const out = runCli(['--resume']);
  ok('沿用旧批次', /续跑.*沿用批次.*已完成 1\/3/.test(out), out.split('\n').find(l=>l.includes('续跑')));
  ok('批次模式=续跑', /批次模式.*续跑/.test(out));
}

console.log('\n=== C2. 当前提示词/参数已改，+ --resume → 仍按旧快照续（关键新行为）===');
{
  // 状态存的是旧模板/旧反向提示词；当前 config 是一套完全不同、张数也不同的新模板。
  // 续跑必须用旧快照（组合、参数、反向提示词全看旧的那份）。
  writeState(baseState({ done: [0], neg: '旧反向词A', template: '旧模板：{{发型}}、{{氛围}}', templateHash: 'ffff0000' }));
  const cfg2 = { version:1, batch:{ template:'全新模板{{人物}}', slots:[{name:'人物',values:['新A','新B']}], skipDup:true, count:5 }, saveDir:TMP };
  const CFG2 = path.join(TMP, 'config2.json');
  fs.writeFileSync(CFG2, JSON.stringify(cfg2, null, 2), 'utf8');
  const args = [process.execPath, CLI, '--config', CFG2, '--list', '--resume'];
  const out = execFileSync(process.execPath, args.slice(1), { encoding: 'utf8', cwd: ROOT });
  ok('仍续跑旧批次', /续跑.*沿用批次/.test(out), out.split('\n').find(l=>l.includes('续跑')));
  const line = out.split('\n').find(l=>l.includes('占位符'));
  ok('占位符用旧快照（发型/氛围，不是新模板的人物）', /发型.*氛围/.test(line), line);
  ok('反向提示取自旧快照（旧反向词A）', out.includes('旧反向词A'));
}

console.log('\n=== D. 已完成批次 + --resume → 无需续 + 开新批 ===');
{
  writeState(baseState({ done: [0,1,2] }));
  const out = runCli(['--resume']);
  ok('提示已完成', out.includes('已完成'));
  ok('开新批次', /批次模式.*开新批次/.test(out));
}

console.log('\n=== E. 旧版进度（v1 无快照）→ 无法续 + 开新批 ===');
{
  // 旧版状态没有 template/slots，不能续
  writeState({ version:1, stamp:'legacy', templateHash:'x', seedBase:1, count:3, params:{w:128,h:128,steps:2,cfg:1,sampler:'euler',scheduler:'discrete'}, linears:[0,1,2], done:[0] });
  const out = runCli(['--resume']);
  ok('提示旧版无法续', out.includes('旧版') || out.includes('缺少快照'));
  ok('开新批次', /批次模式.*开新批次/.test(out));
}

console.log('\n=== F. job 带 mode=resume → 续跑（等价 --resume）===');
{
  writeState(baseState({ done: [0] }));
  const job = { version:1, from:'ui', template:TEMPLATE, slots:SLOTS, count:3, skipDup:true, outDir:TMP, mode:'resume', params:{w:128,h:128,steps:2,cfg:1,sampler:'euler',scheduler:'discrete',neg:'',seed:5} };
  const jobFile = path.join(TMP, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
  const args = [process.execPath, CLI, '--job', jobFile, '--list'];
  const out = execFileSync(process.execPath, args.slice(1), { encoding: 'utf8', cwd: ROOT });
  ok('job mode=resume 触发续跑', /续跑.*沿用批次/.test(out), out.split('\n').find(l=>l.includes('续跑')));
  ok('批次模式=续跑', /批次模式.*续跑/.test(out));
}

console.log('\n=== G. job 无 mode → 默认开新批 + 提示 ===');
{
  writeState(baseState({ done: [0] }));
  const job = { version:1, from:'ui', template:TEMPLATE, slots:SLOTS, count:3, skipDup:true, outDir:TMP, params:{w:128,h:128,steps:2,cfg:1,sampler:'euler',scheduler:'discrete',neg:'',seed:5} };
  const jobFile = path.join(TMP, 'job2.json');
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
  const args = [process.execPath, CLI, '--job', jobFile, '--list'];
  const out = execFileSync(process.execPath, args.slice(1), { encoding: 'utf8', cwd: ROOT });
  ok('检测到未完成批次', /检测到未完成批次/.test(out));
  ok('开新批次', /批次模式.*开新批次/.test(out));
  ok('提示在浏览器里点继续', out.includes('继续未完成批次'));
}

/* 清理 */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);