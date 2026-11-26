// dsh-zentao-panel — 本机 Trae CN 下发
//
// 官方 CLI 契约（Trae CN 3.4.20 实测）：
//   "<Trae CN.exe>" "<resources/app/out/cli.js>" chat --mode agent --add-file <path> ... "<query>"
//   · chat 会把 {query, mode, attachFiles} 交给 workbench.action.chat.open；
//     未传 isPartialQuery，命令内部 acceptInput() → 自动发送。
//   · --add-file 的 png/jpg/gif/webp 会被 attachmentModel.addFile 识别成图片附件。
//   · 只走默认 Trae 实例（chat 子命令不认 --user-data-dir）。
//
// 本模块不读取任何 Trae token；只负责：探测安装、写任务文件/截图、启动 CLI。
// 任务文件放在 $DSH_HOME/zentao-panel/trae/tasks 下，不污染业务仓库。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

const KIND_LABEL = Object.freeze({ task: '任务', bug: 'Bug', story: '需求' });
const MODES = new Set(['agent', 'edit', 'ask']);
const CLI_TIMEOUT_MS = 10_000;
const DETECT_TTL_MS = 60_000;
const TASK_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const TASK_KEEP_MAX = 100;
const MAX_MD_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 20;

function panelDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'zentao-panel');
}

function traeConfigPath() {
  return join(panelDir(), 'trae.json');
}

function traeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function cleanName(value, fallback = 'image') {
  const s = String(value ?? '').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || fallback).slice(0, 100);
}

function cleanText(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function accountDir(accountId) {
  return String(accountId ?? '').replace(/[^\w-]+/g, '').slice(0, 32) || 'anon';
}

function readProductVersion(appRoot) {
  try {
    const raw = readFileSync(join(appRoot, 'resources', 'app', 'product.json'), 'utf8');
    const m = /"appVersion"\s*:\s*"([^"]+)"/.exec(raw) || /"version"\s*:\s*"([^"]+)"/.exec(raw);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 把 exe 或 bin/trae-cn.cmd 归一成 {exePath, appRoot, cliPath, version}。 */
export function resolveTraeInstall(exePath) {
  const raw = String(exePath ?? '').trim();
  if (!raw) return null;
  let exe = resolve(raw);
  if (!existsSync(exe)) return null;
  const base = basename(exe).toLowerCase();
  if (base.endsWith('.cmd') || base.endsWith('.bat') || base === 'trae-cn') {
    const binDir = dirname(exe);
    const root = dirname(binDir);
    const candidates = ['Trae CN.exe', 'Trae.exe', 'trae-cn.exe', 'trae.exe'];
    let found = '';
    for (const name of candidates) {
      const p = join(root, name);
      if (existsSync(p)) { found = p; break; }
    }
    if (!found) return null;
    exe = found;
  }
  const appRoot = dirname(exe);
  const cliPath = join(appRoot, 'resources', 'app', 'out', 'cli.js');
  if (!existsSync(cliPath)) return null;
  return {
    exePath: exe,
    appRoot,
    cliPath,
    version: readProductVersion(appRoot),
  };
}

/** 从注册表命令字符串里取第一个带引号的 .exe（兼容无引号）。 */
export function parseRegistryCommand(output) {
  const text = String(output ?? '');
  const quoted = /"([^"]+?\.exe)"/i.exec(text);
  if (quoted) return quoted[1];
  const bare = /([A-Za-z]:\\[^\r\n"]+?\.exe)/i.exec(text);
  return bare ? bare[1].trim() : '';
}

function readRegistryCommand(key) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/ve'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000,
    });
    return parseRegistryCommand(out);
  } catch {
    return '';
  }
}

/**
 * 探测默认 Trae CN 安装。优先级：配置 exePath → 注册表 trae-cn/trae →
 * 常见安装路径 → PATH。返回 {available, exePath, appRoot, cliPath, version, source}。
 */
export function detectTrae({ config = {}, env = process.env, platform = process.platform } = {}) {
  const seen = new Set();

  const accept = (candidate, source) => {
    const raw = String(candidate ?? '').trim();
    if (!raw) return null;
    const key = raw.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const hit = resolveTraeInstall(raw);
    return hit ? { ...hit, available: true, source } : null;
  };

  if (config.exePath) {
    const hit = accept(config.exePath, 'config');
    if (hit) return hit;
  }

  if (platform === 'win32') {
    const regKeys = [
      'HKCU\\Software\\Classes\\trae-cn\\shell\\open\\command',
      'HKLM\\Software\\Classes\\trae-cn\\shell\\open\\command',
      'HKCU\\Software\\Classes\\trae\\shell\\open\\command',
      'HKLM\\Software\\Classes\\trae\\shell\\open\\command',
    ];
    for (const key of regKeys) {
      const hit = accept(readRegistryCommand(key), 'registry');
      if (hit) return hit;
    }
    const roots = [
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Trae CN', 'Trae CN.exe') : '',
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Trae', 'Trae.exe') : '',
      env.ProgramFiles ? join(env.ProgramFiles, 'Trae CN', 'Trae CN.exe') : '',
      env.ProgramFiles ? join(env.ProgramFiles, 'Trae', 'Trae.exe') : '',
      env.ProgramW6432 ? join(env.ProgramW6432, 'Trae CN', 'Trae CN.exe') : '',
      env.ProgramW6432 ? join(env.ProgramW6432, 'Trae', 'Trae.exe') : '',
      'D:\\ProgramFiles\\Trae CN\\Trae CN.exe',
      'D:\\ProgramFiles\\Trae\\Trae.exe',
    ];
    for (const candidate of roots) {
      const hit = accept(candidate, 'common');
      if (hit) return hit;
    }
    const pathDirs = String(env.PATH ?? '').split(';').filter(Boolean);
    for (const dir of pathDirs) {
      for (const name of ['trae-cn.cmd', 'trae-cn.exe', 'Trae CN.exe', 'trae.cmd', 'trae.exe']) {
        const hit = accept(join(dir, name), 'path');
        if (hit) return hit;
      }
    }
  } else {
    const candidates = [
      '/Applications/Trae CN.app/Contents/MacOS/Trae CN',
      '/Applications/Trae.app/Contents/MacOS/Trae',
      '/usr/local/bin/trae-cn',
      '/usr/local/bin/trae',
      '/usr/bin/trae-cn',
      '/usr/bin/trae',
    ];
    for (const candidate of candidates) {
      const hit = accept(candidate, 'common');
      if (hit) return hit;
    }
    const pathDirs = String(env.PATH ?? '').split(':').filter(Boolean);
    for (const dir of pathDirs) {
      for (const name of ['trae-cn', 'trae']) {
        const hit = accept(join(dir, name), 'path');
        if (hit) return hit;
      }
    }
  }

  return { available: false, exePath: '', appRoot: '', cliPath: '', version: '', source: '' };
}

export function readTraeConfig() {
  const fallback = { version: 1, exePath: '', workspaceDir: '', mode: 'agent', reuseWindow: false };
  try {
    const d = JSON.parse(readFileSync(traeConfigPath(), 'utf8'));
    return {
      version: 1,
      exePath: typeof d?.exePath === 'string' ? d.exePath : '',
      workspaceDir: typeof d?.workspaceDir === 'string' ? d.workspaceDir : '',
      mode: MODES.has(d?.mode) ? d.mode : 'agent',
      reuseWindow: d?.reuseWindow === true,
    };
  } catch {
    return fallback;
  }
}

export function writeTraeConfig(patch = {}) {
  const cur = readTraeConfig();
  const next = {
    version: 1,
    exePath: typeof patch.exePath === 'string' ? patch.exePath.trim() : cur.exePath,
    workspaceDir: typeof patch.workspaceDir === 'string' ? patch.workspaceDir.trim() : cur.workspaceDir,
    mode: MODES.has(patch.mode) ? patch.mode : cur.mode,
    reuseWindow: typeof patch.reuseWindow === 'boolean' ? patch.reuseWindow : cur.reuseWindow,
  };
  try {
    mkdirSync(panelDir(), { recursive: true });
    writeFileSync(traeConfigPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch { /* 配置写失败不拦下发 */ }
  return next;
}

/** 构造 CLI 参数（纯函数，测试可直接断言）。 */
export function buildTraeArgs(install, { taskFile, images = [], query, mode = 'agent', reuseWindow = false }) {
  const args = [install.cliPath, 'chat', '--mode', MODES.has(mode) ? mode : 'agent'];
  if (reuseWindow) args.push('--reuse-window');
  if (taskFile) args.push('--add-file', taskFile);
  for (const p of images) args.push('--add-file', p);
  args.push(String(query ?? ''));
  return args;
}

/** 允许的 Trae 任务目的；未知值一律回落 fix（兼容旧客户端）。 */
export const TRAE_PURPOSES = Object.freeze(new Set(['fix', 'testcases', 'test-analysis', 'requirement-review']));

/**
 * 纯函数：按 purpose 拼 Trae 查询（便于单测，不访问网络/桥接）。
 * - fix：原有「处理任务并改代码」；
 * - testcases：写用例并用禅道 MCP 创建；
 * - test-analysis：测试视角分析，不改代码、不写禅道；
 * - requirement-review：产品视角评审，不改代码。
 */
export function buildTraePrompt({ purpose = 'fix', taskFile = '', workspace = '', md = '', planMode = false } = {}) {
  const p = TRAE_PURPOSES.has(purpose) ? purpose : 'fix';
  const intros = {
    fix: '请处理以下禅道任务。',
    testcases: '请根据以下禅道需求编写测试用例，并使用你在 Trae 中配置的禅道 MCP 将用例创建到禅道'
      + '（优先挂到「关联需求」下）。\n'
      + '要求：覆盖正常流程、异常/边界、权限/状态、数据一致性；每条用例包含标题、前置条件、'
      + '步骤、预期结果、优先级。\n'
      + '创建前如需确认，先列出用例清单与覆盖点；如果 MCP 需要产品/模块信息，按需求上下文选择。',
    'test-analysis': '请以测试视角分析以下禅道事项。输出：\n'
      + '- 需求/变更点与验收标准\n'
      + '- 可测性风险、疑问与缺失信息\n'
      + '- 测试范围与测试点（正常/异常/边界/权限/状态/数据一致性）\n'
      + '- 建议的用例类型与优先级\n'
      + '不要修改代码，不要直接写禅道。',
    'requirement-review': '请以产品视角评审以下需求。输出：\n'
      + '- 目标用户与核心场景\n'
      + '- 功能范围与非目标\n'
      + '- 验收标准\n'
      + '- 歧义、缺失信息与风险\n'
      + '- 建议优先级与拆分\n'
      + '不要修改代码，不要直接写禅道。',
  };
  const tails = {
    fix: '请先阅读任务背景与截图，再在工作区 ' + workspace + ' 定位并修改代码；完成后说明改动与验证结果。',
    testcases: '请基于上面的需求正文编写用例并用禅道 MCP 创建；完成后说明创建结果。',
    'test-analysis': '请基于以上内容输出测试分析；不要修改代码，不要直接写禅道。',
    'requirement-review': '请基于以上内容输出需求评审；不要修改代码。',
  };
  return (planMode ? '/plan\n\n' : '')
    + intros[p] + '\n\n'
    + '任务文件：' + taskFile + '\n\n'
    + String(md ?? '') + '\n\n'
    + tails[p];
}


// ───────────────── Trae AI 桥接（trae-bridge 扩展）─────────────────
// Trae CN 3.4.20 的 `trae-cn chat` 调用内置 workbench.action.chat.open，
// 但该命令在 Trae 窗口里没有注册（renderer 日志：command not found）。
// 桥接扩展在 Trae 窗口内调用 workbench.action.chat.icube.open
// （newChat + query），这是 Trae 自己的 AI 面板命令。

function bridgeRegistryDir() {
  return join(homedir(), '.trae-cn', 'zentao-bridge', 'registry');
}

function normWorkspace(p) {
  return String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').trim().toLowerCase();
}

function readBridges() {
  try {
    const dir = bridgeRegistryDir();
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          if (!d || !d.port || !d.token || typeof d.workspace !== 'string') return null;
          return d;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findBridge(workspace) {
  const target = normWorkspace(workspace);
  const list = readBridges().filter((b) => normWorkspace(b.workspace) === target);
  list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return list[0] || null;
}

function bridgeRequest(entry, method, path, body, timeoutMs = 15_000) {
  return new Promise((resolvePromise) => {
    const data = body == null ? null : JSON.stringify(body);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolvePromise(value);
    };
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port: entry.port,
        path,
        method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          authorization: 'Bearer ' + entry.token,
        },
        timeout: timeoutMs,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 1_000_000) {
            try { req.destroy(); } catch { /* ignore */ }
          }
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* text only */ }
          finish({ status: res.statusCode, json, text });
        });
      });
    } catch (err) {
      finish({ status: 0, error: err });
      return;
    }
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { /* ignore */ } });
    req.on('error', (err) => finish({ status: 0, error: err }));
    if (data) req.write(data);
    req.end();
  });
}

async function pingBridge(entry) {
  const r = await bridgeRequest(entry, 'GET', '/ping', null, 2_500);
  return r.status === 200 && r.json?.ok === true;
}

function openWorkspaceInTrae(det, workspace, spawnImpl, env) {
  try {
    const child = spawnImpl(det.exePath, [det.cliPath, '--new-window', workspace], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child && typeof child.unref === 'function') child.unref();
  } catch { /* bridge error is reported later */ }
}

async function waitForBridge(workspace, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = findBridge(workspace);
    if (entry && await pingBridge(entry)) return entry;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}


function formatCard(card) {
  const kind = KIND_LABEL[card?.kind] || String(card?.kind || '事项');
  const id = card?.id != null ? ' #' + card.id : '';
  const title = cleanText(card?.title, 80);
  return kind + id + (title ? '《' + title + '》' : '');
}

function buildQuery(cards, workspace) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) return '请处理附件中的禅道任务。任务背景见 task.md，截图见图片附件。';
  if (list.length === 1) {
    return '请处理附件中的禅道' + formatCard(list[0])
      + '。完整任务背景、最近动态与处理要求见 task.md，截图见图片附件。'
      + '请先阅读任务文件，再在工作区 ' + workspace + ' 定位并修改代码；完成后说明改动与验证结果。';
  }
  const labels = list.slice(0, 8).map(formatCard).join('、') + (list.length > 8 ? ' 等' : '');
  return '请批量处理附件中的 ' + list.length + ' 个禅道事项：' + labels
    + '。完整任务背景见 task.md，截图见图片附件。'
    + '请先阅读任务文件，再在工作区 ' + workspace + ' 定位并修改代码；完成后按事项逐条说明改动与验证结果。';
}

function appendImageList(md, imageNames) {
  if (!imageNames.length) return md;
  const lines = imageNames.map((name, i) => '- 截图 ' + (i + 1) + '：' + name).join('\n');
  return String(md).replace(/\s+$/, '') + '\n\n## 截图附件\n\n' + lines + '\n';
}

/** 判断 md 里是否已有某段文字（压缩空白 + 取前 60 字，避免图片占位差异导致误判）。 */
function mdHasText(md, text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  const needle = t.slice(0, 60);
  return String(md ?? '').replace(/\s+/g, ' ').includes(needle);
}

/** 把 host 详情里的最近动态压成几行文本（客户端可能没拿到详情时补上）。 */
function detailActionsText(actions) {
  if (!Array.isArray(actions) || !actions.length) return '';
  const rows = [];
  for (const a of actions.slice(-10)) {
    const desc = String(a?.desc || '').trim();
    const comment = String(a?.comment || '').replace(/\[图片：[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    const date = String(a?.date || '').trim();
    const head = [date, desc].filter(Boolean).join(' ');
    if (!head && !comment) continue;
    rows.push('- ' + [head, comment].filter(Boolean).join('：'));
  }
  return rows.join('\n');
}

function runCli(install, args, { cwd, env, spawnImpl, timeoutMs }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(install.exePath, args, {
        cwd,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolvePromise({ error: err });
      return;
    }
    let stderr = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolvePromise(value);
    };
    child.once('error', (err) => finish({ error: err }));
    child.once('exit', (code, signal) => finish({ code, signal, stderr: stderr.trim() }));
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
    }
    const timer = setTimeout(() => {
      if (done) return;
      try { child.unref(); } catch { /* 已退出 */ }
      finish({ pending: true, stderr: stderr.trim() });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function pruneTasks(taskRoot, now) {
  try {
    const accounts = readdirSyncSafe(taskRoot);
    for (const account of accounts) {
      const dir = join(taskRoot, account);
      const entries = readdirSyncSafe(dir);
      const withTime = [];
      for (const name of entries) {
        const p = join(dir, name);
        try {
          const st = statSync(p);
          if (!st.isDirectory()) continue;
          withTime.push({ p, at: st.mtimeMs });
        } catch { /* 忽略 */ }
      }
      withTime.sort((a, b) => b.at - a.at);
      for (let i = 0; i < withTime.length; i++) {
        if (i < TASK_KEEP_MAX && now - withTime[i].at < TASK_KEEP_MS) continue;
        try { rmSync(withTime[i].p, { recursive: true, force: true }); } catch { /* 忽略 */ }
      }
    }
  } catch { /* 清理失败不影响下发 */ }
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function createTraeService({ getZentao, logger = console, spawnImpl = spawn, env = process.env, platform = process.platform } = {}) {
  let cachedDetect = null;
  let cachedAt = 0;
  let queue = Promise.resolve();

  function config() {
    return readTraeConfig();
  }

  function detectCached(force = false) {
    const now = Date.now();
    if (!force && cachedDetect && now - cachedAt < DETECT_TTL_MS) return cachedDetect;
    cachedDetect = detectTrae({ config: config(), env, platform });
    cachedAt = now;
    return cachedDetect;
  }

  function status() {
    const cfg = config();
    const det = detectCached();
    return {
      available: det.available === true,
      exePath: det.exePath || '',
      appRoot: det.appRoot || '',
      cliPath: det.cliPath || '',
      version: det.version || '',
      source: det.source || '',
      workspaceDir: cfg.workspaceDir,
      mode: cfg.mode,
      reuseWindow: cfg.reuseWindow,
      bridges: readBridges().map((b) => ({ workspace: b.workspace, port: b.port, updatedAt: b.updatedAt })),
      error: det.available ? '' : '未检测到 Trae CN（可设置环境或配置 exePath）',
    };
  }

  async function fetchImage(accountId, image) {
    // getZentao 允许传 service 本体或返回 service 的函数（index.js 传的是函数）。
    const svc = typeof getZentao === 'function' ? getZentao() : getZentao;
    if (!svc || !image || typeof image.url !== 'string' || !image.url) return null;
    try {
      if (typeof svc.fetchImageFor === 'function') return await svc.fetchImageFor(accountId, image.url);
      if (typeof svc.fetchImage === 'function') return await svc.fetchImage(image.url);
    } catch (err) {
      logger.warn?.('dsh-zentao-panel: trae image failed: %s', err?.message ?? err);
    }
    return null;
  }

  /**
   * 下发 Trae 前用 host 的禅道会话补全详情：
   * - 客户端列表卡只有标题/300 字摘要；「处理」路径若详情没取到，task.md 就只剩标题。
   * - 任务/ Bug 的正文在 v1 详情 desc；任务还可能挂在某个需求（storyId）下，需求的
   *   spec 往往才是真正要做的东西 —— 这里一并取回。
   * - 返回值 md 追加「禅道详情（自动补全）」；fetched=0 表示一条详情都没拿到。
   */
  async function enrichTaskMd(md, cards, accountId) {
    const svc = typeof getZentao === 'function' ? getZentao() : getZentao;
    const warnings = [];
    const noService = !svc
      || (typeof svc.fetchDetailFor !== 'function' && typeof svc.fetchDetail !== 'function');
    if (noService) return { md, warnings, enriched: false, fetched: 0 };

    const getDetail = (kind, id) => (typeof svc.fetchDetailFor === 'function'
      ? svc.fetchDetailFor(accountId, kind, id)
      : svc.fetchDetail(kind, id));

    const blocks = [];
    let fetched = 0;
    for (const card of (Array.isArray(cards) ? cards.slice(0, 20) : [])) {
      if (!card || !KIND_LABEL[card.kind] || !Number(card.id)) continue;
      const label = KIND_LABEL[card.kind] || card.kind;
      let d = null;
      try {
        d = await getDetail(card.kind, card.id);
        if (d) fetched++;
      } catch (err) {
        warnings.push(label + ' #' + card.id + ' 详情读取失败：' + String(err?.message || err).slice(0, 120));
        logger.warn?.('dsh-zentao-panel: trae detail %s #%s failed: %s', card.kind, card.id, err?.message ?? err);
        continue;
      }
      if (!d) continue;

      const lines = [];
      const desc = String(d.desc || '').trim();
      if (desc && !mdHasText(md, desc)) {
        lines.push('### 描述');
        lines.push(desc);
      }
      const meta = [];
      if (d.status) meta.push('状态：' + d.status);
      if (d.assignedTo) meta.push('指派给：' + d.assignedTo);
      if (d.productName || d.product) meta.push('产品：' + (d.productName || d.product));
      if (d.projectName || d.project) meta.push('项目：' + (d.projectName || d.project));
      if (d.moduleTitle || d.module) meta.push('模块：' + (d.moduleTitle || d.module));
      if (d.deadline) meta.push('截止：' + d.deadline);
      if (meta.length) lines.push(meta.join('；'));

      const storyId = Number(d.storyId) || 0;
      if (storyId && card.kind !== 'story') {
        const storyHead = '### 关联需求 #' + storyId + (d.storyTitle ? '：' + d.storyTitle : '');
        try {
          const s = await getDetail('story', storyId);
          const spec = String(s?.desc || '').trim();
          lines.push(storyHead);
          lines.push(spec || '（关联需求无文字描述）');
        } catch (err) {
          lines.push(storyHead);
          lines.push('（关联需求详情读取失败，请到禅道查看）');
          warnings.push('关联需求 #' + storyId + ' 详情读取失败');
        }
      }

      const acts = detailActionsText(d.actions);
      if (acts && !mdHasText(md, acts)) {
        lines.push('### 最近动态');
        lines.push(acts);
      }
      if (!lines.length) lines.push('（该' + label + '没有文字描述，也没有关联需求；请结合标题与截图定位。）');
      blocks.push('## 禅道详情（自动补全）：' + label + ' #' + card.id
        + (d.title ? '《' + d.title + '》' : '') + '\n\n' + lines.join('\n\n'));
    }

    if (!blocks.length) return { md, warnings, enriched: false, fetched };
    const out = String(md).replace(/\s+$/, '') + '\n\n' + blocks.join('\n\n') + '\n';
    return { md: out, warnings, enriched: true, fetched };
  }

  async function doDispatch(payload) {
    const cards = Array.isArray(payload?.cards) ? payload.cards : [];
    if (!cards.length || cards.length > 50) throw traeError('BAD_CARDS', '事项数量非法');
    const md = String(payload?.md ?? '').trim();
    if (!md) throw traeError('BAD_MD', '任务背景为空');
    if (Buffer.byteLength(md, 'utf8') > MAX_MD_BYTES) throw traeError('BAD_MD', '任务背景过大');

    const cfg = config();
    const workspace = resolve(String(payload?.workspaceDir || cfg.workspaceDir || '').trim());
    if (!workspace) throw traeError('NO_WORKSPACE', '没有指定 Trae 工作区');
    try {
      if (!statSync(workspace).isDirectory()) throw new Error('not a directory');
    } catch {
      throw traeError('NO_WORKSPACE', 'Trae 工作区不存在或不是目录：' + workspace);
    }

    const mode = MODES.has(payload?.mode) ? payload.mode : cfg.mode || 'agent';
    const reuseWindow = typeof payload?.reuseWindow === 'boolean' ? payload.reuseWindow : cfg.reuseWindow;
    const planMode = payload?.planMode === true;
    const purpose = TRAE_PURPOSES.has(payload?.purpose) ? payload.purpose : 'fix';
    const det = detectCached(true);
    if (!det.available) {
      throw traeError('TRAE_NOT_FOUND', '未检测到本机 Trae CN，请先安装并登录 Trae 默认实例');
    }

    const now = Date.now();
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const account = accountDir(payload?.accountId);
    const first = cards[0];
    const label = cards.length > 1 ? 'batch-' + cards.length : cleanName(first.kind + '-' + first.id, 'task');
    const taskDir = join(panelDir(), 'trae', 'tasks', account, label + '-' + stamp);
    const taskFile = join(taskDir, 'task.md');
    const imageDir = join(taskDir, 'images');
    mkdirSync(imageDir, { recursive: true });

    const images = Array.isArray(payload?.images) ? payload.images.slice(0, MAX_IMAGES) : [];
    const imagePaths = [];
    const imageNames = [];
    const warnings = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const value = await fetchImage(payload?.accountId, image);
      if (!value || !value.base64) {
        warnings.push('截图 ' + (i + 1) + ' 下载失败');
        continue;
      }
      const mediaType = String(value.mediaType || 'image/png');
      const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1] || 'png';
      const name = cleanName(value.name || image.name || ('image-' + (i + 1)), 'image-' + (i + 1));
      const fileName = (imageNames.length + 1) + '-' + name.replace(/\.[^.]+$/, '') + '.' + ext;
      const filePath = join(imageDir, fileName);
      try {
        writeFileSync(filePath, Buffer.from(value.base64, 'base64'), { mode: 0o600 });
        imagePaths.push(filePath);
        imageNames.push(fileName);
      } catch (err) {
        warnings.push('截图 ' + (i + 1) + ' 写入失败');
      }
    }

    const enrichment = await enrichTaskMd(md, cards, payload?.accountId);
    for (const w of enrichment.warnings) warnings.push(w);
    if (!enrichment.fetched && !/###\s/.test(md)) {
      const ids = cards.slice(0, 5).map((c) => (KIND_LABEL[c.kind] || c.kind) + ' #' + c.id).join('、');
      throw traeError(
        'TRAE_NO_DETAIL',
        '未能读取禅道详情（' + ids + '），已阻止只发标题到 Trae；请确认禅道登录/网络后重试',
      );
    }
    const finalMd = appendImageList(enrichment.md, imageNames);
    writeFileSync(taskFile, finalMd + '\n', { mode: 0o600 });
    const bridgeQuery = buildTraePrompt({ purpose, taskFile, workspace, md: finalMd, planMode });

    logger.info?.('dsh-zentao-panel: trae dispatch %s -> %s (%d images, bridge, %s)', label, workspace, imagePaths.length, purpose);

    // 优先走 Trae 内的桥接扩展：调用 Trae 自己的 AI 面板命令
    // workbench.action.chat.icube.open（newChat + query），它会新建对话并发送。
    let entry = findBridge(workspace);
    if (!entry || !(await pingBridge(entry))) {
      openWorkspaceInTrae(det, workspace, spawnImpl, env);
      entry = await waitForBridge(workspace, 25_000);
    }
    if (!entry) {
      throw traeError(
        'TRAE_BRIDGE',
        'Trae 桥接未连接：请确认扩展已安装到 ~/.trae-cn/extensions/local.zentao-bridge-0.0.1，'
        + '并在 Trae 中打开工作区 ' + workspace + '（扩展会在窗口启动时自动连接）',
      );
    }
    const bridge = await bridgeRequest(entry, 'POST', '/dispatch', {
      workspace,
      query: bridgeQuery,
      images: imagePaths,
      planMode,
    }, 15_000);
    // Trae 的桥接命令经常在消息已经发到聊天窗后才抛错/超时（命令内部等 agent
    // 响应，或新窗口/输入框还没就绪）。此时任务其实已经送达，不能向用户报「失败」。
    // 5xx / 请求超时 / 连接被重置一律按「可能已发送」处理，让卡片照常标处理中，
    // 并在 toast 里提示到 Trae 确认。
    let bridgeWarning = '';
    if (bridge.status === 200 && bridge.json?.ok) {
      // delivered, no warning
    } else if (bridge.status >= 500) {
      const why = bridge.json?.error || bridge.text || bridge.error?.message || 'unknown';
      bridgeWarning = 'Trae 桥接返回异常，任务可能已发送，请到 Trae 确认：' + String(why).slice(0, 200);
    } else if (bridge.status === 0
      && /timeout|ETIMEDOUT|socket hang up|ECONNRESET|EPIPE/i.test(String(bridge.error?.message || bridge.error || ''))) {
      bridgeWarning = 'Trae 桥接响应超时，任务可能已发送，请到 Trae 确认';
    } else {
      const why = bridge.json?.error || bridge.text || bridge.error?.message || 'unknown';
      throw traeError('TRAE_BRIDGE', 'Trae 桥接发送失败：' + String(why).slice(0, 400));
    }
    if (bridgeWarning) {
      warnings.push(bridgeWarning);
      logger.warn?.('dsh-zentao-panel: ' + bridgeWarning);
    }
    writeTraeConfig({ workspaceDir: workspace, mode, reuseWindow });
    pruneTasks(join(panelDir(), 'trae', 'tasks'), now);
    return {
      taskFile, taskDir, workspace, mode, imageCount: imagePaths.length,
      warnings, pending: false, bridge: true, planMode, purpose, enriched: enrichment.enriched,
      delivered: bridgeWarning ? 'unknown' : true,
    };
  }

  function dispatch(payload) {
    const run = queue.then(() => doDispatch(payload));
    queue = run.catch(() => {});
    return run;
  }

  return {
    status,
    dispatch,
    // 调试/测试用：只补全任务背景，不发 Trae。
    enrich: (payload = {}) => enrichTaskMd(String(payload.md ?? ''), Array.isArray(payload.cards) ? payload.cards : [], payload.accountId),
    detect: () => detectCached(true),
    config,
    configure: writeTraeConfig,
  };
}

export { KIND_LABEL, MODES, buildQuery, appendImageList };
