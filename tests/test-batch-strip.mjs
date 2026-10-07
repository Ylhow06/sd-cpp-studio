/* ══════════════════════════════════════════════════════════════
   本批缩略图条：点击渲染 + 折叠
   ──────────────────────────────────────────────────────────────
   覆盖两个用户报的问题：
   S. 点本批缩略图必须把图渲染到上方主舞台（之前只改了 S.cur 没刷新）
   T. 本批 / 历史两条都要能折叠，折叠后只留表头
   ══════════════════════════════════════════════════════════════ */
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
    w.fetch = () => new Promise(() => {});   // 配置服务挂起，不影响本测试
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

const ok = [], fail = [];
const chk = (c, m) => (c ? ok.push(m) : fail.push(m));

// 造 3 张假图，直接塞进 S.batch 并渲染缩略图条
w.eval(`
  (function(){
    S.batch = [1,2,3].map(i => ({
      b64: 'IMG' + i, w: 512, h: 768, seed: 1000 + i
    }));
    S.cur = null;
    renderBatchStrip();
  })();
`);

const $$ = s => w.document.querySelectorAll(s);
const $  = s => w.document.querySelector(s);

console.log('=== S. 点本批缩略图渲染到主舞台 ===');
const imgs = $$('#batchStrip img');
chk(imgs.length === 3, `缩略图条渲染出 3 张（实际 ${imgs.length}）`);
chk($('#batchWrap').classList.contains('show'), '本批容器显示');

const stageImg = () => ($('#img').src || '');
const wrapShown = () => $('#imgWrap').classList.contains('show');

chk(!wrapShown(), '初始时主舞台还没显示图（S.cur 为 null）');

// 点第 2 张
imgs[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk(wrapShown(), '★ 点缩略图后主舞台显示出来');
chk(stageImg().includes('IMG2'), `★ 主舞台换成第 2 张（实际 src 含 ${stageImg().slice(-8)}）`);
// S 是 const，不在 window 上，只能通过页面作用域取
const curOf = () => w.eval('(S.cur && S.cur.b64) || ""');
chk(curOf() === 'IMG2', 'S.cur 指向第 2 张');
chk(!$('#dl').disabled, '点选后「当前」下载按钮解禁');
chk(/第 2\/3 张/.test($('#meta').textContent), `meta 显示第 2/3 张（实际「${$('#meta').textContent}」）`);
chk(imgs[1].classList.contains('sel'), '第 2 张被标为选中');
chk(!imgs[0].classList.contains('sel') && !imgs[2].classList.contains('sel'), '其余张取消选中');

// 再点第 3 张，主图必须跟着换
imgs[2].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk(stageImg().includes('IMG3'), '★ 再点第 3 张，主舞台继续跟随');
chk(!stageImg().includes('IMG2'), '★ 主舞台不会停留在旧图');

// 再点回第 1 张
imgs[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk(stageImg().includes('IMG1'), '★ 点回第 1 张也正确');
chk(/第 1\/3 张/.test($('#meta').textContent), 'meta 同步回第 1/3 张');

// 图生图模式下点缩略图 → 应变成输入图
console.log('\n=== S2. 图生图模式下点缩略图设为输入图 ===');
w.eval(`S.mode = 'img2img';`);
imgs[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const st = w.eval(`JSON.stringify({ hasInput: !!(S.m.img2img.input && S.m.img2img.input.b64), b64: S.m.img2img.input && S.m.img2img.input.b64 })`);
chk(/"hasInput":true/.test(st), '★ 图生图模式下点缩略图设为了输入图');
chk(/IMG2/.test(st), '输入图内容为被点的那张');
w.eval(`S.mode = 'txt2img';`);

console.log('\n=== T. 折叠 ===');
// 回到文生图并重建
w.eval(`renderBatchStrip(); renderHist();`);

chk(!$('#batchWrap').classList.contains('folded'), '本批默认展开');
chk(!$('#histWrap').classList.contains('folded'), '历史默认展开');
chk($('#batchFold').textContent.trim() === '▾', '本批折叠按钮初始为 ▾');

// 折本批
$('#batchFold').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk($('#batchWrap').classList.contains('folded'), '★ 点一下本批折叠');
chk($('#batchFold').textContent.trim() === '▸', '★ 本批按钮变成 ▸');
chk(!$('#histWrap').classList.contains('folded'), '★ 折本批不影响历史');
chk($('#batchWrap').classList.contains('show'), '折叠后容器仍在（只是内容收起）');
const bs = w.getComputedStyle($('#batchStrip'));
chk(bs.display === 'none', `★ 折叠后缩略图条 display:none（实际 ${bs.display}）`);

// 展开回来
$('#batchFold').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk(!$('#batchWrap').classList.contains('folded'), '★ 再点一下展开');
chk(w.getComputedStyle($('#batchStrip')).display === 'flex', '★ 展开后恢复 flex');

// 折历史
$('#histFold').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk($('#histWrap').classList.contains('folded'), '★ 历史可独立折叠');
chk(!$('#batchWrap').classList.contains('folded'), '★ 折历史不影响本批');
chk(w.getComputedStyle($('#hist')).display === 'none', '历史列表 display:none');

// 两条同时折
$('#batchFold').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk($('#batchWrap').classList.contains('folded') && $('#histWrap').classList.contains('folded'), '★ 两条可同时折叠');

console.log('\n=== T2. 折叠状态在重渲染后保持 ===');
w.eval(`renderBatchStrip(); renderHist();`);
chk($('#batchWrap').classList.contains('folded'), '★ 重渲染本批后折叠状态保持');
chk($('#histWrap').classList.contains('folded'), '★ 重渲染历史后折叠状态保持');

console.log('\n=== T3. 表头计数 ===');
chk(/共 3 张/.test($('#batchCount').textContent), `本批表头显示张数（实际「${$('#batchCount').textContent}」）`);
chk($('#batchTitle').textContent.trim() === '本批', '本批表头标题正确');

console.log('\n=== N. 运行期 JS 异常 ===');
chk(jsErrors.length === 0, `无未过滤的 JS 异常（${jsErrors.length} 条）`);
jsErrors.forEach(e => console.log('  ! ' + e));

console.log('\n通过 ' + ok.length + ' 项：');
ok.forEach(o => console.log('  ✓ ' + o));
if (fail.length){ console.log('\n失败 ' + fail.length + ' 项：'); fail.forEach(f => console.log('  ✗ ' + f)); }
console.log('\n' + '─'.repeat(48));
console.log(fail.length ? `结果：${ok.length} 通过 / ${fail.length} 失败` : `结果：${ok.length} 通过 / 0 失败`);
process.exit(fail.length ? 1 : 0);
