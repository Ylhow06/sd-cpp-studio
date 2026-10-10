/* ══════════════════════════════════════════════════════════════
   在资源管理器打开保存目录 —— 服务端接口与安全测试（安全模型 v2）
   ──────────────────────────────────────────────────────────────
   v2 移除了白名单，改为「反跨站 + 路径合法性校验」。
   覆盖：
     D. /health 暴露 lastSaveDir
     E. /savedir 校验与自动创建
     F. /open-dir 打开任意存在的目录（不再限制盘符）
     G. /list-dir 与 /drives 浏览
     H. ★ 安全：跨站拒绝、路径合法性、空字节
     I. saveDir 随配置持久化

   用法：node tests/test-open-dir.mjs
   （自己起隔离服务，无需任何前置步骤）

   ★ 本文件自己起一个「临时配置 + 临时模板库 + 内核分配的空闲端口」的服务，
     所以 I 段那些写配置的操作全落在临时文件里，**绝不碰** app/ui/config.json。
     之前这里要人工先起服务（端口 1247 写死），并且直接读写真实配置 ——
     中途崩了就把用户的 saveDir / 批量设置写坏。
   ══════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { startIsolatedService, ROOT } from './harness.mjs';

/* ★ 隔离服务：配置与模板库都在临时目录，跑完自动清理 */
const SVC = await startIsolatedService();
const PORT = SVC.port;
const BASE = SVC.base;

const ok = [], fail = [];
const chk = (c, m) => (c ? ok.push(m) : fail.push(m));

async function req(method, p, body, headers) {
  const opt = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + p, opt);
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}

const api = {
  health:  () => req('GET', '/health'),
  savedir: d  => req('POST', '/savedir', { dir: d }),
  openDir: (d, h) => req('POST', '/open-dir', d === undefined ? {} : { dir: d }, h),
  listDir: d  => req('GET', '/list-dir' + (d ? '?dir=' + encodeURIComponent(d) : '')),
  drives:  () => req('GET', '/drives'),
  getCfg:  () => req('GET', '/config'),
  putCfg:  c  => req('POST', '/config', c),
  listTpl: () => req('GET', '/templates'),
  getTpl:  id => req('GET', '/templates/' + encodeURIComponent(id)),
  putTpl:  (id, t) => req('PUT', '/templates/' + encodeURIComponent(id), t),
  delTpl:  id => req('DELETE', '/templates/' + encodeURIComponent(id)),
  raw:     (m, p, h) => req(m, p, undefined, h)
};

try {
  const h = await api.health();
  if (!h.body || !h.body.ok) throw new Error('health 未返回 ok');
} catch (e) {
  console.error(`[ERROR] 隔离配置服务不可用 ${BASE} —— ${e.message}`);
  SVC.stop();
  process.exit(2);
}

console.log('=== D. /health ===');
{
  const h = (await api.health()).body;
  chk(h.ok === true, '/health 返回 ok');
  chk(h.openDir && h.openDir.enabled === true, '★ openDir.enabled 恒为 true（不再依赖白名单）');
  chk(!('roots' in h.openDir), '★ 不再暴露 roots（白名单已移除）');
  chk('lastSaveDir' in h.openDir, '暴露 lastSaveDir');
}

/* ★ 本文件已自己起隔离服务，ROOT 从 harness 取（不再自己推导）。
   CFG_SERVICE 指向真实的工程文件，用作「一个真实存在的文件」来测 notdir；
   UI_CFG 是**隔离的临时配置**，所有写操作都落在它上面，不碰用户真实配置。 */
const CFG_SERVICE = path.join(ROOT, 'config-service', 'serve-config.mjs');
const UI_CFG = SVC.cfgPath;

// 用工程根当「一个真实存在的目录」来测 /savedir 与 /open-dir
const BASE_DIR = ROOT;
chk(fs.existsSync(BASE_DIR), `基准目录存在：${BASE_DIR}`);

console.log('\n=== E. /savedir 校验 ===');
{
  const r1 = await api.savedir(BASE_DIR);
  chk(r1.status === 200 && r1.body.ok, '★ 存在的目录：放行 200');

  const sub = path.join(BASE_DIR, '_dsh-open-test');
  const r2 = await api.savedir(sub);
  chk(r2.status === 200 && r2.body.ok, '★ 不存在的目录：自动创建并放行');
  chk(fs.existsSync(sub), '★ 目录确实被创建出来了');
  fs.rmSync(sub, { recursive: true, force: true });

  const r3 = await api.savedir('');
  chk(r3.status === 400, '空路径被拒（400）');

  const aFile = CFG_SERVICE;
  const r4 = await api.savedir(aFile);
  chk(r4.status === 400 && r4.body.code === 'notdir', '★ 指向文件被拒（400 notdir）');
}

console.log('\n=== F. /open-dir ===');
{
  const r1 = await api.openDir(BASE_DIR);
  chk(r1.status === 200 && r1.body.ok, '★ 本目录可打开');

  /* ★ 断言「没有真的弹窗」。
     测试跑一轮会调 /open-dir 好几次，每次都真 spawn explorer.exe 的话
     屏幕上会攒下一堆文件夹窗口。所以隔离服务带 SDCFG_NO_OPEN=1：
     校验全走、只是不弹窗。这里确认那个开关确实生效了 ——
     否则「不弹窗」只是我们的假设，哪天开关写错名字也没人发现。 */
  chk(r1.body.dryRun === true, '★ 测试模式下不真的弹资源管理器窗口（dryRun）');
  chk(r1.body.path === BASE_DIR, 'dryRun 仍回显要打开的路径（结构一致，断言不用分叉）');

  const win = 'C:\\Windows';
  if (fs.existsSync(win)) {
    const r2 = await api.openDir(win);
    chk(r2.status === 200 && r2.body.ok, '★ 白名单已移除：C:\\Windows 也能打开（v1 会 403）');
  } else {
    console.log('  （跳过 C:\\Windows 用例）');
  }

  const r3 = await api.openDir();
  chk(r3.status === 400 && r3.body.code === 'nopath', '★ 不传 dir → 400 nopath');
  const r4 = await api.openDir('');
  chk(r4.status === 400 && r4.body.code === 'nopath', '★ 传空 dir → 400 nopath');

  const r5 = await api.openDir(path.join(BASE_DIR, '_no_such_zzz'));
  chk(r5.status === 400 && r5.body.code === 'missing', '★ 不存在的目录 → 400 missing');

  const r6 = await api.openDir(CFG_SERVICE);
  chk(r6.status === 400 && r6.body.code === 'notdir', '★ 指向文件 → 400 notdir');

  /* ★ 反向确认：dryRun 只跳过「弹窗」，没跳过校验。
     上面 missing / notdir / nopath 三条都仍按真实规则拒绝，
     说明这个开关没有把 /open-dir 变成无条件放行的空操作。 */
  chk(r5.body.dryRun === undefined && r6.body.dryRun === undefined,
      '★ 被拒的请求不会带 dryRun（校验发生在弹窗之前，没被开关绕过）');
}

console.log('\n=== H. 安全边界（v2 重点：反跨站） ===');
{
  const evil = { Origin: 'https://evil.example' };

  const r1 = await api.openDir('C:\\Windows', evil);
  chk(r1.status === 403, '★ 恶意网页调 /open-dir → 403 拒绝');
  chk(/跨站/.test((r1.body && r1.body.error) || ''), '错误信息说明是跨站拒绝');

  const r2 = await api.raw('GET', '/config', evil);
  chk(r2.status === 403, '★ 恶意网页读配置 → 403 拒绝');

  const r3 = await api.raw('POST', '/savedir', evil);
  chk(r3.status === 403, '★ 恶意网页写 savedir → 403 拒绝');

  const r4 = await api.raw('GET', '/list-dir?dir=C%3A%5C', evil);
  chk(r4.status === 403, '★ 恶意网页列目录 → 403 拒绝（防路径探测）');

  for (const o of ['http://127.0.0.1:1234', 'http://localhost:1234', 'null']) {
    const r = await api.openDir(BASE_DIR, { Origin: o });
    chk(r.status === 200, `本机来源放行：${o}`);
  }

  const r5 = await api.openDir(BASE_DIR, { Origin: 'http://127.0.0.1.evil.com' });
  chk(r5.status === 403, '★ 相似域名 127.0.0.1.evil.com 被拒');
  const r6 = await api.openDir(BASE_DIR, { Origin: 'http://evillocalhost' });
  chk(r6.status === 403, '★ 相似域名 evillocalhost 被拒');

  const r7 = await api.openDir(BASE_DIR + '\0evil');
  chk(r7.status >= 400, '★ 含空字节的路径被拒');
}

console.log('\n=== E2. 换目录：清除旧路径 ===');
{
  const r1 = await api.savedir(BASE_DIR);
  chk(r1.status === 200 && r1.body.ok, '先登记一个路径');

  // 带 clear:true 且 dir 为空 → 清除
  const r2 = await req('POST', '/savedir', { dir: '', clear: true });
  chk(r2.status === 200 && r2.body.ok, '★ clear:true 可清除已登记路径');
  chk(r2.body.dir === '', '清除后返回空路径');

  const h = (await api.health()).body;
  chk(h.openDir.lastSaveDir === null, '★ 服务端 lastSaveDir 已清空（换目录不会残留旧值）');

  // 清了之后不传 dir 打开 → 必须仍被拒
  const r3 = await api.openDir();
  chk(r3.status === 400 && r3.body.code === 'nopath', '★ 清除后不传 dir 打开 → 400');

  // 空的 dir 且没带 clear → 仍应报缺少字段
  const r4 = await req('POST', '/savedir', { dir: '' });
  chk(r4.status === 400, '★ 空 dir 且无 clear → 400（不会误清）');

  // 重新登记回来
  const r5 = await api.savedir(BASE_DIR);
  chk(r5.status === 200, '可重新登记');
  const h2 = (await api.health()).body;
  chk(h2.openDir.lastSaveDir === BASE_DIR, '★ 重新登记后 lastSaveDir 正确');
}

console.log('\n=== G. /list-dir 与 /drives ===');
{
  const d = await api.drives();
  chk(d.status === 200 && Array.isArray(d.body.drives), '★ /drives 返回盘符数组');
  chk(d.body.drives.length >= 1, `检测到盘符（${d.body.drives.join(',')}）`);

  const r = await api.listDir(BASE_DIR);
  chk(r.status === 200 && r.body.ok, '★ 列目录成功');
  chk(Array.isArray(r.body.dirs), '返回 dirs 数组');
  chk(typeof r.body.parent === 'string', '返回 parent 便于上一级');
  chk(Array.isArray(r.body.drives), 'list-dir 也带 drives（弹窗起点用）');

  const r2 = await api.listDir();
  chk(r2.status === 400 && r2.body.code === 'nopath', '★ 不带 dir → 400（不再默认某个根）');

  const r3 = await api.listDir(path.join(BASE_DIR, '_nope_zzz'));
  chk(r3.status === 400 && r3.body.code === 'missing', '★ 列不存在的目录 → 400 missing');
}

console.log('\n=== I. saveDir 持久化 ===');
{
  /* ★ UI_CFG 现在指向**隔离的临时配置**（SVC.cfgPath），不是用户真实配置。
     所以这一组怎么写都不会影响用户；收尾仍按原始字节还原，
     顺带把「写进去能读回来」这个持久化语义本身也验证了。 */
  const fsx = fs;
  const cfgPath = UI_CFG;
  const originalRaw = fsx.existsSync(cfgPath) ? fsx.readFileSync(cfgPath, 'utf8') : null;
  const before = await api.getCfg();

  const put = await api.putCfg({
    version: 1,
    batch: { ...before.body.config.batch },
    saveDir: BASE_DIR,
    plan: null
  });
  chk(put.status === 200 && put.body.ok, '写入带 saveDir 的配置成功');

  const after = await api.getCfg();
  chk(after.body.config.saveDir === BASE_DIR, '★ saveDir 原样读回');

  const put2 = await api.putCfg({
    version: 1,
    batch: before.body.config.batch,
    saveDir: 12345,
    plan: null
  });
  chk(put2.status === 200, 'saveDir 传非字符串不报错');
  const after2 = await api.getCfg();
  chk(after2.body.config.saveDir === '', '★ 非字符串 saveDir 被规范化为空串');

  // 还原成测试前的原始字节
  if (originalRaw !== null) {
    fsx.writeFileSync(cfgPath, originalRaw, 'utf8');
    const back = JSON.parse(fsx.readFileSync(cfgPath, 'utf8'));
    chk(back.saveDir === JSON.parse(originalRaw).saveDir, '★ 收尾已还原原始 saveDir');
    chk(JSON.stringify(back.plan) === JSON.stringify(JSON.parse(originalRaw).plan),
        '★ 收尾已还原原始 plan（不留下测试残留）');
  }
}

console.log('\n=== K. 模板库（一个模板一个文件） ===');
{
  const before = await api.getCfg();
  const batch = before.body.config.batch;

  /* ★ 模板已从 config.json 迁到独立文件，config 不再有 templates 字段。
     这里改测 /templates 接口：CRUD + 净化 + id 安全。 */

  // K1. config 里不该再有 templates
  chk(!('templates' in before.body.config), '★ config 不含 templates 字段（已迁到独立文件）');

  // K2. 即使请求里塞了 templates，也不会落进 config
  const put = await api.putCfg({
    version: 1, batch, saveDir: '', plan: null,
    templates: [{ id: 'tpl_sneak', name: '偷偷塞的', template: 'x' }]
  });
  chk(put.status === 200 && put.body.ok, '写入带 templates 的配置仍成功');
  const after = await api.getCfg();
  chk(!('templates' in after.body.config), '★ 塞进 config 的 templates 被丢弃');

  // K3. 列表接口可用
  const list0 = await api.listTpl();
  chk(list0.status === 200 && list0.body.ok, 'GET /templates 成功');
  chk(Array.isArray(list0.body.templates), '★ templates 是数组');

  // K4. 新建 + 净化（名字裁剪、概率保留）
  const id = 'tpl_test_k_' + Date.now().toString(36);
  const good = {
    name: '  测试模板  ', at: 1234567890,
    template: '内容 {{服装}}',
    slots: [{ name: '服装', values: ['a', 'b'], p: 0.25 }],
    count: 4, skipDup: false
  };
  const w = await api.putTpl(id, good);
  chk(w.status === 200 && w.body.ok, 'PUT /templates/<id> 新建成功');
  chk(w.body.template.name === '测试模板', `★ 名字两端空白被裁剪（「${w.body.template.name}」）`);
  chk(w.body.template.count === 4 && w.body.template.skipDup === false, '★ count / skipDup 原样保留');
  chk(w.body.template.template === '内容 {{服装}}', '★ 模板正文保留');
  chk(w.body.template.slots[0].values.join(',') === 'a,b', '★ 数组保留');
  chk(w.body.template.slots[0].p === 0.25, '★ 概率 p 保留');

  // K5. 能读回
  const rd = await api.getTpl(id);
  chk(rd.status === 200 && rd.body.template.name === '测试模板', 'GET /templates/<id> 读回正确');

  // K6. 坏数据被拒（不再「静默丢弃」，而是明确报错）
  const bad1 = await api.putTpl(id, { name: '', template: 'x' });
  chk(bad1.status === 400, `name 为空 → 400（实际 ${bad1.status}）`);
  const bad2 = await api.putTpl(id, { name: 'n', template: 123 });
  chk(bad2.status === 400, `template 非字符串 → 400（实际 ${bad2.status}）`);

  // K7. id 安全：路径注入一律拒绝
  const evil = ['..%2F..%2Fconfig', 'a%2Fb', 'a%5Cb', 'x'.repeat(65), 'a b'];
  let allBad = true;
  for (const e of evil){
    const rr = await api.getTpl(e);
    if (rr.status !== 400 && rr.status !== 404) allBad = false;
  }
  chk(allBad, '★ 非法 id 全部被拒（防路径注入）');
  const cross = await api.putTpl('..%2Fevil', { name: 'e', template: 'x' });
  chk(cross.status === 400, `★ 路径穿越写入被拒（${cross.status}）`);

  // K8. 删除 + 幂等
  const d1 = await api.delTpl(id);
  chk(d1.status === 200 && d1.body.ok, 'DELETE /templates/<id> 成功');
  const gone = await api.getTpl(id);
  chk(gone.status === 404, '删除后读不到');
  const d2 = await api.delTpl(id);
  chk(d2.status === 200, '重复删除幂等');

  // K9. plan 与模板库互不影响
  await api.putCfg({ version: 1, batch, saveDir: '', plan: { id: 'p1', status: 'paused' } });
  const both = (await api.getCfg()).body.config;
  chk(both.plan && both.plan.id === 'p1', 'plan 正常保存');
  chk(!('templates' in both), 'plan 存在时 config 仍不含 templates');

  // 还原
  await api.putCfg({
    version: 1, batch: before.body.config.batch,
    saveDir: before.body.config.saveDir,
    plan: before.body.config.plan
  });
}

console.log('\n通过 ' + ok.length + ' 项：');
ok.forEach(o => console.log('  ✓ ' + o));
if (fail.length) {
  console.log('\n失败 ' + fail.length + ' 项：');
  fail.forEach(f => console.log('  ✗ ' + f));
}
SVC.stop();                                   // 关掉隔离服务并清掉临时目录
console.log('\n' + '─'.repeat(50));
console.log(fail.length ? `结果：${ok.length} 通过 / ${fail.length} 失败` : `结果：${ok.length} 通过 / 0 失败`);
process.exit(fail.length ? 1 : 0);
