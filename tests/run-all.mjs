/* ══════════════════════════════════════════════════════════════
   跑全部测试：`npm test`

   发现规则：tests/test-*.mjs（harness.mjs 不以 test- 开头，天然排除）
   每个文件在独立子进程里跑，互不污染；汇总各文件的
   「结果：N 通过 / M 失败」行。

   每个测试自己起隔离服务（临时配置 + 临时模板库 + 空闲端口），
   所以这里不需要预先起任何服务，也不会碰 app/ui/ 下的真实数据。
   ══════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, ROOT } from './harness.mjs';

const files = fs.readdirSync(HERE)
  .filter(f => /^test-.*\.mjs$/.test(f))
  .sort();

if (!files.length) {
  console.error('没有找到任何 tests/test-*.mjs');
  process.exit(1);
}

console.log(`跑 ${files.length} 个测试文件（每个自带隔离环境）…\n`);

const results = [];
const t0 = Date.now();

for (const f of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/结果：(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
  const pass = m ? +m[1] : null;
  const fail = m ? +m[2] : null;
  const ms = Date.now() - t;

  results.push({ f, pass, fail, code: r.status, out, ms });

  const good = r.status === 0 && fail === 0 && m !== null;
  const label = m ? `通过 ${String(pass).padStart(3)} / 失败 ${fail}` : `无结果行（exit ${r.status}）`;
  console.log(`${good ? '✓' : '✗'} ${f.padEnd(26)} ${label.padEnd(22)} ${(ms / 1000).toFixed(1)}s`);
}

const tp = results.reduce((a, r) => a + (r.pass || 0), 0);
const tf = results.reduce((a, r) => a + (r.fail || 0), 0);
const bad = results.filter(r => r.code !== 0 || r.fail !== 0 || r.pass === null);
const notRun = results.filter(r => r.pass === null);

console.log('\n' + '─'.repeat(64));
console.log(`${files.length} 个测试文件 · ${tp} 通过 / ${tf} 失败 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ★ 关键：没跑成的文件不能混进「0 失败」里装作全绿。
   原来只汇总各文件的通过/失败数，7 个文件因缺 jsdom 直接退出、
   报「无结果行」，汇总却写「0 失败」—— 看起来是全通过，实际没跑。 */
if (notRun.length) {
  console.log(`\n⚠ 有 ${notRun.length} 个文件没能跑起来（未计入下面的统计）：`);
  notRun.forEach(r => console.log(`    · ${r.f}`));
  if (notRun.length === files.length) {
    console.log('\n  全部文件都没跑起来 —— 多半是缺依赖。先执行：npm install');
  }
}

if (bad.length) {
  console.log('\n失败详情：');
  for (const b of bad) {
    console.log(`\n${'='.repeat(66)}\n=== ${b.f}（exit ${b.code}）\n${'='.repeat(66)}`);
    // 只打失败行与异常，避免刷屏
    const lines = b.out.split('\n');
    const picked = lines.filter(l => /✗|Error|error|异常|失败|Cannot|not found|ERROR/i.test(l));
    console.log((picked.length ? picked : lines).slice(-40).join('\n'));
  }
}

// 落一份完整输出，便于细看（不污染仓库：写进系统临时目录）
try {
  const os = await import('node:os');
  const dump = path.join(os.tmpdir(), 'sdstudio-test-run.txt');
  fs.writeFileSync(dump,
    results.map(r => `\n${'='.repeat(70)}\n=== ${r.f}（exit ${r.code}，${r.pass} 通过 / ${r.fail} 失败，${r.ms}ms）\n${'='.repeat(70)}\n${r.out}`).join('\n'),
    'utf8');
  console.log(`\n完整输出：${dump}`);
} catch { /* 写不出就算了，不影响结果 */ }

process.exit(bad.length ? 1 : 0);
