// local.zentao-bridge — installed into Trae CN's user extensions.
//
// Why: Trae CN's official `trae-cn chat` CLI calls the VS Code built-in
// `workbench.action.chat.open`, which this Trae build does not register
// (`command not found`). Trae's own AI panel exposes the command
// `workbench.action.chat.icube.open` with `{ query, newChat: true }`, which
// creates a new AI chat and sends the prompt. This extension runs inside the
// Trae window and exposes a tiny loopback HTTP bridge so the DSH plugin can
// invoke that command with the ZenTao task text.
//
// Security: binds 127.0.0.1 only, bearer token generated per window, fixed
// command, no arbitrary command execution.

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CHAT_COMMAND = 'workbench.action.chat.icube.open';
const REGISTRY_DIR = path.join(os.homedir(), '.trae-cn', 'zentao-bridge', 'registry');
const LOG_FILE = path.join(os.homedir(), '.trae-cn', 'zentao-bridge', 'bridge.log');
const MAX_BODY = 8 * 1024 * 1024;

let server = null;
let registryFile = '';
let token = '';
let output = null;
let disposed = false;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', { mode: 0o600 });
  } catch { /* ignore */ }
  try { output?.appendLine(line); } catch { /* ignore */ }
}

function workspacePath() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders[0]?.uri?.fsPath || '';
}

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function workspaceHash(workspace) {
  return crypto.createHash('sha1').update(normPath(workspace)).digest('hex').slice(0, 10);
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function writeRegistry(port) {
  const workspace = workspacePath();
  const hash = workspace ? workspaceHash(workspace) : 'no-workspace';
  registryFile = path.join(REGISTRY_DIR, `${hash}.json`);
  const payload = {
    version: 1,
    workspace,
    port,
    token,
    pid: process.pid,
    updatedAt: Date.now(),
  };
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  log(`registry ${registryFile} port=${port}`);
}

function removeRegistry() {
  try { if (registryFile) fs.unlinkSync(registryFile); } catch { /* ignore */ }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, x-zentao-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authOk(req) {
  const auth = String(req.headers.authorization || '');
  const header = String(req.headers['x-zentao-token'] || '');
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : header;
  if (!got || got.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
  } catch {
    return false;
  }
}

function copyImages(workspace, images) {
  const list = Array.isArray(images) ? images.slice(0, 20) : [];
  if (!list.length || !workspace) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(workspace, '.trae', 'zentao', 'bridge-' + stamp, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const src = String(list[i] || '');
    if (!src || !fs.existsSync(src)) continue;
    const base = path.basename(src).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_') || `image-${i + 1}.png`;
    const dst = path.join(dir, `${i + 1}-${base}`);
    try {
      fs.copyFileSync(src, dst);
      out.push(path.relative(workspace, dst).replace(/\//g, '\\'));
    } catch (err) {
      log(`image copy failed ${src}: ${err.message}`);
    }
  }
  return out;
}

function buildQuery(body) {
  let query = String(body.query || '').trim();
  const workspace = workspacePath();
  const relImages = copyImages(workspace, body.images);
  if (relImages.length) {
    query += '\n\n## 截图（工作区内，可直接读取）\n\n' + relImages.map((p) => '- ' + p).join('\n');
  }
  return query;
}

async function dispatch(body) {
  if (!body || typeof body.query !== 'string' || !body.query.trim()) {
    const err = new Error('query is required');
    err.status = 400;
    throw err;
  }
  const current = workspacePath();
  if (body.workspace && current && normPath(body.workspace) !== normPath(current)) {
    const err = new Error(`workspace mismatch: current=${current} requested=${body.workspace}`);
    err.status = 409;
    err.currentWorkspace = current;
    throw err;
  }
  // Ensure the custom chat command is available in this Trae window.
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(CHAT_COMMAND)) {
    const err = new Error(`command not found: ${CHAT_COMMAND}`);
    err.status = 501;
    throw err;
  }
  // The command sends `query` directly when no editor selection exists.
  // Clear a selection so it does not fall back to "add to chat".
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    try { editor.selection = new vscode.Selection(editor.selection.active, editor.selection.active); } catch { /* ignore */ }
  }
  const rawQuery = buildQuery(body);
  // Plan mode: send Trae's real slash command (`/ Plan`) as a slash-command
  // message, not as text in the prompt. A text-prefixed `/plan` gets split by
  // the chat UI into the input box and never reaches the agent as a command.
  // The host may also prefix the query (older hosts do); strip it here.
  const planMode = body.planMode === true || /^\/plan(?:\s|$)/i.test(rawQuery);
  const query = planMode ? rawQuery.replace(/^\/plan(?:\s+|$)/i, '') : rawQuery;
  const options = {
    query,
    newChat: true,
    keepOpen: true,
  };
  if (planMode) options.slashCommand = { command: 'plan', source: 'builtin' };
  log(`dispatch start workspace=${current} queryChars=${query.length} planMode=${planMode} slashCommand=${planMode}`);
  let outcome = 'done';
  try {
    const commandPromise = vscode.commands.executeCommand(CHAT_COMMAND, options);
    // The chat command can wait for the agent response for minutes; the task is
    // already sent as soon as the command starts. Do not hold the HTTP response
    // that long, or the DSH host times out and reports a false failure.
    commandPromise.catch((err) => {
      log(`dispatch late error workspace=${current}: ${String(err && err.message ? err.message : err)}`);
    });
    outcome = await Promise.race([
      commandPromise.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 2000)),
    ]);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    log(`dispatch error workspace=${current}: ${message}`);
    // Command truly missing / disabled: report a real failure.
    if (/not found|not registered|unknown command|not available/i.test(message)) throw err;
    // Chat service errors often happen after the message was already sent.
    return {
      ok: true,
      workspace: current,
      planMode,
      delivered: 'unknown',
      warning: message,
      at: Date.now(),
    };
  }
  log(`dispatch ok workspace=${current} queryChars=${query.length} planMode=${planMode} slashCommand=${planMode} result=${outcome}`);
  return { ok: true, workspace: current, planMode, pending: outcome === 'pending', at: Date.now() };
}

function createServer(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(async (req, res) => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type, authorization, x-zentao-token',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
          });
          res.end();
          return;
        }
        if (req.method === 'GET' && req.url === '/ping') {
          json(res, 200, { ok: true, workspace: workspacePath(), pid: process.pid });
          return;
        }
        if (req.method === 'POST' && req.url === '/dispatch') {
          if (!authOk(req)) {
            json(res, 401, { ok: false, error: 'unauthorized' });
            return;
          }
          let body;
          try { body = JSON.parse(await readBody(req)); } catch {
            json(res, 400, { ok: false, error: 'invalid json' });
            return;
          }
          try {
            const result = await dispatch(body);
            json(res, 200, result);
          } catch (err) {
            json(res, err.status || 500, {
              ok: false,
              error: err.message || String(err),
              currentWorkspace: err.currentWorkspace,
            });
          }
          return;
        }
        json(res, 404, { ok: false, error: 'not found' });
      } catch (err) {
        log(`request failed: ${err && err.stack ? err.stack : err}`);
        try { json(res, 500, { ok: false, error: String((err && err.message) || err) }); } catch { /* ignore */ }
      }
    });
    s.on('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function start() {
  const base = 38200;
  const workspace = workspacePath();
  const hash = workspace ? workspaceHash(workspace) : 'no-workspace';
  const seed = parseInt(hash.slice(0, 4), 16) || 1;
  token = makeToken();
  for (let i = 0; i < 30; i++) {
    const port = base + ((seed + i) % 600);
    try {
      server = await createServer(port);
      writeRegistry(port);
      log(`bridge listening 127.0.0.1:${port} workspace=${workspace}`);
      return;
    } catch (err) {
      if (err && err.code !== 'EADDRINUSE') log(`listen ${port} failed: ${err.message}`);
    }
  }
  log('bridge failed: no free port');
}

function stop() {
  disposed = true;
  removeRegistry();
  try { server?.close(); } catch { /* ignore */ }
  server = null;
  log('bridge stopped');
}

function activate(context) {
  output = vscode.window.createOutputChannel('ZenTao Bridge');
  log('activating');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('zentaoBridge.ping', () => {
    return { ok: true, workspace: workspacePath(), pid: process.pid };
  }));
  context.subscriptions.push({ dispose: stop });
  start().catch((err) => log(`start failed: ${err && err.stack ? err.stack : err}`));
  log('activated');
}

function deactivate() {
  stop();
}

module.exports = { activate, deactivate };
