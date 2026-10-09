#!/usr/bin/env node
/* =============================================================
 *  终端批量生图 —— 关掉浏览器也能跑
 *
 *  和 Web UI 的关系：
 *    · 复用同一份 app\ui\config.json（模板 + 数组 + 张数 + 保存目录）
 *    · 复用同一套组合算法（惰性 Fisher–Yates，见 index.html 的 LAZY_SAMPLER）
 *    · 复用同一个 sd-server HTTP 接口（/sdcpp/v1/img_gen）
 *    · 输出文件名规则与 UI 的 saveBatchToDir 一致
 *  所以「UI 里调好的模板」在终端能原样跑，反过来也成立。
 *
 *  用法（可从任意工作目录执行，路径基于脚本自身位置推导）：
 *    node tools\batch-run.mjs                      用 config.json 的模板与张数（开新批）
 *    node tools\batch-run.mjs --count 3 --w 128 --h 128 --steps 2
 *    node tools\batch-run.mjs --list               只打印计划，不出图
 *    node tools\batch-run.mjs --resume             续跑上次未完成批次（默认总开新批）
 *    node tools\batch-run.mjs --out-dir D:\pics    覆盖保存目录
 *    node tools\batch-run.mjs --server http://127.0.0.1:1234
 *    node tools\batch-run.mjs --job <job.json>     ★ UI 下发的完整任务（含比例/反向提示词）
 *
 *  续跑：默认开新批。加 --resume 才续跑。进度记在 <out-dir>\.batch-cli-state.json，
 *        只要检测到未完成批次，无论续不续都会明确提示，不会闷头开新批。
 *
 *  终端打印的是「选中的标签」而不是整段提示词：
 *        每张列出各占位符取到的值，每个标签取前 5 个字，超长补「…」，按槽对齐。
 *        出图用的仍然是完整提示词，展示只影响终端输出。
 *
 *  ★ --job 模式：UI 点「在终端运行这一批」时，配置服务把当时的完整快照
 *    （模板 + 数组 + 张数 + 尺寸/步数/CFG/采样器/反向提示词/种子）写成一个
 *    JSON 交给本脚本。这样终端跑的就是「UI 里看到的那一份参数」，
 *    不会因为 config.json 不存生成参数而丢失比例和反向提示词。
 * ============================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

/* ────────────────────────── 参数 ────────────────────────── */

const USAGE = `
终端批量生图（关掉浏览器也能跑）

  node tools\\batch-run.mjs [选项]

选项：
  --count N        张数（默认取 config.json 的 batch.count）
  --w N --h N      宽高（默认 512 × 768，与 UI 默认一致）
  --steps N        采样步数（默认 12，与 UI 默认一致）
  --cfg F          CFG（默认 1.0）
  --sampler S      采样器（默认 euler）
  --scheduler S    调度器（默认 discrete）
  --neg "..."      负向提示词（默认与 UI 的 DEFAULT_NEG 一致）
  --seed N         基准 seed（默认随机；第 i 张用 seed + i）
  --out-dir DIR    覆盖保存目录（默认取 config.json 的 saveDir）
  --server URL     生图服务地址（默认 http://127.0.0.1:1234）
  --config PATH    指定配置文件（默认 app\\ui\\config.json）
  --job PATH       由 UI 下发的完整任务 JSON（含尺寸/步数/CFG/反向提示词）
  --resume         续跑上次未完成批次（默认总是开新批，检测到未完成时会提示）
  --list           只打印计划，不出图
  --new            （已过时）现在默认就是开新批，此开关仅作向后兼容
  --no-verify      跳过产物 PNG 校验（不推荐）
  -h, --help       显示本帮助
`.trim();

function parseArgs(argv){
  const o = {
    count: null, w: 512, h: 768, steps: 12, cfg: 1.0,
    sampler: 'euler', scheduler: 'discrete',
    neg: 'lowres, bad anatomy, bad hands, extra limbs, missing fingers, deformed, watermark, text, ugly, disfigured, mismatched pupils, broken halo',
    seed: null, outDir: null, server: 'http://127.0.0.1:1234',
    config: path.join(ROOT, 'app', 'ui', 'config.json'),
    job: null,
    // --job 快照（由 applyJob 填；默认 null 表示「不来自 UI」，不要留 undefined）
    _jobTpl: null, _jobSlots: null, _jobSkipDup: true,
    resume: false, forceNew: false, list: false, verify: true,
    // 记录哪些参数是命令行显式给的 —— 显式给的优先于 --job 里的值
    explicit: new Set()
  };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`选项 ${a} 缺少参数值`);
      return v;
    };
    switch (a){
      case '--count':     o.count = Math.max(1, Math.floor(+next())); o.explicit.add('count'); break;
      case '--w':         o.w = Math.max(1, Math.floor(+next())); o.explicit.add('w'); break;
      case '--h':         o.h = Math.max(1, Math.floor(+next())); o.explicit.add('h'); break;
      case '--steps':     o.steps = Math.max(1, Math.floor(+next())); o.explicit.add('steps'); break;
      case '--cfg':       o.cfg = +next(); o.explicit.add('cfg'); break;
      case '--sampler':   o.sampler = next(); o.explicit.add('sampler'); break;
      case '--scheduler': o.scheduler = next(); o.explicit.add('scheduler'); break;
      case '--neg':       o.neg = next(); o.explicit.add('neg'); break;
      case '--seed':      o.seed = Math.floor(+next()); o.explicit.add('seed'); break;
      case '--out-dir':   o.outDir = next(); o.explicit.add('outDir'); break;
      case '--server':    o.server = next().replace(/\/+$/, ''); o.explicit.add('server'); break;
      case '--config':    o.config = next(); o.explicit.add('config'); break;
      case '--job':       o.job = next(); break;
      case '--list':      o.list = true; break;
      case '--resume':    o.resume = true; o.explicit.add('resume'); break;
      case '--new':       o.forceNew = true; break;
      case '--no-verify': o.verify = false; break;
      case '-h': case '--help': console.log(USAGE); process.exit(0); break;
      default: fail(`未知选项 ${a}（用 --help 看用法）`);
    }
  }
  return o;
}
function fail(msg){ console.error('\n[错误] ' + msg + '\n'); process.exit(2); }

/* ────────────── UI 下发的任务快照（--job） ──────────────
 *  config.json 不保存生成参数（宽高/步数/CFG/反向提示词只在内存里），
 *  所以 UI 点「在终端运行」时必须把这份快照单独传过来，否则终端会
 *  用脚本的默认值出图 —— 比例和反向提示词全丢。
 *
 *  命令行显式给的参数优先于 job 里的值（方便临时覆盖）。
 */
function applyJob(o){
  if (!o.job) return;
  let job;
  try {
    job = JSON.parse(fs.readFileSync(o.job, 'utf8'));
  } catch (e){
    fail(`读不到任务文件 ${o.job}：${e.message}`);
  }
  if (!job || typeof job !== 'object') fail('任务文件不是合法 JSON 对象');

  // 模板/数组：job 里带的就是 UI 当时的那一份，直接内联，不走 config.json
  o._jobTpl = typeof job.template === 'string' ? job.template : null;
  o._jobSlots = Array.isArray(job.slots) ? job.slots : null;
  o._jobSkipDup = job.skipDup !== false;

  const p = job.params || {};
  if (!o.explicit.has('w')         && Number.isFinite(+p.w))         o.w = Math.max(1, Math.floor(+p.w));
  if (!o.explicit.has('h')         && Number.isFinite(+p.h))         o.h = Math.max(1, Math.floor(+p.h));
  if (!o.explicit.has('steps')     && Number.isFinite(+p.steps))     o.steps = Math.max(1, Math.floor(+p.steps));
  if (!o.explicit.has('cfg')       && Number.isFinite(+p.cfg))       o.cfg = +p.cfg;
  if (!o.explicit.has('sampler')   && typeof p.sampler === 'string')   o.sampler = p.sampler;
  if (!o.explicit.has('scheduler') && typeof p.scheduler === 'string') o.scheduler = p.scheduler;
  if (!o.explicit.has('neg')       && typeof p.neg === 'string')       o.neg = p.neg;
  if (!o.explicit.has('seed')      && Number.isFinite(+p.seed) && +p.seed >= 0) o.seed = Math.floor(+p.seed);
  if (!o.explicit.has('count')     && Number.isFinite(+job.count))   o.count = Math.max(1, Math.floor(+job.count));
  if (!o.explicit.has('outDir')    && typeof job.outDir === 'string' && job.outDir.trim()) o.outDir = job.outDir.trim();
  if (!o.explicit.has('server')    && typeof job.server === 'string' && job.server.trim()) o.server = job.server.trim().replace(/\/+$/, '');
  if (!o.explicit.has('resume')    && job.mode === 'resume') o.resume = true;
}

/* ────────────────── 模板 / 组合（与 index.html 同源） ────────────────── */

const SLOT_NAME_RE = /^[^\s{}]+$/;

/** 扫描 {{占位符}}，返回出现位置与未闭合位置（同 index.html 的 scanSlots）。
 *  ★ 会跳过条件块标记 {{#名}} / {{/名}} —— 它们不是取值占位符。 */
function scanSlots(tpl){
  const found = [];
  const re = /\{\{([^{}]*)\}\}/g;
  let m;
  while ((m = re.exec(tpl)) !== null){
    const nm = m[1].trim();
    if (nm.startsWith('#') || nm.startsWith('/')) continue;   // 块标记，不算取值
    found.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  }
  let rest = tpl;
  for (let i = found.length - 1; i >= 0; i--){
    const f = found[i];
    rest = rest.slice(0, f.start) + ' '.repeat(f.end - f.start) + rest.slice(f.end);
  }
  const unclosed = [];
  let idx;
  while ((idx = rest.indexOf('{{')) !== -1){
    unclosed.push(idx);
    rest = rest.slice(0, idx) + '  ' + rest.slice(idx + 2);
  }
  return { found, unclosed };
}

/** 某个占位符的候选值（已过滤空行）。 */
function slotValues(slots, name){
  const s = slots.find(x => (x.name || '').trim() === name);
  if (!s) return [];
  return (s.values || []).map(v => String(v).trim()).filter(v => v !== '');
}

/** 槽位出现概率：缺省 / 非法 → 1（必选）。只有 0<p<1 才是有意义的可选。 */
function slotProb(slots, name){
  const s = (slots || []).find(x => (x.name || '').trim() === name);
  if (!s) return 1;
  const n = Number(s.p);
  return (Number.isFinite(n) && n > 0 && n < 1) ? n : 1;
}

/** 缺席下标（同 index.html 的 ABSENT）。取值下标恒 >= 0。 */
const ABSENT = -1;

/** 校验模板 + 数组，返回错误列表（同 index.html 的 validateTemplate）。 */
function validateTemplate(tpl, slots){
  const errors = [];
  const { found, unclosed } = scanSlots(tpl);
  for (const pos of unclosed) errors.push(`第 ${pos} 个字符处有未闭合的 {{，缺少 }}`);

  const p = parseTpl(tpl);
  for (const e of p.errors) errors.push(e);

  const byName = new Map();
  for (const s of slots){
    const n = (s.name || '').trim();
    if (n) byName.set(n, s);
  }

  // 条件块：块名必须有对应数组，否则块永远不会展开
  const seenBlock = new Set();
  walkTpl(p.root, (n) => {
    if (n.t !== 'block' || seenBlock.has(n.name)) return;
    seenBlock.add(n.name);
    if (!byName.has(n.name)) errors.push(`条件块 {{#${n.name}}} 没有对应的数组`);
    else if (!slotValues(slots, n.name).length) errors.push(`条件块 {{#${n.name}}} 的数组是空的`);
  });

  const seen = new Set();
  for (const f of found){
    const name = f.name.trim();
    if (!name){ errors.push(`第 ${f.start} 个字符处的 {{}} 里没有名称`); continue; }
    if (!SLOT_NAME_RE.test(f.name)){ errors.push(`占位符「${f.name}」不合法：名称不能含空格或花括号`); continue; }
    if (seen.has(name)) continue;
    seen.add(name);
    const s = byName.get(name);
    if (!s){ errors.push(`占位符「{{${name}}}」没有对应的数组`); continue; }
    if (!slotValues(slots, name).length) errors.push(`占位符「{{${name}}}」的数组是空的`);
  }
  return errors;
}

/** 用一组取值渲染最终提示词（同 index.html 的 renderPrompt）。
 *  值为 null 表示该槽位本次「缺席」：条件块 {{#名}}…{{/名}} 整块删除，
 *  裸占位符替换成空串。 */
function renderPrompt(tpl, combo){
  const has = (k) => Object.prototype.hasOwnProperty.call(combo, k);
  const emit = (list) => list.map(n => {
    if (n.t === 'text') return n.s;
    if (n.t === 'block'){
      if (has(n.name) && combo[n.name] === null) return '';
      return emit(n.kids);
    }
    const key = n.name.trim();
    if (!has(key)) return n.raw;
    const v = combo[key];
    return v === null ? '' : v;
  }).join('');
  return emit(parseTpl(tpl).root);
}

/* ────────── 模板解析：取值占位符 + 条件块（同 index.html 的 parseTpl） ──────────
   条件块 {{#名}}…{{/名}}：该槽位缺席时整块（含标签）一起删除。
   只把 {{名}} 换成空串会让「头饰（可选）：」变成「头饰（可选）：；」，污染提示词。 */
function parseTpl(tpl){
  const s = String(tpl || '');
  const root = [];
  const stack = [{ kids: root, name: null, start: -1 }];
  const errors = [];
  const re = /\{\{([^{}]*)\}\}/g;
  let m, last = 0;

  while ((m = re.exec(s)) !== null){
    const at = m.index;
    if (at > last) stack[stack.length - 1].kids.push({ t: 'text', s: s.slice(last, at) });
    last = at + m[0].length;
    const raw = m[1];
    const nm = raw.trim();

    if (nm.startsWith('#')){
      const bn = nm.slice(1).trim();
      if (!bn){ errors.push(`第 ${at} 个字符处的 {{#}} 里没有名称`); continue; }
      if (!SLOT_NAME_RE.test(bn)){ errors.push(`块名「${bn}」不合法：不能含空格或花括号`); continue; }
      const node = { t: 'block', name: bn, kids: [], start: at };
      stack[stack.length - 1].kids.push(node);
      stack.push(node);
      continue;
    }
    if (nm.startsWith('/')){
      const bn = nm.slice(1).trim();
      if (stack.length < 2){ errors.push(`第 ${at} 个字符处的 {{/${bn}}} 没有对应的 {{#${bn}}}`); continue; }
      const top = stack[stack.length - 1];
      if (top.name !== bn){ errors.push(`第 ${at} 个字符处的 {{/${bn}}} 与未闭合的 {{#${top.name}}} 不匹配`); continue; }
      stack.pop();
      continue;
    }
    stack[stack.length - 1].kids.push({ t: 'slot', name: raw, start: at, end: last, raw: m[0] });
  }
  if (last < s.length) stack[stack.length - 1].kids.push({ t: 'text', s: s.slice(last) });
  for (let i = 1; i < stack.length; i++){
    errors.push(`第 ${stack[i].start} 个字符处的 {{#${stack[i].name}}} 没有闭合的 {{/${stack[i].name}}}`);
  }
  return { root, errors };
}

/** 遍历节点树。 */
function walkTpl(nodes, cb, path){
  const p = path || [];
  for (const n of nodes){
    cb(n, p);
    if (n.t === 'block') walkTpl(n.kids, cb, p.concat(n.name));
  }
}

/* ────────── 占位符标签：把组合压成「每个标签前 5 个字」 ──────────
 *  终端里打整段提示词没意义 —— 几百字、带换行，一屏刷过去看不出跑了什么。
 *  打「这一张选中了哪些标签」才有用：一眼看出批次在覆盖哪片组合空间。
 *
 *  规则就一条：每个标签取前 LABEL_CHARS 个字，超长补「…」，按槽对齐。
 *  出图用的始终是完整提示词，这里只影响终端展示。
 */

const LABEL_CHARS = 5;          // 每个标签取前几个字
const LABEL_SEP = ' · ';

/** 折叠空白，取前 n 个字，超长补「…」。 */
function labelOf(v, n = LABEL_CHARS){
  const one = String(v).replace(/\s+/g, ' ').trim();
  const chars = [...one];
  return chars.length <= n ? one : chars.slice(0, n).join('') + '…';
}

/** 终端显示宽度：CJK 全角占 2 格，其余 1 格（只用于列对齐）。 */
function dwidth(s){
  let w = 0;
  for (const ch of String(s)){
    const c = ch.codePointAt(0);
    w += (
      (c >= 0x1100 && c <= 0x115f) || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd)
    ) ? 2 : 1;
  }
  return w;
}

/** 右补空格到指定显示宽度（终端按格子对齐）。 */
function dpad(s, w){ return s + ' '.repeat(Math.max(0, w - dwidth(s))); }

/** 每槽的显示宽度 = max(该槽里最长标签, 槽名) 的宽度（用于对齐）。
 *  把槽名也算进去，表头才不会顶开标签列。 */
function labelWidths(pools, names, n = LABEL_CHARS){
  return pools.map((p, j) => {
    const fromPool = p.reduce((m, v) => Math.max(m, dwidth(labelOf(v, n))), 0);
    const fromName = names ? dwidth(labelOf(names[j] || '', n)) : 0;
    return Math.max(fromPool, fromName);
  });
}

/** 一组槽下标 → 「标签 · 标签 · …」的短摘要。缺席显示「—」。 */
function comboLabels(idxs, pools, widths, n = LABEL_CHARS){
  const last = idxs.length - 1;
  return idxs
    .map((ix, j) => {
      const txt = ix === ABSENT ? '—' : labelOf(pools[j][ix], n);
      return dpad(txt, j === last ? 0 : widths[j]);
    })
    .join(LABEL_SEP);
}

/** 线性索引 → 各槽下标。混合进制，槽 0 最快变化（同 index.html 的 decodeIdxs）。 */
function decodeIdxs(k, pools){
  const idxs = [];
  let rem = k;
  for (const p of pools){
    idxs.push(rem % p.length);
    rem = Math.floor(rem / p.length);
  }
  return idxs;
}

/** 模板指纹，判断模板/数组是否被改过（同 index.html 的 templateHash）。 */
function templateHash(tpl, slots){
  const s = tpl + '##' + (slots || []).map(x => (x.name || '') + ':' + (x.values || []).join(',')).join(';');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* ────────────────── 不重复抽样：惰性 Fisher–Yates ──────────────────
 *  与 index.html 的 LAZY_SAMPLER 同一算法：只洗前 n 步，
 *  复杂度 O(n)，与组合总数无关（2.4 亿和 24 个一样快）。
 *  j 的下界必须是 i —— 否则会抽到已用过的位置。
 */
function drawCombos(total, n){
  const at = new Map();          // 位置 → 值（稀疏；缺省即恒等）
  const get = i => (at.has(i) ? at.get(i) : i);
  const out = [];
  for (let i = 0; i < n; i++){
    const j = i + Math.floor(Math.random() * (total - i));
    const vi = get(i), vj = get(j);
    at.set(i, vj); at.set(j, vi);
    out.push(vj);
  }
  return out;
}

/* ────────────────── 带概率的抽样 ──────────────────
 *  有概率槽位时去重被禁用，所以每张独立：每槽先掷「出现/缺席」，
 *  出现则均匀抽一个取值，缺席记 ABSENT。
 *  不能把缺席塞进池子当第 N+1 个取值 —— 那样缺席概率是 1/(N+1)，
 *  与配置的 p 不符（要精确 p 需要虚拟权重位，非整数）。 */
function drawProbCombos(pools, probs, n){
  const out = [];
  for (let i = 0; i < n; i++){
    out.push(pools.map((p, j) => {
      if (probs[j] < 1 && Math.random() >= probs[j]) return ABSENT;
      return Math.floor(Math.random() * p.length);
    }));
  }
  return out;
}

/* ────────────────────────── HTTP ────────────────────────── */

async function postJob(server, body, timeoutMs){
  const r = await fetch(`${server}/sdcpp/v1/img_gen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 30000)
  });
  if (!r.ok && r.status !== 202){
    throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  return r.json();
}

async function getJob(server, id){
  const r = await fetch(`${server}/sdcpp/v1/jobs/${id}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function cancelJob(server, id){
  try { await fetch(`${server}/sdcpp/v1/jobs/${id}/cancel`, { method: 'POST' }); } catch (_){}
}

/** 取纯 base64；服务端可能返回字符串 / data URI / {b64_json}（同 index.html 的 normB64）。 */
function normB64(x){
  const strip = s => { s = String(s || '').trim(); const i = s.indexOf('base64,'); return i >= 0 ? s.slice(i + 7) : s; };
  if (!x) return '';
  if (typeof x === 'string') return strip(x);
  for (const k of ['b64_json', 'b64', 'image', 'data', 'base64']){
    if (typeof x[k] === 'string' && x[k]) return strip(x[k]);
  }
  return '';
}

/** 等一张图回来。返回 base64 或 null（失败/超时）。 */
async function waitOne(server, jobId, onTick, timeoutSec){
  let fails = 0;
  const t0 = Date.now();
  for (;;){
    await new Promise(r => setTimeout(r, 1000));
    const el = (Date.now() - t0) / 1000;
    if (el > timeoutSec) return { err: `超时 ${timeoutSec}s` };

    let j;
    try { j = await getJob(server, jobId); fails = 0; }
    catch (e){
      if (++fails >= 20) return { err: '与服务端失去联系' };
      continue;
    }
    if (j.status === 'queued' || j.status === 'generating'){ onTick(el, j); continue; }
    if (j.status === 'completed' && j.result?.images?.length){
      const b64 = normB64(j.result.images[0]);
      if (!b64) return { err: '返回数据异常（拿不到图像）' };
      return { b64 };
    }
    const msg = j.error ? (j.error.message || JSON.stringify(j.error)) : ('状态 ' + j.status);
    return { err: msg };
  }
}

/* ────────────────────────── 产物校验 ────────────────────────── */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ★ 不能只看退出码/HTTP 状态：必须确认文件真的存在且是合法 PNG。 */
function verifyPng(file){
  try {
    const st = fs.statSync(file);
    if (st.size < 100) return { ok: false, why: `文件过小（${st.size} 字节）` };
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (!buf.equals(PNG_SIG)) return { ok: false, why: '不是 PNG（文件头不匹配）' };
    return { ok: true, size: st.size };
  } catch (e){
    return { ok: false, why: e.code === 'ENOENT' ? '文件不存在' : e.message };
  }
}

/* ────────────────────────── 进度（状态文件） ────────────────────────── */

const STATE_NAME = '.batch-cli-state.json';

function loadState(file){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function saveState(file, st){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, file);          // 原子替换，避免断电写坏
}

/* ────────────────────────── 主流程 ────────────────────────── */

function tsStamp(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(){
  const o = parseArgs(process.argv.slice(2));
  applyJob(o);                       // ★ --job 先落进 o，后面统一处理

  /* 0) 保存目录（续跑要先知道目录才能定位状态文件）
        优先 o.outDir；否则读 config.json 的 saveDir。 */
  let outDir = o.outDir || '';
  if (!outDir && typeof o._jobTpl !== 'string'){
    try {
      const cfg = JSON.parse(fs.readFileSync(o.config, 'utf8'));
      if (typeof cfg.saveDir === 'string') outDir = cfg.saveDir;
    } catch {}
  }
  if (!outDir) fail('没有保存目录。用 --out-dir 指定，或先在 UI 里设置保存目录。');
  fs.mkdirSync(outDir, { recursive: true });
  if (!o.list){
    try { fs.accessSync(outDir, fs.constants.W_OK); }
    catch { fail(`保存目录不可写：${outDir}`); }
  }

  const stateFile = path.join(outDir, STATE_NAME);
  const prev = o.forceNew ? null : loadState(stateFile);

  /* 1) 取模板与数组
     ★ 续跑走「快照」：旧批次当时存了什么就用什么（模板/数组/参数/反向提示词），
      与当前编辑完全无关 —— 所以改提示词、改参数都不会让旧批次找不回来。
      只有 开新批（默认 / 显式点开新批 / --new） 才用当前的 config 或 --job。 */
  let tpl = '', slots = [], skipDup = true;
  let st = null, mode = 'new';

  const prevUnfinished = !!(prev && Array.isArray(prev.slots) && prev.slots.length
    && Array.isArray(prev.done) && prev.done.length < (prev.count || 0)
    && (Array.isArray(prev.idxRows) || Array.isArray(prev.linears)));   // ★ 无组合数据无法续跑

  if (prevUnfinished && o.resume){
    tpl = typeof prev.template === 'string' ? prev.template : tpl;
    slots = prev.slots;
    skipDup = prev.skipDup !== false;
    st = prev;
    mode = 'resume';
    if (typeof prev.neg === 'string') o.neg = prev.neg;   // 反向提示词也取自快照
    console.log(`[续跑] 沿用批次 ${prev.stamp}，已完成 ${st.done.length}/${st.count} 张。`);
  } else {
    // 当前模板：--job 模式下用 UI 下发的那份，否则读 config.json
    if (typeof o._jobTpl === 'string'){
      tpl = o._jobTpl;
      slots = o._jobSlots || [];
      skipDup = o._jobSkipDup;
    } else {
      if (!fs.existsSync(o.config)) fail(`找不到配置文件：${o.config}`);
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(o.config, 'utf8')); }
      catch (e){ fail(`配置文件不是合法 JSON：${e.message}`); }
      const b = cfg.batch || {};
      tpl = typeof b.template === 'string' ? b.template : '';
      slots = Array.isArray(b.slots) ? b.slots : [];
      skipDup = b.skipDup !== false;
      if (o.count === null) o.count = Math.max(1, Math.floor(+b.count || 1));
    }
  }

  /* 1b) 没续跑时的提示（把话说清楚，绝不闷头开新批） */
  if (prev && !(prevUnfinished && o.resume)){
    const done = Math.min(Array.isArray(prev.done) ? prev.done.length : (prev.count || 0), prev.count || 0);
    if (done >= (prev.count || 0)) {
      console.log(`[提示] 上次批次 ${prev.stamp} 已完成（${done}/${prev.count}），本次开新批次。`);
    } else if (prevUnfinished){
      console.log(`[提示] 检测到未完成批次 ${prev.stamp}（${done}/${prev.count}）。`);
      console.log(`      ${o.job ? '要续跑它请在浏览器里点「继续未完成批次」' : '要续跑它请加 --resume'}；本次仍开新批次。`);
      console.log(`      （旧批次在本次开新后作废。）`);
    } else if (!Array.isArray(prev.slots)) {
      console.log(`[提示] 旧批次是旧版进度（缺少快照），无法续跑，本次开新批次。`);
    }
  }

  if (!tpl.trim()) fail('模板是空的。先在 UI 里写好模板，或用 --job 传入。');

  /* 2) 校验模板 */
  const errors = validateTemplate(tpl, slots);
  if (errors.length){
    console.error('\n[错误] 模板有问题，无法生成：');
    for (const e of errors.slice(0, 10)) console.error('  · ' + e);
    if (errors.length > 10) console.error(`  …还有 ${errors.length - 10} 条`);
    console.error('');
    process.exit(2);
  }

  /* 3) 组合空间 */
  const names = [...new Set(scanSlots(tpl).found.map(f => f.name.trim()).filter(Boolean))];
  const pools = names.map(n => slotValues(slots, n));
  const probs = names.map(n => slotProb(slots, n));
  const anyProb = probs.some(p => p < 1);
  const total = pools.reduce((a, p, i) => a * (probs[i] < 1 ? p.length + 1 : p.length), 1);

  /* ★ 去重规则（与 index.html 的 dedupAllowed 一致）：
     有概率槽位 → 禁用（去重会扭曲概率分布，且用户既然要概率就接受重复）；
     组合空间超出精确整数范围 → 禁用（混合进制索引会失真）。
     两种情况都只是「运行时忽略」，快照里的 skipDup 字段原样保留。 */
  const dedupAllowed = !anyProb && Number.isSafeInteger(total);
  if (skipDup && !dedupAllowed){
    console.log('[提示] 去重已自动禁用：' + (anyProb ? '存在概率占位符' : '组合空间超出精确计算范围'));
    skipDup = false;
  }

  const count = st ? st.count : (o.count ?? 1);
  if (skipDup && count > total){
    fail(`已开启「跳过重复组合」，张数不能超过组合总数 ${total}（当前 ${count}）。`);
  }
  if (total === 0) fail('还没有可用的占位符组合。');

  if (!st){
    /* 开新批：生成组合并写入当次完整快照（v2，含模板/数组/参数/反向提示词），
       让续跑能脱离当前编辑完整复现。
       ★ 有概率槽位时存的是 idxs（可能含 -1 缺席标记），不是线性下标 ——
         线性下标在缺席概率非 1/(N+1) 时无法表示，只能直接存下标。 */
    const seedBase = o.seed ?? Math.floor(Math.random() * 2147483647);
    const rows = anyProb
      ? drawProbCombos(pools, probs, count)
      : drawCombos(total, count);
    st = {
      version: 2,
      stamp: tsStamp(),
      templateHash: templateHash(tpl, slots),
      template: tpl,
      slots,
      seedBase,
      count,
      skipDup,
      src: mode,
      params: { w: o.w, h: o.h, steps: o.steps, cfg: o.cfg, sampler: o.sampler, scheduler: o.scheduler },
      neg: o.neg,
      idxRows: rows,          // 每张的各槽下标（-1 = 缺席）
      linears: null,          // v2 起用 idxRows；linears 仅为兼容旧快照保留
      done: []
    };
    if (!o.list) saveState(stateFile, st);
  }

  /* 6) 打印计划 */
  const pad = String(st.count).length;
  const widths = labelWidths(pools, names);
  const plan = (st.idxRows && st.idxRows.length ? st.idxRows : (st.linears || []).map(k => decodeIdxs(k, pools)))
    .map((idxs, i) => {
    const map = {};
    names.forEach((n, j) => {
      // ABSENT → null：渲染时条件块整块删除
      map[n] = idxs[j] === ABSENT ? null : pools[j][idxs[j]];
    });
    const seq = String(i + 1).padStart(Math.max(2, pad), '0');
    const seed = st.seedBase + i;
    const file = `${st.stamp}_t2i_${seq}_seed${seed}.png`;
    return {
      i, idxs, map, seq, seed, file,
      text: renderPrompt(tpl, map),                 // 出图用（完整提示词）
      label: comboLabels(idxs, pools, widths)       // 终端展示用（标签摘要）
    };
  });

  console.log('');
  console.log('  模板指纹 : ' + st.templateHash);
  console.log('  占位符   : ' + names.map((n, i) => probs[i] < 1 ? `${n}(${Math.round(probs[i]*100)}%)` : n).join(' | '));
  console.log('  各池长度 : ' + pools.map((p, i) => probs[i] < 1 ? `${p.length}+缺席` : p.length).join(' × '));
  console.log('  组合总数 : ' + (Number.isSafeInteger(total) ? total.toLocaleString('en-US') : '超出精确范围'));
  console.log('  本批张数 : ' + st.count + (skipDup ? '（不重复）' : '（允许重复）'));
  console.log('  批次模式 : ' + (mode === 'resume' ? '续跑上一次未完成批次' : '开新批次'));
  console.log('  基准 seed: ' + st.seedBase);
  console.log('  保存目录 : ' + outDir);
  console.log('  出图参数 : ' + `${st.params.w}×${st.params.h} · ${st.params.steps} 步 · CFG ${st.params.cfg} · ${st.params.sampler}/${st.params.scheduler}`);
  console.log('  反向提示 : ' + (o.neg ? o.neg.slice(0, 60) + (o.neg.length > 60 ? ' …' : '') : '（空）'));
  console.log('  服务地址 : ' + o.server);
  if (o.job) console.log('  任务来源 : ' + o.job + '（UI 下发）');
  console.log('');

  // 表头：槽名一行，槽间用 · 分隔，和下面的标签列对齐
  const lastSlot = names.length - 1;
  const head = names
    .map((n, j) => dpad(labelOf(n, LABEL_CHARS), j === lastSlot ? 0 : widths[j]))
    .join(LABEL_SEP);
  console.log('        ' + head);

  for (const p of plan){
    const mark = st.done.includes(p.i) ? '[已完成]' : '[待生成]';
    console.log(`  ${mark} ${String(p.i + 1).padStart(2, '0')}. ${p.file}`);
    console.log(`        ${p.label}`);
  }
  console.log('');

  if (o.list){ console.log('  （--list 模式，不出图）\n'); return; }

  /* 7) 探活 */
  try {
    const r = await fetch(o.server + '/', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e){
    fail(`连不上生图服务 ${o.server}：${e.message}\n       先跑 tools\\serve.cmd 把它拉起来。`);
  }

  /* 8) 逐张生成 */
  const tAll = Date.now();
  let made = 0, skipped = 0;

  for (const p of plan){
    if (st.done.includes(p.i)){ skipped++; continue; }

    const dst = path.join(outDir, p.file);

    // 已经产出过（进度丢了但图在）→ 补记进度，不重复烧显卡
    if (verifyPng(dst).ok){
      console.log(`  [跳过] ${p.file}（已存在）`);
      st.done.push(p.i);
      saveState(stateFile, st);
      skipped++;
      continue;
    }

    process.stdout.write(`  [${p.i + 1}/${st.count}] ${p.file}  提交中…`);
    const t0 = Date.now();

    const body = {
      prompt: p.text,
      negative_prompt: o.neg,
      seed: p.seed,
      batch_count: 1,
      width: st.params.w,
      height: st.params.h,
      sample_params: {
        sample_method: st.params.sampler,
        scheduler: st.params.scheduler,
        sample_steps: st.params.steps,
        guidance: { txt_cfg: +st.params.cfg, distilled_guidance: 3.5 }
      }
    };

    let jobId = null;
    try {
      const job = await postJob(o.server, body, 30000);
      jobId = job.id;
    } catch (e){
      console.log(`\r  [${p.i + 1}/${st.count}] ${p.file}  提交失败：${e.message}\n`);
      break;
    }

    const res = await waitOne(o.server, jobId, (el, j) => {
      process.stdout.write(`\r  [${p.i + 1}/${st.count}] ${p.file}  ${j.status} ${el.toFixed(0)}s   `);
    }, 1800);

    if (res.err){
      console.log(`\r  [${p.i + 1}/${st.count}] ${p.file}  失败：${res.err}\n`);
      break;
    }

    // 落盘
    try {
      fs.writeFileSync(dst, Buffer.from(res.b64, 'base64'));
    } catch (e){
      console.log(`\r  [${p.i + 1}/${st.count}] ${p.file}  写入失败：${e.message}\n`);
      break;
    }

    const chk = verifyPng(dst);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!chk.ok){
      console.log(`\r  [${p.i + 1}/${st.count}] ${p.file}  产物校验失败：${chk.why}\n`);
      try { fs.unlinkSync(dst); } catch (_){}
      break;
    }

    console.log(`\r  [${p.i + 1}/${st.count}] ${p.file}  完成 ${secs}s · ${(chk.size / 1024).toFixed(0)} KB      `);
    st.done.push(p.i);
    saveState(stateFile, st);          // 每张立刻落盘，中断可续
    made++;
  }

  /* 9) 收尾 */
  const all = ((Date.now() - tAll) / 1000);
  console.log('');
  if (st.done.length >= st.count){
    console.log(`  ✅ 本批 ${st.count} 张全部完成。本次新出 ${made} 张，跳过 ${skipped} 张，用时 ${all.toFixed(1)}s。`);
  } else {
    console.log(`  ⏸  进度 ${st.done.length}/${st.count}，已保留。再跑一次同一命令即可续。`);
  }
  console.log(`     目录：${outDir}`);
  console.log(`     进度：${stateFile}`);
  console.log('');
}

main().catch(e => {
  console.error('\n[异常] ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
