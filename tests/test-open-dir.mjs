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

   用法：node tests/test-open-dir.mjs [port]
   需要先启动配置服务：
     node config-service/serve-config.mjs <port>
   ══════════════════════════════════════════════════════════════ */

const PORT = Number(process.argv[2] || 1247);
const BASE = `http://127.0.0.1:${PORT}`;

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
  raw:     (m, p, h) => req(m, p, undefined, h)
};

try {
  const h = await api.health();
  if (!h.body || !h.body.ok) throw new Error('health 未返回 ok');
} catch (e) {
  console.error(`[ERROR] 连不上配置服务 ${BASE} —— ${e.message}`);
  console.error('        先在工程根执行：node config-service/serve-config.mjs ' + PORT);
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

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
/* ★ 路径定位：本文件在 <root>\tests\ 下。用 import.meta.url 推导，
   因此从任何工作目录执行都能找到文件。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CFG_SERVICE = path.join(ROOT, 'config-service', 'serve-config.mjs');
const UI_CFG = path.join(ROOT, 'app', 'ui', 'config.json');

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
  // ★ 注意：本组会写真实配置文件，收尾必须还原成「测试前的样子」。
  //   之前用 GET 拿到的快照做还原，但 GET 返回的是 sanitize 过的对象，
  //   且若启动时磁盘上就有残留 plan，会被原样写回 —— 等于测试往用户配置里
  //   塞了个假计划。这里改成先读原始文件，最后按原始内容写回。
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
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

console.log('\n=== K. templates 落盘与净化 ===');
{
  const before = await api.getCfg();
  const batch = before.body.config.batch;

  const good = {
    id: 'tpl_1', name: '  测试模板  ', at: 1234567890,
    template: '内容 {{服装}}',
    slots: [{ name: '服装', values: ['a', 'b'] }],
    count: 4, skipDup: false
  };
  const put = await api.putCfg({
    version: 1, batch, saveDir: '', plan: null,
    templates: [
      good,
      { name: '', template: 'x' },              // 名字为空 → 丢弃
      { name: 'n', template: 123 },             // template 非字符串 → 丢弃
      { template: '没有名字' },                  // 缺名字 → 丢弃
      null, 'xxx', 42,                          // 非对象 → 丢弃
      { id: 'tpl_1', name: '重复id', template: 'y', slots: [], count: 1, skipDup: true }
    ]
  });
  chk(put.status === 200 && put.body.ok, '写入带 templates 的配置成功');

  const after = await api.getCfg();
  const ts = after.body.config.templates;
  chk(Array.isArray(ts), '★ templates 读回是数组');
  chk(ts.length === 2, `★ 坏数据被净化掉（2 个有效，实际 ${ts.length}）`);
  chk(ts[0].name === '测试模板', `★ 名字两端空白被裁剪（「${ts[0].name}」）`);
  chk(ts[0].count === 4 && ts[0].skipDup === false, '★ count / skipDup 原样保留');
  chk(ts[0].template === '内容 {{服装}}', '★ 模板正文保留');
  chk(ts[0].slots[0].values.join(',') === 'a,b', '★ 数组保留');
  chk(ts[1].id !== 'tpl_1', '★ 重复 id 被重新分配（避免 UI 索引冲突）');
  chk(typeof ts[1].id === 'string' && ts[1].id.length > 0, '新 id 非空');

  // 上限：塞 30 个应只留 20
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: 'x' + i, name: 'M' + i, at: i, template: 't' + i, slots: [], count: 1, skipDup: true
  }));
  await api.putCfg({ version: 1, batch, saveDir: '', plan: null, templates: many });
  const capped = (await api.getCfg()).body.config.templates;
  chk(capped.length === 20, `★ 服务端硬上限 20（实际 ${capped.length}）`);

  // 非数组 → 空数组
  await api.putCfg({ version: 1, batch, saveDir: '', plan: null, templates: 'not-array' });
  const notArr = (await api.getCfg()).body.config.templates;
  chk(Array.isArray(notArr) && notArr.length === 0, '★ templates 非数组时归一化为空数组');

  // plan 与 templates 互不影响
  await api.putCfg({ version: 1, batch, saveDir: '', plan: { id: 'p1', status: 'paused' }, templates: [good] });
  const both = (await api.getCfg()).body.config;
  chk(both.plan && both.plan.id === 'p1', 'plan 与 templates 可共存');
  chk(both.templates.length === 1, 'templates 也在');

  // 还原
  await api.putCfg({
    version: 1, batch: before.body.config.batch,
    saveDir: before.body.config.saveDir,
    plan: before.body.config.plan,
    templates: before.body.config.templates || []
  });
}

console.log('\n通过 ' + ok.length + ' 项：');
ok.forEach(o => console.log('  ✓ ' + o));
if (fail.length) {
  console.log('\n失败 ' + fail.length + ' 项：');
  fail.forEach(f => console.log('  ✗ ' + f));
}
console.log('\n' + '─'.repeat(50));
console.log(fail.length ? `结果：${ok.length} 通过 / ${fail.length} 失败` : `结果：${ok.length} 通过 / 0 失败`);
process.exit(fail.length ? 1 : 0);
