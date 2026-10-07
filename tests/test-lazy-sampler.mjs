/* 惰性洗牌采样器 · 正确性验证
 *  1) 抽满 total 张必须恰好覆盖全部组合（无重、无漏）
 *  2) 均匀性：每个组合被抽到的频率应接近 1/total
 *  3) 续跑重建（按 used 回放）后不重复性依然成立
 *  4) 索引编解码自洽
 *  5) 与旧全量枚举实现语义等价（小空间穷举对比）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const html = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const engine = js.slice(js.indexOf('const BATCH_FACTORY'), js.indexOf('/* ══════════════ 耗时预估'));
const mod = new Function(`
${engine}
return { scanSlots, slotValues, comboCount, pickCombo, decodeIdxs, keyToLinear,
         samplerReset, samplerConsume, samplerDraw, LAZY_SAMPLER };
`)();
const { scanSlots, slotValues, comboCount, pickCombo, decodeIdxs, keyToLinear,
        samplerReset, samplerDraw, LAZY_SAMPLER } = mod;

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : ''))); };

const slots = [
  { name: 'a', values: ['a0', 'a1', 'a2', 'a3'] },
  { name: 'b', values: ['b0', 'b1', 'b2'] },
  { name: 'c', values: ['c0', 'c1'] }
];
const tpl = '{{a}}{{b}}{{c}}';
const total = comboCount(slots, tpl);   // 24
const names = [...new Set(scanSlots(tpl).found.map(f => f.name.trim()))];
const pools = names.map(n => slotValues(slots, n));   // [4,3,2]

console.log(`\n（组合空间 ${total}，池 ${pools.map(p => p.length).join('×')}）`);

console.log('\n=== 1. 抽满空间：必须恰好覆盖全部组合 ===');
{
  const keys = [];
  for (let i = 0; i < total; i++){
    const c = pickCombo(slots, tpl, keys, true);
    if (!c) break;
    keys.push(c.key);
  }
  ok(`抽满 ${total} 张`, keys.length === total, '实抽 ' + keys.length);
  ok('无重复', new Set(keys).size === total, '唯一 ' + new Set(keys).size);
  const all = Array.from({ length: total }, (_, k) => decodeIdxs(k, pools).join('|'));
  const missing = all.filter(x => !keys.includes(x));
  ok('恰好覆盖全部组合（无遗漏）', missing.length === 0, '缺 ' + missing.slice(0, 5).join(','));
  ok('第 25 张返回 null', pickCombo(slots, tpl, keys, true) === null);
}

console.log('\n=== 2. 均匀性：卡方检验（每个组合被抽到的频率 ≈ 1/total）===');
{
  // 反复重开采样器、只看「首张」，检验边缘分布是否均匀。
  // 用卡方而不是「最大偏差 < x%」：24 个组合取最大值，本来就会到 2~3σ，
  // 拍一个百分比阈值只会得到一个随机失败的测试。
  const ROUNDS = 48000;
  const hit = new Map();
  for (let r = 0; r < ROUNDS; r++){
    const c = pickCombo(slots, tpl, [], true);
    hit.set(c.key, (hit.get(c.key) || 0) + 1);
  }
  const expect = ROUNDS / total;
  let chi2 = 0;
  for (let k = 0; k < total; k++){
    const obs = hit.get(decodeIdxs(k, pools).join('|')) || 0;
    chi2 += (obs - expect) ** 2 / expect;
  }
  // df = 23，α = 0.001 的临界值 ≈ 49.7
  ok(`首张分布覆盖全部 ${total} 个组合`, hit.size === total, '覆盖 ' + hit.size);
  ok(`卡方 ${chi2.toFixed(2)} < 49.7（df=23, α=0.001）→ 分布均匀`, chi2 < 49.7, 'chi2 = ' + chi2.toFixed(2));
  const dev = Math.max(...[...hit.values()].map(x => Math.abs(x - expect) / expect));
  ok(`最大偏差 ${(dev * 100).toFixed(2)}% < 15%（合理抽样波动）`, dev < 0.15, (dev * 100).toFixed(2) + '%');
}

console.log('\n=== 3. 续跑重建：按 used 回放后仍不重复 ===');
{
  // 第一段：抽 8 张（模拟跑到一半刷新页面）
  const used = [];
  for (let i = 0; i < 8; i++) used.push(pickCombo(slots, tpl, used, true).key);
  // 刷新后：采样器状态清零，只能靠 used 回放重建
  samplerReset('', 0);
  const used2 = used.slice();
  let allUniq = true, got = 0;
  for (let i = 0; i < total - 8; i++){
    const c = pickCombo(slots, tpl, used2, true);
    if (!c){ allUniq = false; break; }
    if (used2.includes(c.key)){ allUniq = false; break; }
    used2.push(c.key); got++;
  }
  ok(`续跑后共 ${total} 张全不重复`, allUniq && got === total - 8 && new Set(used2).size === total,
     `续抽 ${got}，唯一 ${new Set(used2).size}`);
  ok('续跑结束后再抽返回 null', pickCombo(slots, tpl, used2, true) === null);
}

console.log('\n=== 4. 索引编解码自洽 ===');
{
  let okAll = true;
  for (let k = 0; k < total; k++){
    if (keyToLinear(decodeIdxs(k, pools).join('|'), pools) !== k){ okAll = false; break; }
  }
  ok(`decodeIdxs 与 keyToLinear 互逆（全部 ${total} 个）`, okAll);
  ok('非法键 → -1',
     keyToLinear('9|9|9', pools) === -1 &&
     keyToLinear('1|2', pools) === -1 &&
     keyToLinear('a|b|c', pools) === -1 &&
     keyToLinear('-1|0|0', pools) === -1);
}

console.log('\n=== 5. 与旧全量枚举实现语义等价（小空间穷举对比）===');
{
  function pickComboOld(p, usedSet){
    const n = p.reduce((a, x) => a * x.length, 1);
    const free = [];
    for (let k = 0; k < n; k++){
      let rem = k; const idxs = [];
      for (const x of p){ idxs.push(rem % x.length); rem = Math.floor(rem / x.length); }
      if (!usedSet.has(idxs.join('|'))) free.push(idxs.join('|'));
    }
    if (!free.length) return null;
    return free[Math.floor(Math.random() * free.length)];
  }
  const p2 = [['a0','a1','a2'], ['b0','b1']];        // 6 组合
  const s2 = [{ name: 'a', values: p2[0] }, { name: 'b', values: p2[1] }];
  const t2 = '{{a}}{{b}}';

  let newOk = true, oldOk = true;
  for (let r = 0; r < 500; r++){
    const usedN = [], usedSetO = new Set();
    for (let i = 0; i < 6; i++){
      const cn = pickCombo(s2, t2, usedN, true);
      if (!cn || usedN.includes(cn.key)){ newOk = false; break; }
      usedN.push(cn.key);
      const co = pickComboOld(p2, usedSetO);
      if (!co || usedSetO.has(co)){ oldOk = false; break; }
      usedSetO.add(co);
    }
    if (new Set(usedN).size !== 6 || usedSetO.size !== 6){ newOk = false; oldOk = false; break; }
  }
  ok('新实现 500 轮 × 抽满 6 张均恰好覆盖', newOk);
  ok('旧实现 500 轮 × 抽满 6 张均恰好覆盖（对照组）', oldOk);
}

console.log('\n=== 6. 稀疏交换位的内存与性能（核心诉求）===');
{
  const big = [
    { name: 'a', values: Array.from({ length: 200 }, (_, i) => 'a' + i) },
    { name: 'b', values: Array.from({ length: 200 }, (_, i) => 'b' + i) },
    { name: 'c', values: Array.from({ length: 200 }, (_, i) => 'c' + i) }
  ];
  const tplBig = '{{a}}{{b}}{{c}}';   // 8,000,000
  ok('组合数 = 800 万', comboCount(big, tplBig) === 8000000);

  const used = [];
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) used.push(pickCombo(big, tplBig, used, true).key);
  const dt = performance.now() - t0;
  ok('800 万空间连抽 200 张全不重复', new Set(used).size === 200);
  ok(`200 张耗时 < 100ms（实测 ${dt.toFixed(1)}ms）`, dt < 100, dt.toFixed(1) + 'ms');
  ok(`交换位稀疏（Map 规模 ${LAZY_SAMPLER.at.size} ≪ 空间 8000000）`,
     LAZY_SAMPLER.at.size <= 2 * 200 + 2, 'at.size = ' + LAZY_SAMPLER.at.size);
}

console.log('\n=== 7. 单值数组 / 极小空间边界 ===');
{
  const one = [{ name: 'x', values: ['唯一'] }];
  const c1 = pickCombo(one, '{{x}}', [], true);
  ok('单值数组第 1 张可用', c1 && c1.map.x === '唯一');
  ok('单值数组第 2 张返回 null', pickCombo(one, '{{x}}', [c1.key], true) === null);

  // 2 组合空间：samplerDraw 直接驱动，验证 j 的范围与去重
  samplerReset('t', 2);
  const seen = [samplerDraw(), samplerDraw()];
  ok('极小空间抽满 2 个不重复', new Set(seen).size === 2, seen.join(','));
  ok('极小空间抽尽后返回 -1', samplerDraw() === -1);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);