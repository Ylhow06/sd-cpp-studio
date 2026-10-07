/**
 * 主图放大（灯箱）+ 舞台显示不全修复 —— 行为测试
 * 运行：node _test-lightbox.mjs
 *
 * jsdom 不做真实布局，所以「图有没有被裁」用两条证据交叉验证：
 *   A) CSS 约束：竖图不能只靠 max-height:100% 限高（要 flex 收缩链）
 *   B) 行为：灯箱能打开、缩放、平移、关闭，且 Esc 不会误取消生成任务
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/* ★ 路径定位：本文件在 <root>\tests\ 下，UI 在 <root>\app\ui\ 下。
   用 import.meta.url 推导，因此从任何工作目录执行都能找到文件。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const UI_DIR = path.join(ROOT, 'app', 'ui');
const UI_HTML = path.join(UI_DIR, 'index.html');
const UI_CFG = path.join(UI_DIR, 'config.json');
const CFG_SERVICE = path.join(ROOT, 'config-service', 'serve-config.mjs');

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(process.env.TEMP + '/sdjsdom/node_modules/jsdom');

let pass = 0, fail = 0;
const bad = [];
function ok(n){ pass++; }
function no(n, d){ fail++; bad.push(n + (d ? ': ' + d : '')); console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
function chk(n, c, d){ c ? ok(n) : no(n, d); }

const html = fs.readFileSync(UI_HTML, 'utf8');

/* ───────── A. CSS 证据 ───────── */
const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));

function ruleBody(sel){
  const re = new RegExp('(?:^|[},])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
  const m = style.match(re);
  return m ? m[1] : '';
}

console.log('\n=== A. 主图自适应（CSS）===');
/* 第三版方案：图片脱离内容流。
   #imgWrap 绝对定位铺满 #stage 的内边距框，img 用 inset:0 + object-fit:contain。
   这样宽高都是「相对定位祖先的确定尺寸」，百分比必然可解析——
   横图竖图都严格等比缩放居中，永远不裁切。

   前两版为什么不行（都试过、都没解决）：
     v1 max-height:100% on block 子元素 → 父级无确定高度，百分比失效
     v2 flex 容器 + min-height:0        → 那只管「能否缩小」，不管「百分比基准」 */
const stage = ruleBody('#stage');
const wrap = ruleBody('#imgWrap');
const wrapShow = ruleBody('#imgWrap.show');
const imgRule = ruleBody('#imgWrap img');

chk('#stage 是 relative（给绝对定位的图片当基准）', /position\s*:\s*relative/.test(stage), stage);
chk('#stage 有 overflow:hidden', /overflow\s*:\s*hidden/.test(stage));
chk('#stage 有 min-height:0（能在 flex 列里收缩）', /min-height\s*:\s*0/.test(stage));

chk('★ #imgWrap 用绝对定位铺满舞台内边距框', /position\s*:\s*absolute/.test(wrap), wrap);
chk('★ #imgWrap 用 inset 给出确定尺寸', /inset\s*:/.test(wrap), wrap);
chk('★ #imgWrap 的 inset 与 #stage 的 padding 对齐',
    /inset\s*:\s*12px\s+20px/.test(wrap) && /padding\s*:\s*12px\s+20px/.test(stage),
    '#stage padding=' + (/padding\s*:\s*([^;}]+)/.exec(stage) || [])[1] + ' / #imgWrap ' + wrap);

chk('★ #imgWrap img 用绝对定位填满容器', /position\s*:\s*absolute/.test(imgRule), imgRule);
chk('★ 图片用 inset:0 拿到确定的宽高', /inset\s*:\s*0/.test(imgRule));
chk('★ 图片用 w/h 100% + object-fit:contain 等比缩放', /object-fit\s*:\s*contain/.test(imgRule));
chk('★ 图片用 object-position:center 居中', /object-position\s*:\s*center/.test(imgRule));

{ // 关键回归：不能再退回「靠内容撑高」的老路
  const usesPercentMax = /max-height\s*:\s*100%/.test(imgRule);
  chk('★ 不再依赖图片的 max-height:100%（那正是失效的原因）', !usesPercentMax,
      usesPercentMax ? '还在用百分比高度，竖图会被撑开裁掉' : '');
}

console.log('\n=== A2. 蒙版画布对齐 ===');
const maskRule = ruleBody('#maskLayer');
chk('蒙版是绝对定位', /position\s*:\s*absolute/.test(maskRule), maskRule);
chk('蒙版不再用 inset:0 硬铺满（那会与 contain 留白错位）', !/inset\s*:\s*0/.test(maskRule), maskRule);
chk('syncMaskLayerToImage 已定义', /function syncMaskLayerToImage\s*\(/.test(html));
chk('刷新主图时会调用对齐', /showImg[\s\S]{0,160}syncMaskLayerToImage\(\)/.test(html));
chk('窗口 resize 时会重新对齐', /addEventListener\('resize'[\s\S]{0,80}syncMaskLayerToImage/.test(html));

console.log('\n=== A3. 主图可点击 ===');
chk('#imgWrap img 有 zoom-in 光标', /cursor\s*:\s*zoom-in/.test(imgRule));

/* ───────── B. 行为（jsdom）───────── */
console.log('\n=== B. 灯箱行为 ===');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:9/',
});
const w = dom.window;

// 阻断真实网络：把 fetch 换掉，让 boot 走失败分支（不影响灯箱逻辑）
w.fetch = async () => { throw new Error('offline'); };

await new Promise(r => setTimeout(r, 300));
const $ = s => w.document.querySelector(s);

chk('灯箱元素存在', !!$('#lightbox'));
chk('灯箱初始隐藏', !$('#lightbox').classList.contains('show'));

// 造一张假图放进 S.cur —— 必须在页面 realm 里操作
function setCur(w2, ww, hh, seed){
  w2.eval(`(function(){
    S.cur = {b64:'AAAA', w:${ww}, h:${hh}, seed:${seed}, mode:'txt2img'};
  })()`);
}
setCur(w, 512, 768, 12345);

// 点主图 → 打开
$('#img').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk('点主图后灯箱打开', $('#lightbox').classList.contains('show'));
chk('灯箱大图有 src', ($('#lbImg').getAttribute('src') || '').startsWith('data:image/png;base64,'));

// jsdom 里 naturalWidth 恒为 0，手工造一个尺寸再测缩放数学
w.eval("Object.defineProperty(document.querySelector('#lbImg'),'naturalWidth',{value:512,configurable:true});" +
       "Object.defineProperty(document.querySelector('#lbImg'),'naturalHeight',{value:768,configurable:true});");
w.eval('lbFit()');
const fitScale = w.eval('LB.fit');
chk('适应缩放是个有效数值', Number.isFinite(fitScale) && fitScale > 0, String(fitScale));
chk('适应缩放不会把图放大超过 100%', fitScale <= 1.0001, String(fitScale));

// 放大
w.eval('lbZoomAt(0,0,2)');
const z2 = w.eval('LB.scale');
chk('放大后 scale 变大', z2 > fitScale, z2 + ' vs ' + fitScale);

// 以光标为锚点：缩放后锚点位置应保持
w.eval('LB.x=0;LB.y=0;LB.scale=1;lbZoomAt(100,50,2)');
const ax = w.eval('LB.x'), ay = w.eval('LB.y');
chk('以光标为锚点缩放（x 有补偿）', Math.abs(ax - (-100)) < 0.01, String(ax));
chk('以光标为锚点缩放（y 有补偿）', Math.abs(ay - (-50)) < 0.01, String(ay));

// 上限：不能无限放大
w.eval('LB.scale=LB.fit*39;lbZoomAt(0,0,2)');
const capped = w.eval('LB.scale');
chk('放大有上限（≤ 适应值 40 倍）', capped <= w.eval('LB.fit') * 40 + 0.001, String(capped));

// 下限
w.eval('lbZoomAt(0,0,0.0001)');
chk('缩小有下限（≥ 适应值 0.2 倍）', w.eval('LB.scale') >= w.eval('LB.fit') * 0.2 - 0.001, String(w.eval('LB.scale')));

// 百分比显示
w.eval('LB.scale=1;LB.fit=1;lbApply()');
chk('显示 100% 正确', $('#lbInfo').textContent === '100%', $('#lbInfo').textContent);
w.eval('LB.scale=0.5;lbApply()');
chk('显示 50% 正确', $('#lbInfo').textContent === '50%', $('#lbInfo').textContent);

// 1:1 按钮
$('#lbFull').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk('「1:1」把 scale 设为 1', Math.abs(w.eval('LB.scale') - 1) < 1e-9, String(w.eval('LB.scale')));

// 适应按钮
$('#lbFit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk('「适应」回到 fit', Math.abs(w.eval('LB.scale') - w.eval('LB.fit')) < 1e-9);

// 关闭按钮
$('#lbClose').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk('点关闭后灯箱隐藏', !$('#lightbox').classList.contains('show'));
chk('关闭后释放大图 src', !$('#lbImg').getAttribute('src'), $('#lbImg').getAttribute('src') || '');

// Esc 关闭，且不误取消任务
console.log('\n=== B2. Esc 优先级 ===');
setCur(w, 512, 768, 1);
$('#img').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk('重新打开成功', $('#lightbox').classList.contains('show'));

let cancelled = 0;
w.eval('window.__origCancel = cancelJob; cancelJob = function(){ window.__cancelled = true; };');
w.eval('S.busy = true');   // 假装正在生成

w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
chk('★ Esc 关掉了灯箱', !$('#lightbox').classList.contains('show'));
chk('★ Esc 没有顺手取消正在跑的任务', w.eval('!window.__cancelled'));

// 灯箱关着时 Esc 仍能取消任务
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
chk('灯箱关着时 Esc 正常取消任务', w.eval('!!window.__cancelled'));

// 背景点击关闭
console.log('\n=== B3. 点背景关闭 ===');
setCur(w, 512, 768, 2);
$('#img').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
chk('打开', $('#lightbox').classList.contains('show'));
$('#lightbox').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
chk('点背景关闭', !$('#lightbox').classList.contains('show'));

// 拖动平移
console.log('\n=== B4. 拖动平移 ===');
setCur(w, 512, 768, 3);
$('#img').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
w.eval('LB.x=0;LB.y=0');
$('#lbImg').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 200 }));
chk('按下后进入拖动状态', w.eval('!!LB.drag'));
w.dispatchEvent(new w.MouseEvent('mousemove', { clientX: 260, clientY: 230, bubbles: true }));
chk('拖动改变了 x', w.eval('LB.x') !== 0, String(w.eval('LB.x')));
chk('拖动改变了 y', w.eval('LB.y') !== 0, String(w.eval('LB.y')));
w.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
chk('松开后退出拖动状态', !w.eval('LB.drag'));

// 缩略图双击
console.log('\n=== B5. 缩略图双击放大 ===');
chk('bindThumbZoom 已定义', typeof w.eval('typeof bindThumbZoom') === 'string' && w.eval('typeof bindThumbZoom') === 'function');
chk('openLightbox 已定义', w.eval('typeof openLightbox') === 'function');
setCur(w, 0, 0, 0);
w.eval("S.cur=null");
w.eval("openLightbox('BBBB','512×768 · seed 9')");
chk('可直接用 item 打开', $('#lightbox').classList.contains('show'));
chk('元信息正确写入', ($('#lbMeta').textContent || '').includes('seed 9'), $('#lbMeta').textContent);

// 无图时点主图不应崩
w.eval('closeLightbox(); S.cur=null;');
let threw = false;
try { $('#img').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); } catch (e){ threw = true; }
chk('没有图时点主图不报错', !threw);
chk('没有图时灯箱保持关闭', !$('#lightbox').classList.contains('show'));

// 无未过滤异常
const errs = w.__errs || [];

console.log(`\n${'─'.repeat(46)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (bad.length){ console.log('\n问题：'); bad.forEach(b => console.log('  · ' + b)); }
process.exit(fail ? 1 : 0);
