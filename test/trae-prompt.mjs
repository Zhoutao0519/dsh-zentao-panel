// dsh-zentao-panel — Trae 下发 prompt 纯函数回归测试（不访问网络 / 桥接 / 禅道）
//
// 覆盖角色模式新增的 purpose：fix / testcases / test-analysis / requirement-review，
// 以及 planMode 前缀与未知 purpose 的回落。顺带校验 client 与 host 的 RPC 渠道一致。
// 用法：node test/trae-prompt.mjs
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendImageList, buildTraePrompt, collectImageRefs, createTraeService,
  stripImageMarkers, TRAE_PURPOSES,
} from '../lib/trae.mjs';
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

// ── 详情 / 关联需求里的图片（2026-11-26）：必须随任务一起带到 Trae ──────────
const imageUrl = (id) => `http://zt.example.com/file-read-${id}.png`;
{
  const calls = [];
  const fakeZentao = {
    async fetchDetailFor(accountId, kind, id) {
      calls.push(`${kind}:${id}:${accountId}`);
      if (kind === 'task' && Number(id) === 1) {
        return {
          id: 1,
          title: '任务一',
          desc: '任务正文 [图片：111.png]',
          images: [{ url: imageUrl(111), name: '111.png' }],
          actions: [{
            date: '2026-11-20 10:00', desc: '备注',
            comment: '看这个 [图片：222.png]',
            images: [{ url: imageUrl(222), name: '222.png' }],
          }],
          storyId: 9,
          storyTitle: '需求九',
        };
      }
      if (kind === 'story' && Number(id) === 9) {
        return {
          id: 9,
          title: '需求九',
          desc: '需求正文 [图片：333.png]',
          images: [
            { url: imageUrl(333), name: '333.png' },
            { url: imageUrl(111), name: '111.png' }, // 与任务详情重复：必须去重
          ],
        };
      }
      return null;
    },
  };
  const trae = createTraeService({
    getZentao: () => fakeZentao,
    logger: { info() {}, warn() {}, error() {} },
  });
  const enriched = await trae.enrich({
    cards: [{ kind: 'task', id: 1 }],
    md: '## 禅道任务 #1：任务一',
    accountId: 'acct',
  });
  const urls = enriched.images.map((x) => x.url);
  check('enrich：详情 + 关联需求图片按出现顺序带回', urls.length === 3
    && urls[0] === imageUrl(111) && urls[1] === imageUrl(222) && urls[2] === imageUrl(333),
  urls.join(' , '));
  check('enrich：图片按 url 去重', new Set(urls).size === urls.length);
  check('enrich：md 去掉 [图片：…] 占位标记', !enriched.md.includes('[图片'));
  check('enrich：需求正文文字保留', enriched.md.includes('需求正文'));
  check('enrich：按账号读取任务 + 关联需求详情', calls.join(',') === 'task:1:acct,story:9:acct', calls.join(','));

  const storyOnly = await trae.enrich({
    cards: [{ kind: 'story', id: 9 }],
    md: '## 禅道需求 #9：需求九',
    accountId: 'acct',
  });
  check('enrich：需求卡自己详情的图片也带回', storyOnly.images.length >= 1
    && storyOnly.images[0].url === imageUrl(333));

  const noService = createTraeService({ getZentao: () => null, logger: { info() {}, warn() {}, error() {} } });
  const empty = await noService.enrich({ cards: [{ kind: 'task', id: 1 }], md: 'x', accountId: 'acct' });
  check('enrich：拿不到禅道服务时 images 仍是空数组', Array.isArray(empty.images) && empty.images.length === 0);

  // 纯合并逻辑：客户端图 + enrich 图 去重保序（host 下载前就是这么拼的）
  const merged = [];
  const seen = new Set();
  collectImageRefs(merged, seen, [{ url: imageUrl(111), name: '111.png' }]);
  collectImageRefs(merged, seen, enriched.images);
  check('合并：客户端图在前、enrich 图补后、整体去重', merged.length === 3
    && merged[0].url === imageUrl(111) && merged[2].url === imageUrl(333));
}

check('stripImageMarkers：清掉占位标记与空行', stripImageMarkers('正文[图片：1.png]\n\n\n下一段')
  === '正文\n\n下一段');
check('appendImageList：列出截图附件', appendImageList('正文', ['1-a.png', '2-b.png'])
  .includes('## 截图附件') && appendImageList('正文', ['1-a.png']).includes('1-a.png'));
check('appendImageList：无图时不加小节', appendImageList('正文', []) === '正文');

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
