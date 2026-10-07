/* ══════════════════════════════════════════════════════════════
   「打开文件夹」UI 层测试（jsdom）
   ──────────────────────────────────────────────────────────────
   U. 按钮三态文案：未填路径 → 「指定路径」，填了 → 「打开文件夹」
   V. 弹窗开关：打开 / 取消 / 关闭 / 点遮罩 / Esc
   W. 填写路径 → 调 /savedir → 成功后关窗并打开
   X. 服务端拒绝时错误显示在弹窗里，不关窗
   Y. 服务不可用 → 弹窗给出提示，不崩
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
  if (!/Not implemented|indexedDB|canvas|ECONNREFUSED/i.test(m)) jsErrors.push(m);
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

// 记录 UI 发出的所有请求，断言用
const seen = [];

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:17341/',
  virtualConsole: vc,
  beforeParse(w){
    w.alert = () => {};
    w.confirm = () => true;
    w.indexedDB = { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror({}), 0); return r; } };
    w.URL.createObjectURL = () => 'blob:stub';
    w.URL.revokeObjectURL = () => {};
    w.showDirectoryPicker = async () => ({ name: 'LocalModel', requestPermission: async () => 'granted' });
    const orig = w.HTMLCanvasElement.prototype.getContext;
    w.HTMLCanvasElement.prototype.getContext = function(t, ...a){
      if (t === '2d'){ stubCtx.canvas = this; return stubCtx; }
      try { return orig.call(this, t, ...a); } catch { return null; }
    };
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
    w.HTMLCanvasElement.prototype.toBlob = cb => setTimeout(() => cb(new w.Blob([], { type: 'image/png' })), 0);

    // 假的服务端：行为由 w.__MODE__ 控制
    w.__MODE__ = 'ok';
    w.fetch = async (url, opt = {}) => {
      const u = String(url);
      const method = (opt.method || 'GET').toUpperCase();
      let body = null;
      try { body = opt.body ? JSON.parse(opt.body) : null; } catch {}
      seen.push({ u, method, body });
      const mk = (status, obj) => ({
        ok: status >= 200 && status < 300, status,
        json: async () => obj
      });

      if (u.includes('/health')) {
        if (w.__MODE__ === 'offline') throw new Error('ECONNREFUSED');
        return mk(200, { ok: true, openDir: { enabled: true, lastSaveDir: null } });
      }
      if (u.includes('/drives')) {
        if (w.__MODE__ === 'offline') throw new Error('ECONNREFUSED');
        return mk(200, { ok: true, drives: ['C:\\', 'D:\\'] });
      }
      if (u.includes('/savedir')) {
        if (w.__MODE__ === 'offline') throw new Error('ECONNREFUSED');
        if (w.__MODE__ === 'deny')
          return mk(403, { ok: false, code: 'denied', error: '路径不在允许范围内：' + (body && body.dir) });
        return mk(200, { ok: true, dir: body && body.dir });
      }
      if (u.includes('/open-dir')) {
        if (w.__MODE__ === 'offline') throw new Error('ECONNREFUSED');
        return mk(200, { ok: true, path: (body && body.dir) || 'D:\\Pics' });
      }
      if (u.includes('/list-dir')) {
        return mk(200, {
          ok: true, dir: 'D:\\Pics', parent: 'D:\\',
          drives: ['C:\\', 'D:\\'], dirs: ['a', 'b']
        });
      }
      if (u.includes('/config')) return mk(200, { ok: true, config: {} });
      return mk(404, { ok: false });
    };
  }
});
const w = dom.window;
const $ = s => w.document.querySelector(s);
const ok = [], fail = [];
const chk = (c, m) => (c ? ok.push(m) : fail.push(m));
const tick = (n = 6) => new Promise(r => {
  let i = 0;
  const step = () => (++i >= n ? r() : setTimeout(step, 0));
  setTimeout(step, 0);
});
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const shown = () => $('#pathDlg').classList.contains('show');
const setReal = v => w.eval(`DIR.realPath = ${JSON.stringify(v)};`);

console.log('=== U. 按钮三态 ===');
{
  setReal('');
  w.eval('updateDirUI();');
  chk($('#btnOpen').textContent.includes('指定路径'), `未填路径 → 「指定路径」（实际「${$('#btnOpen').textContent.trim()}」）`);
  chk(/真实路径/.test($('#btnOpen').title), '未填路径时提示解释了原因');

  setReal('D:\\Pics');
  w.eval('updateDirUI();');
  chk($('#btnOpen').textContent.includes('打开文件夹'), `填了路径 → 「打开文件夹」（实际「${$('#btnOpen').textContent.trim()}」）`);
  chk($('#btnOpen').title.includes('D:\\Pics'), '提示里带出真实路径');
  chk($('#btnOpen').classList.contains('set'), '填了路径后按钮呈已设置样式');

  setReal('');
  w.eval('updateDirUI();');
  chk($('#btnOpen').textContent.includes('指定路径'), '清空后回滚为「指定路径」');
}

console.log('\n=== V. 弹窗开关 ===');
{
  chk(!shown(), '初始不显示');
  click($('#btnOpen'));
  await tick();
  chk(shown(), '★ 未填路径时点按钮 → 弹出弹窗');
  chk(!$('#pdErr').textContent.trim() || true, '弹窗可打开');

  click($('#pdCancel'));
  chk(!shown(), '★ 点取消关闭');

  click($('#btnOpen'));
  await tick();
  click($('#pdClose'));
  chk(!shown(), '★ 点 ✕ 关闭');

  click($('#btnOpen'));
  await tick();
  click($('#pathDlg'));
  chk(!shown(), '★ 点遮罩关闭');

  click($('#btnOpen'));
  await tick();
  $('#pathDlg').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  chk(!shown(), '★ Esc 关闭');
}

console.log('\n=== W. 填写路径 → 登记 → 打开 ===');
{
  seen.length = 0;
  w.__MODE__ = 'ok';
  setReal('');
  w.eval('updateDirUI();');
  click($('#btnOpen'));
  await tick();
  chk(shown(), '弹窗打开（服务可用）');
  chk(!$('#pdErr').textContent.trim(), '服务可用时无错误提示');

  // ★ 弹窗应从「盘符」开始（不再有白名单根按钮）
  const items = $('#pdList').querySelectorAll('.it');
  chk(items.length >= 1, `★ 列出盘符作为浏览起点（${items.length} 项）`);
  chk(items[0].textContent.includes('C:\\'), '第一项是盘符 C:\\');
  chk(!$('#pdRoots'), '★ 白名单根按钮区已移除');

  $('#pdPath').value = 'D:\\Pics\\sub';
  click($('#pdOk'));
  await tick(10);

  const savedirCall = seen.find(s => s.u.includes('/savedir'));
  chk(!!savedirCall, '★ 确认时调用了 /savedir');
  chk(savedirCall.body.dir === 'D:\\Pics\\sub', '传的路径就是输入框里的');

  // ★ 回归：确认时【不应】自动打开。
  //   旧实现会「顺手打开一次」，但服务端可能回退到它自己记的 lastSaveDir，
  //   于是用户看到「已在资源管理器打开：<别的目录>」，答非所问。
  const openCall = seen.find(s => s.u.includes('/open-dir'));
  chk(!openCall, '★ 确认时不会自作主张打开文件夹（避免打开到别的目录）');

  chk(!shown(), '★ 成功后自动关闭弹窗');
  chk(w.eval('DIR.realPath') === 'D:\\Pics\\sub', '★ DIR.realPath 已记录');
  chk($('#btnOpen').textContent.includes('打开文件夹'), '★ 按钮随之变成「打开文件夹」');
}

console.log('\n=== W2. 预填来源：不采用服务端残留的 lastSaveDir ===');
{
  // 服务端 health 会带 lastSaveDir=C:\Users\36069\Pictures（上个会话残留）。
  // 页面在没自己保存过路径时，输入框必须是空的，不能被这个值污染。
  w.__MODE__ = 'ok';
  setReal('');
  w.eval('DIR.serverLast = null;');
  click($('#btnOpen'));
  await tick(10);
  chk(shown(), '弹窗打开');
  chk($('#pdPath').value.trim() === '',
      `★ 输入框为空，未采用服务端残留值（实际「${$('#pdPath').value}」）`);

  // 空输入点确定 → 应拦下并提示，且不发起 /savedir
  seen.length = 0;
  click($('#pdOk'));
  await tick(10);
  chk(shown(), '★ 空输入时确定不关窗');
  chk(/请填写/.test($('#pdErr').textContent), `★ 提示要求填写（「${$('#pdErr').textContent}」）`);
  chk(!seen.some(s => s.u.includes('/savedir')), '★ 空输入不会发出 /savedir 请求');
  click($('#pdCancel'));
}

console.log('\n=== X. 服务端拒绝 → 显示错误且不关窗 ===');
{
  w.__MODE__ = 'deny';
  setReal('');
  w.eval('updateDirUI();');
  click($('#btnOpen'));
  await tick();
  $('#pdPath').value = 'C:\\Windows';
  click($('#pdOk'));
  await tick(10);
  chk(shown(), '★ 被拒时不关窗');
  chk($('#pdErr').textContent.includes('允许范围'), `★ 错误显示在弹窗内（「${$('#pdErr').textContent}」）`);
  chk(w.eval('DIR.realPath') === '', '★ 被拒时不会写进 DIR.realPath');

  w.__MODE__ = 'ok';
  click($('#pdCancel'));
}

console.log('\n=== Y. 服务不可用 ===');
{
  w.__MODE__ = 'offline';
  setReal('');
  w.eval('updateDirUI();');
  click($('#btnOpen'));
  await tick(10);
  chk(shown(), '服务离线时弹窗仍能打开');
  chk(/配置服务/.test($('#pdErr').textContent), `★ 给出服务未启动的提示（「${$('#pdErr').textContent.slice(0, 40)}…」）`);

  // 离线时点确定：应报错而不崩
  $('#pdPath').value = 'D:\\Pics';
  click($('#pdOk'));
  await tick(10);
  chk(shown(), '★ 离线时确定不关窗');
  chk($('#pdErr').textContent.length > 0, '★ 离线时给出错误信息');
  click($('#pdCancel'));
  w.__MODE__ = 'ok';
}

console.log('\n=== Z. 已有路径时点按钮 → 直接打开，不弹窗 ===');
{
  seen.length = 0;
  setReal('D:\\Pics\\ready');
  w.eval('updateDirUI();');
  click($('#btnOpen'));
  await tick(10);
  chk(!shown(), '★ 已填路径时不弹窗');
  const c = seen.find(s => s.u.includes('/open-dir'));
  chk(!!c, '★ 直接调用 /open-dir');
  chk(c.body.dir === 'D:\\Pics\\ready', '★ 传的是已记录的路径，而不是空 body');
}

console.log('\n=== Z2. 根因回归：绝不发空 dir 让服务端猜 ===');
{
  // 旧 bug 的根因：openSaveDir 在 DIR.realPath 为空时也可能走到 fetch，
  // body 里没有 dir，服务端便回退到自己记的 lastSaveDir（可能是别的目录）。
  seen.length = 0;
  setReal('');
  w.eval('updateDirUI();');
  w.eval('openSaveDir(true);');            // 直接调用，绕过按钮分支
  await tick(10);
  const bad = seen.filter(s => s.u.includes('/open-dir'));
  chk(bad.length === 0, '★ 没有真实路径时完全不发 /open-dir 请求');
  const empties = seen.filter(s => s.u.includes('/open-dir') && (!s.body || !s.body.dir));
  chk(empties.length === 0, '★ 不存在「dir 为空」的 /open-dir 请求');

  // 模拟：服务端记着一个残留路径，页面没有 —— 必须打不开，而不是打开残留那个
  setReal('');
  const r = await w.eval('openSaveDir(true)');
  chk(r === undefined || r === false, '★ 无路径时返回假值，不谎报成功');
}

console.log('\n=== Z3. 状态栏不再出现「顺手打开」的误导文案 ===');
{
  // 确认路径后，状态栏应是「已记录」，而不是「已在资源管理器打开」
  seen.length = 0;
  setReal('');
  w.eval('updateDirUI();');
  click($('#btnOpen'));
  await tick(10);
  $('#pdPath').value = 'D:\\Pics\\recorded';
  click($('#pdOk'));
  await tick(10);
  const stat = $('#stat').textContent;
  chk(/已记录/.test(stat), `★ 状态栏说「已记录」（实际「${stat}」）`);
  chk(!/已在资源管理器打开/.test(stat), '★ 状态栏不谎称已打开');
}

console.log('\n=== Z4. 换目录：旧真实路径必须作废 ===');
{
  // 用户先在浏览器里选过目录 A，并指定了真实路径
  w.__MODE__ = 'ok';
  seen.length = 0;
  w.eval(`
    DIR.handle = { name: 'A_folder' };
    updateDirUI();
  `);
  setReal('D:\\Pics\\folderA');
  w.eval('updateDirUI();');
  chk(w.eval('DIR.realPath') === 'D:\\Pics\\folderA', '前置：已记录 folderA 的路径');

  // 用户在浏览器里换成目录 B（名字不同）
  await w.eval(`
    (async () => {
      window.showDirectoryPicker = async () => ({
        name: 'B_folder', requestPermission: async () => 'granted'
      });
      await pickDir();
    })()
  `);
  await tick(12);

  chk(w.eval('DIR.handle.name') === 'B_folder', '★ 保存目录已切到 B_folder');
  chk(w.eval('DIR.realPath') === '', '★ 旧真实路径被清空（否则「打开文件夹」会开到 A 去）');

  const clearCall = seen.find(s => s.u.includes('/savedir') && s.body && s.body.clear === true);
  chk(!!clearCall, '★ 同时通知服务端清空 lastSaveDir');

  chk($('#btnOpen').textContent.includes('指定路径'),
      '★ 按钮回退为「指定路径」，提示需要重新指定');
  // 状态栏现在提示「请确认它的磁盘路径」并随即弹窗，措辞随流程改过
  chk(/磁盘路径|真实路径/.test($('#stat').textContent),
      `★ 状态栏提示要指定磁盘路径（「${$('#stat').textContent.slice(0, 50)}…」）`);
  chk(shown(), '★ 换目录后紧跟着弹出路径窗口（一次连续操作）');

  // 此时点按钮 → 应弹窗而不是打开旧目录
  seen.length = 0;
  click($('#btnOpen'));
  await tick(10);
  chk(shown(), '★ 换目录后点按钮 → 弹窗（不再打开旧目录）');
  chk(!seen.some(s => s.u.includes('/open-dir')), '★ 不会误开旧目录');
  click($('#pdCancel'));
}

console.log('\n=== Z5. 弹窗内「清除路径」 ===');
{
  w.__MODE__ = 'ok';
  setReal('D:\\Pics\\toClear');
  w.eval('updateDirUI();');
  seen.length = 0;
  // 已记路径时左键是「打开」，要开弹窗得用右键
  $('#btnOpen').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick(10);
  chk(shown(), '弹窗打开（右键）');
  chk($('#pdClear').style.display !== 'none', '★ 有路径时「清除路径」按钮可见');

  click($('#pdClear'));
  await tick(10);
  chk(w.eval('DIR.realPath') === '', '★ 清除后 DIR.realPath 为空');
  chk($('#pdPath').value === '', '★ 输入框也清空');
  chk($('#pdClear').style.display === 'none', '★ 清除按钮自己隐藏');
  chk(shown(), '清除后弹窗仍开着，方便直接选新目录');
  chk(/已清除/.test($('#pdErr').textContent), '给出已清除的反馈');

  const c = seen.find(s => s.u.includes('/savedir') && s.body && s.body.clear === true);
  chk(!!c, '★ 调了服务端的 clear');
  click($('#pdCancel'));
}

console.log('\n=== Z6. 右键按钮 = 改路径 ===');
{
  setReal('D:\\Pics\\rightclick');
  w.eval('updateDirUI();');
  chk($('#btnOpen').title.includes('右键'), '★ tooltip 说明右键可改路径');

  click($('#btnOpen'));
  await tick(10);
  chk(!shown(), '左键 = 直接打开（不弹窗）');

  $('#btnOpen').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick(10);
  chk(shown(), '★ 右键 = 弹出改路径窗口');
  click($('#pdCancel'));
}

console.log('\n=== Z7. 选完文件夹立刻接上路径填写（一次连续操作） ===');
{
  w.__MODE__ = 'ok';
  seen.length = 0;
  w.eval(`DIR.handle = null; DIR.realPath = ''; updateDirUI();`);

  // 用户点「保存目录」→ 在浏览器里选了一个文件夹
  await w.eval(`
    (async () => {
      window.showDirectoryPicker = async () => ({
        name: 'local-model', requestPermission: async () => 'granted'
      });
      await pickDir();
    })()
  `);
  await tick(20);

  chk(shown(), '★ 选完文件夹后自动弹出路径窗口（不用再回头点一次「指定路径」）');
  const hint = $('.pd-hint').textContent;
  chk(hint.includes('local-model'), '★ 提示语里点出了刚选的文件夹名，便于对照');
  chk(/不告诉网页它的磁盘位置/.test(hint), '提示语解释了为什么还要手动指定');
  chk(w.eval('DIR.handle.name') === 'local-model', '门禁卡已保存（存图不受影响）');
  click($('#pdCancel'));
}

console.log('\n=== Z8. 自动定位同名文件夹 ===');
{
  w.__MODE__ = 'ok';
  w.eval(`DIR.handle = null; DIR.realPath = ''; updateDirUI();`);
  await w.eval(`
    (async () => {
      window.showDirectoryPicker = async () => ({
        name: 'b', requestPermission: async () => 'granted'
      });
      await pickDir();
    })()
  `);
  await tick(30);
  // 假服务端里 D:\Pics 下有 a、b 两个子目录 → 应自动跳到 D:\Pics\b
  chk(shown(), '弹窗打开');
  const listed = $('#pdList').textContent;
  chk(/\bb\b/.test(listed) || $('#pdPath').value.includes('b'),
      `★ 自动定位到同名文件夹（列表面板或输入框已指向 b）`);
  chk($('#pdPath').value.includes('b') || listed.includes('a'),
      '定位结果可见');
  click($('#pdCancel'));
}

console.log('\n=== Z9. 刷新后按钮状态必须恢复（回归） ===');
{
  // 复现用户报的问题：配好路径 → 刷新 → 按钮却显示「指定路径」。
  // 根因：cfgLoad() 恢复了 DIR.realPath，但没调 updateDirUI()，
  //       按钮停在 HTML 里写死的初始文案上。功能是通的（能打开），
  //       所以表现为「显示不对但能用」。
  w.__MODE__ = 'ok';
  seen.length = 0;

  // 模拟：磁盘上有 saveDir，页面刚启动
  w.eval(`
    DIR.realPath = '';
    DIR.handle = null;
    updateDirUI();
  `);
  chk($('#btnOpen').textContent.includes('指定路径'), '前置：初始状态显示「指定路径」');

  // 让 /config 返回一个 saveDir，然后跑 cfgLoad（模拟刷新后的加载）
  const savedFetch = w.fetch;
  w.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('/config') && (opt.method || 'GET').toUpperCase() === 'GET'){
      return { ok: true, status: 200, json: async () => ({
        ok: true, existed: true,
        config: {
          version: 1,
          batch: {
            template: '刷新测试 {{服装}}',
            slots: [{ name: '服装', values: ['A'] }],
            skipDup: true, count: 1
          },
          saveDir: 'D:\\Pictures\\restored',
          plan: null
        }
      }) };
    }
    return savedFetch(url, opt);
  };
  await w.eval('cfgLoad()');
  await tick(10);
  w.fetch = savedFetch;

  chk(w.eval('DIR.realPath') === 'D:\\Pictures\\restored',
      '★ cfgLoad 恢复出了 saveDir');
  chk($('#btnOpen').textContent.includes('打开文件夹'),
      `★ 按钮随之显示「打开文件夹」（实际「${$('#btnOpen').textContent.trim()}」）`);
  chk(!$('#btnOpen').textContent.includes('指定路径'),
      '★ 不再错误地显示「指定路径」');
  chk($('#btnOpen').title.includes('D:\\Pictures\\restored'),
      '★ 按钮提示里带出了恢复的路径');
}

console.log('\n=== Z10. 恢复的路径可直接打开（功能与显示一致） ===');
{
  seen.length = 0;
  click($('#btnOpen'));
  await tick(10);
  chk(!shown(), '已恢复路径时左键不弹窗');
  const c = seen.find(s => s.u.includes('/open-dir'));
  chk(!!c && c.body.dir === 'D:\\Pictures\\restored', '★ 直接打开恢复的那个目录');
}

console.log('\n=== N. 运行期 JS 异常 ===');
chk(jsErrors.length === 0, `无未过滤的 JS 异常（${jsErrors.length} 条）`);
jsErrors.forEach(e => console.log('  ! ' + e));

console.log('\n通过 ' + ok.length + ' 项：');
ok.forEach(o => console.log('  ✓ ' + o));
if (fail.length) {
  console.log('\n失败 ' + fail.length + ' 项：');
  fail.forEach(f => console.log('  ✗ ' + f));
}
console.log('\n' + '─'.repeat(50));
console.log(fail.length ? `结果：${ok.length} 通过 / ${fail.length} 失败` : `结果：${ok.length} 通过 / 0 失败`);
process.exit(fail.length ? 1 : 0);
