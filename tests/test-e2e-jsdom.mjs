/**
 * DOM 级端到端验证：用 jsdom 真实加载 ui/index.html 并执行全部 JS。
 *
 * 为什么不用真浏览器：本沙箱禁止命名管道，Edge 的 mojo IPC 直接
 * Check failed: 拒绝访问 (0x5)，CDP 端口永远起不来。jsdom 在 Node 内
 * 构造 DOM，无需子进程 IPC，能覆盖除渲染外的全部逻辑。
 *
 * 注意：页面脚本用 const 声明顶层变量，不会成为 window 的属性，
 * 所以一律通过 window.eval() 在页面全局词法作用域里求值。
 *
 * 用法：node _test-e2e-jsdom.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

/* ★ 不用固定 1235 —— 用户可能正开着自己的 serve-config.mjs 占着它。
   抢不到端口就会出现「测试的服务起不来，页面连到用户的旧服务」，
   于是读不到自己写的临时配置。这里随机挑一个高位端口。 */
const CFG_PORT = 21000 + Math.floor(Math.random() * 2000);

const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const problems = [];
function ok(n){ pass++; log('  ✓ ' + n); }
function bad(n, d){ fail++; problems.push(n + (d ? ': ' + d : '')); log('  ✗ ' + n + (d ? '  → ' + d : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ★ 用独立的临时配置文件跑测试，绝不碰用户真实的 ui/config.json。
   之前这里直接删 ui/config.json，会把用户的 saveDir / 批量设置全部清掉。 */
const TEST_CFG = path.join(process.env.TEMP || '/tmp', `sdstudio-test-cfg-${process.pid}.json`);
const cfgProc = spawn(process.execPath, [CFG_SERVICE, String(CFG_PORT)], {
  stdio: 'ignore',
  env: { ...process.env, SDCFG_PATH: TEST_CFG }
});

let page = null;

/** 在页面全局词法作用域里求值（支持 await） */
async function ev(expr){
  const r = page.w.eval(`(async () => { ${expr} })()`);
  return await r;
}
/** 同步求值（用于取值） */
function evs(expr){ return page.w.eval(expr); }

async function makePage(){
  const rawHtml = fs.readFileSync(UI_HTML, 'utf8');
  // ★ 页面里 CFG_URL 写死 127.0.0.1:1235。测试用随机端口起自己的服务，
  //   所以这里把地址改写成测试端口，否则页面会连到用户正在跑的那个服务上。
  const html = rawHtml.replace(
    /const CFG_URL\s*=\s*'http:\/\/127\.0\.0\.1:\d+'/,
    `const CFG_URL = 'http://127.0.0.1:${CFG_PORT}'`
  );
  if (!/CFG_URL = 'http:\/\/127\.0\.0\.1:\d+'/.test(html)) {
    throw new Error('未能改写 CFG_URL，页面结构可能变了');
  }
  const vc = new VirtualConsole();
  const jsErrors = [];
  vc.on('jsdomError', e => jsErrors.push('jsdomError: ' + (e.message || e)));
  const consoleErrors = [];

  const realFetch = globalThis.fetch.bind(globalThis);

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:17341/',
    virtualConsole: vc,
    // ★ 关键：在页面脚本执行之前注入环境。
    //   若在构造之后再赋值，页面里的 boot() 早已跑过并失败。
    beforeParse(w){
      w.fetch = function(url, ...rest){
        const u = String(url);
        if (u.includes('/sdcpp/v1/capabilities')){
          return Promise.resolve(new w.Response(JSON.stringify({
            model: { stem: 'z_image_turbo-Q4_K' },
            limits: { max_width: 1024, max_height: 1024, max_batch_count: 8 },
            sample_methods: ['euler'], schedulers: ['discrete']
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        // ★ 绝不能落到真实 fetch！
        //   本机可能正跑着 serve-config.mjs（127.0.0.1:1235），页面的 bootConfig()
        //   会真的去读配置，随后的自动保存又会把配置【写回磁盘】——
        //   等于测试往用户真实的 ui/config.json 里灌数据（曾污染出 saveDir=''
        //   和一个 id:'stale' 的假计划）。
        //
        //   ★ 2026-10 修：之前只挡了 1235，漏了两条路：
        //     a) 本测试自己的服务跑在随机端口，页面连上它之后会触发
        //        cfgSaveDebounced()，把「当前 batch」写回配置。虽然临时文件与
        //        用户文件是两份，但**同一份临时配置内**的 templates 列表会被
        //        这个写入挤掉条目，导致用例之间互相污染、模板莫名少一个。
        //     b) 任何其它端口的本地服务都会被真实请求打到。
        //   现在改成白名单：只放行本测试自己的端口，且只放行只读类接口。
        const isTestSvc = u.includes(`127.0.0.1:${CFG_PORT}`) || u.includes(`localhost:${CFG_PORT}`);
        if (!isTestSvc) {
          return Promise.reject(new TypeError('Failed to fetch（测试中屏蔽外部服务）'));
        }
        // 对本测试服务放开写（这是临时文件，写坏也不影响用户）。
        // 但仍然只认本测试自己的端口，别的端口一律拒绝。
        return realFetch(u, ...rest);
      };
      w.Response = Response;
      w.alert = m => { w.__alerted = m; };
      w.confirm = () => true;
      if (!w.indexedDB){
        w.indexedDB = { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror({}), 0); return r; } };
      }
      if (!w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:stub';
      if (!w.URL.revokeObjectURL) w.URL.revokeObjectURL = () => {};

      // ★ jsdom 不带 canvas 包，getContext() 返回 null，会让页面的
      //   sizeMaskCanvas() 抛异常、进而导致 boot() 根本执行不到。
      //   这里给一个最小 2D context 桩，让脚本能跑完初始化。
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
      const origGetCtx = w.HTMLCanvasElement.prototype.getContext;
      w.HTMLCanvasElement.prototype.getContext = function(type, ...a){
        if (type === '2d'){
          const c = stubCtx;
          c.canvas = this;
          return c;
        }
        try { return origGetCtx.call(this, type, ...a); } catch (_) { return null; }
      };
      w.HTMLCanvasElement.prototype.toDataURL = function(){ return 'data:image/png;base64,'; };
      w.HTMLCanvasElement.prototype.toBlob = function(cb){ setTimeout(() => cb(new w.Blob([], { type: 'image/png' })), 0); };

      // 捕获页面里的 console.error（jsdom 默认吞掉）
      const origErr = w.console.error.bind(w.console);
      w.console.error = (...a) => { consoleErrors.push(a.join(' ')); origErr(...a); };
    }
  });
  const w = dom.window;

  page = { dom, w, jsErrors, consoleErrors };
  await sleep(1800);   // 等 boot() 的异步 fetch 完成
  return page;
}

/* ★ 指向测试专用的临时配置，不再动 ui/config.json */
const cfgPath = TEST_CFG;
function readDiskCfg(){ return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }

/* 从页面源码里解析出厂定义的组合数，避免把数字写死 */
const BATCH_FACTORY_COMBO = (() => {
  const html = fs.readFileSync(UI_HTML, 'utf8');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const seg = js.slice(js.indexOf('const BATCH_FACTORY'), js.indexOf('/* ══════════════ 批量生图 · 占位符引擎'));
  const m = new Function(`${seg}; return BATCH_FACTORY;`)();
  return m.slots.reduce((a, s) => a * s.values.length, 1);
})();

async function main(){
  await sleep(900);
  // 只清测试专用的临时配置，用户真实配置不受影响
  try { fs.unlinkSync(TEST_CFG); } catch(_){}

  log('\n=== A. 页面加载与初始化 ===');
  {
    await makePage();
    const r = await ev(`return {
      mode: S.mode,
      hasBatch: !!S.m.batch,
      tplLen: (S.m.batch.template||'').length,
      slotN: (S.m.batch.slots||[]).length,
      cfgOk: S.b.cfgOk,
      caps: !!S.caps,
      model: S.model,
      goDisabled: $('#go').disabled
    };`);
    log('  ' + JSON.stringify(r));
    r.mode === 'txt2img' ? ok('默认模式 = txt2img') : bad('默认模式异常', r.mode);
    r.hasBatch ? ok('S.m.batch 已初始化') : bad('S.m.batch 缺失');
    r.tplLen > 100 ? ok(`出厂模板已载入（${r.tplLen} 字）`) : bad('模板未载入', r.tplLen);
    r.slotN === 3 ? ok('出厂 3 组数组已载入') : bad('数组数不对', r.slotN);
    r.cfgOk ? ok('配置服务已连上') : bad('配置服务未连上');
    r.caps ? ok(`已连上 sd-server（${r.model}）`) : bad('未连上 sd-server');
    r.goDisabled === false ? ok('生成按钮已启用') : bad('生成按钮仍禁用');
  }

  log('\n=== B. 切到批量 tab ===');
  {
    const r = await ev(`
      switchMode('batch');
      await new Promise(r=>setTimeout(r,120));
      const d = document;
      return {
        mode: S.mode,
        paneOn: d.querySelector('[data-pane="batch"]').classList.contains('on'),
        tabOn: d.querySelector('[data-mode="batch"]').classList.contains('on'),
        tplInDom: (d.querySelector('[data-pane="batch"] [data-f="template"]')||{}).value?.length || 0,
        comboNum: d.querySelector('#comboNum').textContent,
        errShown: d.querySelector('#tplErr').classList.contains('show'),
        tags: d.querySelectorAll('#tplTags .tg').length,
        slots: d.querySelectorAll('#slotList .slot').length,
        countVal: d.querySelector('[data-pane="batch"] [data-f="count"]').value,
        skipChecked: d.querySelector('[data-pane="batch"] [data-f="skipDup"]').checked,
        frozenInfo: d.querySelector('#frozenInfo').textContent.slice(0,60)
      };`);
    log('  ' + JSON.stringify(r));
    r.mode === 'batch' ? ok('模式已切换') : bad('模式切换失败');
    r.paneOn ? ok('batch pane 已显示') : bad('batch pane 未显示');
    r.tabOn ? ok('batch tab 高亮') : bad('batch tab 未高亮');
    r.tplInDom > 100 ? ok('模板已填入 textarea') : bad('textarea 未填', r.tplInDom);
    String(r.comboNum) === String(BATCH_FACTORY_COMBO)
      ? ok(`组合数显示 ${BATCH_FACTORY_COMBO}`) : bad('组合数不对', r.comboNum);
    r.errShown === false ? ok('出厂模板无报错（关键：不能一打开就红）') : bad('出厂模板竟然报错');
    r.tags === 3 ? ok('3 个占位符标记已渲染') : bad('标记数不对', r.tags);
    r.slots === 3 ? ok('3 个数组编辑器已渲染') : bad('编辑器数不对', r.slots);
    r.countVal === '8' ? ok('张数默认 8') : bad('张数默认值不对', r.countVal);
    r.skipChecked === true ? ok('跳过重复默认勾选') : bad('跳过重复未勾选');
    r.frozenInfo.includes('768') ? ok('参数来源提示显示文生图尺寸') : bad('参数提示不对', r.frozenInfo);
  }

  log('\n=== C. 占位符校验：缺失 / 未闭合 / 空数组 ===');
  {
    const r = await ev(`
      const d = document;
      const ta = d.querySelector('[data-pane="batch"] [data-f="template"]');
      const setTpl = async v => { ta.value = v; ta.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,60)); };

      await setTpl('一位女孩穿{{不存在的占位符}}在{{场景}}');
      const v1 = validateBatch();
      const o1 = {
        errShown: d.querySelector('#tplErr').classList.contains('show'),
        boxBad: d.querySelector('#tplBox').classList.contains('bad'),
        errCount: v1.errors.length,
        errMsg: v1.errors[0]?.msg || '',
        missTag: d.querySelectorAll('#tplTags .tg.miss').length
      };

      await setTpl('一位女孩穿{{服装');
      const v2 = validateBatch();
      const o2 = {
        errShown: d.querySelector('#tplErr').classList.contains('show'),
        hasUnclosed: v2.errors.some(e=>e.kind==='unclosed')
      };

      await setTpl('穿{{服装}}去{{场景}}');
      const slot = [...d.querySelectorAll('#slotList .slot')].find(x => S.m.batch.slots[+x.dataset.i].name === '场景');
      const nv = slot.querySelector('[data-slotvals]');
      nv.value = ''; nv.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,60));
      const v3 = validateBatch();
      const o3 = {
        errShown: d.querySelector('#tplErr').classList.contains('show'),
        hasEmpty: v3.errors.some(e=>e.kind==='emptyarr')
      };
      return { o1, o2, o3 };`);
    log('  缺失: ' + JSON.stringify(r.o1));
    log('  未闭合: ' + JSON.stringify(r.o2));
    log('  空数组: ' + JSON.stringify(r.o3));
    r.o1.errShown ? ok('缺失数组 → 实时标红') : bad('未标红');
    r.o1.boxBad ? ok('输入框红边') : bad('输入框没红边');
    r.o1.errMsg.includes('没有对应的数组') ? ok('错误信息准确') : bad('错误信息不对', r.o1.errMsg);
    r.o1.missTag >= 1 ? ok('占位符标记显示「缺数组」') : bad('标记未标红');
    r.o2.errShown && r.o2.hasUnclosed ? ok('未闭合 {{ → 报红') : bad('未闭合未报红', JSON.stringify(r.o2));
    r.o3.errShown && r.o3.hasEmpty ? ok('空数组 → 报红') : bad('空数组未报红', JSON.stringify(r.o3));
  }

  log('\n=== D. 生成时硬拦（不提交任何请求）===');
  {
    const r = await ev(`
      window.__fetchCalls = [];
      const orig = window.fetch;
      window.fetch = function(...a){ window.__fetchCalls.push(String(a[0])); return orig.apply(this,a); };
      window.__alerted = null;
      await generateBatch();
      window.fetch = orig;
      return {
        alerted: window.__alerted,
        imgGenCalls: window.__fetchCalls.filter(u=>u.includes('img_gen')).length,
        busy: S.busy
      };`);
    log('  ' + JSON.stringify(r).slice(0, 200));
    r.alerted && r.alerted.includes('模板有问题') ? ok('弹窗提示模板有问题') : bad('没弹窗', r.alerted);
    r.imgGenCalls === 0 ? ok('未提交任何生成请求（硬拦成功）') : bad('竟然提交了请求', r.imgGenCalls);
    r.busy === false ? ok('未进入 busy 状态') : bad('错误地进入 busy');
  }

  log('\n=== E. 跳过重复 + 张数上限 ===');
  {
    const r = await ev(`
      const d = document;
      const ta = d.querySelector('[data-pane="batch"] [data-f="template"]');
      ta.value = '{{服装}}与{{场景}}'; ta.dispatchEvent(new Event('input',{bubbles:true}));
      const setSlot = (name, vals) => {
        const slot = [...d.querySelectorAll('#slotList .slot')].find(x => S.m.batch.slots[+x.dataset.i].name === name);
        const nv = slot.querySelector('[data-slotvals]');
        nv.value = vals; nv.dispatchEvent(new Event('input',{bubbles:true}));
      };
      setSlot('服装','A1\\nA2');
      setSlot('场景','B1\\nB2');
      await new Promise(r=>setTimeout(r,100));
      const sd = d.querySelector('[data-pane="batch"] [data-f="skipDup"]');
      sd.checked = true; sd.dispatchEvent(new Event('change',{bubbles:true}));
      const cn = d.querySelector('[data-pane="batch"] [data-f="count"]');
      cn.value = '99'; cn.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
      const o1 = {
        comboNum: d.querySelector('#comboNum').textContent,
        warnShown: d.querySelector('#countWarn').classList.contains('show'),
        warnText: d.querySelector('#countWarn').textContent,
        lineOver: d.querySelector('#comboLine').classList.contains('over')
      };
      window.__alerted = null;
      await generateBatch();
      return { o1, alerted: window.__alerted, busy: S.busy };`);
    log('  ' + JSON.stringify(r.o1));
    r.o1.comboNum === '4' ? ok('组合数正确算成 4') : bad('组合数不对', r.o1.comboNum);
    r.o1.warnShown ? ok('张数超限警告已显示') : bad('未警告');
    r.o1.warnText.includes('不能超过') ? ok('警告文案正确') : bad('文案不对', r.o1.warnText);
    r.o1.lineOver ? ok('组合数行标红') : bad('未标红');
    r.alerted && r.alerted.includes('不能超过组合总数 4')
      ? ok('生成时硬拦超限张数') : bad('未拦住', r.alerted);
    r.busy === false ? ok('拦截后未进入 busy') : bad('错误进入 busy');
  }

  log('\n=== F. 组合预览与随机性 ===');
  {
    const r = await ev(`
      const d = document;
      const cn = d.querySelector('[data-pane="batch"] [data-f="count"]');
      cn.value = '4'; cn.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
      syncBatchLabels();
      const rows = d.querySelectorAll('#comboPrev .r').length;
      const p1 = S.b.preview.map(c=>c.key);
      d.querySelector('#prevRoll').click();
      const p2 = S.b.preview.map(c=>c.key);
      return { rows, p1, p2, changed: JSON.stringify(p1)!==JSON.stringify(p2), uniq: new Set(p1).size };`);
    log('  ' + JSON.stringify(r));
    r.rows === 4 ? ok('预览渲染 4 行') : bad('预览行数不对', r.rows);
    r.uniq === 4 ? ok('勾选跳过后 4 行互不重复') : bad('预览有重复', r.uniq);
    r.changed ? ok('重新随机预览会变') : bad('预览没变化（随机性异常）');
  }

  log('\n=== G. 配置持久化（刷新不丢失）===');
  {
    // 通过「新增占位符」按钮真实创建两个数组，再改名与填值，
    // 走的是用户真实操作路径（而不是直接改内存）
    await ev(`
      const d = document;
      const ta = d.querySelector('[data-pane="batch"] [data-f="template"]');
      ta.value = '持久化测试 {{甲}} 和 {{乙}}';
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,80));

      // 新增两个占位符
      d.querySelector('#slotAdd').click();
      await new Promise(r=>setTimeout(r,60));
      d.querySelector('#slotAdd').click();
      await new Promise(r=>setTimeout(r,60));

      // 把最后两个改成 甲 / 乙 并填值
      const slots = [...d.querySelectorAll('#slotList .slot')];
      const setSlot = (el, name, vals) => {
        const ni = el.querySelector('[data-slotname]');
        const nv = el.querySelector('[data-slotvals]');
        ni.value = name; ni.dispatchEvent(new Event('input',{bubbles:true}));
        nv.value = vals; nv.dispatchEvent(new Event('input',{bubbles:true}));
      };
      setSlot(slots[slots.length-2], '甲', 'A1\\nA2');
      setSlot(slots[slots.length-1], '乙', 'B1\\nB2');
      await new Promise(r=>setTimeout(r,150));
      await cfgSaveNow();`);
    await sleep(250);

    let disk = readDiskCfg();
    disk.batch.template === '持久化测试 {{甲}} 和 {{乙}}'
      ? ok('磁盘上的模板内容正确') : bad('磁盘内容不对', disk.batch.template);
    const names = disk.batch.slots.map(s => s.name);
    names.includes('甲') && names.includes('乙')
      ? ok('磁盘上包含新建的数组（甲/乙）') : bad('磁盘数组不对', JSON.stringify(names));
    const jia = disk.batch.slots.find(s => s.name === '甲');
    jia && jia.values.join(',') === 'A1,A2'
      ? ok('数组取值正确落盘') : bad('取值不对', JSON.stringify(jia));

    // 重建页面 = 刷新
    await makePage();
    const r = await ev(`return {
      tpl: S.m.batch.template,
      hasJia: S.m.batch.slots.some(s=>s.name==='甲' && s.values.join(',')==='A1,A2'),
      hasYi: S.m.batch.slots.some(s=>s.name==='乙'),
      cfgOk: S.b.cfgOk
    };`);
    log('  ' + JSON.stringify(r));
    r.tpl === '持久化测试 {{甲}} 和 {{乙}}' ? ok('刷新后模板保留（核心需求）') : bad('模板丢失', r.tpl);
    r.hasJia ? ok('刷新后「甲」数组与取值保留') : bad('甲数组丢失');
    r.hasYi ? ok('刷新后「乙」数组保留') : bad('乙数组丢失');
    r.cfgOk ? ok('刷新后配置服务仍连上') : bad('配置服务断开');
  }

  log('\n=== H. 恢复默认 ===');
  {
    // 注意：G 段刚把配置改成「甲/乙」两个数组，这里点「恢复默认」应当
    // 回到出厂 3 组（服装 6 / 场景 6 / 动作 8 = 288 组合）。
    // 用出厂定义算出期望值，避免把数字写死在对不上时难以定位。
    const expectCombo = BATCH_FACTORY_COMBO;
    const r = await ev(`
      window.confirm = () => true;
      switchMode('batch');
      await new Promise(r=>setTimeout(r,80));
      document.querySelector('#tplReset').click();
      await new Promise(r=>setTimeout(r,900));   // 等 loadBatchPane + planSave 走完
      return {
        slots: S.m.batch.slots.length,
        actionCount: (S.m.batch.slots.find(s=>s.name==='动作')||{values:[]}).values.length,
        tplHas3: ['服装','场景','动作'].every(n=>S.m.batch.template.includes('{{'+n+'}}')),
        comboNum: document.querySelector('#comboNum').textContent,
        cfgOk: S.b.cfgOk
      };`);
    log('  ' + JSON.stringify(r) + `  （期望组合数 ${expectCombo}）`);
    r.slots === 3 ? ok('恢复为 3 组数组') : bad('数组数不对', r.slots);
    r.actionCount === 8 ? ok('动作数组恢复为 8 条') : bad('动作条数不对', r.actionCount);
    r.tplHas3 ? ok('模板恢复为出厂内容') : bad('模板未恢复');
    String(r.comboNum) === String(expectCombo)
      ? ok(`组合数回到 ${expectCombo}`) : bad('组合数不对', r.comboNum);

    await sleep(400);
    const disk = readDiskCfg();
    disk.batch.slots.length === 3 ? ok('恢复默认已落盘') : bad('恢复默认未落盘');
    disk.batch.slots.find(s => s.name === '动作')?.values.length === 8
      ? ok('磁盘上动作数组为 8 条') : bad('磁盘动作条数不对');
  }

  log('\n=== I. 计划续跑（1 档：只续计划）===');
  {
    await ev(`
      S.b.plan = {
        id: 'batch-test', status: 'paused', total: 10, cursor: 4,
        usedCombos: ['0|0|0','1|1|1','2|2|2','3|3|3'],
        templateHash: templateHash(S.m.batch.template, S.m.batch.slots),
        frozen: { width: 768, height: 768, steps: 8, cfg: 1, sampler:'euler', scheduler:'discrete', seed: 12345, negative: '' },
        results: []
      };
      await planSave();`);
    await sleep(250);

    const disk = readDiskCfg();
    disk.plan && disk.plan.cursor === 4 ? ok('计划已落盘（cursor=4）') : bad('计划未落盘', JSON.stringify(disk.plan));

    // 刷新
    await makePage();
    const r = await ev(`
      const card = document.querySelector('#planCard');
      return {
        planLoaded: !!S.b.plan,
        cursor: S.b.plan?.cursor,
        cardShown: card.classList.contains('show'),
        title: document.querySelector('#planTitle').textContent,
        desc: document.querySelector('#planDesc').textContent,
        resumeLabel: document.querySelector('#planResume').textContent,
        autoRan: S.busy,
        stat: document.querySelector('#stat').textContent
      };`);
    log('  ' + JSON.stringify(r));
    r.planLoaded ? ok('刷新后计划被载入') : bad('计划丢失');
    r.cursor === 4 ? ok('cursor 正确恢复') : bad('cursor 不对', r.cursor);
    r.cardShown ? ok('显示未完成批次卡片') : bad('卡片未显示');
    r.title.includes('未完成') ? ok('卡片标题正确') : bad('标题不对', r.title);
    r.desc.includes('4/10') ? ok('卡片显示进度 4/10') : bad('进度不对', r.desc);
    r.resumeLabel.includes('剩 6 张') ? ok('继续按钮显示剩余张数') : bad('按钮文案不对', r.resumeLabel);
    r.autoRan === false ? ok('不自动跑（只提示）') : bad('竟然自动跑了');
    r.stat.includes('未完成') ? ok('顶栏提示未完成批次') : bad('顶栏未提示', r.stat);
  }

  log('\n=== J. 改模板 → 旧计划作废 ===');
  {
    const r = await ev(`
      switchMode('batch');
      await new Promise(r=>setTimeout(r,80));
      const ta = document.querySelector('[data-pane="batch"] [data-f="template"]');
      ta.value = S.m.batch.template + '\\n改过了';
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,120));
      renderPlanCard();
      return {
        planNull: S.b.plan === null,
        cardShown: document.querySelector('#planCard').classList.contains('show')
      };`);
    log('  ' + JSON.stringify(r));
    r.planNull ? ok('改模板后旧计划作废') : bad('旧计划未作废');
    r.cardShown === false ? ok('批次卡片已隐藏') : bad('卡片仍在');
  }

  log('\n=== K. 配置服务降级 ===');
  {
    const r = await ev(`
      const orig = window.fetch;
      window.fetch = function(url, ...rest){
        if (String(url).includes(':${CFG_PORT}')) return Promise.reject(new Error('ECONNREFUSED'));
        return orig.call(this, url, ...rest);
      };
      const c = await cfgLoad();
      const out = {
        cfgLoadNull: c === null,
        cfgOk: S.b.cfgOk,
        barClass: document.querySelector('#cfgBar').className,
        capsOk: !!S.caps,
        tplStillThere: S.m.batch.template.length > 100
      };
      window.fetch = orig;
      return out;`);
    log('  ' + JSON.stringify(r));
    r.cfgLoadNull ? ok('配置服务不可用时 cfgLoad 返回 null') : bad('未正确降级');
    r.cfgOk === false ? ok('降级标志已置') : bad('降级标志未置');
    r.barClass.includes('err') ? ok('状态条显示错误') : bad('状态条未提示', r.barClass);
    r.capsOk ? ok('主功能（sd-server 连接）不受影响') : bad('主功能被影响');
    r.tplStillThere ? ok('降级后模板仍可用（回退出厂默认）') : bad('模板丢失');
  }

  log('\n=== L. 参数继承 + 冻结快照 ===');
  {
    const r = await ev(`
      S.m.txt2img.w = 512; S.m.txt2img.h = 512; S.m.txt2img.steps = 12;
      const p1 = batchParams();
      const body = batchBody('测试提示词', 999);
      S.b.frozen = { width:512, height:512, steps:12, cfg:1, sampler:'euler', scheduler:'discrete', seed:1, negative:'' };
      S.m.txt2img.w = 1024;
      const p2 = batchParams();
      S.b.frozen = null;
      S.m.txt2img.w = 768;
      return {
        p1, p2,
        bodyPrompt: body.prompt, bodyW: body.width, bodySteps: body.sample_params.sample_steps,
        bodyBatch: body.batch_count, bodyGuidance: JSON.stringify(body.sample_params.guidance)
      };`);
    log('  p1=' + JSON.stringify(r.p1));
    log('  p2=' + JSON.stringify(r.p2));
    r.p1.w === 512 && r.p1.h === 512 && r.p1.steps === 12
      ? ok('批量继承文生图的尺寸与步数') : bad('参数未继承', JSON.stringify(r.p1));
    r.bodyPrompt === '测试提示词' && r.bodyW === 512 && r.bodySteps === 12
      ? ok('batchBody 正确构造请求体') : bad('请求体不对');
    r.bodyBatch === 1 ? ok('每张只出 1 张（串行）') : bad('batch_count 不对');
    r.p2.w === 512 ? ok('冻结快照生效（改文生图不影响本批）') : bad('冻结失效', r.p2.w);
  }

  log('\n=== M. 模式切换不串状态 ===');
  {
    const r = await ev(`
      // 切到图生图再切回批量，批量模板不应被覆盖
      const before = S.m.batch.template;
      const domBefore = document.querySelector('[data-pane="batch"] [data-f="template"]').value;
      switchMode('txt2img'); await new Promise(r=>setTimeout(r,50));
      const afterLeave = S.m.batch.template;
      switchMode('img2img'); await new Promise(r=>setTimeout(r,50));
      switchMode('batch');   await new Promise(r=>setTimeout(r,50));
      const after = S.m.batch.template;
      const ta = document.querySelector('[data-pane="batch"] [data-f="template"]');
      return {
        same: before === after,
        beforeLen: before.length, afterLen: after.length,
        beforeTail: before.slice(-14), afterTail: after.slice(-14),
        domBeforeLen: domBefore.length, afterLeaveLen: afterLeave.length,
        domMatches: ta.value === after,
        mode: S.mode,
        txt2imgPromptIntact: typeof S.m.txt2img.prompt === 'string'
      };`);
    log('  ' + JSON.stringify(r));
    r.same ? ok('切换模式后批量模板不丢失') : bad('模板被覆盖',
      `before(${r.beforeLen})尾=${JSON.stringify(r.beforeTail)} vs after(${r.afterLen})尾=${JSON.stringify(r.afterTail)}`);
    r.domMatches ? ok('textarea 内容与状态一致') : bad('DOM 与状态不一致');
    r.mode === 'batch' ? ok('最终停在批量模式') : bad('模式不对', r.mode);
  }

  log('\n=== O. 回归：预览必须等于实际生成（Bug 1） ===');
  {
    const r = await ev(`
      // 造一个小组合空间，方便逐一核对
      const d = document;
      switchMode('batch');
      await new Promise(r=>setTimeout(r,80));
      const ta = d.querySelector('[data-pane="batch"] [data-f="template"]');
      ta.value = '{{服装}}与{{场景}}'; ta.dispatchEvent(new Event('input',{bubbles:true}));
      const setSlot = (name, vals) => {
        const slot = [...d.querySelectorAll('#slotList .slot')].find(x => S.m.batch.slots[+x.dataset.i].name === name);
        const nv = slot.querySelector('[data-slotvals]');
        nv.value = vals; nv.dispatchEvent(new Event('input',{bubbles:true}));
      };
      setSlot('服装','A1\\nA2\\nA3');
      setSlot('场景','B1\\nB2');
      await new Promise(r=>setTimeout(r,120));
      const cn = d.querySelector('[data-pane="batch"] [data-f="count"]');
      cn.value = '5'; cn.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,120));

      // 预览展示的组合（前 5 行）
      syncBatchLabels();
      const previewKeys = S.b.preview.map(c => c.key);

      // 抓取实际提交的提示词
      window.__prompts = [];
      const origFetch = window.fetch;
      window.fetch = function(url, ...rest){
        if (String(url).includes('/sdcpp/v1/img_gen')){
          try { window.__prompts.push(JSON.parse(rest[0].body).prompt); } catch(_){}
          // 立刻返回一个失败的 job，避免真的等
          return Promise.resolve(new Response(JSON.stringify({ id: 'fake' }), { status: 202 }));
        }
        if (String(url).includes('/sdcpp/v1/jobs/')){
          return Promise.resolve(new Response(JSON.stringify({ status: 'failed', error: { message: 'test' } }), { status: 200 }));
        }
        return origFetch.call(this, url, ...rest);
      };
      window.alert = () => {};

      // 起一批（跑一张就会因为 fake 失败而停，够验证第一张）
      await generateBatch();
      window.fetch = origFetch;

      return {
        previewKeys,
        planCombos: S.b.plan ? S.b.plan.combos.map(r => r.join('|')) : null,
        firstPrompt: window.__prompts[0] || '',
        count: previewKeys.length
      };`);
    log('  预览组合: ' + JSON.stringify(r.previewKeys));
    log('  计划组合: ' + JSON.stringify(r.planCombos));
    log('  首个提示词: ' + JSON.stringify(r.firstPrompt));

    r.count === 5 ? ok('预览给出 5 条组合') : bad('预览条数不对', r.count);
    JSON.stringify(r.previewKeys) === JSON.stringify(r.planCombos)
      ? ok('计划里的组合 = 预览展示的组合（Bug 1 已修）')
      : bad('计划与预览仍不一致');

    // 第一条提示词必须由第一条预览组合渲染而来
    const top = r.previewKeys[0].split('|').map(Number);
    const outfit = ['A1','A2','A3'][top[0]];
    const scene = ['B1','B2'][top[1]];
    r.firstPrompt.includes(outfit) && r.firstPrompt.includes(scene)
      ? ok(`实际提交的提示词用的是预览第 1 条（${outfit}/${scene}）`)
      : bad('提示词与预览第 1 条不符', r.firstPrompt.slice(0, 60));
  }

  log('\n=== P. 回归：生成中不得提供「继续」（Bug 2） ===');
  {
    const r = await ev(`
      const d = document;
      // 造一个"正在跑"的状态
      S.b.planActive = true;
      S.busy = true;
      S.b.plan = {
        id: 't', status: 'running', total: 8, cursor: 2,
        templateHash: templateHash(S.m.batch.template, S.m.batch.slots),
        usedCombos: [], combos: [[0,0],[1,1]], frozen: null, results: []
      };
      renderPlanCard();
      const card = d.querySelector('#planCard');
      const out1 = {
        cardShown: card.classList.contains('show'),
        isLive: card.classList.contains('live'),
        title: d.querySelector('#planTitle').textContent,
        resumeHidden: d.querySelector('#planResume').style.display === 'none',
        abandonLabel: d.querySelector('#planAbandon').textContent
      };

      // resumeBatch 必须被 busy 守卫拦住
      const before = S.b.cursor;
      await resumeBatch();
      const out2 = { cursorUnchanged: S.b.cursor === before, stillBusy: S.busy };

      // 复位
      S.b.planActive = false; S.b.busy = false;
      S.busy = false;
      return { out1, out2 };`);
    log('  ' + JSON.stringify(r.out1));
    r.out1.cardShown ? ok('批次卡仍显示') : bad('卡片未显示');
    r.out1.isLive ? ok('卡片显示为「进行中」状态') : bad('未进入进行中状态');
    r.out1.title.includes('正在生成') ? ok('标题为「正在生成这一批」') : bad('标题不对', r.out1.title);
    r.out1.resumeHidden ? ok('「继续」按钮已隐藏（关键）') : bad('「继续」仍可见');
    r.out1.abandonLabel.includes('取消') ? ok('按钮文案改为「取消这一批」') : bad('文案不对', r.out1.abandonLabel);
    log('  ' + JSON.stringify(r.out2));
    r.out2.cursorUnchanged ? ok('busy 时调用 resumeBatch 不改变进度') : bad('cursor 被改动');
    r.out2.stillBusy ? ok('busy 状态未被破坏') : bad('busy 被清掉');
  }

  log('\n=== Q. 回归：空闲时才允许「继续」 ===');
  {
    const r = await ev(`
      const d = document;
      // 复位后：非进行中 + 未完成 → 应显示「继续」
      S.b.planActive = false;
      S.busy = false;
      S.b.plan = {
        id: 't2', status: 'paused', total: 8, cursor: 2,
        templateHash: templateHash(S.m.batch.template, S.m.batch.slots),
        usedCombos: [], combos: [], frozen: null, results: []
      };
      renderPlanCard();
      const card = d.querySelector('#planCard');
      const out = {
        isLive: card.classList.contains('live'),
        title: d.querySelector('#planTitle').textContent,
        resumeShown: d.querySelector('#planResume').style.display !== 'none',
        resumeLabel: d.querySelector('#planResume').textContent,
        abandonLabel: d.querySelector('#planAbandon').textContent
      };
      // 清理
      S.b.plan = null; renderPlanCard();
      return out;`);
    log('  ' + JSON.stringify(r));
    r.isLive === false ? ok('空闲时不是进行中样式') : bad('仍显示进行中');
    r.title.includes('未完成') ? ok('标题为「有未完成的批次」') : bad('标题不对', r.title);
    r.resumeShown ? ok('「继续」按钮可见') : bad('「继续」被误隐藏');
    r.resumeLabel.includes('剩 6 张') ? ok('显示剩余张数') : bad('剩余张数不对', r.resumeLabel);
    r.abandonLabel.includes('放弃') ? ok('按钮文案为「放弃本批次」') : bad('文案不对', r.abandonLabel);
  }

  log('\n=== R. 回归：磁盘上残留 running 状态在启动时降级 ===');
  {
    // 关键：hash 必须与「重新加载后页面算出来的 hash」一致。
    // 前面的段落改过模板，而页面重载后会从磁盘恢复，
    // 所以这里必须【先重新加载一次拿到稳定的模板】，再写计划。
    await ev(`await cfgSaveNow();`);
    await sleep(250);
    await makePage();                       // ← 重载，让内存状态 = 磁盘状态
    const hash = await ev(`return templateHash(S.m.batch.template, S.m.batch.slots)`);

    const cfg = readDiskCfg();
    cfg.plan = {
      id: 'stale', status: 'running', total: 6, cursor: 1,
      templateHash: hash, usedCombos: [], combos: [], frozen: null, results: []
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    await makePage();                       // ← 再重载，验证降级
    const r = await ev(`return {
      status: S.b.plan ? S.b.plan.status : null,
      cursor: S.b.plan ? S.b.plan.cursor : null,
      hashNow: templateHash(S.m.batch.template, S.m.batch.slots),
      planActive: S.b.planActive,
      busy: S.busy
    };`);
    log('  ' + JSON.stringify(r));
    r.status === 'paused' ? ok('残留的 running 被降级为 paused') : bad('未降级', r.status);
    r.cursor === 1 ? ok('进度 cursor 被保留') : bad('cursor 丢失', r.cursor);
    r.hashNow === hash ? ok('模板哈希一致（计划未被误判作废）') : bad('哈希不一致');
    r.planActive === false ? ok('planActive 为 false') : bad('planActive 未复位');
    r.busy === false ? ok('busy 为 false') : bad('busy 未复位');
  }

  /* ══ M2. 百万级组合空间：输入路径不卡顿 + 本批组合完整可用 ══
     回归「跳过重复」的 O(n × total) 全量枚举：旧实现下 total=100 万时，
     单次 syncBatchLabels（输入框每敲一个字符都会走）要 2.7 秒，
     1139 万时 42 秒，页面直接假死。 */
  log('\n=== M2. 百万级组合空间（性能回归）===');
  {
    await ev(`
      window.confirm = () => true;
      switchMode('batch');
      await new Promise(r=>setTimeout(r,80));
      // 直接铺一个百万级空间：4 个占位符 × 各 32 条 = 1048576 组合
      S.m.batch.template = '{{p}}{{q}}{{r}}{{s}}';
      S.m.batch.slots = [
        { name:'p', values: Array.from({length:32},(_,i)=>'p'+i) },
        { name:'q', values: Array.from({length:32},(_,i)=>'q'+i) },
        { name:'r', values: Array.from({length:32},(_,i)=>'r'+i) },
        { name:'s', values: Array.from({length:32},(_,i)=>'s'+i) }
      ];
      S.m.batch.skipDup = true;
      S.m.batch.count = 40;
      loadBatchPane();
      await new Promise(r=>setTimeout(r,120));
    `);

    const total = await evs(`comboCount(S.m.batch.slots, S.m.batch.template)`);
    total === 1048576 ? ok(`组合数 = 1048576（实测 ${total}）`) : bad('组合数不对', total);

    // ① 输入路径耗时：模拟连打 10 个字符，每次都走 onSlotEdit → syncBatchLabels
    const perf = await ev(`
      const t0 = performance.now();
      for (let i = 0; i < 10; i++){
        S.m.batch.count = 40 + i;
        syncBatchLabels();
      }
      const dt = performance.now() - t0;
      return { dt, per: dt / 10 };`);
    log(`  输入路径 10 次同步：${perf.dt.toFixed(1)} ms（${perf.per.toFixed(2)} ms/次）`);
    perf.per < 50
      ? ok(`每次输入同步 < 50ms（实测 ${perf.per.toFixed(2)}ms）`)
      : bad('输入路径仍然卡顿', perf.per.toFixed(1) + ' ms/次');

    // ② 重新预览按钮：同样必须秒回
    const roll = await ev(`
      const t0 = performance.now();
      document.querySelector('#prevRoll').click();
      const dt = performance.now() - t0;
      return { dt, rows: document.querySelectorAll('#comboPrev .r').length };`);
    log(`  「重新预览」耗时：${roll.dt.toFixed(1)} ms`);
    roll.dt < 200 ? ok(`重新预览 < 200ms（实测 ${roll.dt.toFixed(1)}ms）`) : bad('预览卡顿', roll.dt.toFixed(1) + 'ms');

    // ③ 百万级空间下，预览里的组合必须真的互不重复
    const uniq = await ev(`
      const keys = S.b.preview.map(c => c.key);
      return { n: keys.length, uniq: new Set(keys).size };`);
    uniq.n === 40 && uniq.uniq === 40
      ? ok('百万级空间下预览 40 张互不重复')
      : bad('预览有重复或数量不对', JSON.stringify(uniq));

    // ④ 真的跑一批（拦住网络，只验证组合表与计划落盘的一致性）
    const run = await ev(`
      window.__netBlocked = true;
      const p0 = S.b.preview.map(c => c.key);
      S.b.plan = {
        id:'perf-'+Date.now(), status:'running', total:0, cursor:0,
        slotNames:null, combos:[], usedCombos:[], templateHash:'', frozen:null, results:[]
      };
      const combos = ensurePreview();
      const { found } = scanSlots(S.m.batch.template);
      const slotNames = [...new Set(found.map(f => f.name.trim()).filter(Boolean))];
      S.b.comboIdx = combos.map(c => c.idxs);
      S.b.slotNames = slotNames;
      S.b.planTotal = combos.length;
      // 逐张走真实取值路径 comboAt()，检查索引表能精确复原每组
      const bad = [];
      for (let i = 0; i < combos.length; i++){
        const c = comboAt(i);
        if (!c || c.key !== p0[i]) bad.push(i);
      }
      return { n: combos.length, bad, sample: comboAt(0).key };`);
    log('  ' + JSON.stringify(run));
    run.n === 40 ? ok('本批冻结 40 组索引') : bad('冻结数量不对', run.n);
    run.bad.length === 0
      ? ok('comboAt(i) 逐张复原的 key 与预览完全一致（索引表无错位）')
      : bad('索引表错位', JSON.stringify(run.bad.slice(0, 5)));

    // ⑤ 极端空间：1 亿组合，仍须即时
    const huge = await ev(`
      S.m.batch.slots = [
        { name:'p', values: Array.from({length:100},(_,i)=>'p'+i) },
        { name:'q', values: Array.from({length:100},(_,i)=>'q'+i) },
        { name:'r', values: Array.from({length:100},(_,i)=>'r'+i) },
        { name:'s', values: Array.from({length:100},(_,i)=>'s'+i) }
      ];
      S.m.batch.count = 30;
      const t0 = performance.now();
      syncBatchLabels();
      const dt = performance.now() - t0;
      const keys = S.b.preview.map(c => c.key);
      return { dt, total: comboCount(S.m.batch.slots, S.m.batch.template),
               uniq: new Set(keys).size, n: keys.length };`);
    log(`  1 亿组合空间：${huge.dt.toFixed(1)} ms，唯一 ${huge.uniq}/${huge.n}`);
    huge.total === 100000000 ? ok('组合数 = 1 亿') : bad('组合数不对', huge.total);
    huge.dt < 200 ? ok(`1 亿空间预览 < 200ms（实测 ${huge.dt.toFixed(1)}ms）`) : bad('1 亿空间卡顿', huge.dt.toFixed(1) + 'ms');
    huge.uniq === huge.n ? ok('1 亿空间下 30 张互不重复') : bad('1 亿空间出现重复', JSON.stringify(huge));

    // 收尾：清掉计划，别影响后面的段落
    await ev(`
      S.b.plan = null; S.b.comboIdx = null; S.b.slotNames = null;
      S.b.planTotal = 0; S.b.planActive = false; S.b.preview = [];
      window.__netBlocked = false;`);
    await ev(`await cfgSaveNow();`);
    await sleep(150);
    await makePage();               // 重载，让后面的段落从干净状态继续
  }

  log('\n=== N. 页面 JS 异常检查 ===');
  {
    const real = page.jsErrors.filter(e => !/fetch|network|ECONNREFUSED|Not implemented|indexedDB|canvas/i.test(e));
    if (real.length) bad('页面有 JS 异常', real.slice(0, 3).join(' | '));
    else ok('无 JS 运行时异常');
    log(`  （原始 ${page.jsErrors.length} 条，过滤环境类后 ${real.length} 条）`);
    if (page.jsErrors.length) log('  样本: ' + page.jsErrors.slice(0, 2).join(' || ').slice(0, 220));
  }

  log(`\n${'─'.repeat(48)}`);
  log(`DOM 端到端结果：${pass} 通过 / ${fail} 失败`);
  if (problems.length){
    log('\n失败清单：');
    problems.forEach(p => log('  · ' + p));
  }
  return fail;
}

let code = 1;
try { code = await main(); }
catch (e){ console.error('\n测试异常：', e.stack || e.message); code = 1; }
finally {
  try { cfgProc.kill(); } catch(_){}
  try { fs.unlinkSync(TEST_CFG); } catch(_){}
  try { fs.unlinkSync(TEST_CFG + '.tmp'); } catch(_){}
  await sleep(300);
}
process.exit(code);
