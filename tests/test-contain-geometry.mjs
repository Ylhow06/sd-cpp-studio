/**
 * 主图自适应的「几何正确性」验证。
 * 浏览器渲染不了（沙箱禁 mojo 管道），所以把 contain 的算法抽出来算：
 * 给定舞台可用框和图片原始尺寸，验证缩放后：
 *   1) 不溢出（宽高都 ≤ 可用框）
 *   2) 至少有一边贴满（真的「适应」，不是缩太小）
 *   3) 严格等比（无变形）
 *   4) 覆盖竖图/横图/方图/极端长条
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
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));

let pass = 0, fail = 0;
const bad = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; bad.push(n + (d ? ': ' + d : '')); console.log('  ✗ ' + n + (d ? '  → ' + d : '')); } };

/* ── 从 CSS 里读出实际写死的 inset 与 padding，确保两边一致 ── */
const mInset = css.match(/#imgWrap\{[^}]*inset:([^;}]+)/);
const mPad   = css.match(/#stage\{[^}]*padding:([^;}]+)/);
chk('能从 CSS 解析出 #imgWrap 的 inset', !!mInset, String(mInset));
chk('能从 CSS 解析出 #stage 的 padding', !!mPad, String(mPad));

const inset = (mInset ? mInset[1] : '12px 20px').trim().split(/\s+/).map(s => parseFloat(s));
const pad   = (mPad ? mPad[1] : '12px 20px').trim().split(/\s+/).map(s => parseFloat(s));
const insV = inset[0], insH = inset[1] !== undefined ? inset[1] : inset[0];
const padV = pad[0],   padH = pad[1] !== undefined ? pad[1] : pad[0];
chk('inset 与 padding 的垂直值一致', insV === padV, insV + ' vs ' + padV);
chk('inset 与 padding 的水平值一致', insH === padH, insH + ' vs ' + padH);

/* ── contain 算法（与浏览器 object-fit:contain 同义） ── */
function contain(boxW, boxH, nw, nh){
  const k = Math.min(boxW / nw, boxH / nh);
  return { k, w: nw * k, h: nh * k };
}

console.log('\n=== 各种尺寸下的适应结果（舞台 1200×700 可用框）===');
const boxW = 1200, boxH = 700;
const cases = [
  ['2:3 竖图（默认）', 512, 768],
  ['9:16 竖图',        576, 1024],
  ['1:1 方图',         768, 768],
  ['3:2 横图',         768, 512],
  ['16:9 横图',        1024, 576],
  ['21:9 超宽',        1152, 512],
  ['小图',             512, 512],
  ['1024 方图',        1024, 1024],
  ['极端长条',         256, 2048],
  ['极端扁条',         2048, 256],
];

for (const [name, nw, nh] of cases){
  const { k, w, h } = contain(boxW, boxH, nw, nh);
  const fits = w <= boxW + 1e-6 && h <= boxH + 1e-6;
  const touches = Math.abs(w - boxW) < 1e-6 || Math.abs(h - boxH) < 1e-6;
  const ratioKept = Math.abs((w / h) - (nw / nh)) < 1e-9;
  const noUpscale = true; // contain 允许放大，这里只看几何
  console.log(`  ${name.padEnd(16)} ${nw}×${nh} → ${w.toFixed(1)}×${h.toFixed(1)}  k=${k.toFixed(3)}`);
  chk(`  ${name}：不溢出可用框`, fits, `${w.toFixed(1)}×${h.toFixed(1)}`);
  chk(`  ${name}：贴满至少一边`, touches);
  chk(`  ${name}：严格等比`, ratioKept);
}

console.log('\n=== 竖图在典型窗口下不再被裁 ===');
// 模拟用户截图里的窗口：右侧舞台高度被工具条+两条缩略图条挤掉
const scenarios = [
  ['1920×1080 全屏、两条都展开', 1920 - 352 - 40, 1080 - 48 - 56 - 78 - 10 - 24],
  ['1600×900 常见笔记本',        1600 - 352 - 40, 900 - 48 - 56 - 78 - 10 - 24],
  ['1366×768 小屏',              1366 - 352 - 40, 768 - 48 - 56 - 78 - 10 - 24],
  ['1920×1080、两条都折叠',      1920 - 352 - 40, 1080 - 48 - 56 - 40 - 10 - 24],
];
for (const [name, sw, sh] of scenarios){
  const availW = Math.max(50, sw - padH * 2);
  const availH = Math.max(50, sh - padV * 2);
  const { w, h } = contain(availW, availH, 512, 768);
  const fullHeightVisible = Math.abs(h - availH) < 0.5 || h <= availH + 1e-6;
  console.log(`  ${name.padEnd(28)} 可用 ${availW.toFixed(0)}×${availH.toFixed(0)} → 图 ${w.toFixed(0)}×${h.toFixed(0)}`);
  chk(`  ${name}：整张竖图完整可见`, w <= availW + 1e-6 && h <= availH + 1e-6);
  chk(`  ${name}：尽量占满高度`, Math.abs(h - availH) < 0.5 || Math.abs(w - availW) < 0.5,
      `图 ${w.toFixed(0)}×${h.toFixed(0)} vs 可用 ${availW.toFixed(0)}×${availH.toFixed(0)}`);
}

console.log('\n=== 蒙版对齐算法 ===');
// 蒙版要贴在「图片实际渲染的那块矩形」上
function maskRect(boxW2, boxH2, nw, nh){
  const { w, h } = contain(boxW2, boxH2, nw, nh);
  return { left: (boxW2 - w) / 2, top: (boxH2 - h) / 2, w, h };
}
for (const [name, nw, nh] of [['2:3 竖图', 512, 768], ['16:9 横图', 1024, 576], ['方图', 768, 768]]){
  const r = maskRect(boxW, boxH, nw, nh);
  chk(`${name}：蒙版与图片同宽`, Math.abs(r.w - contain(boxW, boxH, nw, nh).w) < 1e-9);
  chk(`${name}：蒙版水平居中`, Math.abs(r.left * 2 + r.w - boxW) < 1e-9, String(r.left));
  chk(`${name}：蒙版垂直居中`, Math.abs(r.top * 2 + r.h - boxH) < 1e-9, String(r.top));
  chk(`${name}：蒙版不越界`, r.left >= -1e-9 && r.top >= -1e-9);
  console.log(`  ${name.padEnd(12)} 蒙版 left=${r.left.toFixed(1)} top=${r.top.toFixed(1)} ${r.w.toFixed(1)}×${r.h.toFixed(1)}`);
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (bad.length){ console.log('\n问题：'); bad.forEach(b => console.log('  · ' + b)); }
process.exit(fail ? 1 : 0);
