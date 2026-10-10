/* ══════════════════════════════════════════════════════════════
   「我的模板」用户模板库测试
   ──────────────────────────────────────────────────────────────
   覆盖：
     A. 另存为：整包保存（模板+数组+张数+跳过重复）
     B. 重名 → 覆盖
     C. 恢复：套用内容 + 恢复前自动备份
     D. 撤回：回到恢复前的状态
     E. 重命名 / 删除 / 无数量上限
     F. 落盘：模板写进独立文件（不再进 config.json）
     G. 刷新（cfgLoad）后从 /templates 恢复模板库
     H. 「恢复默认模板」也应可撤回
     I. 边界：空模板不允许存、名字为空
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

// 记录写盘请求，验证模板真的进了 payload
const saved = [];
/* ★ 模板库的模拟存储：真服务端是 <tpl_dir>/<id>.json，这里用 Map 等价模拟。
   模板不再进 config.json，所以断言要针对 /templates 接口而不是 payload。 */
const tplStore = new Map();
let promptAnswer = null;
let confirmAnswer = true;

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:17341/',
  virtualConsole: vc,
  beforeParse(w){
    w.alert = () => {};
    w.confirm = () => confirmAnswer;
    w.prompt = () => promptAnswer;
    w.indexedDB = { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror({}), 0); return r; } };
    w.URL.createObjectURL = () => 'blob:';
    w.URL.revokeObjectURL = () => {};
    w.showDirectoryPicker = async () => ({ name: 'D', requestPermission: async () => 'granted' });
    const orig = w.HTMLCanvasElement.prototype.getContext;
    w.HTMLCanvasElement.prototype.getContext = function(t, ...a){
      if (t === '2d'){ stubCtx.canvas = this; return stubCtx; }
      try { return orig.call(this, t, ...a); } catch { return null; }
    };
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    w.HTMLCanvasElement.prototype.toBlob = cb => setTimeout(() => cb(new w.Blob([], { type: 'image/png' })), 0);

    w.fetch = async (url, opt = {}) => {
      const u = String(url);
      const method = (opt.method || 'GET').toUpperCase();
      const mk = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

      /* ★ 模板库已改为独立文件（/templates/<id>.json），不再走 config.json。
         这里用内存 Map 模拟服务端的模板文件存储，语义与真服务一致：
         PUT 写入、DELETE 删除、GET 列表按 at 倒序。 */
      if (u.includes('/templates')){
        const m = u.match(/\/templates\/([^/?#]+)/);
        if (m){
          const id = decodeURIComponent(m[1]);
          if (method === 'DELETE'){ tplStore.delete(id); return mk(200, { ok: true, deleted: id }); }
          if (method === 'GET'){
            const t = tplStore.get(id);
            return t ? mk(200, { ok: true, template: t }) : mk(404, { ok: false, error: '模板不存在' });
          }
          if (method === 'PUT' || method === 'POST'){
            let body = null; try { body = JSON.parse(opt.body); } catch {}
            if (!body || !body.name || typeof body.template !== 'string'){
              return mk(400, { ok: false, error: '模板结构不合法' });
            }
            const t = Object.assign({}, body, { id });
            tplStore.set(id, t);
            saved.push(body);
            return mk(200, { ok: true, template: t });
          }
        }
        // 列表
        const list = [...tplStore.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
        return mk(200, { ok: true, dir: 'X', templates: list });
      }

      if (u.includes('/health')) return mk(200, { ok: true, configPath: 'X', openDir: { enabled: true, lastSaveDir: null } });
      if (u.includes('/drives')) return mk(200, { ok: true, drives: ['C:\\', 'D:\\'] });
      if (u.includes('/config') && method === 'POST'){
        let body = null; try { body = JSON.parse(opt.body); } catch {}
        saved.push(body);
        return mk(200, { ok: true });
      }
      if (u.includes('/config')) return mk(200, { ok: true, existed: true, config: {} });
      return mk(200, {});
    };
  }
});
const w = dom.window;
const $ = s => w.document.querySelector(s);
const ok = [], fail = [];
const chk = (c, m) => (c ? ok.push(m) : fail.push(m));
const tick = (n = 8) => new Promise(r => {
  let i = 0; const s = () => (++i >= n ? r() : setTimeout(s, 0)); setTimeout(s, 0);
});
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
/* ★ w.eval 返回的是 jsdom realm 里的对象，直接在 Node 里索引会拿到 undefined。
   统一经 JSON 往返成纯 Node 值，断言才可靠。
   注意：JSON.stringify 必须在【页面内】执行，不能靠 w.eval 的返回值再 stringify。 */
const J = e => JSON.parse(w.eval(`JSON.stringify(${e})`));
const S = () => J('S.m.batch');
const TB = () => J('S.b.templates');
const BK = () => (w.eval('S.b.tplBackup === null') ? null : J('S.b.tplBackup'));
const lastSaved = () => saved[saved.length - 1];

// 让配置服务"可用"，否则 cfgSaveNow 会直接 return
w.eval('S.b.cfgOk = true;');
w.eval('S.mode = "batch"; loadBatchPane();');
// ★ 等页面启动流程（boot → bootConfig → cfgLoad）彻底跑完再动手，
//   否则我们设的状态会被后到的 cfgLoad 覆盖掉。
await tick(40);
w.eval('S.b.cfgOk = true;');
w.eval('S.mode = "batch"; loadBatchPane();');

/** 设定面板内容 —— 必须走 DOM，因为 saveBatchPane() 以 DOM 为准。
 *  （直接改 S.m.batch 会被随后的 saveBatchPane() 用空 textarea 覆盖掉） */
function setPane(tpl, slots, count, skipDup){
  const ta = $('[data-f="template"]');
  ta.value = tpl;
  const cn = $('[data-f="count"]');
  if (cn) cn.value = count;
  const sd = $('[data-f="skipDup"]');
  if (sd) sd.checked = !!skipDup;
  // 数组用状态 + 重渲染（数组编辑器的 DOM 是 loadBatchPane 建的）
  w.eval(`
    S.m.batch.slots = ${JSON.stringify(slots)};
    loadBatchPane();
  `);
  // loadBatchPane 会用 S.m.batch 回填 textarea，所以再写一次确保一致
  ta.value = tpl;
  if (cn) cn.value = count;
  if (sd) sd.checked = !!skipDup;
  w.eval('saveBatchPane()');
}

console.log('=== A. 另存为：整包保存 ===');
{
  setPane('A 模板 {{服装}}', [{ name: '服装', values: ['x', 'y'] }], 5, false);
  promptAnswer = '测试模板A';
  saved.length = 0;
  const dbg = await w.eval(`(async () => {
    try {
      await saveAsTemplate();
      return { tplLen: (S.m.batch.template||'').length, n: (S.b.templates||[]).length, stat: document.querySelector('#stat').textContent };
    } catch(e){ return { err: e.message }; }
  })()`);
  console.log('  [debug]', JSON.stringify(dbg));
  await tick();

  const list = TB();
  console.log('  [debug] TB() =', typeof list, JSON.stringify(list).slice(0, 200));
  chk(list.length === 1, `★ 存了 1 个模板（实际 ${list.length}）`);
  chk(list[0].name === '测试模板A', `名字正确（${list[0].name}）`);
  chk(list[0].template === 'A 模板 {{服装}}', '★ 模板正文已保存');
  chk(list[0].slots.length === 1 && list[0].slots[0].values.join(',') === 'x,y', '★ 数组已保存');
  chk(list[0].count === 5, `★ 张数已保存（${list[0].count}）`);
  chk(list[0].skipDup === false, '★ 跳过重复开关已保存');
  chk(!!list[0].id && !!list[0].at, '带 id 与时间戳');

  chk(saved.length >= 1, '★ 触发了一次写盘');
  const p = lastSaved();
  chk(!('templates' in p), '★ config payload 不再带 templates（已拆成独立文件）');
  chk(tplStore.size === 1, `★ 模板写进了独立文件存储（${tplStore.size} 个）`);
  const stored = [...tplStore.values()][0];
  chk(stored.name === '测试模板A', '独立文件里的内容正确');
  chk(stored.id === list[0].id, '独立文件名（id）与列表一致');
}

console.log('\n=== B. 重名 → 覆盖 ===');
{
  setPane('B 模板大改 {{场景}}', [{ name: '场景', values: ['p'] }], 9, true);
  promptAnswer = '测试模板A';
  confirmAnswer = true;
  await w.eval('saveAsTemplate()');
  await tick();
  const list = TB();
  chk(list.length === 1, '★ 重名不新增，仍是 1 个');
  chk(list[0].template === 'B 模板大改 {{场景}}', '★ 内容被覆盖');
  chk(list[0].count === 9, '★ 张数也更新了');
  chk(list[0].skipDup === true, '★ 开关也更新了');

  // 覆盖时选「取消」应不动
  confirmAnswer = false;
  setPane('不该被保存的内容', [], 1, false);
  promptAnswer = '测试模板A';
  await w.eval('saveAsTemplate()');
  await tick();
  chk(TB()[0].template === 'B 模板大改 {{场景}}', '★ 取消覆盖后内容没变');
  confirmAnswer = true;
}

console.log('\n=== C. 恢复：套用 + 自动备份 ===');
{
  // 另存一个第二个模板
  setPane('C 模板 {{动作}}', [{ name: '动作', values: ['z'] }], 3, true);
  promptAnswer = '测试模板C';
  await w.eval('saveAsTemplate()');
  await tick();
  chk(TB().length === 2, '现在有 2 个模板');

  // 把面板改成别的内容，再恢复模板A
  setPane('临时乱改的 {{X}}', [{ name: 'X', values: ['1'] }], 99, false);
  chk(BK() === null, '前置：没有备份');

  const idA = TB().find(t => t.name === '测试模板A').id;
  await w.eval(`restoreTemplate(${JSON.stringify(idA)})`);
  await tick();

  chk(S().template === 'B 模板大改 {{场景}}', '★ 恢复出了模板A的内容');
  chk(S().count === 9, '★ 张数也恢复了');
  chk(S().skipDup === true, '★ 开关也恢复了');
  chk(S().slots[0].name === '场景', '★ 数组也恢复了');

  chk(BK() !== null, '★ 恢复前自动做了备份');
  chk(BK().template === '临时乱改的 {{X}}', '★ 备份里是恢复前的内容');
  chk(!$('#tplUndo') || $('#tplUndo').style.display !== 'none', '★ 「撤回」按钮出现了');
}

console.log('\n=== C2. 覆盖：把当前内容存回指定模板 ===');
{
  // 先清掉 C 段留下的备份槽，避免干扰下面的断言
  w.eval('S.b.tplBackup = null; updateUndoBtn();');
  chk(BK() === null, '前置：备份槽已清空');

  // 找一个已有模板，用当前面板内容覆盖它
  w.eval('renderTplLib()');
  const tb = TB().find(t => t.name === '测试模板C');
  chk(!!tb, '前置：模板C存在');

  const before = JSON.parse(JSON.stringify(tb));
  const beforeName = tb.name;
  const beforeId = tb.id;

  setPane('覆盖后的新内容 {{新槽}}', [{ name: '新槽', values: ['a', 'b', 'c'] }], 5, false);

  // 覆盖需要确认，confirm 已被桩成 true
  await w.eval(`overwriteTemplate(${JSON.stringify(beforeId)})`);
  await tick();

  const after = TB().find(t => t.id === beforeId);
  chk(!!after, '★ 覆盖后模板还在（是覆盖不是新建）');
  chk(TB().length === 2, '★ 模板总数没变（没有多出一个）');
  chk(after.template === '覆盖后的新内容 {{新槽}}', '★ 正文被替换');
  chk(after.slots.length === 1 && after.slots[0].name === '新槽', '★ 数组被替换');
  chk(JSON.stringify(after.slots[0].values) === JSON.stringify(['a','b','c']), '★ 数组取值被替换');
  chk(after.count === 5, '★ 张数被替换');
  chk(after.skipDup === false, '★ 跳过重复开关被替换');
  chk(after.name === beforeName, '★ 名字保持不变');
  chk(after.id === beforeId, '★ id 保持不变');
  chk(after.at >= before.at, '★ 保存时间被刷新');
  chk(w.eval('S.b.activeTplId') === beforeId, '★ 覆盖后该模板被标记为当前');

  // 覆盖不产生备份（它不是破坏当前面板，而是破坏模板本身）
  chk(BK() === null, '覆盖不写备份槽（当前面板内容本来就是源头）');

  // 内容一致时不重复覆盖
  const t2 = TB().find(t => t.id === beforeId);
  const atBefore = t2.at;
  await w.eval(`overwriteTemplate(${JSON.stringify(beforeId)})`);
  await tick();
  chk(TB().find(t => t.id === beforeId).at === atBefore, '内容一致时提示「无需覆盖」且不更新时间');

  // 空正文时拒绝覆盖
  setPane('', [], 5, false);
  const snapshot = JSON.stringify(TB().find(t => t.id === beforeId));
  await w.eval(`overwriteTemplate(${JSON.stringify(beforeId)})`);
  await tick();
  chk(JSON.stringify(TB().find(t => t.id === beforeId)) === snapshot, '★ 正文为空时拒绝覆盖，模板未变');

  // 覆盖不存在的 id → 静默返回，不崩
  let threw = false;
  try { await w.eval('overwriteTemplate("不存在_id")'); await tick(); } catch(e){ threw = true; }
  chk('覆盖不存在的 id 不抛异常', !threw);
  chk(TB().length === 2, '模板总数仍然是 2');
}

console.log('\n=== D. 撤回：回到使用前 ===');
{
  // C2 把备份槽清空了，这里重新造一个「使用前」的场景，
  // 否则没法验证撤回——它要撤回的正是「使用」动作留下的备份。
  setPane('临时乱改的 {{X}}', [{ name: 'X', values: ['1'] }], 99, false);
  const idA2 = TB().find(t => t.name === '测试模板A').id;
  await w.eval(`restoreTemplate(${JSON.stringify(idA2)})`);
  await tick();
  chk(BK() !== null, '前置：使用后产生了备份');
  chk(S().template !== '临时乱改的 {{X}}', '前置：面板已被模板覆盖');

  await w.eval('undoTemplate()');
  await tick();
  chk(S().template === '临时乱改的 {{X}}', '★ 撤回到了使用前的模板');
  chk(S().count === 99, '★ 张数也回来了');
  chk(BK() === null, '★ 备份已消耗（只留一次）');
  chk($('#tplUndo').style.display === 'none', '★ 「撤回」按钮隐藏了');

  // 没有备份时再点撤回 → 给出提示，不崩
  await w.eval('undoTemplate()');
  await tick();
  chk(S().template === '临时乱改的 {{X}}', '★ 无备份时撤回不改变内容');
}

console.log('\n=== E. 重命名 / 删除 / 无上限 ===');
{
  const idA = TB().find(t => t.name === '测试模板A').id;
  promptAnswer = '改名后的A';
  await w.eval(`renameTemplate(${JSON.stringify(idA)})`);
  await tick();
  chk(TB().find(t => t.id === idA).name === '改名后的A', '★ 重命名生效');
  chk(tplStore.get(idA).name === '改名后的A', '★ 改名写回了独立文件');
  chk(tplStore.has(idA), '★ 改名不改文件名（仍按 id 存）');

  // 改成已存在的名字应被拒
  promptAnswer = '测试模板C';
  await w.eval(`renameTemplate(${JSON.stringify(idA)})`);
  await tick();
  chk(TB().find(t => t.id === idA).name === '改名后的A', '★ 重名被拒，名字没变');

  // 空名字被拒
  promptAnswer = '   ';
  await w.eval(`renameTemplate(${JSON.stringify(idA)})`);
  await tick();
  chk(TB().find(t => t.id === idA).name === '改名后的A', '★ 空名字被拒');

  // 删除
  const idC = TB().find(t => t.name === '测试模板C').id;
  confirmAnswer = true;
  await w.eval(`deleteTemplate(${JSON.stringify(idC)})`);
  await tick();
  chk(TB().length === 1, `★ 删除生效（剩 ${TB().length}）`);
  chk(!TB().some(t => t.id === idC), '被删的确实没了');
  chk(!tplStore.has(idC), '★ 独立文件也被删掉了');

  // 删除时取消
  confirmAnswer = false;
  await w.eval(`deleteTemplate(${JSON.stringify(idA)})`);
  await tick();
  chk(TB().length === 1, '★ 取消删除后仍在');
  chk(tplStore.has(idA), '取消删除后独立文件仍在');
  confirmAnswer = true;
}

console.log('\n=== H. 「恢复默认模板」也可撤回 ===');
{
  setPane('要被默认覆盖的内容', [{ name: 'Q', values: ['1'] }], 7, false);
  confirmAnswer = true;
  await w.eval(`$('#tplReset').onclick()`);
  await tick();
  chk(S().template !== '要被默认覆盖的内容', '★ 已恢复为出厂默认');
  chk(S().template.includes('全身竖构图') || S().template.length > 50, '内容确为出厂模板');
  chk(BK() !== null && BK().template === '要被默认覆盖的内容', '★ 恢复默认也做了备份');

  await w.eval('undoTemplate()');
  await tick();
  chk(S().template === '要被默认覆盖的内容', '★ 可撤回默认恢复');
}

console.log('\n=== I. 边界 ===');
{
  // 空模板不允许存
  const before = TB().length;
  setPane('   ', [], 8, true);
  promptAnswer = '空模板';
  await w.eval('saveAsTemplate()');
  await tick();
  chk(TB().length === before, '★ 模板正文为空时拒绝保存');

  // 用户取消 prompt
  setPane('正常内容', [], 8, true);
  promptAnswer = null;
  await w.eval('saveAsTemplate()');
  await tick();
  chk(TB().length === before, '★ 取消命名不保存');

  // 不再有数量上限（模板是一个模板一个文件）
  setPane('批量填很多', [], 1, true);
  for (let i = 0; i < 25; i++){
    promptAnswer = '填充' + i;
    await w.eval('saveAsTemplate()');
  }
  await tick();
  chk(TB().length > 20, `★ 不再有 20 个上限（实际 ${TB().length}）`);
  chk(tplStore.size === TB().length, `★ 每个模板都有独立文件（${tplStore.size} 个）`);
}

console.log('\n=== F. 落盘：模板写进独立文件而非 config ===');
{
  const p = lastSaved();
  chk(!('templates' in p), '★ config payload 里没有 templates');
  chk(tplStore.size > 0, `★ 模板存在独立文件存储里（${tplStore.size} 个）`);
  const t = [...tplStore.values()][0];
  chk(['id', 'name', 'at', 'template', 'slots', 'count', 'skipDup'].every(k => k in t),
      '★ 每个模板字段齐全');
  chk(!('tplBackup' in p), '★ 备份不会写进磁盘（只存在内存，刷新即弃）');
}

console.log('\n=== G. 刷新后模板库仍在（从 /templates 拉取）===');
{
  const snapshot = JSON.parse(JSON.stringify([...tplStore.values()]));
  w.eval(`S.b.templates = []; S.b.activeTplId = null; renderTplLib();`);
  chk(TB().length === 0, '前置：已清空');

  // cfgLoad 现在从 /templates 拉模板库（mock 已按真服务语义实现）
  await w.eval('cfgLoad()');
  await tick();

  chk(TB().length === snapshot.length, `★ cfgLoad 恢复了 ${TB().length} 个模板（期望 ${snapshot.length}）`);
  chk(TB().some(t => t.name === '填充0'), '名字完好');
  // ★ 走真实的启动路径（bootConfig），它会在任何模式下都渲染一次模板库。
  await w.eval('bootConfig()');
  await tick();
  const n = TB().length;
  chk($('#tplLibList').children.length === n, `★ 列表渲染出 ${n} 行（实际 ${$('#tplLibList').children.length}）`);
  chk($('#tplLibStat').textContent === `${n} 个`, `★ 计数显示「${n} 个」（实际「${$('#tplLibStat').textContent}」）`);
}

console.log('\n=== J. 列表 UI ===');
{
  // 重新渲染一遍，确保列表与当前状态一致（G 里换过 fetch，可能留下空列表）
  w.eval('renderTplLib()');
  const rows = [...$('#tplLibList').querySelectorAll('.tpl')];
  console.log('  [debug] rows len =', rows.length);
  chk(rows.length === TB().length, `每行一个模板（${rows.length}）`);
  const first = rows[0];
  if (!first){ chk(false, '拿不到第一行'); }
  else {
    chk(first.querySelectorAll('.op').length === 4, '★ 每行有 使用/覆盖/改名/删除 四个操作');
    const ops = [...first.querySelectorAll('.op')].map(o => o.textContent);
    console.log('  操作按钮: ' + ops.join(' / '));
    chk(ops[0] === '使用', '第一个操作是「使用」（原「恢复」）');
    chk(ops[1] === '覆盖', '第二个操作是「覆盖」');
    chk(ops[2] === '改名', '第三个操作是「改名」');
    chk(ops[3] === '删除', '第四个操作是「删除」');
    chk(ops.indexOf('恢复') < 0, '★ 列表里不再出现「恢复」字样（已改名「使用」）');
    chk(!!first.querySelector('.op.danger'), '删除按钮带 danger 样式');
    chk(first.querySelector('.mt').textContent.includes('张'), '副标题显示张数');
    chk((first.querySelector('.op').title || '').length > 0, '「使用」有说明性 title');
    chk((first.querySelector('.op').title || '').includes('备份'), '「使用」的 title 提示会自动备份');
    chk((ops[1] && first.querySelectorAll('.op')[1].title || '').includes('覆盖'), '「覆盖」的 title 说明用途');
  }
}

console.log('\n=== N. 运行期 JS 异常 ===');
chk(jsErrors.length === 0, `无未过滤的 JS 异常（${jsErrors.length} 条）`);
jsErrors.forEach(e => console.log('  ! ' + e));

console.log('\n通过 ' + ok.length + ' 项：');
ok.forEach(o => console.log('  ✓ ' + o));
if (fail.length){ console.log('\n失败 ' + fail.length + ' 项：'); fail.forEach(f => console.log('  ✗ ' + f)); }
console.log('\n' + '─'.repeat(50));
console.log(fail.length ? `结果：${ok.length} 通过 / ${fail.length} 失败` : `结果：${ok.length} 通过 / 0 失败`);
process.exit(fail.length ? 1 : 0);
