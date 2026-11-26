// dsh-zentao-panel — Trae 下发 prompt 纯函数回归测试（不访问网络 / 桥接 / 禅道）
//
// 覆盖角色模式新增的 purpose：fix / testcases / test-analysis / requirement-review，
// 以及 planMode 前缀与未知 purpose 的回落。顺带校验 client 与 host 的 RPC 渠道一致。
// 用法：node test/trae-prompt.mjs
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTraePrompt, TRAE_PURPOSES } from '../lib/trae.mjs';
import { CHANNEL } from '../lib/rpc.mjs';
import { apply } from '../lib/index.js';

// 不读真实 ~/.dsh 配置（apply 只做本地读取，不产生网络/写入）
process.env.DSH_HOME = join(tmpdir(), 'dsh-ztp-prompt-' + process.pid);

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

const base = { taskFile: 'C:\\tmp\\task.md', workspace: 'D:\\work\\repo', md: '正文内容' };
const prompt = (extra = {}) => buildTraePrompt({ ...base, ...extra });

// ── purpose 分支 ────────────────────────────────────────────────
check('fix 保留原有「定位并修改代码」', prompt({ purpose: 'fix' }).includes('定位并修改代码'));
check('fix 带工作区与任务文件', prompt({ purpose: 'fix' }).includes('D:\\work\\repo')
  && prompt({ purpose: 'fix' }).includes('C:\\tmp\\task.md'));

const tc = prompt({ purpose: 'testcases' });
check('testcases 走禅道 MCP 写用例', tc.includes('禅道 MCP'));
check('testcases 不落入改代码文案', !tc.includes('定位并修改代码'));

for (const purpose of ['test-analysis', 'requirement-review']) {
  const p = prompt({ purpose });
  check(`${purpose} 包含「不要修改代码」`, p.includes('不要修改代码'));
  check(`${purpose} 不包含「定位并修改代码」`, !p.includes('定位并修改代码'));
  check(`${purpose} 不提示写禅道`, !p.includes('禅道 MCP'));
}

// ── planMode 前缀 ───────────────────────────────────────────────
check('planMode 以 /plan 开头', prompt({ purpose: 'fix', planMode: true }).startsWith('/plan'));
check('planMode 保留原 purpose 文案', prompt({ purpose: 'test-analysis', planMode: true }).includes('不要修改代码'));

// ── 未知 purpose 回落到 fix ─────────────────────────────────────
const unknown = prompt({ purpose: 'deploy-something' });
check('未知 purpose 回落 fix（改代码文案）', unknown.includes('定位并修改代码')
  && !unknown.includes('不要修改代码'));
check('未传 purpose 默认 fix', buildTraePrompt().includes('定位并修改代码'));
check('TRAE_PURPOSES 只含四种已实现目的', TRAE_PURPOSES.size === 4
  && ['fix', 'testcases', 'test-analysis', 'requirement-review'].every((p) => TRAE_PURPOSES.has(p)));

// ── RPC 渠道一致性（防止 client / host 渠道漂移）──────────────────
check('host RPC 渠道为 /dsh-ztp9-rpc', CHANNEL === '/dsh-ztp9-rpc', CHANNEL);
const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
const clientChannel = /var CHANNEL = '([^']+)'/.exec(clientSrc)?.[1] ?? '';
check('client 渠道与 host 一致', clientChannel === CHANNEL, clientChannel);

// ── apply() 挂载的路由前缀（mock ctx，无需凭据/网络）────────────────
const routes = [];
const mockCtx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  webServer: { register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; } },
  connection: { requestRejection: () => undefined },
};
const dispose = apply(mockCtx, {});
check('apply() 挂载 rpc 路由', routes.length === 1 && routes[0].path === CHANNEL, routes[0]?.path ?? '(none)');
dispose();
check('dispose 移除路由', routes.length === 0);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
