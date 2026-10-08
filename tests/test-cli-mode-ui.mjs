/* ══════════════════════════════════════════════════════════════
   终端运行：继续/开新批 的 UI 探测与下发
   ──────────────────────────────────────────────────────────────
   覆盖这次改动：
    A. cliDetect 发现未完成批次 → 按钮变「继续未完成批次」、mode=resume
    B. 无批次记录 → 按钮保持「在终端运行这一批」、mode=new
    C. cliRun(new) 下发 job.mode='new'；cliRun(resume) 下发 job.mode='resume'
   ══════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const UI_HTML = path.join(ROOT, 'app', 'ui', 'index.html');
const { JSDOM, VirtualConsole } = await import(
  'file:///' + process.env.TEMP.replace(/\\/g, '/') + '/sdjsdom/node_modules/jsdom/lib/api.js'
);

const html = fs.readFileSync(UI_HTML, 'utf8');
const vc = new VirtualConsole();
const jsErrors = [];
vc.on('jsdomError', e => {
  const m = e.message || String(e);
  if (!/Not implemented|indexedDB|canvas|ECONNREFUSED|fetch/i.test(m)) jsErrors.push(m);
});

const stubCtx = {
  canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1,
  globalCompositeOperation: 'source-over', lineCap: 'round', lineJoin: 'round',
  clearRect(){}, fillRect(){}, strokeRect(){}, beginPath(){}, closePath(){},
  moveTo(){}, lineTo(){}, arc(){}, rect(){}, fill(){}, stroke(){}, clip(){},
  save(){}, restore(){}, translate(){}, scale(){}, rotate(){}, setTransform(){},
  drawImage(){}, getImageData(){ return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; },
  putImageData(){}, createImageData(){ return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; },
  createLinearGradient(){ return { addColorStop(){} }; },
  createRadialGradient(){ return { addColorStop(){} }; },
  measureText(){ return { width: 0 }; }, fillText(){}, strokeText(){}
};

/* 可切换的 fetch stub：记录 /run-cli 请求体，按当前 state 响应 /run-cli/state */
let stateBatch = null;          // 传给 /run-cli/state 的 batch 内容（null=无批次）
let cliPostBody = null;         // 最近一次 POST /run-cli 的 body
const fetchCalls = [];
const stateHandler = (url, opts) => {
  fetchCalls.push(String(url));
  if (String(url).includes('/run-cli/state')){
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, batch: stateBatch })
    });
  }
  if (String(url).includes('/run-cli') && opts && opts.method === 'POST'){
    cliPostBody = JSON.parse(opts.body);
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, jobFile: 'C:/j/job.json', pid: 123 })
    });
  }
  // 其它路由统统挂起，不影响
  return new Promise(() => {});
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:17341/',
  virtualConsole: vc,
  beforeParse(w){
    w.alert = m => { w.__alerted = m; };
    w.confirm = () => true;
    w.indexedDB = { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror({}), 0); return r; } };
    w.URL.createObjectURL = () => 'blob:stub';
    w.URL.revokeObjectURL = () => {};
    w.showDirectoryPicker = async () => ({ name: 'LocalModel', requestPermission: async () => 'granted' });
    w.fetch = stateHandler;
    const orig = w.HTMLCanvasElement.prototype.getContext;
    w.HTMLCanvasElement.prototype.getContext = function(type, ...a){
      if (type === '2d'){ stubCtx.canvas = this; return stubCtx; }
      try { return orig.call(this, type, ...a); } catch (_) { return null; }
    };
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
    w.HTMLCanvasElement.prototype.toBlob = cb => setTimeout(() => cb(new w.Blob([], { type: 'image/png' })), 0);
  }
});
const w = dom.window;
const $ = s => w.document.querySelector(s);
const $$ = s => w.document.querySelectorAll(s);

// 设置真实保存目录，让 cliDetect 能走 fetch
w.eval(`(function(){ DIR.realPath = 'C:/pics/node'; DIR.serverOk = true; })()`);

// 用当前页面的 templateHash 造一个「匹配」的未完成批次
const curHash = w.eval('templateHash(S.m.batch.template, S.m.batch.slots)');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? ' → ' + e : ''))); };
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n=== A. 探测到未完成批次 → 主按钮「继续」+ 出现「开新批次」===');
async function a(){
  stateBatch = { stamp: '20261008_1', done: 1, count: 3, finished: false, resumable: true, hasSnapshot: true, templateHash: curHash };
  await w.eval('cliDetect()');
  await wait(30);
  const btn = $('#cliRun');
  const newBtn = $('#cliRunNew');
  ok('主按钮文案「继续（1/3）」', btn.textContent.includes('继续（1/3）'), btn.textContent);
  ok('主按钮 mode=resume', btn.dataset.mode === 'resume', btn.dataset.mode);
  ok('出现「开新批次」按钮', newBtn && newBtn.style.display !== 'none', 'display=' + (newBtn && newBtn.style.display));
  const st = $('#cliStat').textContent || '';
  ok('状态条提示（1/3）', st.includes('1/3'), st);
}
await a();

console.log('\n=== B. 无批次记录 → 主按钮「开新批」、无「开新批次」按钮 ===');
async function b(){
  stateBatch = null;
  await w.eval('cliDetect()');
  await wait(30);
  const btn = $('#cliRun');
  const newBtn = $('#cliRunNew');
  ok('主按钮「在终端运行这一批」', btn.textContent.includes('在终端运行这一批'), btn.textContent);
  ok('主按钮 mode=new', btn.dataset.mode === 'new', btn.dataset.mode);
  ok('无「开新批次」按钮', newBtn && newBtn.style.display === 'none', 'display=' + (newBtn && newBtn.style.display));
}
await b();

console.log('\n=== C. 按钮接线：dataset.mode 决定 cliRun 参数 ===');
async function c(){
  // 在裸 jsdom 里 buildCliJob 无法通过 DOM 校验（无实际输入值），
  // 所以这里不测完整下发，只测「接线」参数。
  const wiring = w.eval(`(function(){
    const cr = document.getElementById('cliRun');
    const cn = document.getElementById('cliRunNew');
    const orig = cliRun;
    let log = [];
    cliRun = function(mode){ log.push({ mode }); return Promise.resolve(); };
    // 主按钮
    cr.dataset.mode = 'new'; cr.onclick();
    cr.dataset.mode = 'resume'; cr.onclick();
    // 开新批次按钮（永远 new）
    cn.onclick();
    cliRun = orig;
    return JSON.stringify(log);
  })()`);
  const log = JSON.parse(wiring);
  ok('主按钮 mode=new → cliRun("new")', log[0] && log[0].mode === 'new', wiring);
  ok('主按钮 mode=resume → cliRun("resume")', log[1] && log[1].mode === 'resume', wiring);
  ok('「开新批次」按钮 → cliRun("new")', log[2] && log[2].mode === 'new', wiring);
}
await c();

console.log('\n=== D. 已完成的批次 → 不显示「继续」，状态条提示已完成 ===');
async function d(){
  stateBatch = { stamp: '20261008_1', done: 3, count: 3, finished: true, resumable: false, hasSnapshot: true, templateHash: curHash };
  await w.eval('cliDetect()');
  await wait(30);
  const btn = $('#cliRun');
  const newBtn = $('#cliRunNew');
  ok('主按钮保持「在终端运行这一批」', !btn.textContent.includes('继续'), btn.textContent);
  ok('主按钮 mode=new', btn.dataset.mode === 'new', btn.dataset.mode);
  ok('无「开新批次」按钮', newBtn && newBtn.style.display === 'none', 'display=' + (newBtn && newBtn.style.display));
  const st = $('#cliStat').textContent || '';
  ok('状态条提示已完成', st.includes('已完成'), st);
}
await d();

console.log('\n=== E. 旧版进度（无快照）→ 不显示「继续」，提示无法续 ===');
async function e(){
  stateBatch = { stamp: 'legacy', done: 1, count: 3, finished: false, resumable: false, hasSnapshot: false, templateHash: 'x' };
  await w.eval('cliDetect()');
  await wait(30);
  const btn = $('#cliRun');
  ok('无快照时主按钮不显示「继续」', !btn.textContent.includes('继续'), btn.textContent);
  ok('主按钮 mode=new', btn.dataset.mode === 'new', btn.dataset.mode);
  const st = $('#cliStat').textContent || '';
  ok('状态条提示无法续/开新', st.includes('无法续') || st.includes('开新批次'), st);
}
await e();

if (jsErrors.length){
  console.log('\n[jsdom 报错]');
  jsErrors.slice(0, 8).forEach(e => console.log('  ' + e));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
