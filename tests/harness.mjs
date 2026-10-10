/* ══════════════════════════════════════════════════════════════
   测试公共环境 —— 所有测试都从这里取路径、加载 jsdom、起隔离服务。

   为什么要有这个文件
   ──────────────────────────────────────────────────────────────
   之前每个测试各自写：
     · `process.env.TEMP + '/sdjsdom/node_modules/jsdom'`
       → jsdom 装在某个人的 %TEMP% 里，仓库没有 package.json。
         别人 clone 下来 7 个测试一行都跑不了；清了 TEMP 也全挂。
     · 端口 1247 写死、要人工先起服务
       → 起不来就整个文件失败。
     · 直接读写 `app/ui/config.json`（真实用户配置）
       → 中途崩了就把用户的 saveDir / 批量设置写坏。

   现在统一为：
     · jsdom 走正常模块解析（仓库根 `npm install` 后即有），
       并且优先用本地 node_modules —— 找不到时给出可照抄的安装命令。
     · 每个测试要服务就自己起一个「临时配置 + 随机空闲端口」的实例，
       跑完自己关；不依赖任何人工前置步骤。
     · 一切落盘都进临时目录，**绝不碰** app/ui/ 下的真实配置与模板库。

   约定：本文件以 `test-` 开头会被 `npm test` 的发现逻辑排除，
        但它本身不是测试（不会被自动执行）。
   ══════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* ── 路径 ──
   本文件在 <root>/tests/ 下，用 import.meta.url 推导，
   所以从任何工作目录执行都能找到工程文件。 */
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);
export const UI_DIR = path.join(ROOT, 'app', 'ui');
export const UI_HTML = path.join(UI_DIR, 'index.html');
export const CFG_SERVICE = path.join(ROOT, 'config-service', 'serve-config.mjs');

/** 用户真实的配置文件。测试**只读不写**，需要写时一律用 makeTempEnv()。 */
export const REAL_UI_CFG = path.join(UI_DIR, 'config.json');
/** 用户真实的模板库目录。测试**只读不写**。 */
export const REAL_TPL_DIR = path.join(UI_DIR, 'templates');

/* ── jsdom ──
   走正常解析：仓库根 `npm install` 之后 node_modules/jsdom 就在。
   找不到时抛一个能直接照抄的提示，而不是 `MODULE_NOT_FOUND` 堆栈。 */
let _jsdom = null;
export function loadJsdom(){
  if (_jsdom) return _jsdom;
  const req = createRequire(import.meta.url);
  try {
    _jsdom = req('jsdom');
  } catch {
    // 干净退出：只给一条能照抄的提示，不打印 MODULE_NOT_FOUND 堆栈
    console.error(
      '\n[ERROR] 找不到 jsdom —— 测试需要它来加载 ui/index.html。\n' +
      '        在工程根执行一次即可（只需一次）：\n\n' +
      '            npm install\n\n' +
      `        工程根：${ROOT}\n`
    );
    process.exit(1);
  }
  return _jsdom;
}

/** 读 ui/index.html，可选把 CFG_URL 改写成指定端口。 */
export function readUiHtml(cfgPort){
  const raw = fs.readFileSync(UI_HTML, 'utf8');
  if (cfgPort === undefined) return raw;
  const patched = raw.replace(
    /const CFG_URL\s*=\s*'http:\/\/127\.0\.0\.1:\d+'/,
    `const CFG_URL = 'http://127.0.0.1:${cfgPort}'`
  );
  if (!/CFG_URL = 'http:\/\/127\.0\.0\.1:\d+'/.test(patched)) {
    throw new Error('未能改写 CFG_URL，页面结构可能变了');
  }
  return patched;
}

/* ── 端口 ── */

/** 要一个真正空闲的端口（绑 0 让内核分配，随即释放）。
 *  比「随机猜一个高位端口」可靠：不会撞上用户正在跑的服务。 */
export function freePort(){
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 轮询等某个端口上的服务可用（默认最多 8 秒）。 */
export async function waitForService(port, timeoutMs = 8000){
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

/* ── 隔离环境 ──
   一次调用给出：临时配置路径 + 临时模板目录 + 起好的服务 + 关停函数。
   跑完（或出错）务必调 env.stop()，否则留下孤儿进程占着端口。 */
export async function startIsolatedService(opt = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdstudio-test-'));
  const cfgPath = path.join(dir, 'config.json');
  const tplDir = path.join(dir, 'templates');
  fs.mkdirSync(tplDir, { recursive: true });

  // 起手给一份最小可用配置（不含任何用户数据）
  fs.writeFileSync(cfgPath, JSON.stringify({
    version: 1,
    batch: { template: '', slots: [], count: 8, skipDup: true },
    saveDir: ''
  }, null, 2), 'utf8');

  const port = opt.port ?? await freePort();
  const proc = spawn(process.execPath, [CFG_SERVICE, String(port)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      SDCFG_PATH: cfgPath,
      SDTPL_DIR: tplDir,
      /* ★ 别真的弹资源管理器窗口。
         服务端照常走完全部校验（跨站拒绝 / 路径合法性 / missing / notdir），
         只是不 spawn explorer.exe —— 否则跑一轮测试会攒下一堆文件夹窗口。 */
      SDCFG_NO_OPEN: '1',
      // 服务端自己也会用 TEMP 做临时文件，指到隔离目录里
      TEMP: dir,
      TMP: dir
    }
  });

  const ok = await waitForService(port);
  if (!ok) {
    try { proc.kill('SIGKILL'); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(`隔离配置服务未能在端口 ${port} 起来（${CFG_SERVICE}）`);
  }

  return {
    port, cfgPath, tplDir, dir,
    base: `http://127.0.0.1:${port}`,
    /** 往隔离模板目录里写一个模板文件 */
    writeTemplate(t){
      fs.writeFileSync(path.join(tplDir, t.id + '.json'), JSON.stringify(t, null, 2), 'utf8');
    },
    stop(){
      try { proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

/* ── 断言小工具 ──
   各测试的通过/失败计数与输出格式本来各写一套，这里统一，
   顺带保证「结果：N 通过 / M 失败」这一行格式一致（run-all 靠它汇总）。 */
export function makeChecker(){
  let pass = 0, fail = 0;
  const failures = [];
  return {
    ok(name, cond, extra){
      if (cond) { pass++; console.log('  ✓ ' + name); }
      else {
        fail++; failures.push(name + (extra ? ': ' + extra : ''));
        console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
      }
    },
    get pass(){ return pass; },
    get fail(){ return fail; },
    get failures(){ return failures; },
    /** 打印统一的结果行并返回退出码（0 = 全通过） */
    done(){
      console.log('\n' + '─'.repeat(50));
      console.log(fail ? `结果：${pass} 通过 / ${fail} 失败` : `结果：${pass} 通过 / 0 失败`);
      return fail ? 1 : 0;
    }
  };
}

/** 让出一个事件循环轮次，等 DOM/定时器稳定。 */
export const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
