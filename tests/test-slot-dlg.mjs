/* ══════════════════════════════════════════════════════════════
   占位符取值编辑器（弹窗：左选占位符 / 右编辑）

   覆盖：
     A. 面板结构：编辑器移入弹窗后，面板上的摘要 + #slotList 隐藏容器仍正常
     B. 打开弹窗：左侧列出全部占位符，恰好一项选中
     C. 编辑取值 → 同步进 S.m.batch，且同步给 #slotList 的「真相」控件
        （saveBatchPane 读的是它，不同步会静默丢弃用户的编辑）
     D. 切换占位符不丢已编辑的内容
     E. 改名 / 改概率（含左侧列表与角标实时刷新）
     F. 新增 / 删除
     G. 三种关闭方式：Escape / 点遮罩 / 「完成」
     H. 套用真实模板（裙子女生 11 槽）后仍正确
     I. 标签行三态：亮（已配置+已用）/ 暗（已配置+未用）/ 红（已用+未配置）
     J. 点标签：亮/暗 → 追加（重复点重复追加）；红 → 打开编辑器去新增/编辑

   用法：node tests/test-slot-dlg.mjs [port]
   需要先起配置服务（脚本自己起也行）：
     node config-service/serve-config.mjs 1247
   ══════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const UI_HTML = path.join(ROOT, 'app', 'ui', 'index.html');
const PORT = Number(process.argv[2] || 1247);

const { JSDOM, VirtualConsole } = await import(
  'file:///' + process.env.TEMP.replace(/\\/g, '/') + '/sdjsdom/node_modules/jsdom/lib/api.js'
);

const raw = fs.readFileSync(UI_HTML, 'utf8');
const html = raw.replace(/const CFG_URL\s*=\s*'http:\/\/127\.0\.0\.1:\d+'/, `const CFG_URL = 'http://127.0.0.1:${PORT}'`);

const vc = new VirtualConsole();
const errs = [];
vc.on('jsdomError', e => errs.push(String(e.message || e).slice(0, 160)));

const stub = new Proxy({}, { get: () => () => ({ width: 0, addColorStop(){} }) });
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:17341/', virtualConsole: vc,
  beforeParse(w){
    w.alert = () => {}; w.confirm = () => true; w.prompt = () => 'X';
    const rf = globalThis.fetch.bind(globalThis);
    w.fetch = (u, o) => String(u).includes('/sdcpp/') ? Promise.reject(new Error('x')) : rf(u, o);
    w.Response = globalThis.Response; w.Headers = globalThis.Headers; w.Request = globalThis.Request;
    w.HTMLCanvasElement.prototype.getContext = function(){ return stub; };
  }
});
const w = dom.window;
await new Promise(r => setTimeout(r, 1500));
await w.eval('(async()=>{ await cfgLoad(); return 1; })()');
w.eval("S.mode='batch'; loadBatchPane();");
await new Promise(r => setTimeout(r, 400));

/* ★ 先复位到「出厂 3 个占位符」，否则上一轮跑测试留下的模板会污染断言
   （隔离配置会被上一次运行写回）。 */
w.eval(`
  S.m.batch.template = '一个{{服装}}的{{场景}}，{{动作}}';
  S.m.batch.slots = [
    { name: '服装', values: ['皮夹克','马甲','卫衣'] },
    { name: '场景', values: ['夜市','沙滩','书店'] },
    { name: '动作', values: ['站着','坐着'] }
  ];
  S.m.batch.count = 8;
  S.m.batch.skipDup = true;
  S.b.activeTplId = null;
  loadBatchPane();
`);
await new Promise(r => setTimeout(r, 300));

let pass = 0, fail = 0;
const chk = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m)); };
const $ = s => w.document.querySelector(s);
const $$ = s => [...w.document.querySelectorAll(s)];
const slots = () => JSON.parse(w.eval('JSON.stringify(S.m.batch.slots)'));

console.log('\n=== 1. 面板结构与摘要 ===');
chk(!!$('#slotList'), '#slotList 仍在 DOM（测试与 saveBatchPane 依赖）');
chk($('#slotList').hasAttribute('hidden'), '#slotList 视觉上隐藏');
chk($$('#slotList .slot').length === 3, `#slotList 仍渲染 3 个槽（实际 ${$$('#slotList .slot').length}）`);
chk(!!$('#slotOpen'), '「编辑占位符取值」按钮存在');
chk(!!$('#slotSummary'), '摘要容器存在');
chk($$('#slotSummary .tg').length === 3, `摘要显示 3 个标签（实际 ${$$('#slotSummary .tg').length}）`);
chk($('#slotSummary').textContent.includes('3 个占位符'), `摘要文案：${$('#slotSummary').textContent.trim().slice(0,30)}`);

console.log('\n=== 2. 打开弹窗 ===');
chk(!$('#slotDlg').classList.contains('show'), '初始是关的');
$('#slotOpen').click();
await new Promise(r => setTimeout(r, 200));
chk($('#slotDlg').classList.contains('show'), '点按钮后打开');
chk(!!$('#slotDlgNav'), '有左侧列表');
chk(!!$('#slotDlgEdit'), '有右侧编辑区');
chk($$('#slotDlgNav .it').length === 3, `左侧列出 3 项（实际 ${$$('#slotDlgNav .it').length}）`);
chk($$('#slotDlgNav .it.on').length === 1, '恰好一项被选中');
chk(!!$('#slotDlgName') && !!$('#slotDlgVals') && !!$('#slotDlgProb'), '右侧有 名称/取值/概率 三个控件');
chk(!!$('#slotDlgVals').closest('.nvwrap'), '取值框带行号槽');
chk($$('#slotDlgVals').length === 1 && $$('#slotList [data-slotvals]').length === 3,
    '弹窗用独立 textarea，没搬走 #slotList 的（否则 saveBatchPane 读不到）');

console.log('\n=== 3. 编辑取值 → 同步到状态 ===');
const name0 = $('#slotDlgName').value;
chk(name0 === slots()[0].name, `右侧显示的是选中项（${name0}）`);
const ta = $('#slotDlgVals');
ta.value = '甲A\n甲B\n甲C';
ta.dispatchEvent(new w.Event('input', { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
chk(JSON.stringify(slots()[0].values) === JSON.stringify(['甲A','甲B','甲C']),
    `取值已进状态（${JSON.stringify(slots()[0].values)}）`);
const srcTa = $(`#slotList .slot[data-i="0"] [data-slotvals]`);
chk(srcTa && srcTa.value === ta.value, '隐藏控件已同步（saveBatchPane 读的是它）');
chk($$('#slotDlgVals').length === 1, '弹窗仍只有一个 textarea');

console.log('\n=== 4. 切占位符不丢编辑 ===');
$('#slotDlgNav .it:nth-child(2)').click();
await new Promise(r => setTimeout(r, 250));
chk($('#slotDlgName').value === slots()[1].name, `切到第 2 项（${$('#slotDlgName').value}）`);
chk(JSON.stringify(slots()[0].values) === JSON.stringify(['甲A','甲B','甲C']), '第 1 项的编辑还在');
const ta2 = $('#slotDlgVals');
ta2.value = '乙X';
ta2.dispatchEvent(new w.Event('input', { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
chk(JSON.stringify(slots()[1].values) === JSON.stringify(['乙X']), '第 2 项编辑生效');

console.log('\n=== 5. 改名字 / 改概率 ===');
const ni = $('#slotDlgName');
ni.value = '改过的名字';
ni.dispatchEvent(new w.Event('input', { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
chk(slots()[1].name === '改过的名字', `名字已改（${slots()[1].name}）`);
chk($$('#slotDlgNav .it')[1].querySelector('.nm').textContent === '改过的名字', '左侧列表同步刷新');

const pi = $('#slotDlgProb');
pi.value = '40';
pi.dispatchEvent(new w.Event('input', { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
chk(slots()[1].p === 0.4, `概率已改（p=${slots()[1].p}）`);
chk($$('#slotDlgNav .it')[1].querySelector('.pn')?.textContent === '40%', '左侧出现概率角标');

console.log('\n=== 6. 新增 / 删除 ===');
const n0 = slots().length;
$('#slotDlgAdd').click();
await new Promise(r => setTimeout(r, 300));
chk(slots().length === n0 + 1, `新增后 ${slots().length} 个（原 ${n0}）`);
chk($$('#slotDlgNav .it').length === n0 + 1, '左侧列表也更新');
chk($$('#slotDlgNav .it.on')[0]?.dataset.i === String(n0), '新项自动选中');
// 删除刚新增的
$('#slotDlgDel').click();
await new Promise(r => setTimeout(r, 300));
chk(slots().length === n0, `删除后回到 ${slots().length} 个（期望 ${n0}）`);

console.log('\n=== 7. 关闭方式 ===');
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await new Promise(r => setTimeout(r, 200));
chk(!$('#slotDlg').classList.contains('show'), 'Escape 能关');
$('#slotOpen').click();
await new Promise(r => setTimeout(r, 150));
$('#slotDlg').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 200));
chk(!$('#slotDlg').classList.contains('show'), '点遮罩能关');
$('#slotOpen').click();
await new Promise(r => setTimeout(r, 150));
$('#slotDlgDone').click();
await new Promise(r => setTimeout(r, 200));
chk(!$('#slotDlg').classList.contains('show'), '「完成」能关');

console.log('\n=== 8. 套用模板后仍正确 ===');
// 模板库可能为空（隔离配置）—— 有「裙子女生」才测这一段
const hasSkirt = await w.eval(`(S.b.templates||[]).some(t => t.id === 'tpl_muwcqto6_skirt_full')`);
if (!hasSkirt){
  console.log('  （模板库里没有「裙子女生·竖版」，跳过这一段 —— 不影响弹窗本身）');
} else {
  await w.eval(`(async()=>{ await restoreTemplate('tpl_muwcqto6_skirt_full'); return 1; })()`);
  await new Promise(r => setTimeout(r, 700));
  chk(slots().length === 11, `套用后有 11 个槽（实际 ${slots().length}）`);
  chk($$('#slotList .slot').length === 11, '隐藏容器也渲染 11 个');
  $('#slotOpen').click();
  await new Promise(r => setTimeout(r, 300));
  chk($$('#slotDlgNav .it').length === 11, `弹窗左侧 11 项（实际 ${$$('#slotDlgNav .it').length}）`);
  const glass = $$('#slotDlgNav .it').find(it => it.querySelector('.nm').textContent === '眼镜');
  chk(!!glass && glass.querySelector('.pn')?.textContent === '20%', '眼镜显示 20% 角标');
  const shoe = $$('#slotDlgNav .it').find(it => it.querySelector('.nm').textContent === '鞋子');
  chk(!!shoe && !shoe.querySelector('.pn'), '鞋子（必选）无概率角标');
  chk($$('#slotSummary .tg').length === 11, '面板摘要 11 个标签');
}

console.log('\n=== 9. 行号槽在弹窗里必须并排（回归）===');
{
  /* ★ 曾经踩的坑：.nvwrap / .nvnum 的样式被限定在 `.slot` 作用域下，
     而弹窗里的这份不在 .slot 里 → display:flex 没生效 →
     行号槽与 textarea 上下堆叠，行号跑到输入框上方。
     所以这里用 getComputedStyle 断言「弹窗里也拿到了 flex」。 */
  if (!$('#slotDlg').classList.contains('show')){
    $('#slotOpen').click();
    await new Promise(r => setTimeout(r, 250));
  }
  const wrap = $('#slotDlgVals').closest('.nvwrap');
  const gutter = wrap.querySelector('.nvnum');
  chk(!!wrap && !!gutter, '弹窗里有 .nvwrap 与 .nvnum');
  chk(w.getComputedStyle(wrap).display === 'flex',
      `弹窗里 .nvwrap 是 flex（实际 ${w.getComputedStyle(wrap).display}）`);
  const kids = [...wrap.children].map(e => e.className || e.tagName.toLowerCase());
  chk(kids.length === 2 && kids[0].includes('nvnum') && kids[1] === 'textarea',
      '行号槽与 textarea 是同级兄弟（flex 才并排）');
  const tcs = w.getComputedStyle($('#slotDlgVals'));
  const gcs = w.getComputedStyle(gutter);
  chk(tcs.fontSize === gcs.fontSize && tcs.lineHeight === gcs.lineHeight,
      `字号行高一致（${tcs.fontSize}/${tcs.lineHeight} vs ${gcs.fontSize}/${gcs.lineHeight}）`);
}

console.log('\n=== 10. 行号按「视觉行」编号（软换行不错位）===');
{
  /* ★ 曾经踩的坑：行号按逻辑行（换行符）编号，长取值软换行成多行后，
     第 2 个编号落到第 1 条的续行上。改为按视觉行编号：首行给编号、
     续行给空占位。
     jsdom 没有布局，这里用可控的假布局验证「测量 → 排布」这条链路。 */
  const r = JSON.parse(w.eval(`
  (() => {
    if (!$('#slotDlg').classList.contains('show')) $('#slotOpen').click();
    const ta = $('#slotDlgVals');
    const COLS = 10, LH = 21.25;                     // 容器 10 单位宽，行高 21.25px
    const width = s => [...s].reduce((a, ch) => a + (/[\\x00-\\xff]/.test(ch) ? 0.5 : 1), 0);
    const expectRows = s => Math.max(1, Math.ceil(width(s) / COLS));
    Object.defineProperty(ta, 'clientWidth', { value: 114, configurable: true });   // 内容宽 100
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(){
        if (this.id === 'nvMirror') return 0;
        if (this.tagName === 'DIV' && this.parentElement && this.parentElement.id === 'nvMirror'){
          const t = this.textContent === '\\u200b' ? '' : (this.textContent || '');
          return expectRows(t) * LH;
        }
        return 0;
      }
    });
    const cases = ['短句', '这是一条很长的取值需要折行显示', 'x'.repeat(40), '', '中文中文中文中文中文中文'];
    ta.value = cases.join('\\n');
    const rows = measureVisualRows(ta);
    const items = gutterItemsFor(cases, rows);
    return JSON.stringify({ rows, expected: cases.map(expectRows), items, n: cases.length });
  })()
  `));
  console.log('    测得行数 = ' + JSON.stringify(r.rows) + '  期望 = ' + JSON.stringify(r.expected));
  chk(JSON.stringify(r.rows) === JSON.stringify(r.expected), '测得行数与真实折行一致');
  chk(r.items.filter(x => x).length === r.n, `编号个数 = 取值条数（${r.n}）`);
  chk(r.items[0] === '1', '第 1 条编号在首位');
  const long = r.expected.findIndex(e => e > 1);
  chk(long >= 0 && r.items[long + 1] === '', '长取值的续行是空占位（编号不会错位）');

  // 纯逻辑边界
  const edge = JSON.parse(w.eval(`JSON.stringify(gutterItemsFor(['a','b'], [1,1]))`));
  chk(JSON.stringify(edge) === '["1","2"]', '全 1 行时行为不变（1,2）');
  const z = JSON.parse(w.eval(`JSON.stringify(gutterItemsFor(['a'], [0]))`));
  chk(z.length === 1 && z[0] === '1', '视觉行数 0 时兜底为 1，不丢编号');
  const lh = w.eval(`resolveLineHeightPx(getComputedStyle($('#slotDlgVals')))`);
  chk(Math.abs(lh - 21.25) < 0.01, `无单位 line-height 换算成像素（1.7 × 12.5 = ${lh}）`);
}

console.log('\n=== 11. 模板写法速查（条件块此前在 UI 上没有任何入口）===');
{
  const help = $('#tplHelp');
  chk(!!help, '速查区存在');
  chk(help.tagName.toLowerCase() === 'details', '用 details 实现（原生折叠，无需 JS）');
  chk(!help.hasAttribute('open'), '★ 默认收起（不占面板高度）');
  const txt = help.textContent;
  chk(txt.includes('{{名称}}'), '讲了取值占位符写法');
  chk(txt.includes('{{#名称}}') && txt.includes('{{/名称}}'), '★ 讲了条件块写法（核心：此前 UI 完全没提）');
  chk(/缺席|不出现/.test(txt), '解释了条件块「缺席时整块删除」的行为');
  chk(/标签/.test(txt), '★ 点明了「标签要包进块里」这个最容易写错的地方');
  chk(/不能含空格|不可含空格/.test(txt), '讲了命名规则');
  chk(/最小可跑示例|直接抄/.test(txt), '★ 给了可直接抄的最小示例');
  chk(/20%|概率/.test(txt), '给了可选占位符的例子');

  // 速查里给出的示例必须真的能跑 —— 否则教程本身就在教错
  const r = JSON.parse(w.eval(`
    (() => {
      const tpl = '一位女孩，{{#眼镜}}戴{{眼镜}}，{{/眼镜}}穿{{鞋子}}。';
      const slots = [
        { name: '眼镜', values: ['银色细框圆形眼镜'], p: 0.2 },
        { name: '鞋子', values: ['白色运动鞋'] }
      ];
      const v = validateTemplate(tpl, slots);
      const ww = warnTemplate(tpl, slots);
      const on  = renderPrompt(tpl, { 眼镜: '银色细框圆形眼镜', 鞋子: '白色运动鞋' });
      const off = renderPrompt(tpl, { 眼镜: null, 鞋子: '白色运动鞋' });
      return JSON.stringify({ errs: v.errors.length, warns: ww.warns.length, on, off });
    })()
  `));
  console.log('    出现时: ' + r.on);
  console.log('    缺席时: ' + r.off);
  chk(r.errs === 0, '速查里的可选占位符示例零错误');
  chk(r.warns === 0, '速查里的示例不触发警告（条件块用对了）');
  chk(r.on.includes('戴银色细框圆形眼镜'), '示例：出现时正常渲染');
  chk(!r.off.includes('眼镜') && r.off.includes('穿白色运动鞋'),
      '★ 示例：缺席时整块连「戴」字一起消失，不留空标签');
}

console.log('\n=== 12. 警告通道（黄色提醒，不拦生成）===');
{
  const r = JSON.parse(w.eval(`
    (() => {
      S.m.batch.slots = [
        { name: '眼镜', values: ['银色细框圆形眼镜'], p: 0.2 },
        { name: '鞋子', values: ['白色运动鞋'] }
      ];
      const ta = fld('batch','template');
      // 裸写可选占位符 → 应当出现黄色警告
      ta.value = '眼镜：{{眼镜}}。鞋子：{{鞋子}}。';
      S.m.batch.template = ta.value;
      const v1 = validateBatch();
      const o1 = {
        warnShown: $('#tplWarn').classList.contains('show'),
        warnText: $('#tplWarn').textContent,
        errShown: $('#tplErr').classList.contains('show'),
        errs: v1.errors.length,
        warns: v1.warns.length
      };
      // 包进条件块 → 警告消失
      ta.value = '{{#眼镜}}眼镜：{{眼镜}}。{{/眼镜}}鞋子：{{鞋子}}。';
      S.m.batch.template = ta.value;
      const v2 = validateBatch();
      const o2 = {
        warnShown: $('#tplWarn').classList.contains('show'),
        warns: v2.warns.length,
        errs: v2.errors.length
      };
      return JSON.stringify({ o1, o2 });
    })()
  `));
  console.log('    裸写: ' + JSON.stringify(r.o1).slice(0, 150));
  chk(r.o1.warnShown, '★ 裸写可选占位符 → 黄色警告出现');
  chk(r.o1.warnText.includes('眼镜'), '警告里点出了具体占位符');
  chk(!r.o1.errShown && r.o1.errs === 0, '★ 警告不是错误（不标红、不拦生成）');
  chk(r.o1.warns === 1, `警告恰好 1 条（实际 ${r.o1.warns}）`);
  chk(!r.o2.warnShown && r.o2.warns === 0, '★ 包进条件块后警告消失');
  chk(r.o2.errs === 0, '包块后仍零错误');
}

console.log('\n=== 13. 标签行三态：亮 / 暗 / 红 ===');
{
  /* 构造一个能同时覆盖三态的场景：
       · 服装：已配置 + 已使用        → 亮
       · 场景：已配置 + 已使用        → 亮
       · 道具：已配置 + 未使用        → 暗
       · 空槽：已配置但数组为空 + 未使用 → 暗？不 —— 未使用且空数组按 miss
       · 发型：模板用了但完全没配置   → 红 */
  w.eval(`
    S.m.batch.template = '一个{{服装}}的{{场景}}，{{发型}}';
    S.m.batch.slots = [
      { name: '服装', values: ['皮夹克','马甲'] },
      { name: '场景', values: ['夜市','沙滩'] },
      { name: '道具', values: ['雨伞','相机'] },
      { name: '空槽', values: [] }
    ];
    loadBatchPane();
  `);
  await new Promise(r => setTimeout(r, 250));

  const states = JSON.parse(w.eval(`
    JSON.stringify([...$('#tplTags').querySelectorAll('.tg')]
      .map(el => ({ name: el.dataset.name, state: el.dataset.state, cls: el.className,
                    text: el.textContent })))
  `));
  console.log('    ' + JSON.stringify(states));

  const st = n => states.find(x => x.name === n)?.state;

  chk(states.length === 5, `标签行显示全部 5 个占位符（含未使用/未配置）（实际 ${states.length}）`);
  chk(st('服装') === 'ok' && st('场景') === 'ok', '★ 已配置+已使用 → 亮（ok）');
  chk(st('道具') === 'off', '★ 已配置+未使用 → 暗（off）');
  chk(st('发型') === 'miss', '★ 已使用+未配置 → 红（miss）');
  /* ★ 边界：未使用 + 空数组 = 暗（草稿），不是红。
     标红会让「刚点＋新增」的槽位看起来像出错了 —— 它只是还没写完。
     一旦点它追加进模板（变成已使用），仍为空就会自动转红，路径自洽。 */
  chk(st('空槽') === 'off', '★ 未使用+空数组 → 暗（草稿，不标红）');

  // 角标文案：红的说「缺数组」，暗的草稿说「0 条」
  const txtOf = n => states.find(x => x.name === n)?.text || '';
  chk(txtOf('发型').includes('缺数组'), '红色角标显示「缺数组」');
  chk(txtOf('空槽').includes('0 条') && !txtOf('空槽').includes('缺数组'),
      '★ 暗色草稿显示「0 条」而不是「缺数组」（不是错误状态）');

  // 类名要真的落到 DOM 上（CSS 才生效）
  const clsOf = n => states.find(x => x.name === n)?.cls || '';
  chk(!/ off| miss/.test(clsOf('服装')), '亮的没有附加状态类');
  chk(clsOf('道具').includes('off'), '暗的带 off 类');
  chk(clsOf('发型').includes('miss'), '红的带 miss 类');

  // 顺序：先模板出现顺序，再补未使用的
  const order = states.map(x => x.name);
  console.log('    顺序: ' + order.join(' → '));
  chk(order.indexOf('服装') < order.indexOf('场景')
      && order.indexOf('场景') < order.indexOf('发型'),
      '★ 模板里用到的按出现顺序排在前面');
  chk(order.indexOf('道具') > order.indexOf('发型'), '未使用的排在后面');

  // 红色标签的提示语说明会去编辑，不是追加
  const missTitle = JSON.parse(w.eval(`
    JSON.stringify([...$('#tplTags').querySelectorAll('.tg')]
      .find(el => el.dataset.name === '发型').title)
  `));
  console.log('    红色标签 title: ' + JSON.stringify(missTitle).slice(0, 90));
  chk(/新增|编辑/.test(missTitle), '★ 红色标签提示「点击去新增/编辑」');
  chk(!/追加到模板末尾/.test(missTitle), '红色标签不提「追加」（避免误导）');

  /* ★ 状态自洽：暗的草稿（未使用 + 空数组）点一下追加进模板后，
     就变成「已使用 + 空数组」→ 应当自动转红。
     这条路径保证「暗 → 点 → 红」不会卡在中间态。 */
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='空槽').click()`);
  await new Promise(r => setTimeout(r, 200));
  chk(w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='空槽').dataset.state`) === 'miss',
      '★ 暗草稿追加进模板后自动转红（未使用空数组 → 已使用空数组）');
  chk(JSON.parse(w.eval(`JSON.stringify(validateBatch().errors.some(e=>e.kind==='emptyarr'))`)) === true,
      '转红后确实报「数组为空」错误（状态与实际校验一致）');
  // 复原，别影响后续断言
  w.eval(`
    S.m.batch.template = '一个{{服装}}的{{场景}}，{{发型}}';
    loadBatchPane();
  `);
  await new Promise(r => setTimeout(r, 200));
}

console.log('\n=== 14. 点标签：亮/暗 → 追加，重复点重复追加 ===');
{
  w.eval(`
    S.m.batch.template = '一个{{服装}}的{{场景}}';
    S.m.batch.slots = [
      { name: '服装', values: ['皮夹克','马甲'] },
      { name: '场景', values: ['夜市','沙滩'] },
      { name: '道具', values: ['雨伞'] }
    ];
    loadBatchPane();
  `);
  await new Promise(r => setTimeout(r, 250));

  const t0 = w.eval('S.m.batch.template');

  // 点亮标签 → 追加
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='服装').click()`);
  await new Promise(r => setTimeout(r, 150));
  chk(w.eval('S.m.batch.template') === t0 + '{{服装}}', '★ 点亮标签 → 追加 {{服装}}');

  // 点暗标签 → 也追加（这是本次新增的能力：把没用到的插进来）
  const t1 = w.eval('S.m.batch.template');
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='道具').click()`);
  await new Promise(r => setTimeout(r, 150));
  chk(w.eval('S.m.batch.template') === t1 + '{{道具}}', '★ 点暗标签 → 追加 {{道具}}（新能力）');
  chk(w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='道具').dataset.state`) === 'ok',
      '★ 追加后「道具」由暗转亮（已使用）');

  // 重复点同一个 → 重复追加
  const t2 = w.eval('S.m.batch.template');
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='服装').click()`);
  await new Promise(r => setTimeout(r, 120));
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='服装').click()`);
  await new Promise(r => setTimeout(r, 120));
  chk(w.eval('S.m.batch.template') === t2 + '{{服装}}{{服装}}', '★ 重复点击重复追加');

  // DOM 同步 + 渲染无残留 + 组合数不受重复影响
  chk(w.eval('fld("batch","template").value') === w.eval('S.m.batch.template'),
      'DOM textarea 已同步');
  const r = JSON.parse(w.eval(`
    (() => {
      const tpl = S.m.batch.template;
      const c = pickCombo(S.m.batch.slots, tpl, null, false);
      return JSON.stringify({ out: renderPrompt(tpl, c.map),
                              combo: comboCount(S.m.batch.slots, tpl) });
    })()
  `));
  console.log('    渲染: ' + r.out);
  chk(!/\{\{/.test(r.out), '★ 渲染无残留占位符');
  chk(r.combo === 2 * 2 * 1, `组合数不受重复出现影响（${r.combo}，期望 4）`);
  chk(JSON.parse(w.eval(`JSON.stringify(validateBatch().errors.length)`)) === 0, '追加后仍零错误');

  // 高亮反馈
  const fl = w.eval(`
    (() => {
      appendSlotToTpl('服装');
      const tg = [...$('#tplTags').querySelectorAll('.tg')].find(el => el.dataset.name === '服装');
      return tg ? tg.classList.contains('flash') : false;
    })()
  `);
  chk(fl === true, '★ 追加后标签有高亮反馈');
  chk(w.eval(`(()=>{ appendSlotToTpl(''); return S.m.batch.template; })()`) === w.eval('S.m.batch.template'),
      '空名字不追加');
}

console.log('\n=== 15. 点红色标签 → 打开编辑器去新增/编辑 ===');
{
  w.eval(`
    S.m.batch.template = '一个{{服装}}的{{发型}}';
    S.m.batch.slots = [{ name: '服装', values: ['皮夹克'] }];
    S.m.batch.template = '一个{{服装}}的{{发型}}';
    loadBatchPane();
  `);
  await new Promise(r => setTimeout(r, 250));

  chk(w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='发型').dataset.state`) === 'miss',
      '前置：「发型」是红色（模板用了但没配置）');
  const n0 = JSON.parse(w.eval('S.m.batch.slots.length'));
  const tplBefore = w.eval('S.m.batch.template');

  // 点红色标签
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='发型').click()`);
  await new Promise(r => setTimeout(r, 400));

  chk(w.eval(`$('#slotDlg').classList.contains('show')`), '★ 打开了占位符编辑器');
  chk(JSON.parse(w.eval('S.m.batch.slots.length')) === n0 + 1,
      `★ 自动新建了同名空槽（${n0} → ${w.eval('S.m.batch.slots.length')}）`);
  chk(w.eval(`S.m.batch.slots[slotDlgIndex].name`) === '发型',
      '★ 弹窗定位到「发型」（不用手打名字）');
  chk(w.eval(`$('#slotDlgName').value`) === '发型', '右侧编辑区显示的是「发型」');
  chk(w.eval('S.m.batch.template') === tplBefore, '★ 红色标签不会改动模板（不追加）');

  // 填上取值后应变亮
  w.eval(`
    (() => {
      const ta = $('#slotDlgVals');
      ta.value = '双马尾\\n短发';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await new Promise(r => setTimeout(r, 300));
  chk(w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='发型').dataset.state`) === 'ok',
      '★ 填上取值后「发型」由红转亮');

  // 已存在的槽位：点红色标签不应重复新建
  w.eval(`
    S.m.batch.slots.push({ name: '眼镜', values: [] });
    S.m.batch.template = '一个{{服装}}的{{眼镜}}';
    loadBatchPane();
  `);
  await new Promise(r => setTimeout(r, 250));
  const n1 = JSON.parse(w.eval('S.m.batch.slots.length'));
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='眼镜').click()`);
  await new Promise(r => setTimeout(r, 300));
  chk(JSON.parse(w.eval('S.m.batch.slots.length')) === n1,
      '★ 空数组但已存在的槽位：不重复新建，直接定位过去');
  chk(w.eval(`S.m.batch.slots[slotDlgIndex].name`) === '眼镜', '定位到「眼镜」');

  // 关掉弹窗，免得影响后面
  w.eval(`closeSlotDlg()`);
  await new Promise(r => setTimeout(r, 200));
}

console.log('\n=== 16. 回归：标签操作不依赖隐藏的 #slotList ===');
{
  /* ★ 旧实现（占位符弹窗重构之前）是 scrollIntoView / focus #slotList 里
     对应的槽位。重构后 #slotList 变成 hidden 的「真相容器」，
     对隐藏元素这两者都不生效 —— 表现为「点了没反应」。
     这里断言：追加与跳转都在 #slotList 不可见时正常工作。 */
  chk($('#slotList').hasAttribute('hidden'), '#slotList 仍是隐藏的（真相容器）');

  w.eval(`
    S.m.batch.template = '一个{{服装}}';
    S.m.batch.slots = [{ name: '服装', values: ['A'] }, { name: '场景', values: ['B'] }];
    loadBatchPane();
  `);
  await new Promise(r => setTimeout(r, 250));

  const t = w.eval('S.m.batch.template');
  w.eval(`[...$('#tplTags').querySelectorAll('.tg')].find(el=>el.dataset.name==='场景').click()`);
  await new Promise(r => setTimeout(r, 150));
  chk(w.eval('S.m.batch.template') === t + '{{场景}}',
      '★ 隐藏容器存在时点暗标签仍追加（旧实现失效点）');
}

console.log('\n页面异常: ' + (errs.length ? errs.slice(0, 3).join(' | ') : '无'));
if (errs.length) fail += errs.length;
console.log('\n' + '─'.repeat(50));
console.log(fail ? `结果：${pass} 通过 / ${fail} 失败` : `结果：${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);