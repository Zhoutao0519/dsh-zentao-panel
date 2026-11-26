// host RPC 路由注册的健壮性测试（离线，不打网络、不加载 DSH）：
//   1) 正常挂载 / 清理；
//   2) 宿主重载插件时旧 fiber 未释放 → 新实例能回收上一次的路由；
//   3) 更老版本（没登记过清理函数）残留的同名路由 → 从 webServer 路由表里摘掉重挂；
//   4) 旧实例清理晚到 → 不能把新实例已挂的路由删掉；
//   5) 回收不了时给出可执行的报错（提示重启 DSH Desktop）。
import { CHANNEL, installZentaoRpc } from '../lib/rpc.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? `  — ${extra}` : ''}`);
  if (!cond) failures++;
}

// ── 复刻 dsh-host-webserver 的 route 表语义 ─────────────────────────────────
class FakeWebServer {
  exact = new Map();
  prefixes = new Map();
  upgrades = new Map();
  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes;
    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
    table.set(route.path, route);
    return () => { table.delete(route.path); };
  }
}

const service = { status: () => ({ ok: true, configured: false, accounts: [] }) };
const trae = {};

function makeCtx(webServer, { useEffect = true } = {}) {
  const warnings = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    webServer,
    connection: { requestRejection: () => 401 },
  };
  if (useEffect) {
    // 复刻 cordis ctx.effect：立即执行，返回一个幂等的清理包装
    ctx.effect = (execute) => {
      const dispose = execute();
      let done = false;
      return () => {
        if (done) return undefined;
        done = true;
        return typeof dispose === 'function' ? dispose() : undefined;
      };
    };
  }
  const log = {
    info() {}, error() {},
    warn(format, ...args) { warnings.push(String(format).replace(/%s/g, () => args.shift())); },
  };
  return { ctx, log, warnings };
}

function mount(webServer, opts) {
  const { ctx, log, warnings } = makeCtx(webServer, opts);
  const dispose = installZentaoRpc(ctx, { service, trae, log });
  return { dispose, warnings, ctx };
}

// ── 1. 正常挂载 / 清理 ───────────────────────────────────────────────────────
{
  const ws = new FakeWebServer();
  const { dispose } = mount(ws);
  check('挂载：路由出现在 prefixes', ws.prefixes.size === 1 && ws.prefixes.get(CHANNEL)?.kind === 'prefix');
  dispose();
  check('清理：dispose 后路由移除', ws.prefixes.size === 0);
  dispose();
  check('清理：重复 dispose 安全', ws.prefixes.size === 0);
}

// ── 2. 旧 fiber 未释放：新实例接管 ──────────────────────────────────────────
{
  const ws = new FakeWebServer();
  const first = mount(ws);
  const oldRoute = ws.prefixes.get(CHANNEL);
  const second = mount(ws); // 没有先 dispose 第一次 —— 复刻宿主重载不跑清理
  const newRoute = ws.prefixes.get(CHANNEL);
  check('接管：第二次 apply 不报错且只留一条路由', ws.prefixes.size === 1);
  check('接管：路由已换成新实例的', newRoute && newRoute !== oldRoute);

  first.dispose(); // 旧实例的清理晚到
  check('接管：旧清理晚到不误删新路由', ws.prefixes.get(CHANNEL) === newRoute);
  second.dispose();
  check('接管：新实例 dispose 后路由移除', ws.prefixes.size === 0);
}

// ── 3. 更早版本残留路由（没有登记清理函数）─────────────────────────────────
{
  const ws = new FakeWebServer();
  const stale = { kind: 'prefix', path: CHANNEL, handler: () => {} };
  ws.prefixes.set(CHANNEL, stale); // 模拟进程里已有的僵尸路由
  const { dispose, warnings } = mount(ws);
  check('残留：撞上僵尸路由后仍能挂载', ws.prefixes.size === 1 && ws.prefixes.get(CHANNEL) !== stale);
  check('残留：给出可读警告', warnings.some((line) => line.includes('残留')));
  dispose();
  check('残留：清理正常', ws.prefixes.size === 0);
}

// ── 4. 没有 ctx.effect 的旧版 DSH：退回 register 返回清理 ───────────────────
{
  const ws = new FakeWebServer();
  const { dispose } = mount(ws, { useEffect: false });
  check('兼容：无 ctx.effect 也能挂载', ws.prefixes.size === 1);
  dispose();
  check('兼容：无 ctx.effect 也能清理', ws.prefixes.size === 0);
}

// ── 5. 无法回收 → 报错要能指导用户 ─────────────────────────────────────────
{
  const ws = {
    register() { throw new Error(`webserver: duplicate prefix route "${CHANNEL}"`); },
  };
  let error;
  try {
    mount(ws);
  } catch (err) {
    error = err;
  }
  check('兜底：无法回收时抛出错误', Boolean(error));
  check('兜底：错误提示重启 DSH Desktop', /重启 DSH Desktop/.test(error?.message ?? ''));
  check('兜底：保留原始错误作为 cause', error?.cause instanceof Error);
}

console.log(failures === 0 ? '\nall route checks passed' : `\n${failures} route check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
