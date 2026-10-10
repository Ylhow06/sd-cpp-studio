/**
 * 批量生图配置服务 · Local config service for the batch-generation module
 *
 * 为什么需要它：
 *   sd-server（stable-diffusion.cpp）只提供 5 个路由 —— capabilities / img_gen /
 *   jobs / upscale / vid_gen，既没有文件读写接口，也没有静态目录服务
 *   （命令行只有 --serve-html-path，没有 --serve-dir）。所以「配置落磁盘、
 *   刷新不丢失」这件事无法在 sd-server 内完成，必须另起一个进程。
 *
 * 职责：
 *   - GET  /health  探活
 *   - GET  /config  读配置；文件不存在或损坏 → 返回出厂默认（不报 500）
 *   - POST /config  写配置；原子替换（写 .tmp 再 rename）
 *
 * 监听 127.0.0.1:1235（sd-server 默认在 1234）。
 * UI 在 1234 上，跨源访问本服务，因此必须自带 CORS 头并处理 OPTIONS 预检。
 *
 * 用法：node serve-config.mjs [port]
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/* ★ 配置文件路径可用 SDCFG_PATH 覆盖。
   测试要一个干净、互不干扰的配置，绝不能去删/改用户真实的 app/ui/config.json。

   默认位置：<root>\app\ui\config.json
   本脚本在 <root>\config-service\ 下，所以要往上一级再进 app\ui。 */
const CONFIG_PATH = process.env.SDCFG_PATH
  ? path.resolve(process.env.SDCFG_PATH)
  : path.join(__dirname, '..', 'app', 'ui', 'config.json');
const TMP_PATH = CONFIG_PATH + '.tmp';

/* ★ 模板库目录：一个模板一个文件，模板的权威源就在这里。
   config.json 不再保存 templates 字段（旧数据启动时自动迁移）。

   为什么拆开（用户实测的痛点）：
     · 5 个模板挤在 config.json 一个数组里，手工改很难定位
     · 更糟的是写入是「整份覆盖」：页面内存里持有一份配置副本，
       任何编辑触发防抖保存就把整份 config.json 覆盖掉 ——
       手工改过的内容会被静默抹掉
     拆成独立文件后，一个模板一个文件，直接打开就能改、改完即生效。

   路径推导：默认 <root>/app/ui/templates。
   ★ 设了 SDCFG_PATH 时（测试用），模板目录跟着配置走 ——
     这样测试自动隔离，绝不会碰到用户真实的模板库。 */
const TPL_DIR = process.env.SDTPL_DIR
  ? path.resolve(process.env.SDTPL_DIR)
  : (process.env.SDCFG_PATH
      ? path.join(path.dirname(CONFIG_PATH), 'templates')
      : path.join(__dirname, '..', 'app', 'ui', 'templates'));
const HOST = '127.0.0.1';
const MAX_BODY = 4 * 1024 * 1024;   // 4 MB，配置里只有文本，够用

/* ── 命令行 ──
   node serve-config.mjs [port]
   端口也可用 SDCFG_PORT 指定。
   注：v1 的 --allow-open 白名单已移除（见文件头「安全模型 v2」），
   该参数现在被忽略并给出提示，避免老脚本静默失效。 */
const argvRaw = process.argv.slice(2);
const positional = [];
for (let i = 0; i < argvRaw.length; i++) {
  const a = argvRaw[i];
  if (a === '--allow-open' || a === '-a') {
    const v = argvRaw[++i];
    console.warn(`[warn] --allow-open 已废弃（白名单机制已移除），忽略参数：${v || ''}`);
  } else if (a.startsWith('--allow-open=')) {
    console.warn(`[warn] --allow-open 已废弃，忽略参数：${a.slice('--allow-open='.length)}`);
  } else {
    positional.push(a);
  }
}
const PORT = Number(positional[0] || process.env.SDCFG_PORT || 1235);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[ERROR] 端口不合法：${positional[0]}`);
  process.exit(1);
}

/* ────────────────────────── 出厂默认 ──────────────────────────
   注意：默认模板里的占位符必须都有非空数组，否则按「找不到数组就硬拦」
   的规则，用户第一次打开批量面板就会看到红色报错。

   ★ 构图原则（实测总结，两轮迭代得来）：
     身份块很长，会把模型权重压在脸上，默认出图会变成「胸部以上半身」，
     导致服装和腰部以下的姿势全部体现不出来。
     解决办法是【构图前置 + 末尾重复】：
       1) 把「全身构图」写在模板最开头（开头权重最高）
       2) 结尾再用一句「全身站姿，完整展示服装」加固
       3) 身份块保持完整（脸的一致性靠它），但不再让它独占权重
     实测失败例（半身时代）：举起奶茶（杯子裁在画面边缘）、低头挑选水果
     （水果在底部被裁）、撑伞回头（伞面出画）、靠着栏杆（栏杆不在画面内）。
     现在的姿势数组一律是【静态站姿】——动态动作（走、蹲、跑）在这套
     写实风格下容易崩肢体，静态站姿稳定且能展示整套服装。 */
const FACTORY = {
  version: 1,
  batch: {
    template:
      '全身竖构图，一位20岁中国女孩的全身生活快照，从头到脚完整入镜，' +
      '人物占画面主体，服装完整清晰可见，全身穿搭都拍进画面。\n' +
      '固定身份特征，每一张都必须完全一致：左眼下方有一颗小泪痣，' +
      '细长的单眼皮杏眼、眼尾微微下垂，眉毛细而平直，鼻子小巧挺直、鼻头圆润，嘴唇小巧饱满呈' +
      '自然粉色，圆润柔和的鹅蛋脸、下巴略短，齐刘海及肩黑发，白皙偏暖的皮肤带自然肌理，身材纤细。\n' +
      '服装：{{服装}}。场景：{{场景}}。姿势：{{动作}}。\n' +
      '全身站姿，完整展示服装与身形，双脚和鞋子都在画面内。' +
      '真实抓拍风格，纪实生活摄影，可用自然光，手机拍摄质感，写实。',
    slots: [
      {
        name: '服装',
        values: [
          '黑色皮夹克内搭白T恤配黑色长裤和短靴',
          '黄色针织马甲配牛仔短裙和白色运动鞋',
          '灰色超大号连帽卫衣配深色工装裤和帆布鞋',
          '红色格子衬衫配卡其工装裤和马丁靴',
          '米色针织开衫配长裙和乐福鞋',
          '白色衬衫配西装裤和黑色皮鞋'
        ]
      },
      {
        name: '场景',
        values: [
          '夜晚拥挤的夜市街道',
          '日落时分的海边沙滩',
          '书店的书架之间',
          '傍晚的城市天台',
          '雨天公交站台',
          '清晨的菜市场'
        ]
      },
      {
        name: '动作',
        values: [
          '自然站立，双手垂在身体两侧，正视镜头',
          '站直，一手插在口袋里，微微侧身',
          '站立，双手交握放在身前，神情平静',
          '微微侧身站立，一手轻搭在腰侧',
          '双脚并拢站立，一手拨弄耳边的发丝',
          '站立，双手插兜，肩膀放松，浅笑',
          '站姿，一只手扶着肩上的包带',
          '侧身站立，回头看向镜头'
        ]
      }
    ],
    skipDup: true,
    count: 8
  },
  templates: [],
  plan: null
};

/* ────────────────────── 保存目录 / 打开资源管理器 ──────────────────────

   为什么需要服务端来开：
     浏览器的 File System Access API 出于安全考虑【永远不告诉网页真实路径】，
     FileSystemDirectoryHandle 只给一个 .name（如 "LocalModel"），拿不到
     "D:\Pictures\local-model"。所以纯前端无法实现「在资源管理器里打开」。

   做法：
     UI 把要打开的「真实路径」告诉我们（它自己拿不到），我们 spawn explorer.exe。

   安全模型（v2，比 v1 简单得多）：
     v1 用「白名单根目录 + --allow-open」来限制能打开哪些目录。实践下来这是
     自找麻烦：用户每次换保存目录都得改启动参数，忘了就报「路径不在允许范围内」。
     而这个服务只监听 127.0.0.1，唯一的使用者就是本机的用户本人。

     真正要防的不是「用户打开自己的目录」，而是【浏览器里的恶意网页偷偷
     POST 到这个本地端口】。所以正确的做法是防跨站，而不是限制路径：

       1. 只接受来自本工作台页面的请求（Origin/Referer 校验）
       2. 拒绝跨站的「简单请求」——它不带 Origin 也可能到达，用自定义头强制预检
       3. 打开前校验：路径存在、是目录（避免拿它当文件探测工具）
       4. 只 spawn explorer.exe，参数走数组，绝不拼 shell 字符串

     这样「任意目录都能打开」而不会被任意网页利用。
   ─────────────────────────────────────────────────────────────── */

/** UI 最近一次报告的保存目录（由 /savedir 写入，仅内存，不落盘）。 */
let lastSaveDir = null;

/* ── 反跨站 ──
   本页面可能是 file:// 或 http://127.0.0.1:<sd-server端口>，两者都要放行。
   其他来源一律拒绝，防止恶意网页借本地服务打开/探测目录。 */
function originAllowed(req) {
  const o = req.headers.origin;
  // 同源的非 CORS 请求（curl、本机脚本）没有 Origin —— 放行，浏览器才会带 Origin
  if (!o) return true;
  if (o === 'null') return true;                       // file:// 页面
  try {
    const u = new URL(o);
    const h = u.hostname;
    return u.protocol === 'http:' &&
      (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1');
  } catch {
    return false;
  }
}

/* ────────────────────────── 终端运行（/run-cli） ──────────────────────────
 *
 *  为什么需要它：
 *    「关掉浏览器也能跑」要求把批量任务交给终端。但 config.json 只存
 *    模板/数组/张数/保存目录 —— 尺寸、步数、CFG、采样器、反向提示词
 *    只在浏览器的内存里，落不了盘。所以必须由 UI 把「当时的完整快照」
 *    交给一个能起进程的服务，由它写成任务文件再拉起 node。
 *
 *  安全边界（重要）：
 *    本接口会**启动进程**，比开目录危险得多。因此：
 *      1) 只允许 POST，且必须过 originAllowed（跨站一律 403）
 *      2) 不接受任意命令 —— 可执行文件写死为 process.execPath（node 自身），
 *         脚本写死为 <root>\tools\batch-run.mjs，用户数据只作为**参数值**传入，
 *         且经 spawn(..., {shell:false}) 传数组，不存在命令拼接
 *      3) 路径（任务文件、保存目录）都经 path.resolve 校验
 *      4) 任务快照先写进 <root>\output\.cli-jobs\ 再交给脚本，
 *         避免超长命令行（中文模板很长，Windows 命令行有 32K 上限）
 */

const JOB_DIR = path.join(__dirname, '..', 'output', '.cli-jobs');
const CLI_SCRIPT = path.join(__dirname, '..', 'tools', 'batch-run.mjs');

/** 最近一次拉起的终端进程（仅内存，用于 /run-cli/status 报告）。 */
let lastCliRun = null;

/** 把 UI 传来的任务快照落成任务文件，返回文件路径。 */
async function writeJobFile(job) {
  await fsp.mkdir(JOB_DIR, { recursive: true });
  const name = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.json`;
  const file = path.join(JOB_DIR, name);
  await fsp.writeFile(file, JSON.stringify(job, null, 2), 'utf8');
  return file;
}

/**
 * 拉起一个可见的终端窗口跑批量脚本。
 * ★ 用 cmd /k 保留窗口，跑完不会立刻消失，用户能看到结果。
 */
function spawnBatchTerminal(jobFile, extraArgs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    // 参数数组直传，shell:false —— 不存在命令拼接
    const args = [process.execPath, CLI_SCRIPT, '--job', jobFile, ...extraArgs];

    let child;
    try {
      if (process.platform === 'win32') {
        // 用 start 开一个新窗口，/k 让它跑完停住
        const cmd = ['/c', 'start', '""', 'cmd', '/k', ...args];
        child = spawn('cmd.exe', cmd, { detached: true, stdio: 'ignore', windowsHide: false });
      } else {
        child = spawn(args[0], args.slice(1), { detached: true, stdio: 'ignore' });
      }
    } catch (e) {
      return done({ ok: false, code: 'spawn', error: '启动终端失败：' + e.message });
    }
    child.on('error', (e) => done({ ok: false, code: 'spawn', error: '启动终端失败：' + e.message }));
    child.on('spawn', () => { child.unref(); done({ ok: true, pid: child.pid }); });
    setTimeout(() => done({ ok: true, pid: child.pid || null }), 2000).unref();
  });
}

/**
 * 校验要打开的目录。
 * 不再限制「在哪个盘」，只保证：路径合法、存在、确实是目录。
 * @param {string} target 待校验路径
 * @param {{create?:boolean}} opts create=true 时允许不存在并自动建
 */
function checkOpenAllowed(target, opts = {}) {
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, code: 'bad', error: '路径为空' };
  }
  if (target.includes('\0')) return { ok: false, code: 'bad', error: '路径含非法字符' };

  let abs;
  try {
    abs = path.resolve(target);
  } catch {
    return { ok: false, code: 'bad', error: '路径无法解析' };
  }

  if (!fs.existsSync(abs)) {
    if (!opts.create) return { ok: false, code: 'missing', error: '目录不存在：' + abs };
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (e) {
      return { ok: false, code: 'mkdir', error: '创建目录失败：' + e.message };
    }
  }

  try {
    if (!fs.statSync(abs).isDirectory()) return { ok: false, code: 'notdir', error: '不是目录：' + abs };
  } catch (e) {
    return { ok: false, code: 'bad', error: e.message };
  }
  return { ok: true, path: abs };
}

/** 把内部错误码映射成合适的 HTTP 状态码。 */
function codeToStatus(code) {
  switch (code) {
    case 'denied':   return 403;
    case 'missing':
    case 'notdir':
    case 'nopath':   return 400;
    case 'mkdir':    return 500;
    default:         return 400;
  }
}

/**
 * 用 explorer.exe 打开一个目录。
 * ★ 关键：explorer.exe 即使成功也常返回非 0 退出码（本机实测 0xC0000142），
 *   所以【绝不能】用退出码判断成败。只要进程能 spawn 起来就算成功。
 */
function openInExplorer(dir) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let child;
    try {
      child = spawn('explorer.exe', [dir], {
        detached: true, stdio: 'ignore', windowsHide: false
      });
    } catch (e) {
      return done({ ok: false, code: 'spawn', error: '启动 explorer 失败：' + e.message });
    }
    child.on('error', (e) => done({ ok: false, code: 'spawn', error: '启动 explorer 失败：' + e.message }));
    // 能起来就立刻算成功，不等待它退出
    child.on('spawn', () => { child.unref(); done({ ok: true, path: dir }); });
    // 兜底：2 秒内既没 spawn 也没 error，按成功处理（避免误报失败）
    setTimeout(() => done({ ok: true, path: dir }), 2000).unref();
  });
}

/* ────────────────────────── 工具 ────────────────────────── */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  cors(res);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 深拷贝出厂默认，避免被调用方改坏。 */
function factory() {
  return JSON.parse(JSON.stringify(FACTORY));
}

/** 只做形状校验：不信任磁盘上的内容，坏结构一律回退默认。 */
function sanitize(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (!cfg.batch || typeof cfg.batch !== 'object') return null;
  if (typeof cfg.batch.template !== 'string') return null;
  if (!Array.isArray(cfg.batch.slots)) return null;

  const slots = [];
  for (const s of cfg.batch.slots) {
    if (!s || typeof s.name !== 'string') continue;
    const name = s.name.trim();
    if (!name) continue;
    const values = Array.isArray(s.values)
      ? s.values.filter((v) => typeof v === 'string')
      : [];
    slots.push(withProb({ name, values }, s.p));
  }

  const out = {
    version: 1,
    batch: {
      template: cfg.batch.template,
      slots,
      skipDup: cfg.batch.skipDup !== false,
      count: Number.isFinite(+cfg.batch.count) ? Math.max(1, Math.floor(+cfg.batch.count)) : 8
    },
    // ★ 保存目录的真实路径（浏览器拿不到，由 UI 记在这里）。
    //   仅作为文本保存，不在这里做白名单校验 —— 路径可能暂时不可用，
    //   校验放在真正要用它的 /savedir 和 /open-dir 上。
    saveDir: typeof cfg.saveDir === 'string' ? cfg.saveDir.slice(0, 512) : '',
    // ★ 模板库已迁到 <TPL_DIR>/<id>.json（一个模板一个文件），
    //   config.json 不再保存该字段。这里显式丢弃旧字段，
    //   迁移由启动时的 migrateTemplatesFromConfig 完成。
    plan: cfg.plan && typeof cfg.plan === 'object' ? cfg.plan : null
  };
  return out;
}

/* ────────── 占位符出现概率 ──────────
   槽位可选字段 p：该占位符在每张图里「出现」的概率。
      · 缺省 / 非法值  → 视为 1（必选），字段不落盘
      · p ∈ (0, 1)     → 可选，保留字段（0 < p < 1 才会禁用去重）
      · p <= 0 / p >= 1 → 归一化掉（p>=1 与必选等价；0 概率是死配置，由 UI 拦）
   校验放这里是因为 sanitize 是白名单重建 —— 不加这一步，概率会在每次
   保存时被静默丢弃（界面正常、落盘即失效）。 */
function withProb(slot, p) {
  const n = Number(p);
  if (Number.isFinite(n) && n > 0 && n < 1) slot.p = n;
  return slot;
}

/* ────────── 用户模板库（一个模板一个文件） ──────────
   每个模板 = 批量面板的完整可复现状态：
     { id, name, at, template, slots, count, skipDup }
   落盘位置：<TPL_DIR>/<id>.json

   只做形状校验与裁剪，业务规则（同名）交给 UI，
   但服务端也要兜住，避免手工改坏文件后炸掉页面。 */

const TPL_NAME_MAX = 60;
const TPL_SLOTS_MAX = 40;     // 单个模板最多多少个占位符
const TPL_VALUES_MAX = 300;   // 单个占位符最多多少条取值

/** id → 文件名。★ 必须严格校验：id 直接来自 HTTP，是路径注入的入口。
 *  只允许字母/数字/下划线/连字符，长度受限；其余一律拒绝。 */
const TPL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function tplFile(id) {
  if (typeof id !== 'string' || !TPL_ID_RE.test(id)) return null;
  const f = path.join(TPL_DIR, id + '.json');
  // 双保险：解析后的绝对路径必须仍落在 TPL_DIR 内（防 `..` 之类绕过）
  const rel = path.relative(TPL_DIR, f);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return f;
}

/** 净化模板里的 slot 数组（与 batch.slots 同样的形状要求）。 */
function sanitizeTplSlots(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const s of raw.slice(0, TPL_SLOTS_MAX)) {
    if (!s || typeof s.name !== 'string') continue;
    const name = s.name.trim();
    if (!name) continue;
    const values = Array.isArray(s.values)
      ? s.values.filter((v) => typeof v === 'string').slice(0, TPL_VALUES_MAX)
      : [];
    out.push(withProb({ name, values }, s.p));
  }
  return out;
}

/** 净化单个模板对象。不合法返回 null。 */
function sanitizeTemplate(t, fallbackId) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.template !== 'string') return null;
  let name = typeof t.name === 'string' ? t.name.trim() : '';
  if (!name) return null;
  if (name.length > TPL_NAME_MAX) name = name.slice(0, TPL_NAME_MAX);

  const id = (typeof t.id === 'string' && TPL_ID_RE.test(t.id.trim()))
    ? t.id.trim()
    : (fallbackId && TPL_ID_RE.test(fallbackId) ? fallbackId : null);
  if (!id) return null;

  return {
    id,
    name,
    at: Number.isFinite(+t.at) ? +t.at : Date.now(),
    template: t.template,
    slots: sanitizeTplSlots(t.slots),
    count: Number.isFinite(+t.count) ? Math.max(1, Math.floor(+t.count)) : 8,
    skipDup: t.skipDup !== false
  };
}

/** 读取整个模板库（按 at 倒序，与旧列表顺序一致）。 */
async function readTemplates() {
  let names;
  try {
    names = await fsp.readdir(TPL_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -'.json'.length);
    if (!TPL_ID_RE.test(id)) continue;
    try {
      const raw = await fsp.readFile(path.join(TPL_DIR, n), 'utf8');
      const t = sanitizeTemplate(JSON.parse(raw), id);
      if (t) out.push(t);
      else console.warn('[warn] 模板文件结构异常，已跳过：' + n);
    } catch (e) {
      console.warn('[warn] 模板文件读取失败，已跳过：' + n + ' — ' + e.message);
    }
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out;
}

/** 原子写单个模板文件。 */
async function writeTemplate(t) {
  const f = tplFile(t.id);
  if (!f) throw new Error('模板 id 不合法：' + t.id);
  await fsp.mkdir(TPL_DIR, { recursive: true });
  const tmp = f + '.tmp';
  const data = JSON.stringify(t, null, 2);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, f);
}

/** 删除单个模板文件。文件不存在不算错（幂等）。 */
async function deleteTemplateFile(id) {
  const f = tplFile(id);
  if (!f) throw new Error('模板 id 不合法：' + id);
  try {
    await fsp.unlink(f);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** 一次性迁移：config.json 里若有 templates 数组，写成独立文件。
 *  只在确实有内容时动手；迁移完成后由 writeConfig 落一份不含该字段的配置。
 *  幂等：重复启动不会重复迁移（字段已被移除）。 */
async function migrateTemplatesFromConfig(cfg) {
  const raw = cfg && cfg.templates;
  if (!Array.isArray(raw) || !raw.length) return 0;
  let n = 0;
  for (const t of raw) {
    const clean = sanitizeTemplate(t, null);
    if (!clean) continue;
    try {
      // ★ 已存在同名文件则不覆盖 —— 独立文件是权威源，
      //   不能让一次旧配置的启动把用户手改过的模板冲掉。
      const f = tplFile(clean.id);
      if (f && fs.existsSync(f)) continue;
      await writeTemplate(clean);
      n++;
    } catch (e) {
      console.warn('[warn] 迁移模板失败：' + (t && t.name) + ' — ' + e.message);
    }
  }
  return n;
}

async function readConfig() {
  let raw;
  try {
    raw = await fsp.readFile(CONFIG_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { cfg: factory(), existed: false };
    throw e;
  }
  try {
    const parsed = sanitize(JSON.parse(raw));
    if (!parsed) {
      console.warn('[warn] config.json 结构异常，回退出厂默认');
      return { cfg: factory(), existed: true, bad: true };
    }
    return { cfg: parsed, existed: true };
  } catch (e) {
    console.warn('[warn] config.json 解析失败：' + e.message + '，回退出厂默认');
    return { cfg: factory(), existed: true, bad: true };
  }
}

/** 原子写：先写 .tmp 并 fsync，再 rename 覆盖，避免断电/崩溃留下半个文件。 */
async function writeConfig(cfg) {
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const data = JSON.stringify(cfg, null, 2);
  const fh = await fsp.open(TMP_PATH, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(TMP_PATH, CONFIG_PATH);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ────────────────────────── 路由 ────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // 预检
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ★ 反跨站：只服务本机页面。浏览器一定会带 Origin，
  //   恶意网页的跨站请求会被这里挡下，避免被借刀开目录/探测路径。
  if (!originAllowed(req)) {
    sendJSON(res, 403, { ok: false, error: '拒绝跨站请求（Origin 不是本机）' });
    return;
  }

  try {
    if (p === '/health' && req.method === 'GET') {
      sendJSON(res, 200, {
        ok: true, configPath: CONFIG_PATH, version: 1, templatesDir: TPL_DIR,
        openDir: { enabled: true, lastSaveDir }
      });
      return;
    }

    /* UI 报告它选中的真实目录（浏览器自己拿不到路径，必须由页面回传） */
    if (p === '/savedir' && req.method === 'POST') {
      const text = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: 'JSON 解析失败：' + e.message });
        return;
      }
      const dir = parsed && typeof parsed.dir === 'string' ? parsed.dir.trim() : '';
      // 显式清除：用户换了保存目录，旧的真实路径作废
      if (!dir && parsed && parsed.clear === true) {
        lastSaveDir = null;
        sendJSON(res, 200, { ok: true, dir: '' });
        return;
      }
      if (!dir) {
        sendJSON(res, 400, { ok: false, error: '缺少 dir 字段' });
        return;
      }
      const chk = checkOpenAllowed(dir, { create: true });   // 不存在就顺手建出来
      if (!chk.ok) {
        sendJSON(res, codeToStatus(chk.code), { ok: false, code: chk.code, error: chk.error });
        return;
      }
      lastSaveDir = chk.path;
      sendJSON(res, 200, { ok: true, dir: lastSaveDir });
      return;
    }

    /* 在资源管理器里打开保存目录 */
    if (p === '/open-dir' && req.method === 'POST') {
      const text = await readBody(req);
      let parsed = {};
      if (text && text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' });
          return;
        }
      }
      // ★ 必须显式传 dir。
      //   旧实现会在 dir 缺失时回退到 lastSaveDir，导致「用户没指定、却打开了
      //   服务端自己记的某个目录」—— 表现为弹出一句莫名其妙的「已在资源管理器
      //   打开：<别的目录>」。开目录是有副作用的动作，不允许猜。
      const target = (parsed && typeof parsed.dir === 'string') ? parsed.dir.trim() : '';
      if (!target) {
        sendJSON(res, 400, {
          ok: false, code: 'nopath',
          error: '必须在请求里显式提供 dir；本接口不会替你猜要打开哪个目录'
        });
        return;
      }
      const chk = checkOpenAllowed(target);
      if (!chk.ok) {
        sendJSON(res, codeToStatus(chk.code), { ok: false, code: chk.code, error: chk.error });
        return;
      }
      const r = await openInExplorer(chk.path);
      sendJSON(res, r.ok ? 200 : 500, r);
      return;
    }

    /* 列出指定目录下的子文件夹（给「指定路径」弹窗做浏览用） */
    if (p === '/list-dir' && req.method === 'GET') {
      const q = url.searchParams.get('dir') || '';
      if (!q) {
        sendJSON(res, 400, { ok: false, code: 'nopath', error: '请提供 dir 参数' });
        return;
      }
      const chk = checkOpenAllowed(q);
      if (!chk.ok) {
        sendJSON(res, codeToStatus(chk.code), { ok: false, code: chk.code, error: chk.error });
        return;
      }
      try {
        const ents = await fsp.readdir(chk.path, { withFileTypes: true });
        const dirs = ents
          .filter((e) => { try { return e.isDirectory(); } catch { return false; } })
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b, 'zh'));
        // 盘符列表：方便从「我的电脑」层开始浏览
        const drives = [];
        for (let c = 65; c <= 90; c++) {
          const d = String.fromCharCode(c) + ':\\';
          try { if (fs.existsSync(d)) drives.push(d); } catch {}
        }
        sendJSON(res, 200, {
          ok: true, dir: chk.path,
          parent: path.dirname(chk.path),
          drives, dirs
        });
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: '读取目录失败：' + e.message });
      }
      return;
    }

    /* 「我的电脑」层：列出所有盘符，作为浏览起点 */
    if (p === '/drives' && req.method === 'GET') {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(d)) drives.push(d); } catch {}
      }
      sendJSON(res, 200, { ok: true, drives });
      return;
    }

    if (p === '/config' && req.method === 'GET') {
      const { cfg, existed, bad } = await readConfig();
      sendJSON(res, 200, { ok: true, existed: !!existed, bad: !!bad, config: cfg });
      return;
    }

    if (p === '/config' && req.method === 'POST') {
      const text = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: 'JSON 解析失败：' + e.message });
        return;
      }
      const clean = sanitize(parsed);
      if (!clean) {
        sendJSON(res, 400, { ok: false, error: '配置结构不合法' });
        return;
      }
      await writeConfig(clean);
      sendJSON(res, 200, { ok: true, savedAt: Date.now() });
      return;
    }

    /* ────────── 模板库（一个模板一个文件） ──────────
       GET    /templates          列出全部模板（含正文）
       PUT    /templates/<id>     新建或覆盖一个模板
       DELETE /templates/<id>     删除一个模板
       id 只允许 [A-Za-z0-9_-]，是文件名的一部分，因此必须严格校验。 */

    if (p === '/templates' && req.method === 'GET') {
      const list = await readTemplates();
      sendJSON(res, 200, { ok: true, dir: TPL_DIR, templates: list });
      return;
    }

    if (p.startsWith('/templates/')) {
      const id = decodeURIComponent(p.slice('/templates/'.length));
      const file = tplFile(id);
      if (!file) {
        sendJSON(res, 400, { ok: false, code: 'badid', error: '模板 id 不合法（只允许字母、数字、下划线、连字符）' });
        return;
      }

      if (req.method === 'GET') {
        try {
          const raw = await fsp.readFile(file, 'utf8');
          const t = sanitizeTemplate(JSON.parse(raw), id);
          if (!t) {
            sendJSON(res, 500, { ok: false, error: '模板文件结构异常' });
            return;
          }
          sendJSON(res, 200, { ok: true, template: t });
        } catch (e) {
          if (e.code === 'ENOENT') sendJSON(res, 404, { ok: false, error: '模板不存在' });
          else sendJSON(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (req.method === 'PUT' || req.method === 'POST') {
        const text = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          sendJSON(res, 400, { ok: false, error: 'JSON 解析失败：' + e.message });
          return;
        }
        // 路径里的 id 为准（防止正文里的 id 与文件名不一致）
        const t = sanitizeTemplate(Object.assign({}, parsed, { id }), id);
        if (!t) {
          sendJSON(res, 400, { ok: false, error: '模板结构不合法（需要 name 与 template）' });
          return;
        }
        await writeTemplate(t);
        sendJSON(res, 200, { ok: true, template: t, savedAt: Date.now() });
        return;
      }

      if (req.method === 'DELETE') {
        await deleteTemplateFile(id);
        sendJSON(res, 200, { ok: true, deleted: id });
        return;
      }
    }

    // 兼容：POST /config/reset → 恢复出厂默认
    if (p === '/config/reset' && req.method === 'POST') {
      const cfg = factory();
      await writeConfig(cfg);
      sendJSON(res, 200, { ok: true, config: cfg });
      return;
    }

    /* ★ 把当前这一批交给终端跑（关掉浏览器也能继续）。
       请求体 = UI 当时的完整快照；服务端只负责落成任务文件 + 拉起终端。 */
    if (p === '/run-cli' && req.method === 'POST') {
      const text = await readBody(req);
      let job;
      try {
        job = JSON.parse(text);
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: 'JSON 解析失败：' + e.message });
        return;
      }
      if (!job || typeof job !== 'object') {
        sendJSON(res, 400, { ok: false, error: '任务快照必须是 JSON 对象' });
        return;
      }
      if (typeof job.template !== 'string' || !job.template.trim()) {
        sendJSON(res, 400, { ok: false, error: '任务快照缺少 template' });
        return;
      }
      if (!Array.isArray(job.slots)) {
        sendJSON(res, 400, { ok: false, error: '任务快照缺少 slots 数组' });
        return;
      }

      // 保存目录：有就校验并建出来，脚本写盘前不再依赖浏览器权限
      if (typeof job.outDir === 'string' && job.outDir.trim()) {
        const chk = checkOpenAllowed(job.outDir.trim(), { create: true });
        if (!chk.ok) {
          sendJSON(res, codeToStatus(chk.code), { ok: false, code: chk.code, error: '保存目录不可用：' + chk.error });
          return;
        }
        job.outDir = chk.path;
      }

      if (!fs.existsSync(CLI_SCRIPT)) {
        sendJSON(res, 500, { ok: false, error: '找不到批量脚本：' + CLI_SCRIPT });
        return;
      }

      let jobFile;
      try {
        jobFile = await writeJobFile(job);
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: '写任务文件失败：' + e.message });
        return;
      }

      // dryRun：只落文件、打印将要执行的命令，不真的起进程（给测试用）
      if (job.dryRun === true) {
        const args = [process.execPath, CLI_SCRIPT, '--job', jobFile];
        sendJSON(res, 200, { ok: true, dryRun: true, jobFile, argv: args });
        return;
      }

      const r = await spawnBatchTerminal(jobFile, []);
      if (!r.ok) {
        sendJSON(res, 500, { ok: false, error: r.error });
        return;
      }
      lastCliRun = { at: Date.now(), jobFile, pid: r.pid || null };
      sendJSON(res, 200, {
        ok: true, jobFile, pid: r.pid || null,
        hint: '终端窗口已打开，浏览器可以关掉了。'
      });
      return;
    }

    /* 查最近一次终端任务（只报告服务端记得的信息，进度以保存目录里的
       .batch-cli-state.json 为准 —— 那由脚本维护，这里不重复读）。 */
    if (p === '/run-cli/status' && req.method === 'GET') {
      if (!lastCliRun) {
        sendJSON(res, 200, { ok: true, last: null });
        return;
      }
      sendJSON(res, 200, {
        ok: true,
        last: { at: lastCliRun.at, pid: lastCliRun.pid, jobFile: lastCliRun.jobFile }
      });
      return;
    }

    /* 供 UI 探测保存目录里是否有「未完成批次」以及是否可续。
       只读 .batch-cli-state.json 并将其元信息透出；不读图片、不改任何东西。
       返回：batch=null（没批次记录）| { stamp, done, count, finished, resumable }。 */
    if (p === '/run-cli/state' && req.method === 'GET') {
      const dir = (url.searchParams.get('dir') || '').trim();
      const chk = checkOpenAllowed(dir);
      if (!chk.ok) { sendJSON(res, codeToStatus(chk.code), { ok: false, code: chk.code, error: chk.error }); return; }

      const sf = path.join(chk.path, '.batch-cli-state.json');
      if (!fs.existsSync(sf)) { sendJSON(res, 200, { ok: true, batch: null }); return; }

      let s = null;
      try { s = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {}
      if (!s) { sendJSON(res, 200, { ok: true, batch: null }); return; }

      const done = Array.isArray(s.done) ? s.done.length : 0;
      const count = Math.max(0, Math.floor(+s.count || 0));
      // ★ 可续 = 未完成 且 是 v2 快照（带 template/slots）。
      //   旧版 v1 只有参数没有模板/数组，脚本无法按快照续跑，这里就不能标「可续」。
      const hasSnapshot = typeof s.template === 'string' && Array.isArray(s.slots) && s.slots.length > 0;
      sendJSON(res, 200, {
        ok: true,
        batch: {
          stamp: typeof s.stamp === 'string' ? s.stamp : null,
          done, count,
          finished: count > 0 && done >= count,
          resumable: hasSnapshot && done < count,
          hasSnapshot,
          templateHash: typeof s.templateHash === 'string' ? s.templateHash : null
        }
      });
      return;
    }

    sendJSON(res, 404, { ok: false, error: 'not found: ' + p });
  } catch (e) {
    console.error('[error]', e);
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[ERROR] 端口 ${PORT} 已被占用。`);
    console.error(`        可能是上一个配置服务没退干净，或别的程序占了这个端口。`);
    console.error(`        换端口：node serve-config.mjs 1236`);
    console.error('');
  } else {
    console.error('[ERROR]', e.message);
  }
  process.exit(1);
});

/* ★ 启动前迁移：config.json 里的 templates → 独立文件。
   必须在 listen 之前完成，否则 UI 一打开读到的模板库是空的。
   迁移后写回一份不含 templates 的配置（字段被 sanitize 丢弃）。 */
async function startup() {
  try {
    let raw = null;
    try {
      raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (raw) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* 坏文件交给 readConfig 兜底 */ }
      if (parsed && Array.isArray(parsed.templates) && parsed.templates.length) {
        const n = await migrateTemplatesFromConfig(parsed);
        const clean = sanitize(parsed);
        if (clean) await writeConfig(clean);
        console.log(`[config] 已把 ${n} 个模板迁移到独立文件：${TPL_DIR}`);
        if (n < parsed.templates.length) {
          console.log(`[config] （${parsed.templates.length - n} 个已存在同名文件，按「独立文件为准」跳过）`);
        }
      }
    }
  } catch (e) {
    console.error('[warn] 模板迁移失败（不影响启动）：' + e.message);
  }

  server.listen(PORT, HOST, () => {
    console.log(`[config] 配置服务已启动  http://${HOST}:${PORT}`);
    console.log(`[config] 配置文件          ${CONFIG_PATH}`);
    console.log(`[config] 模板库目录        ${TPL_DIR}`);
    console.log('[open]   「打开文件夹」已启用（任意存在的目录均可打开，跨站请求会被拒绝）');
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('[config] 配置文件不存在，首次写入时自动创建（当前使用出厂默认）');
    }
  });
}
startup();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[config] 正在退出…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  });
}
