// dsh-zentao-panel — 周报功能回归测试（纯函数 / service / 导出 / RPC）
//
// 不访问真实禅道：service 用 mock client，RPC 用 mock ctx + 真实 http server。
// 用法：node test/weekly.mjs
import http from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// store 写入隔离（configure 会落盘配置）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-ztp-weekly-'));

import {
  buildOverview, buildSummary, buildWeeklyDraft, cleanTaskTitle, fillTemplate, formatChineseDate,
  isDateInRange, mapBugStatus, mapPriority, normalizeCollection, parseDateOnly,
  parseEmbeddedJson, validateRange, WEEKLY_EMPTY_TEXT,
} from '../lib/weekly.mjs';
import { exportWeeklyReport, defaultReportsDir } from '../lib/docx-exporter.mjs';
import { createZentaoService } from '../lib/service.mjs';
import { CHANNEL, installZentaoRpc } from '../lib/rpc.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
const silent = { info() {}, warn() {}, error() {} };

// ───────────────────────── 1. 纯函数 ─────────────────────────
check('parseEmbeddedJson：二次 JSON.parse / 已解析对象 / 坏数据',
  parseEmbeddedJson('{"tasks":[1]}').tasks[0] === 1
  && parseEmbeddedJson({ bugs: [] }).bugs.length === 0
  && parseEmbeddedJson('not-json') === null
  && parseEmbeddedJson(undefined) === null);
check('normalizeCollection：数组 / dict / 空值',
  normalizeCollection([1, 2]).length === 2
  && normalizeCollection({ 1: 'a', 2: 'b' }).join() === 'a,b'
  && normalizeCollection(null).length === 0
  && normalizeCollection('x').length === 0);

check('isDateInRange：起止当天含边界，范围外排除',
  isDateInRange('2026-11-23 00:00:00', '2026-11-23', '2026-11-29') === true
  && isDateInRange('2026-11-29 23:59:59', '2026-11-23', '2026-11-29') === true
  && isDateInRange('2026-11-22 23:59:59', '2026-11-23', '2026-11-29') === false
  && isDateInRange('2026-11-30 00:00:00', '2026-11-23', '2026-11-29') === false
  && isDateInRange('', '2026-11-23', '2026-11-29') === false);
check('parseDateOnly：非法日期（2 月 30 日）拒绝', parseDateOnly('2026-02-30') === null
  && parseDateOnly('2026-11-25') instanceof Date);

check('cleanTaskTitle：去「前缀:」与「YYYY.N」',
  cleanTaskTitle('需求: 登录优化') === '登录优化'
  && cleanTaskTitle('2026.3 登录优化') === '登录优化'
  && cleanTaskTitle('普通标题') === '普通标题'
  && cleanTaskTitle('') === '');
check('mapBugStatus：closed/resolved/其他',
  mapBugStatus('closed') === '已关闭' && mapBugStatus('resolved') === '已解决'
  && mapBugStatus('active') === '已处理');
check('mapPriority：doing / pri 1-2 / pri 3 / 其他',
  mapPriority('3', 'doing') === '高' && mapPriority('1', 'wait') === '高'
  && mapPriority('2', 'wait') === '高' && mapPriority('3', 'wait') === '中'
  && mapPriority('4', 'wait') === '低' && mapPriority('', 'wait') === '低');

const fxWorks = [
  { title: 'A', consumed: 2.5, projectName: '项目A' },
  { title: 'B', consumed: 1, projectName: '项目B' },
  { title: 'C', consumed: 0.5, projectName: '项目A' },
];
const fxBugs = [{ title: 'bug1' }];
const fxPlans = [{ title: '计划1' }, { title: '计划2' }, { title: '计划3' }];
check('fillTemplate：值中的 $ 按字面保留', fillTemplate('%s / %s', '$&', '$1') === '$& / $1');
check('buildOverview：项目名去重 + 数量口径',
  buildOverview(fxWorks, fxBugs) === '本周主要围绕 项目A、项目B 展开工作，累计完成 3 项主要任务，处理 1 个 Bug，并持续推进在研需求与交付支持。');
check('buildOverview：无项目名回落默认',
  buildOverview([{ title: 'x' }], []).includes('当前负责项目'));
check('buildSummary：工时/前 3 项/前 2 项计划',
  buildSummary(fxWorks, fxBugs, fxPlans) === '本周共完成 3 项工作，累计工时 4.0 小时。重点推进了 A、B、C，并处理 1 个 Bug。下周将继续围绕 计划1、计划2 展开。');
check('buildSummary：空数据回落默认事项',
  buildSummary([], [], []).includes('核心开发事项') && buildSummary([], [], []).includes('在研任务'));

check('validateRange：格式/倒序/超 31 天/合法',
  validateRange('2026-11-23', '2026-11-29').ok === true
  && validateRange('2026-11-29', '2026-11-23').ok === false
  && validateRange('2026-11-01', '2026-12-02').ok === false
  && validateRange('2026-02-30', '2026-03-01').ok === false
  && validateRange('', '2026-11-29').ok === false);
check('formatChineseDate：M月D日', formatChineseDate('2026-11-23') === '11月23日');

// 原始接口行 → 草稿（过滤 / 排序 / 映射）
const finishedRows = [
  { id: '11', name: '需求: 老任务', consumed: '4', status: 'done', finishedDate: '2026-11-22 10:00:00', projectName: '项目A' },
  { id: '12', name: '2026.5 新任务', consumed: '2.5', status: 'done', finishedDate: '2026-11-24 10:00:00', projectName: '项目A', executionName: '迭代1' },
  { id: '13', name: '边界任务', consumed: '0', status: 'done', finishedDate: '2026-11-29 23:59:59', projectName: '项目B' },
];
const bugRows = [
  { id: '31', title: 'Bug 后', status: 'resolved', resolvedDate: '2026-11-26 09:00:00' },
  { id: '30', title: 'Bug 前', status: 'closed', resolvedDate: '2026-11-23 00:00:00' },
  { id: '32', title: '范围外', status: 'closed', resolvedDate: '2026-11-30 09:00:00' },
];
const planRows = [
  { id: '41', name: '待开始', status: 'wait', pri: '3' },
  { id: '42', name: '进行中', status: 'doing', pri: '4' },
  { id: '43', name: '已完成', status: 'done', pri: '1' },
  { id: '44', name: '', status: 'wait', pri: '1' },
];
const draftFixture = buildWeeklyDraft({
  profile: { id: 114, account: 'dev', realname: '李宏博' },
  works: finishedRows, bugs: bugRows, plans: planRows,
  start: '2026-11-23', end: '2026-11-29', now: new Date(2026, 10, 25, 10, 0, 0),
});
check('buildWeeklyDraft：完成工作按 finishedDate 过滤 + ID 倒序 + 标题清洗',
  draftFixture.completedWorks.length === 2
  && draftFixture.completedWorks[0].objectID === 13
  && draftFixture.completedWorks[1].objectID === 12
  && draftFixture.completedWorks[1].title === '新任务'
  && draftFixture.completedWorks[1].consumed === 2.5
  && draftFixture.completedWorks[1].executionName === '迭代1');
check('buildWeeklyDraft：Bug 按 resolvedDate 过滤 + ID 正序 + 状态映射',
  draftFixture.bugs.length === 2
  && draftFixture.bugs[0].id === 30 && draftFixture.bugs[0].status === '已关闭'
  && draftFixture.bugs[1].id === 31 && draftFixture.bugs[1].status === '已解决');
check('buildWeeklyDraft：下周计划只留 wait/doing（忽略空标题）',
  draftFixture.nextWeekPlan.length === 2
  && draftFixture.nextWeekPlan[0].title === '待开始' && draftFixture.nextWeekPlan[0].priority === '中'
  && draftFixture.nextWeekPlan[1].title === '进行中' && draftFixture.nextWeekPlan[1].priority === '高');
check('buildWeeklyDraft：基本信息（周期/报告人/部门/报告日期）',
  draftFixture.basicInfo.reportPeriod === '11月23日 至 11月29日'
  && draftFixture.basicInfo.reporter === '李宏博'
  && draftFixture.basicInfo.department === '研发部'
  && draftFixture.basicInfo.reportDate === '2026/11/25');
check('buildWeeklyDraft：空数据也能生成（数组为空 + 模板兜底）',
  (() => {
    const d = buildWeeklyDraft({ profile: { account: 'dev' }, works: null, bugs: {}, plans: [], start: '2026-11-23', end: '2026-11-29', now: 0 });
    return d.completedWorks.length === 0 && d.bugs.length === 0 && d.nextWeekPlan.length === 0
      && d.basicInfo.reporter === 'dev' && d.overview.includes('当前负责项目');
  })());

// ───────────────────────── 2. service（mock client）─────────────────────────
const PAGE = {
  finished: '/user-task-114-finishedBy-id_desc-839-100-1.json',
  bugs: '/user-bug-114-resolvedBy-id_desc-3042-1000-1.json',
  assigned: '/user-task-114-assignedTo-status_asc-5159-20-1.json',
};
function pageBody(key) {
  if (key === 'finished') return JSON.stringify({ tasks: [
    { id: '12', name: '需求: 新任务', consumed: '5', finishedDate: '2026-11-24 10:00:00', projectName: '项目A' },
  ] });
  if (key === 'bugs') return JSON.stringify({ bugs: [
    { id: '31', title: 'Bug 后', status: 'resolved', resolvedDate: '2026-11-26 09:00:00' },
  ] });
  return JSON.stringify({ tasks: [
    { id: '41', name: '待开始', status: 'wait', pri: '3' },
    { id: '43', name: '已完成', status: 'done', pri: '1' },
  ] });
}

function makeMockClient(options = {}) {
  const calls = [];
  const pageHits = { finished: 0, bugs: 0, assigned: 0 };
  const client = {
    restore() {},
    loggedIn() { return true; },
    exportCookies() { return {}; },
    async login() { calls.push('login'); },
    async fetchMyWork(kind) { calls.push(`fetchMyWork:${kind}`); return []; },
    async fetchV1Token(account, password) {
      calls.push('fetchV1Token');
      if (options.tokenFails) throw new Error('HTTP 401');
      return 'tok-secret-123';
    },
    async request(path, init = {}) {
      calls.push({ path, headers: init.headers || {}, referer: init.referer || '' });
      if (path === '/api.php/v1/user') {
        if (options.profileFail) return { status: 401, text: async () => '{}' };
        if (options.profileCookieOnly && init.headers && init.headers.Token) {
          return { status: 401, text: async () => '{}' };
        }
        return { status: 200, text: async () => JSON.stringify({ profile: { id: 114, account: 'dev', realname: '李宏博' } }) };
      }
      const key = Object.keys(PAGE).find((k) => PAGE[k] === path);
      if (!key) throw new Error(`unexpected path ${path}`);
      pageHits[key]++;
      if (options.failPart === key) return { status: 500, text: async () => 'boom' };
      if (options.expiredOnce === key && pageHits[key] === 1) {
        return { status: 200, text: async () => JSON.stringify({ result: false, message: '登录已超时，请重新登入!' }) };
      }
      return { status: 200, text: async () => JSON.stringify({ status: 'success', data: pageBody(key) }) };
    },
  };
  return { client, calls, pageHits };
}

function makeService(options) {
  const mock = makeMockClient(options);
  const service = createZentaoService({ createClient: () => mock.client, logger: silent });
  service.configure({ baseUrl: 'http://zentao.test', account: 'dev', password: 'pw-secret' });
  return { service, ...mock };
}

{
  const { service, calls, pageHits } = makeService();
  const draft = await service.fetchWeeklyReport({ start: '2026-11-23', end: '2026-11-29' });
  const pagePaths = [PAGE.finished, PAGE.bugs, PAGE.assigned];
  const pageCalls = calls.filter((c) => c && pagePaths.includes(c.path));
  check('service：三个页面接口各请求一次（带用户 ID 路径）',
    pageHits.finished === 1 && pageHits.bugs === 1 && pageHits.assigned === 1 && pageCalls.length === 3);
  const profileCall = calls.find((c) => c && c.path === '/api.php/v1/user');
  check('service：v1 用户资料带 Token Header，页面接口不带 Token',
    profileCall && profileCall.headers.Token === 'tok-secret-123'
    && pageCalls.every((c) => !c.headers.Token)
    && pageCalls.every((c) => c.referer === 'http://zentao.test/my.html'));
  check('service：草稿口径（完成工作/Bug/计划 + 报告人）',
    draft.completedWorks.length === 1 && draft.completedWorks[0].title === '新任务'
    && draft.bugs.length === 1 && draft.bugs[0].status === '已解决'
    && draft.nextWeekPlan.length === 1 && draft.nextWeekPlan[0].title === '待开始'
    && draft.basicInfo.reporter === '李宏博' && draft.warnings.length === 0);
  const serialized = JSON.stringify(draft);
  check('service：不泄露 Token / 密码',
    !serialized.includes('tok-secret-123') && !serialized.includes('pw-secret') && !serialized.includes('"password"'));
}

{
  const { service } = makeService({ failPart: 'bugs' });
  const draft = await service.fetchWeeklyReport({ start: '2026-11-23', end: '2026-11-29' });
  check('service：单区块失败 → 空区块 + warning，其余正常',
    draft.bugs.length === 0 && draft.completedWorks.length === 1 && draft.nextWeekPlan.length === 1
    && draft.warnings.length === 1 && draft.warnings[0].includes('Bug 修复情况读取失败'));
}

{
  const { service, pageHits } = makeService({ expiredOnce: 'finished' });
  const draft = await service.fetchWeeklyReport({ start: '2026-11-23', end: '2026-11-29' });
  check('service：页面会话失效 → 强制重登并重试一次',
    pageHits.finished === 2 && draft.completedWorks.length === 1 && draft.warnings.length === 0);
}

{
  const { service, calls } = makeService({ tokenFails: true, profileCookieOnly: true });
  const draft = await service.fetchWeeklyReport({ start: '2026-11-23', end: '2026-11-29' });
  const profileCalls = calls.filter((c) => c && c.path === '/api.php/v1/user');
  check('service：v1 Token 失败 → Cookie 兜底取用户资料',
    profileCalls.length === 1 && !profileCalls[0].headers.Token
    && calls.includes('fetchV1Token') && draft.basicInfo.reporter === '李宏博');
}

{
  const { service } = makeService({ profileFail: true });
  let message = '';
  try { await service.fetchWeeklyReport({ start: '2026-11-23', end: '2026-11-29' }); } catch (e) { message = e.message; }
  check('service：用户资料不可用 → 明确报错', message.includes('无法识别当前用户'), message);
}

// ───────────────────────── 3. 导出（docx / .doc 回退）─────────────────────────
const exportDir = mkdtempSync(join(tmpdir(), 'dsh-ztp-weekly-export-'));
const exportDraft = { ...draftFixture, warnings: [] };

const docxOut = await exportWeeklyReport({ draft: exportDraft, outputDir: exportDir, now: new Date(2026, 10, 25, 18, 30, 5) });
const docxHead = readFileSync(docxOut.path).subarray(0, 2).toString('ascii');
check('导出：docx 依赖可用时生成 .docx（PK 头 + 字节数）',
  docxOut.format === 'docx' && docxOut.path.endsWith('开发周报-20261125-183005.docx')
  && docxHead === 'PK' && docxOut.bytes > 1000 && statSync(docxOut.path).size === docxOut.bytes,
  `${docxOut.format} ${docxOut.bytes}B`);

const docxOut2 = await exportWeeklyReport({ draft: exportDraft, outputDir: exportDir, now: new Date(2026, 10, 25, 18, 30, 5) });
check('导出：同秒重复导出不覆盖（自动加后缀）', docxOut2.path !== docxOut.path && docxOut2.path.includes('-2.docx'),
  docxOut2.path);

const docOut = await exportWeeklyReport({
  draft: { ...exportDraft, completedWorks: [], bugs: [], nextWeekPlan: [] },
  outputDir: exportDir, now: new Date(2026, 10, 25, 18, 31, 0),
  loadDocx: async () => { throw new Error('docx missing'); },
});
const docHtml = readFileSync(docOut.path, 'utf8');
check('导出：docx 缺失 → Word 兼容 .doc（含六区块/中文字体/占位行）',
  docOut.format === 'doc' && docOut.path.endsWith('.doc')
  && docHtml.includes('<meta charset="utf-8">') && docHtml.includes('微软雅黑')
  && docHtml.includes('开发周报') && docHtml.includes('一、基本信息') && docHtml.includes('六、下周工作计划')
  && docHtml.includes(WEEKLY_EMPTY_TEXT.works) && docHtml.includes(WEEKLY_EMPTY_TEXT.bugs)
  && docHtml.includes(WEEKLY_EMPTY_TEXT.plans));
check('导出：中文标题被 HTML 转义', await (async () => {
  const out = await exportWeeklyReport({
    draft: { ...exportDraft, basicInfo: { ...exportDraft.basicInfo, reporter: '张三<script>' } },
    outputDir: exportDir, now: new Date(2026, 10, 25, 18, 32, 0),
    loadDocx: async () => { throw new Error('docx missing'); },
  });
  const html = readFileSync(out.path, 'utf8');
  return html.includes('张三&lt;script&gt;') && !html.includes('张三<script>');
})());

const defaultOut = await exportWeeklyReport({ draft: exportDraft, now: new Date(2026, 10, 25, 18, 33, 0) });
check('导出：未指定目录 → 默认 $DSH_HOME/zentao-panel/reports',
  defaultOut.path.startsWith(defaultReportsDir()) && defaultOut.path.includes(join('zentao-panel', 'reports')),
  defaultOut.path);

let badDirMessage = '';
try {
  await exportWeeklyReport({ draft: exportDraft, outputDir: 'relative/dir' });
} catch (e) { badDirMessage = e.message; }
check('导出：相对路径目录被拒绝', badDirMessage.includes('绝对路径'), badDirMessage);

// ───────────────────────── 4. RPC（mock ctx + 真实 http）─────────────────────────
const routeCalls = [];
const server = http.createServer((req, res) => {
  const route = routeCalls.find((r) => req.url?.startsWith(r.path));
  if (route) { route.handler(req, res); return; }
  res.writeHead(404).end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let weeklySeen = null;
const stubService = {
  status: () => ({ configured: true }),
  fetchWeeklyReport: async ({ start, end }) => {
    weeklySeen = { start, end };
    return { ...exportDraft, warnings: [] };
  },
};
const dispose = installZentaoRpc({
  webServer: { register(route) { routeCalls.push(route); return () => { const i = routeCalls.indexOf(route); if (i >= 0) routeCalls.splice(i, 1); }; } },
  connection: { requestRejection: () => undefined },
}, { service: stubService, log: silent });

let rpcSeq = 0;
async function rpc(endpoint, payload = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${CHANNEL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rpcId: `w-${++rpcSeq}`, method: endpoint, payload }),
  });
  return (await res.json()).result;
}

check('RPC：渠道挂载为 /dsh-ztp9-rpc', CHANNEL === '/dsh-ztp9-rpc' && routeCalls[0]?.path === CHANNEL, CHANNEL);
check('RPC weekly：参数校验（非法日期/倒序/超范围）',
  (await rpc('zentao.weekly', { start: '2026-02-30', end: '2026-03-01' })).ok === false
  && (await rpc('zentao.weekly', { start: '2026-11-29', end: '2026-11-23' })).ok === false
  && (await rpc('zentao.weekly', { start: '2026-11-01', end: '2026-12-02' })).ok === false
  && (await rpc('zentao.weekly', {})).ok === false);
const weeklyOk = await rpc('zentao.weekly', { start: '2026-11-23', end: '2026-11-29' });
check('RPC weekly：成功透传 start/end 并返回草稿',
  weeklyOk.ok === true && weeklySeen.start === '2026-11-23' && weeklySeen.end === '2026-11-29'
  && weeklyOk.value.basicInfo.reporter === '李宏博');

const badDraft = await rpc('zentao.weeklyExport', { draft: { basicInfo: {} } });
check('RPC weeklyExport：草稿形状非法被拒绝', badDraft.ok === false, badDraft.error?.message);
const tooMany = await rpc('zentao.weeklyExport', {
  draft: { ...exportDraft, completedWorks: Array.from({ length: 201 }, () => ({ title: 'x', consumed: 1 })) },
});
check('RPC weeklyExport：条目超过 200 被拒绝', tooMany.ok === false);
const badText = await rpc('zentao.weeklyExport', { draft: { ...exportDraft, overview: 'x'.repeat(20001) } });
check('RPC weeklyExport：长文本超过 20000 被拒绝', badText.ok === false);
const relDir = await rpc('zentao.weeklyExport', { draft: exportDraft, outputDir: 'relative/dir' });
check('RPC weeklyExport：相对输出目录被拒绝', relDir.ok === false, relDir.error?.message);
const missingDir = await rpc('zentao.weeklyExport', { draft: exportDraft, outputDir: join(exportDir, 'nope') });
check('RPC weeklyExport：不存在的输出目录被拒绝', missingDir.ok === false, missingDir.error?.message);

const rpcExport = await rpc('zentao.weeklyExport', { draft: exportDraft, outputDir: exportDir });
check('RPC weeklyExport：导出成功返回 path/format/bytes',
  rpcExport.ok === true && typeof rpcExport.value.path === 'string'
  && ['docx', 'doc'].includes(rpcExport.value.format) && rpcExport.value.bytes > 0
  && existsSyncSafe(rpcExport.value.path), rpcExport.value?.path);

const unknown = await rpc('zentao.unknown', {});
check('RPC：未知 endpoint 返回错误', unknown.ok === false && String(unknown.error?.message).includes('Unknown endpoint'));

function existsSyncSafe(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

dispose();
check('RPC：dispose 移除路由', routeCalls.length === 0);
server.close();

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
