#!/usr/bin/env node
// claude-workers MCP server: hands coding tasks to a worker agent and reports back.
// Zero dependencies; MCP over stdio (newline-delimited JSON-RPC 2.0).
//
// Harnesses are configured in ~/.claude-workers/config.json (see "harness registry" below and
// config.example.json): the built-in ones are cursor, deepseek, codex and opencode, and any ACP
// agent can be added by name with its own model. deepseek (over ACP, mcp/acp.mjs), codex (the
// Codex app-server, mcp/codex.mjs) and other ACP agents run in long-lived processes and stream
// what they do: text and tool calls go out as MCP progress notifications while the tool call
// waits, and each report lists the activity since the previous one. worker_usage reads plan usage
// (Codex rate-limit windows and credits from its app-server, Cursor's pools).
//
// engine=auto (the default) picks Cursor while the Cursor plan keeps at least
// CLAUDE_WORKERS_CURSOR_MIN_LEFT percent (30) of the pool its model draws on, DeepSeek otherwise:
// - cursor: the Cursor CLI (`agent -p`, model CLAUDE_WORKERS_CURSOR_MODEL, default auto) in a
//   process of its own, with Cursor's auto-review: safe tool calls run, the rest are refused
//   (headless Cursor cannot ask anyone) and the report lists them under BLOCKED. Quota comes
//   from the CLI's own /usage screen (mcp/cursor-usage.py, a pty), re-read after every Cursor
//   task and at least every 30 minutes; a run that hits the plan limit is handed to DeepSeek.
//   Each run is appended to ~/.cursor/claude-workers/usage-YYYY-MM.jsonl with its tokens and the model
//   Auto actually picked (read from the CLI's chat store), for usage dashboards to read.
// - deepseek: DeepSeek Harness (dsh): over ACP by default (`dsh --profile acp`), or by one of
//   the two older runners (runner=web|headless, or when continuing a session-… id):
//
// The two older dsh runners:
// - web: this machine's running dsh web instance executes the task itself. The session is
//   created in the workspace for `cwd`, so it shows up live in that web UI's sidebar. Login
//   uses the web instance's launch token, re-read on every login, so a restarted instance or
//   an expired cookie just means logging in again.
// - headless: `dsh headless --json` in a process of its own, when no web instance answers (or
//   runner=headless). Its session still shows in the UI, under 未分组, but not live.
//
// Tools: worker_run, worker_wait, worker_approve, worker_cancel, worker_jobs. A task outlives one tool call:
// worker_run returns a job id when its wait runs out, and the job keeps going until it finishes.
// A cancelled tool call (the user interrupting) stops its task.
//
// Web sessions are switched to dsh's Auto review permission preset (`/permission auto`) and to
// the CLAUDE_WORKERS_EFFORT reasoning effort before they get the task. Under Auto a model reviews
// every tool call, and a call it rejects waits for a human approval. This server answers those
// itself: while a web job runs it listens on the web instance's approval stream, and a request
// for one of its sessions makes worker_run / worker_wait return at once with APPROVAL NEEDED, to be
// answered with worker_approve (the web UI can still answer it too). Auto needs the experimental
// auto-review layer enabled in the web profile; headless has no Auto.
//
// Env: CLAUDE_WORKERS_ENGINE (auto | cursor | deepseek), CLAUDE_WORKERS_CURSOR_MODEL (auto),
// CLAUDE_WORKERS_CURSOR_MIN_LEFT (30), CLAUDE_WORKERS_CURSOR_BIN (the agent launcher), CLAUDE_WORKERS_RUNNER (auto |
// web | headless, for DeepSeek), CLAUDE_WORKERS_PERMISSION (preset for web sessions, default auto; empty
// keeps the profile default), CLAUDE_WORKERS_EFFORT (reasoning effort for web sessions, default max;
// empty keeps the session's), DSH_WEB_BASE (http://127.0.0.1:3080), DSH_WEB_TOKEN_FILE (where the
// web launch token is), CLAUDE_WORKERS_DSH_HOME (the ~/.dsh the web instance writes; WSL points it at the
// Windows one), DSH_BIN, DSH_WEB_URL, CLAUDE_WORKERS_DEFAULT_WAIT.
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { AcpAgent } from './acp.mjs';
import { CodexServer, usageLine } from './codex.mjs';

const VERSION = '0.7.0';
// Names from before the rename (DSH_MCP_*, ~/.dsh-mcp, ~/.cursor/dsh-mcp) keep working.
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('DSH_MCP_')) process.env[`CLAUDE_WORKERS_${k.slice(8)}`] ??= v;
const legacyDir = (now, old) => (!fs.existsSync(now) && fs.existsSync(old) ? old : now);
const STATE_DIR = legacyDir(path.join(os.homedir(), '.claude-workers'), path.join(os.homedir(), '.dsh-mcp'));
const CONFIG_FILE = process.env.CLAUDE_WORKERS_CONFIG || path.join(STATE_DIR, 'config.json');
const isWin = process.platform === 'win32';
const isWsl = process.platform === 'linux' && /microsoft/i.test(safeRead('/proc/version'));

const WEB_BASE = (process.env.DSH_WEB_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '');
// Where a person opens dsh sessions: the web instance's address as they reach it (DSH_WEB_URL, or
// "webUi" in the config file), else the local address this server talks to.
const webUi = process.env.DSH_WEB_URL || (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).webUi; } catch { return null; }
})() || WEB_BASE;
const DSH_HOME = process.env.CLAUDE_WORKERS_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PERMISSION = (process.env.CLAUDE_WORKERS_PERMISSION ?? 'auto').trim();
const EFFORT = (process.env.CLAUDE_WORKERS_EFFORT ?? 'max').trim();
const ENGINE = (process.env.CLAUDE_WORKERS_ENGINE || 'auto').trim();
const CURSOR_MODEL = (process.env.CLAUDE_WORKERS_CURSOR_MODEL || 'auto').trim();
const CURSOR_MIN_LEFT = Number(process.env.CLAUDE_WORKERS_CURSOR_MIN_LEFT ?? 30);
const CURSOR_HOME = path.join(os.homedir(), '.cursor');
const CURSOR_STATE = legacyDir(path.join(CURSOR_HOME, 'claude-workers'), path.join(CURSOR_HOME, 'dsh-mcp')); // quota reading + usage log
const HERE = path.dirname(fileURLToPath(import.meta.url));

let defaultWait = Number(process.env.CLAUDE_WORKERS_DEFAULT_WAIT) || 45;
const jobs = new Map();
const inflight = new Map(); // JSON-RPC request id -> job id, so a cancelled call can stop its task
let jobSeq = 0;

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function log(...a) { process.stderr.write('[claude-workers] ' + a.join(' ') + '\n'); }
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function newJob(runner, cwd, task) {
  const job = {
    id: `job-${++jobSeq}`, runner, cwd, task, startedAt: Date.now(), endedAt: null, status: 'running',
    sessionId: null, workspace: null, final: null, lastText: null, errors: [], calls: [], failedCalls: 0,
    written: new Set(), stderr: '', exitCode: null, listeners: new Set(), wake: new Set(),
    permission: null, model: null, approvals: new Map(), approvalLog: [],
    pending: new Map(), // approval-stream eventId -> approval request held for worker_approve
    answered: new Set(), // callIds whose approval worker_approve answered
    callInputs: new Map(), // dsh tool callId -> { tool, input }, to show what an approval is for
    feed: [], feedSeen: 0, // what happened, in order (text lines and tool calls); reports show what is new
    textBuf: '', textTimer: null, msgKey: null, msgText: '',
  };
  jobs.set(job.id, job);
  return job;
}
// One line of activity: kept for the next report and pushed to the waiting tool call as progress.
function emit(job, line) {
  job.feed.push(line);
  if (job.feed.length > 400) { const cut = job.feed.length - 400; job.feed.splice(0, cut); job.feedSeen = Math.max(0, job.feedSeen - cut); }
  for (const fn of job.listeners) fn(line);
}
// Streamed assistant text. `key` names the message it belongs to: the last message is the final
// one. Whole lines go out at once, a partial line after a second without a newline.
function streamText(job, text, key) {
  if (!text) return;
  if (key !== job.msgKey) { flushText(job); job.msgKey = key; job.msgText = ''; }
  job.msgText += text; job.lastText = job.msgText.trim() || job.lastText;
  job.textBuf += text;
  const nl = job.textBuf.lastIndexOf('\n');
  if (nl >= 0) {
    for (const l of job.textBuf.slice(0, nl).split('\n')) if (l.trim()) emit(job, `» ${l.trimEnd()}`);
    job.textBuf = job.textBuf.slice(nl + 1);
  }
  clearTimeout(job.textTimer);
  if (job.textBuf) job.textTimer = setTimeout(() => flushText(job), 1000);
}
function flushText(job) {
  clearTimeout(job.textTimer);
  if (job.textBuf.trim()) emit(job, `» ${job.textBuf.trimEnd()}`);
  job.textBuf = '';
}
function finish(job, status, error) {
  if (job.status !== 'running') return;
  job.status = status; job.endedAt = Date.now();
  if (error) job.errors.push(error);
  setTimeout(closeEventsIfIdle, 5000);
}
function noteCall(job, tool, input, callId) {
  const line = brief(tool, input);
  job.calls.push(line);
  if (callId) {
    // Only what brief() shows: a write's content can be large.
    const { file_path, path: p, command, url, pattern, queries, name } = input ?? {};
    job.callInputs.set(callId, { tool, input: { file_path, path: p, command, url, pattern, queries, name } });
  }
  const target = input?.file_path ?? (job.runner === 'cursor' ? input?.path : undefined);
  if (['write', 'edit', 'multi_edit', 'apply_patch', 'delete'].includes(tool) && target) job.written.add(target);
  flushText(job);
  job.msgKey = null; // text after a tool call is a new message
  emit(job, `· ${line}`);
}
function brief(tool, input = {}, max = 90) {
  const v = input.file_path || input.path || input.command || input.url || input.pattern
    || (Array.isArray(input.queries) ? input.queries.join(' | ') : '') || input.name || '';
  const s = String(v).replace(/\s+/g, ' ');
  return s ? `${tool}: ${s.length > max ? s.slice(0, max - 3) + '...' : s}` : tool;
}

function checkCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return 'cwd must be an absolute path to the project directory';
  let st; try { st = fs.statSync(cwd); } catch { return `cwd does not exist: ${cwd}`; }
  if (!st.isDirectory()) return `cwd is not a directory: ${cwd}`;
  return null;
}
// What keeps dsh (DeepSeek) itself from working in cwd; Cursor runs natively everywhere.
function dshCwdProblem(cwd) {
  if (isWin && cwd.length >= 248) return `cwd is ${cwd.length} characters; Windows cannot start dsh in a directory path of 248+ characters. Use a shorter path.`;
  if (isWsl && !cwd.startsWith('/mnt/')) return 'On WSL, dsh runs as the Windows DeepSeek Harness and cannot write inside the WSL filesystem (\\\\wsl.localhost paths). Use a project under /mnt/c, or run the task on a host with a native dsh.';
  return null;
}
// The web instance on WSL's host is a Windows process: give it Windows paths.
function toHostPath(p) {
  if (!isWsl) return p;
  try { return execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim(); } catch { return p; }
}

// ---------------------------------------------------------------- web runner
let webCookie = null, webCheckedAt = 0, webOk = false, rpcSeq = 0;

function webTokenFile() {
  if (process.env.DSH_WEB_TOKEN_FILE) return process.env.DSH_WEB_TOKEN_FILE;
  if (isWin) return path.join(process.env.LOCALAPPDATA || '', 'DeepSeekHarnessWeb', 'logs', 'harness.stdout.log');
  return path.join(os.homedir(), '.config', 'dsh-web', 'token');
}
// The launch token is printed by `dsh web` ("...?token=<t>") or kept alone in a 0600 file.
function readWebToken() {
  const s = safeRead(webTokenFile()).trim();
  const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(s) || /^([A-Za-z0-9_-]{16,})$/.exec(s);
  return m ? m[1] : null;
}
async function webLogin() {
  const token = readWebToken();
  if (!token) throw new Error(`no web launch token in ${webTokenFile()}`);
  const res = await fetch(`${WEB_BASE}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('dsh-auth-')) throw new Error(`web login refused (HTTP ${res.status}); the launch token may be stale`);
  webCookie = cookie;
}
async function webCall(method, args, retried = false) {
  if (!webCookie) await webLogin();
  const res = await fetch(`${WEB_BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie: webCookie, origin: WEB_BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `mcp-${++rpcSeq}`, method, payload: { args } }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 && !retried) { webCookie = null; return webCall(method, args, true); }
  const j = await res.json().catch(() => null);
  if (!j?.result?.ok) throw new Error(`${method}: ${j?.result?.error?.message ?? 'HTTP ' + res.status}`);
  return j.result.value;
}
async function webAvailable() {
  if (Date.now() - webCheckedAt < 30000) return webOk;
  webCheckedAt = Date.now();
  if (typeof zlib.zstdDecompressSync !== 'function') { webOk = false; log('this Node has no zstd; web runner disabled'); return false; }
  try { await webCall('session/list', { _request: {} }); webOk = true; }
  catch (e) { webOk = false; log('web instance unavailable:', e.message); }
  return webOk;
}

// dsh session logs are concatenated zstd frames (or plain JSONL). Node decodes only one frame
// per call and returns a truncated frame's partial output without an error, so frames are
// delimited from their own headers: a frame the writer is still appending is left for later.
// Returns the decoded text and how many bytes of complete frames it used.
function zstdFrameLength(buf, at) {
  if (buf.length < at + 8) return 0;
  const magic = buf.readUInt32LE(at);
  if ((magic & 0xfffffff0) === 0x184d2a50) { const n = 8 + buf.readUInt32LE(at + 4); return at + n <= buf.length ? n : 0; } // skippable
  if (magic !== 0xfd2fb528) return -1;
  const fhd = buf[at + 4], single = (fhd >> 5) & 1;
  let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [single, 2, 4, 8][fhd >> 6];
  for (let last = 0; !last;) {
    if (p + 3 > buf.length) return 0;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    last = h & 1;
    p += 3 + (((h >> 1) & 3) === 1 ? 1 : h >>> 3); // an RLE block stores one byte
  }
  if ((fhd >> 2) & 1) p += 4; // content checksum
  return p <= buf.length ? p - at : 0;
}
function decodeLog(buf) {
  let text = '', used = 0;
  for (let n; used < buf.length && (n = zstdFrameLength(buf, used)) > 0; used += n) {
    if (buf.readUInt32LE(used) === 0xfd2fb528) text += zlib.zstdDecompressSync(buf.subarray(used, used + n)).toString('utf8');
  }
  return { text, used };
}
// Records from byte offset `from` on, and the offset to continue from next time: polling a
// long session must not decompress its whole log every two seconds.
function readRecords(file, from = 0) {
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.max(0, fs.fstatSync(fd).size - from));
    fs.readSync(fd, buf, 0, buf.length, from);
  } finally { fs.closeSync(fd); }
  let text, used;
  if (file.endsWith('.zstd')) ({ text, used } = decodeLog(buf));
  else { used = buf.lastIndexOf(0x0a) + 1; text = buf.subarray(0, used).toString('utf8'); }
  const records = [];
  for (const line of text.split('\n')) { if (line.trim()) try { records.push(JSON.parse(line)); } catch {} }
  return { records, next: from + used };
}
function catchUp(job) {
  job.logFile ??= findSessionLog(job.sessionId);
  if (!job.logFile) return;
  const { records, next } = readRecords(job.logFile, job.logPos);
  job.logPos = next;
  ingest(job, records);
}
function findSessionLog(sessionId) {
  const root = path.join(DSH_HOME, 'sessions');
  for (const project of safeReaddir(root)) {
    const dir = path.join(root, project, sessionId);
    const f = safeReaddir(dir).filter((n) => /^session.*\.jsonl(\.zstd)?$/.test(n)).sort().pop();
    if (f) return path.join(dir, f);
  }
  return null;
}
const parsed = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

function ingest(job, records) {
  for (const r of records) {
    if (typeof r.seq !== 'number' || r.seq <= job.lastSeq) continue;
    job.lastSeq = r.seq;
    if (r.seq <= job.baseSeq) continue;
    const d = r.data || {};
    if (r.type === 'job/registered' && d.jobId) job.liveJobs.add(d.jobId);
    else if (r.type === 'job/settled' && d.jobId) job.liveJobs.delete(d.jobId);
    else if (r.type === 'turn/start') job.lastTurnStartSeq = r.seq;
    if (r.type === 'tool/call') noteCall(job, d.name, parsed(d.arguments) || {}, d.callId);
    else if (r.type === 'tool/result' && d.message?.isError) job.failedCalls++;
    else if (r.type === 'approval/asked') {
      job.approvals.set(d.id, d);
      if (!viaStream(job, d)) for (const fn of job.listeners) fn(`waiting for approval in ${webUi}: ${d.toolName}${d.reason ? ` (${d.reason})` : ''}`);
    } else if (r.type === 'approval/decided') {
      const asked = job.approvals.get(d.id);
      job.approvals.delete(d.id);
      const by = asked?.callId && job.answered.has(asked.callId) ? ' by worker_approve' : '';
      job.approvalLog.push(`${d.outcome}${by}: ${asked ? describeApproval(job, asked) : d.id}${asked?.reason ? `\n      reviewer: ${asked.reason}` : ''}`);
    }
    else if (r.type === 'assistant/message') {
      const text = (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) { job.lastText = text; for (const l of text.split('\n')) if (l.trim()) emit(job, `» ${l.trimEnd()}`); }
    } else if (r.type === 'turn/end') {
      const kind = d.reason?.kind ?? 'unknown';
      job.final = job.lastText;
      finish(job, kind === 'completed' ? 'completed' : 'failed', kind === 'completed' ? null : `turn ended: ${kind}`);
    }
  }
}

async function startWebJob({ task, cwd, session_id }) {
  const job = newJob('web', cwd, task);
  job.lastSeq = -1; job.baseSeq = -1; job.liveJobs = new Set(); job.lastTurnStartSeq = -1; job.logPos = 0;
  try {
    const { workspace } = await webCall('workspace/create', { request: { path: toHostPath(cwd) } });
    job.workspace = workspace.title || workspace.path;
    job.sessionId = session_id || (await webCall('session/create', { request: { workspaceId: workspace.workspaceId } })).sessionId;
    ensureEvents();
    job.permission = await setPermission(job.sessionId);
    job.model = await setEffort(job.sessionId);
    const prior = findSessionLog(job.sessionId);
    if (prior) {
      const { records } = readRecords(prior);
      for (const r of records) if (typeof r.seq === 'number') job.baseSeq = Math.max(job.baseSeq, r.seq);
    }
    await webCall('session/prompt', { request: { requestId: crypto.randomUUID(), sessionId: job.sessionId, mode: 'queue', content: [{ type: 'text', text: task }] } });
    job.promptedAt = Date.now();
    pollWebJob(job);
  } catch (e) { finish(job, 'failed', `web runner: ${e.message}`); }
  return job;
}
// Switch a session to the PERMISSION preset the way the web UI's /permission picker does.
// Works on cold sessions too; reports what the session actually runs under.
async function setPermission(sessionId) {
  if (!PERMISSION) return 'profile default (CLAUDE_WORKERS_PERMISSION is empty)';
  try {
    const v = await webCall('commands/execute', { agentId: sessionId, line: `/permission ${PERMISSION}`, submittedAttachments: [] });
    if (v?.result?.kind === 'success') return PERMISSION === 'auto' ? 'Auto review (the model reviews each tool call; a call it rejects waits for your approval in the web UI)' : PERMISSION;
    return `profile default: /permission ${PERMISSION} gave ${v?.result?.kind ?? 'no result'}${v?.result?.text ? `: ${v.result.text}` : ''}`;
  } catch (e) {
    return `profile default: /permission ${PERMISSION} failed (${e.message}); is the auto-review layer enabled in this web profile?`;
  }
}
// Give the session EFFORT on the model it already uses, the way the composer's model picker
// does (session/selectModel). A fresh session has no selection yet and takes the profile
// default; a model that does not offer EFFORT keeps its own setting.
async function setEffort(sessionId) {
  try {
    const it = (await webCall('session/list', { _request: {} })).items.find((x) => x.sessionId === sessionId);
    const ms = it?.projections?.values?.modelSelection;
    const sel = ms?.next ?? ms?.lastUsed ?? (await webCall('session/modelCatalog', {})).default;
    if (!sel?.provider) return 'profile default';
    const route = `${sel.provider}/${sel.model}`;
    if (!EFFORT || sel.reasoningEffort === EFFORT) return `${route}, reasoning ${sel.reasoningEffort ?? 'model default'}`;
    const v = await webCall('session/selectModel', { request: { sessionId, provider: sel.provider, model: sel.model, reasoningEffort: EFFORT } });
    return `${route}, reasoning ${v?.selected?.reasoningEffort ?? EFFORT}`;
  } catch (e) {
    return `unchanged (reasoning ${EFFORT} not applied: ${e.message})`;
  }
}

// ---------------------------------------------------------------- approval stream
// dsh asks for a human approval through the web instance's Remote event stream: `$events` on
// the /api/remote.mux WebSocket carries an Agent-scoped `approval/request` waterfall to every
// answering client (the login cookie makes this server one, like a browser tab), and the first
// `$events/result` answer settles it; the others get a `cancel`. While web jobs run, this keeps
// the stream open. Requests for their sessions are held for worker_approve; anything else is
// answered `next`, as the web client does for sessions it does not handle, so the other
// clients decide. Pending requests are replayed to a client that (re)connects.
const events = { ws: null, clientId: null, gen: 0, retry: null };
const runningWebJobs = () => [...jobs.values()].filter((j) => j.runner === 'web' && j.status === 'running');

async function ensureEvents() {
  if (events.ws || events.retry || typeof WebSocket !== 'function' || !runningWebJobs().length) return;
  const stream = `claude-workers-${++events.gen}`;
  let ws;
  try {
    if (!webCookie) await webLogin();
    ws = new WebSocket(WEB_BASE.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie: webCookie } });
  } catch (e) { return retryEvents(e.message); }
  events.ws = ws; events.clientId = null;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'open', streamId: stream, endpoint: '$events', payload: { args: {} } }));
  ws.onmessage = ({ data }) => {
    let f; try { f = JSON.parse(String(data)); } catch { return; }
    if (f.streamId === stream) onEvent(ws, f).catch((e) => log('approval stream:', e.message));
  };
  ws.onerror = () => {};
  ws.onclose = (e) => {
    if (events.ws !== ws) return;
    events.ws = null; events.clientId = null;
    retryEvents(`closed (${e.code})`);
  };
}
function retryEvents(why) {
  if (events.retry || !runningWebJobs().length) return;
  log(`approval stream ${why}; reconnecting`);
  webCookie = null; // a refused upgrade is usually a stale cookie
  events.retry = setTimeout(() => { events.retry = null; ensureEvents(); }, 3000);
}
function closeEventsIfIdle() {
  if (runningWebJobs().length) return;
  clearTimeout(events.retry); events.retry = null;
  const ws = events.ws; events.ws = null; events.clientId = null;
  ws?.close();
}
async function onEvent(ws, f) {
  if (f.type !== 'item') { ws.close(); return; } // end | error: this stream generation is over
  const v = f.value ?? {};
  if (!events.clientId) { if (v.type === 'ready') events.clientId = v.clientId; else ws.close(); return; }
  if (v.type === 'cancel') {
    for (const job of jobs.values()) if (job.pending.delete(v.eventId)) for (const fn of job.wake) fn();
    return;
  }
  if (v.type !== 'waterfall') return;
  const job = v.event === 'approval/request' && runningWebJobs().find((j) => j.sessionId === v.agentId);
  if (!job) { await answerEvent(v.eventId, { kind: 'next' }); return; }
  if (job.pending.has(v.eventId)) return; // replayed after a reconnect
  try { catchUp(job); } catch {} // the tool call it is about
  const r = v.request ?? {};
  const a = { id: v.eventId, toolName: r.toolName, callId: r.callId, reason: r.reason ?? r.displayReason?.en, reported: false };
  job.pending.set(a.id, a);
  for (const fn of job.listeners) fn(`APPROVAL NEEDED: ${describeApproval(job, a)}`);
  for (const fn of job.wake) fn();
}
function answerEvent(eventId, outcome) {
  if (!events.clientId) throw new Error('the approval stream is not connected');
  return webCall('$events/result', { clientId: events.clientId, eventId, outcome });
}
// Whether a logged approval/asked is one the stream delivered (held now, or answered already).
function viaStream(job, asked) {
  if (!asked.callId) return false;
  return job.answered.has(asked.callId) || [...job.pending.values()].some((p) => p.callId === asked.callId);
}
function describeApproval(job, a) {
  const call = a.callId && job.callInputs.get(a.callId);
  return call ? brief(call.tool, call.input, 600) : (a.toolName ?? 'a tool call');
}

function pollWebJob(job) {
  let sawRunning = false, idle = 0, errors = 0;
  const tick = async () => {
    if (job.status !== 'running') return;
    try {
      catchUp(job);
      if (job.status === 'running') {
        const it = (await webCall('session/list', { _request: {} })).items.find((x) => x.sessionId === job.sessionId);
        ensureEvents();
        if (it?.running || job.approvals.size || job.pending.size) { sawRunning = true; idle = 0; }
        else if ((sawRunning || Date.now() - job.promptedAt > 20000) && ++idle >= 3) {
          catchUp(job); // the end of turn may land just after the flag drops
          finish(job, 'failed', 'the web instance shows the session idle but logged no end of turn (stopped, or waiting for something in the UI)');
        }
      }
      errors = 0;
    } catch (e) {
      if (++errors >= 15) finish(job, 'failed', `lost the web instance: ${e.message}`);
    }
    if (job.status === 'running') job.timer = setTimeout(tick, 2000);
  };
  job.timer = setTimeout(tick, 1500);
}

// ---------------------------------------------------------------- headless runner
function dshCommand() {
  if (process.env.DSH_BIN) return { cmd: process.env.DSH_BIN, pre: [], env: {} };
  if (isWin) {
    // Run the desktop install's Electron as Node directly: no cmd.exe quoting of the task.
    const app = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
    const cli = path.join(app, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    return { cmd: path.join(app, 'DeepSeek Harness.exe'), pre: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'dsh');
  if (fs.existsSync(local)) return { cmd: local, pre: [], env: {} };
  const mac = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  if (fs.existsSync(mac)) return { cmd: mac, pre: [], env: {} };
  return { cmd: 'dsh', pre: [], env: {} };
}

function startHeadlessJob({ task, cwd, session_id }) {
  const job = newJob('headless', cwd, task);
  const { cmd, pre, env } = dshCommand();
  const args = [...pre, 'headless', '--json', ...(session_id ? ['--session-id', session_id] : []), task];
  let child;
  try {
    child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) { finish(job, 'failed', `could not start dsh (${cmd}): ${err.message}`); return job; }
  job.child = child;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let e; try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'session') job.sessionId = e.sessionId;
    else if (e.type === 'tool_call') noteCall(job, e.tool, e.input);
    else if (e.type === 'tool_result' && e.status && e.status !== 'completed') job.failedCalls++;
    else if (e.type === 'final') job.final = e.text;
    else if (e.type === 'error') job.errors.push(e.message || JSON.stringify(e));
  });
  child.stderr.on('data', (d) => { job.stderr = (job.stderr + d).slice(-4000); });
  child.on('error', (err) => {
    job.errors.push(`dsh failed to start (${cmd}): ${err.message}`);
    if (!child.pid) { job.child = null; finish(job, 'failed'); } // 'close' may never come
  });
  child.on('close', (code, signal) => {
    job.exitCode = code; job.child = null;
    if (code !== 0) finish(job, 'failed', `dsh exited with ${code ?? signal}`);
    else if (job.final == null) finish(job, 'failed', 'dsh exited without a final message: treat the task as unfinished');
    else finish(job, 'completed');
  });
  return job;
}

// ---------------------------------------------------------------- cursor runner
// The Cursor CLI launcher. On Windows its .cmd/.ps1 shims only start the newest version's
// bundled node.exe with index.js, so that is started directly: no cmd.exe quoting of the task.
const cursorVersionKey = (name) => Number(name.split('-')[0].split('.').map((p) => p.padStart(2, '0')).join(''));
function cursorCommand() {
  if (process.env.CLAUDE_WORKERS_CURSOR_BIN) return { cmd: process.env.CLAUDE_WORKERS_CURSOR_BIN, pre: [], env: {}, probe: process.env.CLAUDE_WORKERS_CURSOR_BIN };
  if (isWin) {
    const home = path.join(process.env.LOCALAPPDATA || '', 'cursor-agent');
    const v = safeReaddir(path.join(home, 'versions'))
      .filter((n) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(n))
      .sort((a, b) => cursorVersionKey(b) - cursorVersionKey(a))[0];
    if (!v) return null;
    const dir = path.join(home, 'versions', v);
    return {
      cmd: path.join(dir, 'node.exe'), pre: [path.join(dir, 'index.js')], probe: path.join(home, 'agent.cmd'),
      env: { CURSOR_INVOKED_AS: 'agent', NODE_COMPILE_CACHE: path.join(process.env.LOCALAPPDATA || '', 'cursor-compile-cache') },
    };
  }
  for (const p of ['agent', 'cursor-agent'].map((n) => path.join(os.homedir(), '.local', 'bin', n))) {
    if (fs.existsSync(p)) return { cmd: p, pre: [], env: {}, probe: p };
  }
  return null;
}

// Cursor installs the account's plugins on every start, by `git fetch` from SSH GitHub URLs.
// With no GitHub key that hangs (or, behind an SSH agent with a hardware key, asks for a touch
// on every try), so its runs get a global git config of their own: the user's, plus GitHub
// SSH URLs rewritten to HTTPS (the plugin repos are public). Cursor sets GIT_CONFIG_COUNT for
// its git calls itself, but leaves GIT_CONFIG_GLOBAL alone.
function cursorGitConfig() {
  const file = path.join(CURSOR_STATE, 'gitconfig');
  const body = '# Git config for Cursor CLI runs started by the claude-workers MCP server (GIT_CONFIG_GLOBAL).\n'
    + '# Cursor installs the account\'s plugins from SSH GitHub URLs; they are public, so HTTPS needs no key.\n'
    + '[include]\n\tpath = ~/.gitconfig\n[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n\tinsteadOf = ssh://git@github.com/\n';
  try {
    if (safeRead(file) !== body) { fs.mkdirSync(CURSOR_STATE, { recursive: true }); fs.writeFileSync(file, body); }
  } catch (e) { log('could not write', file, e.message); }
  return file;
}

let cursorLogin = null; // { ok, at }: `agent status` takes seconds, so it is asked once in a while
function cursorLoggedIn() {
  if (cursorLogin && Date.now() - cursorLogin.at < 30 * 60e3) return Promise.resolve(cursorLogin.ok);
  const c = cursorCommand();
  if (!c) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(c.cmd, [...c.pre, 'status'], { env: { ...process.env, ...c.env }, timeout: 60000, windowsHide: true }, (err, stdout) => {
      const ok = /logged in as/i.test(String(stdout)) && !/not logged in/i.test(String(stdout));
      cursorLogin = { ok, at: Date.now() };
      resolve(ok);
    });
  });
}

// Plan usage, as the CLI's /usage screen shows it: percentages used of the included pools.
// The reading is shared by every MCP server on this machine through QUOTA_FILE.
const QUOTA_FILE = path.join(CURSOR_STATE, 'quota.json');
let quotaProbe = null;
function readQuota() { try { return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')); } catch { return null; } }
function probeQuota() {
  if (quotaProbe) return quotaProbe;
  const c = cursorCommand();
  const script = path.join(HERE, 'cursor-usage.py');
  // Windows has no pty for Python, so the probe runs in WSL and starts the Windows agent.cmd.
  const git = ['--gitconfig', cursorGitConfig()];
  const [cmd, args] = isWin
    ? ['wsl.exe', ['-e', 'python3', script.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, '/'), '--json', ...git, c?.probe ?? '']]
    : ['python3', [script, '--json', ...git, c?.probe ?? '']];
  quotaProbe = new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120000, windowsHide: true }, (err, stdout) => {
      let q = null;
      try { q = JSON.parse(String(stdout).trim().split('\n').pop()); } catch {}
      if (!q || (q.included == null && q.auto == null)) q = { error: q?.error || err?.message || 'the /usage screen gave no figures' };
      q.checkedAt = Date.now();
      try { fs.mkdirSync(CURSOR_STATE, { recursive: true }); fs.writeFileSync(QUOTA_FILE, JSON.stringify(q)); } catch {}
      quotaProbe = null;
      resolve(q);
    });
  });
  return quotaProbe;
}
// Percent left of the pool a model draws on: Auto has its own pool, named models use API.
function quotaLeft(q, model) {
  if (!q || q.error) return null;
  const pool = model === 'auto' ? q.auto : q.api;
  return Math.round((100 - Math.max(q.included ?? 0, pool ?? 0)) * 10) / 10;
}
function quotaLine(q, model) {
  if (!q) return 'not read yet';
  if (q.error) return `unknown (${q.error})`;
  const at = new Date(q.checkedAt).toTimeString().slice(0, 5);
  return `${model === 'auto' ? 'Auto' : 'API'} pool ${quotaLeft(q, model)}% left (included ${q.included}% used, Auto ${q.auto}%, API ${q.api}%; on-demand ${q.on_demand ?? '?'}; resets ${q.resets ?? '?'}; read ${at})`;
}
// Why Cursor should not take a task now, or null when it can.
async function cursorUnavailable(model) {
  if (!cursorCommand()) return 'the Cursor CLI is not installed on this host';
  if (!(await cursorLoggedIn())) return 'the Cursor CLI is not logged in here (run `agent login`)';
  let q = quotaProbe ? await quotaProbe : readQuota();
  if (!q || q.error || q.stale || Date.now() - q.checkedAt > 30 * 60e3) q = await probeQuota();
  const left = quotaLeft(q, model);
  if (left === null) return `the Cursor quota could not be read (${q.error})`;
  if (left < CURSOR_MIN_LEFT) return `Cursor's ${model === 'auto' ? 'Auto' : 'API'} pool has ${left}% left (below ${CURSOR_MIN_LEFT}%)`;
  return null;
}

// The model Auto picked is not in the CLI's output, but the chat store records it.
function cursorActualModel(chatId) {
  if (!chatId) return null;
  for (const hash of safeReaddir(path.join(CURSOR_HOME, 'chats'))) {
    const dir = path.join(CURSOR_HOME, 'chats', hash, chatId);
    const files = ['store.db', 'store.db-wal'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
    if (!files.length) continue;
    const text = files.map((f) => fs.readFileSync(f).toString('latin1')).join('\n');
    const names = [...text.matchAll(/"modelName":"([A-Za-z0-9._\-[\]=,]{2,80})"/g)].map((m) => m[1]);
    return names.at(-1) ?? null;
  }
  return null;
}

const CURSOR_TOOL = { shell: 'bash', read: 'read', edit: 'edit', write: 'write', delete: 'delete', grep: 'grep', glob: 'glob', ls: 'ls' };
function cursorToolCall(e) {
  const kind = Object.keys(e.tool_call || {}).find((k) => k.endsWith('ToolCall'));
  if (!kind) return null;
  const short = kind.replace(/ToolCall$/, '');
  return { tool: CURSOR_TOOL[short] ?? short, call: e.tool_call[kind] };
}
const QUOTA_ERROR = /usage limit|limit reached|quota|out of (fast )?requests|exceeded your|upgrade (your )?plan|insufficient (credits|balance)|spend limit/i;

function startCursorJob({ task, cwd, session_id }, model, why) {
  const job = newJob('cursor', cwd, task);
  Object.assign(job, { cursorModel: model, routing: why, blocked: [], usage: null, requestId: null });
  const c = cursorCommand();
  const args = [...c.pre, '-p', '--output-format', 'stream-json', '--trust', '--auto-review', '--model', model,
    '--workspace', cwd, ...(session_id ? ['--resume', session_id] : []), task];
  let child;
  try {
    child = spawn(c.cmd, args, {
      cwd, env: { ...process.env, ...c.env, GIT_CONFIG_GLOBAL: cursorGitConfig() }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (err) { finish(job, 'failed', `could not start the Cursor CLI (${c.cmd}): ${err.message}`); return job; }
  job.child = child;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let e; try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'system' && e.subtype === 'init') job.sessionId = e.session_id;
    else if (e.type === 'tool_call') {
      const t = cursorToolCall(e);
      if (!t) return;
      if (e.subtype === 'started') noteCall(job, t.tool, t.call.args || {});
      else if (e.subtype === 'completed') {
        const r = t.call.result || {};
        if (r.rejected) {
          job.failedCalls++;
          const line = brief(t.tool, { ...t.call.args, command: r.rejected.command ?? t.call.args?.command }, 400) + (r.rejected.reason ? ` (${r.rejected.reason})` : '');
          job.blocked.push(line);
          for (const fn of job.listeners) fn(`BLOCKED by Cursor auto-review: ${line}`);
        } else if (r.error || r.failure) job.failedCalls++;
      }
    } else if (e.type === 'assistant' && !e.subtype) {
      const text = (e.message?.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
      if (text) { job.lastText = text; for (const l of text.split('\n')) if (l.trim()) emit(job, `» ${l.trimEnd()}`); }
    } else if (e.type === 'result') {
      job.usage = e.usage ?? null; job.requestId = e.request_id ?? null;
      if (e.is_error) job.errors.push(`Cursor: ${String(e.result ?? e.subtype).slice(0, 500)}`);
      else job.final = job.lastText ?? e.result ?? null;
    }
  });
  child.stderr.on('data', (d) => { job.stderr = (job.stderr + d).slice(-4000); });
  child.on('error', (err) => {
    job.errors.push(`the Cursor CLI failed to start (${c.cmd}): ${err.message}`);
    if (!child.pid) { job.child = null; finish(job, 'failed'); }
  });
  child.on('close', (code, signal) => {
    job.exitCode = code; job.child = null;
    if (code !== 0) finish(job, 'failed', `the Cursor CLI exited with ${code ?? signal}`);
    else if (job.final == null) finish(job, 'failed', 'Cursor ended without a final message: treat the task as unfinished');
    else finish(job, 'completed');
    afterCursorJob(job);
  });
  return job;
}

// After every Cursor task: record its usage and read the quota again.
function afterCursorJob(job) {
  job.quotaExhausted = job.status === 'failed' && QUOTA_ERROR.test([job.stderr, ...job.errors].join('\n'));
  job.actualModel = cursorActualModel(job.sessionId);
  if (job.usage) {
    const u = job.usage, at = new Date(job.endedAt);
    const rec = {
      ts: job.endedAt, host: os.hostname(), session_id: job.sessionId, request_id: job.requestId, model_requested: job.cursorModel,
      model: job.actualModel || job.cursorModel, input: u.inputTokens ?? 0, output: u.outputTokens ?? 0,
      cache_read: u.cacheReadTokens ?? 0, cache_write: u.cacheWriteTokens ?? 0, duration_ms: job.endedAt - job.startedAt,
      status: job.status, cwd: job.cwd,
    };
    try {
      fs.mkdirSync(CURSOR_STATE, { recursive: true });
      fs.appendFileSync(path.join(CURSOR_STATE, `usage-${at.toISOString().slice(0, 7)}.jsonl`), JSON.stringify(rec) + '\n');
    } catch (e) { log('could not write the Cursor usage log:', e.message); }
  }
  if (job.quotaExhausted) {
    try { fs.mkdirSync(CURSOR_STATE, { recursive: true }); fs.writeFileSync(QUOTA_FILE, JSON.stringify({ ...(readQuota() ?? {}), auto: 100, api: 100, included: 100, error: undefined, checkedAt: Date.now(), exhausted: true })); } catch {}
  } else {
    probeQuota().then((q) => { job.quotaAfter = q; });
  }
}

// ---------------------------------------------------------------- harness registry
// Which harnesses exist and which model each one uses is configuration, not code:
// ~/.claude-workers/config.json (or CLAUDE_WORKERS_CONFIG), re-read when it changes.
//   { "default": "auto", "webUi": "https://my-host.example/",
//     "harnesses": {
//       "deepseek": { "runner": "acp", "model": "soclaas/x-test-2", "effort": "max" },
//       "codex":    { "model": "gpt-5.5", "effort": "high", "sandbox": "workspace-write", "approval": "on-request" },
//       "opencode": { "model": "soclaas/x-test-2" },
//       "mine":     { "type": "acp", "command": "some-agent", "args": ["acp"], "env": {}, "model": "...", "options": {} },
//       "cursor":   { "disabled": true } } }
// "approvals" per harness says who decides a tool call that needs approval: "claude" (it comes
// back as APPROVAL NEEDED for worker_approve) or "self" (the harness's own reviewer model). Only
// harnesses that have a reviewer can be "self": Codex (auto-review) and dsh's web runner (Auto
// review); everything else always asks Claude. Default: "self" for Codex on a ChatGPT
// subscription login, "claude" for the rest.
// A harness with no "model" uses whatever model the harness itself defaults to.
// Types: dsh (DeepSeek Harness: acp | web | headless runners), acp (any ACP agent on stdio),
// codex (the Codex app-server), cursor (the Cursor CLI). The four built-ins below need no entry.
let configCache = { mtime: -1, value: {} };
function loadConfig() {
  let mtime = 0; try { mtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch {}
  if (mtime !== configCache.mtime) {
    let value = {};
    if (mtime) try { value = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { log(`ignoring ${CONFIG_FILE}: ${e.message}`); }
    configCache = { mtime, value: value && typeof value === 'object' ? value : {} };
  }
  return configCache.value;
}
function harnesses() {
  const user = loadConfig().harnesses ?? {};
  const base = {
    cursor: { type: 'cursor', model: CURSOR_MODEL },
    deepseek: { type: 'dsh', runner: process.env.CLAUDE_WORKERS_RUNNER || 'auto', model: process.env.CLAUDE_WORKERS_MODEL || undefined, effort: EFFORT },
    codex: { type: 'codex' },
    opencode: { type: 'acp', command: 'opencode', args: ['acp'] },
  };
  const out = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(user)])) {
    const h = { ...(base[name] ?? {}), ...(user[name] ?? {}) };
    if (h.disabled) continue;
    h.type ??= 'acp';
    out[name] = h;
  }
  return out;
}
function onPath(name) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of isWin ? ['.exe', '.cmd', '.bat'] : ['']) {
      const p = path.join(dir, name + ext);
      try { if (dir && fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}
// How to start a harness's process, or null when it is not installed here. On Windows an npm
// shim (.cmd) is bypassed for the tools we know, so no cmd.exe sits between us and the agent.
function launchSpec(h) {
  const env = h.env ?? {};
  if (h.type === 'dsh') { const c = dshCommand(); return { cmd: c.cmd, args: [...c.pre, '--profile', 'acp'], env: { ...c.env, ...env } }; }
  const npm = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  const command = h.command ?? (h.type === 'codex' ? 'codex' : null);
  if (!command) return null;
  const args = h.args ?? [];
  if (isWin && command === 'codex') {
    const js = path.join(npm, '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return { cmd: process.execPath, args: [js, ...args], env };
  }
  if (isWin && command === 'opencode') {
    const exe = path.join(npm, 'opencode-ai', 'bin', 'opencode.exe');
    if (fs.existsSync(exe)) return { cmd: exe, args, env: opencodeEnv(h, env) };
  }
  const p = onPath(command);
  if (!p) return null;
  if (command === 'opencode') return { cmd: p, args, env: opencodeEnv(h, env), shell: isWin && /.(cmd|bat)$/i.test(p) };
  return { cmd: p, args, env, shell: isWin && /\.(cmd|bat)$/i.test(p) };
}
// OpenCode has no sandbox and no reviewer model, and by default runs every tool unasked. So that
// Claude gets to decide, its shell commands (bar read-only ones) and anything outside the project
// ask for permission; edits inside the project run. "permission" in the harness entry replaces this.
const OPENCODE_PERMISSION = {
  edit: 'allow', external_directory: 'ask', webfetch: 'allow',
  bash: Object.fromEntries([['*', 'ask'], ...['ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'which', 'echo', 'git status', 'git diff', 'git log', 'git show', 'git branch', 'Get-ChildItem', 'Get-Content', 'Select-String', 'Get-Location', 'Test-Path']
    .flatMap((c) => [[c, 'allow'], [`${c} *`, 'allow']])]),
};
function opencodeEnv(h, env) {
  if (env.OPENCODE_PERMISSION) return env;
  return { ...env, OPENCODE_PERMISSION: JSON.stringify(h.permission ?? OPENCODE_PERMISSION) };
}
function harnessMissing(h) {
  if (h.type === 'cursor') return cursorCommand() ? null : 'the Cursor CLI is not installed on this host';
  if (h.type === 'dsh') return null;
  return launchSpec(h) ? null : `\`${h.command ?? 'codex'}\` is not installed on this host`;
}

// Which harness owns a session id, so worker_run(session_id) continues on it after a restart too.
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
function readSessions() { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; } }
function rememberSession(id, harness, runner) {
  if (!id) return;
  try {
    const all = Object.entries({ ...readSessions(), [id]: { harness, runner, at: Date.now() } }).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(all)));
  } catch (e) { log('could not write', SESSIONS_FILE, e.message); }
}

// A permission request held for worker_approve. `answer(allow)` settles it with the harness.
let approvalSeq = 0;
function holdApproval(job, { toolName, callId, reason, answer }) {
  const a = { id: `apr-${++approvalSeq}`, toolName, callId, reason: reason ?? null, reported: false, answer };
  job.pending.set(a.id, a);
  flushText(job);
  emit(job, `APPROVAL NEEDED: ${describeApproval(job, a)}`);
  for (const fn of job.wake) fn();
}
function dropApprovals(job) {
  for (const a of job.pending.values()) a.answer?.(false, true);
  job.pending.clear();
}

// ---------------------------------------------------------------- ACP runner
const acpAgents = new Map(); // harness name -> { key, agent }: one warm process per harness
function acpAgent(name, spec) {
  const key = JSON.stringify(spec), had = acpAgents.get(name);
  if (had?.key === key) return had.agent;
  had?.agent.stop();
  const agent = new AcpAgent(name, spec, log);
  acpAgents.set(name, { key, agent });
  return agent;
}
function acpUpdate(job, u) {
  const k = u.sessionUpdate;
  if (k === 'agent_message_chunk') {
    if (u.content?.type === 'text') streamText(job, u.content.text, u.messageId ?? 'message');
  } else if (k === 'tool_call' || k === 'tool_call_update') {
    // Some agents announce a call before its input is known: note it once the input is there.
    const c = job.toolCalls.get(u.toolCallId) ?? { noted: false, done: false, title: null, kind: null, input: null, paths: [] };
    job.toolCalls.set(u.toolCallId, c);
    if (u.title && !c.title) c.title = u.title; // the first title is the tool's name; some agents retitle with the command
    if (u.kind) c.kind = u.kind;
    if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) c.input = u.rawInput;
    if (u.locations?.length) c.paths = u.locations.map((l) => l.path).filter(Boolean);
    const ended = u.status === 'completed' || u.status === 'failed';
    // A pending call's input may still be partial (OpenCode streams it): wait for the part worth showing.
    const i0 = c.input ?? {};
    const shown = i0.file_path || i0.filePath || i0.path || i0.command || i0.url || i0.pattern || i0.queries || i0.name;
    if (!c.noted && (ended || (c.input && (shown || (u.status && u.status !== 'pending'))))) {
      c.noted = true;
      const i = c.input ?? {};
      noteCall(job, c.title ?? c.kind ?? 'tool', { ...i, file_path: i.file_path ?? i.filePath ?? (c.kind === 'edit' ? c.paths[0] : undefined) }, u.toolCallId);
      if (c.kind === 'edit' || c.kind === 'delete' || c.kind === 'move') for (const p of c.paths) job.written.add(p);
    }
    if (ended && !c.done) {
      c.done = true;
      if (u.status === 'failed') { job.failedCalls++; emit(job, `  ✗ ${c.title ?? 'tool'} failed`); }
    }
  } else if (k === 'usage_update') job.context = { used: u.used, size: u.size };
}
async function startAcpJob(name, h, { task, cwd, session_id, model }, why) {
  const job = newJob('acp', cwd, task);
  Object.assign(job, { harness: name, harnessType: h.type, routing: why, toolCalls: new Map() });
  const spec = launchSpec(h);
  if (!spec) { finish(job, 'failed', harnessMissing(h)); return job; }
  const agent = acpAgent(name, spec);
  const sink = {
    update: (u) => { if (job.status === 'running') acpUpdate(job, u); },
    permission: (p) => new Promise((resolve) => {
      const tc = p.toolCall ?? {}, known = job.toolCalls.get(tc.toolCallId);
      const tool = known?.title ?? tc.title ?? 'tool';
      if (tc.rawInput && Object.keys(tc.rawInput).length) job.callInputs.set(tc.toolCallId, { tool: known?.title ?? tool, input: tc.rawInput });
      const option = (allow) => (p.options ?? []).find((o) => o.kind === (allow ? 'allow_once' : 'reject_once'))
        ?? (p.options ?? []).find((o) => String(o.kind).startsWith(allow ? 'allow' : 'reject'));
      holdApproval(job, { toolName: tool, callId: tc.toolCallId, answer: (allow, dropped) => {
        const o = dropped ? null : option(allow);
        resolve(o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } });
      } });
    }),
    closed: (gone) => finish(job, 'failed', `the ${name} agent process went away: ${gone}`),
  };
  try {
    const s = await agent.open({
      cwd: h.type === 'dsh' ? toHostPath(cwd) : cwd, sessionId: session_id, model: model || h.model, effort: h.effort, options: h.options,
    }, sink);
    job.sessionId = s.sessionId;
    job.model = [s.model ?? 'the harness default', ...s.notes.filter((n) => !n.startsWith('model '))].join(', ');
    rememberSession(s.sessionId, name, 'acp');
    job.cancel = () => agent.cancel(s.sessionId);
    agent.prompt(s.sessionId, task).then((r) => {
      flushText(job);
      const stop = r.stopReason ?? 'unknown';
      if (stop === 'end_turn') {
        job.final = job.lastText;
        finish(job, job.final ? 'completed' : 'failed', job.final ? null : `${name} ended its turn without a message${job.approvalLog.some((l) => l.startsWith('rejected')) ? ' after the rejected call' : ''}: treat the task as unfinished`);
      } else finish(job, stop === 'cancelled' ? 'cancelled' : 'failed', `turn ended: ${stop}`);
    }, (e) => finish(job, 'failed', `${name}: ${e.message}`)).finally(() => { dropApprovals(job); agent.release(s.sessionId); });
  } catch (e) { finish(job, 'failed', `${name}: ${e.message}`); }
  return job;
}

// ---------------------------------------------------------------- Codex runner
let codexHeld = null; // { key, server }
function codexServer(h) {
  const spec = launchSpec(h);
  if (!spec) return null;
  const key = JSON.stringify(spec);
  if (codexHeld?.key !== key) { codexHeld?.server.stop(); codexHeld = { key, server: new CodexServer(spec, log) }; }
  return codexHeld.server;
}
function codexEvent(job, srv, method, p) {
  if (job.status !== 'running') return;
  if (method === 'item/agentMessage/delta') streamText(job, p.delta, p.itemId);
  else if (method === 'item/started' || method === 'item/completed') {
    const it = p.item ?? {}, done = method === 'item/completed';
    if (it.type === 'agentMessage') {
      if (done && it.text?.trim()) {
        if (job.msgKey !== it.id) streamText(job, it.text + '\n', it.id); // it came without deltas
        flushText(job);
        job.lastText = it.text.trim();
      }
    } else if (it.type === 'commandExecution') {
      if (!done) noteCall(job, 'bash', { command: it.command }, it.id);
      else if (it.status === 'failed' || it.status === 'declined') { job.failedCalls++; emit(job, `  ✗ command ${it.status}${it.exitCode != null ? ` (exit ${it.exitCode})` : ''}`); }
    } else if (it.type === 'fileChange') {
      const paths = (it.changes ?? []).map((c) => c.path).filter(Boolean);
      if (!done) noteCall(job, 'edit', { path: paths.join(', ') }, it.id);
      else if (it.status === 'completed') for (const f of paths) job.written.add(f);
      else if (it.status === 'failed' || it.status === 'declined') { job.failedCalls++; emit(job, `  ✗ edit ${it.status}`); }
    } else if (!done && it.type === 'mcpToolCall') noteCall(job, `${it.server}.${it.tool}`, {}, it.id);
    else if (!done && it.type === 'webSearch') noteCall(job, 'web_search', { queries: [it.query].filter(Boolean) }, it.id);
  } else if (method === 'item/autoApprovalReview/completed') {
    const a = p.action ?? {}, r = p.review ?? {};
    const what = a.command ?? (a.argv ? a.argv.join(' ') : a.type ?? 'a tool call');
    const line = `${r.status ?? 'reviewed'} by Codex auto-review${r.riskLevel ? ` (risk ${r.riskLevel})` : ''}: ${String(what).replace(/\s+/g, ' ').slice(0, 300)}`;
    job.approvalLog.push(line + (r.rationale ? `\n      reviewer: ${r.rationale}` : ''));
    emit(job, `  auto-review ${line}`);
  } else if (method === 'thread/tokenUsage/updated') job.usage = p.tokenUsage?.total ?? job.usage;
  else if (method === 'error') { if (!p.willRetry) job.errors.push(`Codex: ${p.error?.message ?? JSON.stringify(p).slice(0, 300)}`); }
  else if (method === 'turn/completed') {
    const t = p.turn ?? {};
    flushText(job);
    if (t.status === 'completed') {
      job.final = job.lastText;
      finish(job, job.final ? 'completed' : 'failed', job.final ? null : 'Codex ended its turn without a message: treat the task as unfinished');
    } else if (t.status === 'interrupted') finish(job, 'cancelled', 'the turn was interrupted');
    else finish(job, 'failed', `turn ${t.status}${t.error?.message ? `: ${t.error.message}` : ''}`);
    dropApprovals(job);
    srv.release(job.sessionId);
    job.usageRead = srv.usage().then((u) => { job.codexUsage = u; });
  }
}
async function startCodexJob(name, h, { task, cwd, session_id, model }, why) {
  const job = newJob('codex', cwd, task);
  Object.assign(job, { harness: name, harnessType: 'codex', routing: why });
  const srv = codexServer(h);
  if (!srv) { finish(job, 'failed', harnessMissing(h)); return job; }
  job.codex = srv;
  const sink = {
    event: (method, p) => codexEvent(job, srv, method, p),
    approval: (method, p) => new Promise((resolve) => {
      const file = /fileChange|applyPatch/.test(method);
      const command = Array.isArray(p.command) ? p.command.join(' ') : p.command;
      const callId = `codex-${p.approvalId ?? p.itemId ?? p.callId ?? ++approvalSeq}`;
      job.callInputs.set(callId, file ? { tool: 'edit', input: { path: p.grantRoot ?? job.callInputs.get(p.itemId)?.input?.path ?? 'file changes' } } : { tool: 'bash', input: { command } });
      holdApproval(job, { toolName: file ? 'edit' : 'bash', callId, reason: p.reason, answer: (allow) => resolve(!!allow) });
    }),
    closed: (gone) => finish(job, 'failed', `the Codex app-server went away: ${gone}`),
  };
  try {
    // Who decides approvals: Codex's own auto-review on a ChatGPT subscription, Claude otherwise.
    const self = h.approvals ? h.approvals === 'self' : (await srv.accountType()) === 'chatgpt';
    const reviewer = h.reviewer ?? (self ? 'auto_review' : 'user');
    const t = await srv.open({ cwd, threadId: session_id, model: model || h.model, sandbox: h.sandbox, approval: h.approval, reviewer }, sink);
    job.sessionId = t.threadId;
    job.model = `${t.model ?? 'the Codex config default'}, reasoning ${h.effort ?? t.effort ?? 'config default'}`;
    job.permission = `Codex sandbox ${t.sandbox ?? 'per ~/.codex/config.toml'}, approval policy ${t.approval ?? 'per config'}, ` + (t.reviewer && t.reviewer !== 'user'
      ? `approvals decided by Codex's own auto-review ("approvals": "claude" for this harness sends them to worker_approve instead)`
      : 'approval requests return as APPROVAL NEEDED');
    rememberSession(t.threadId, name, 'codex');
    job.cancel = () => srv.interrupt(t.threadId, job.turnId);
    job.turnId = await srv.turn(t.threadId, task, { model, effort: h.effort });
  } catch (e) { finish(job, 'failed', `Codex: ${e.message}`); }
  return job;
}

// ---------------------------------------------------------------- job control
async function stopJob(job, why) {
  if (job.status !== 'running') return;
  if (job.cancel) {
    dropApprovals(job);
    try { await job.cancel(); } catch {}
  } else if (job.runner === 'web' && job.sessionId) {
    // Cancelling the turn alone is not enough: a background job (a long shell command) keeps
    // running, and when it settles dsh delivers that to the agent and starts a new turn.
    // So kill the session's live jobs, cancel the turn, and repeat if a new turn starts anyway.
    const cancelOnce = async () => {
      catchUp(job);
      for (const jobId of job.liveJobs) {
        try { await webCall('job/kill', { request: { sessionId: job.sessionId, jobId } }); } catch (e) { job.errors.push(`job/kill ${jobId}: ${e.message}`); }
      }
      try { await webCall('session/cancel', { request: { sessionId: job.sessionId } }); } catch (e) { job.errors.push(`session/cancel failed: ${e.message}`); }
    };
    await cancelOnce();
    let watchedSeq = job.lastSeq, rounds = 0;
    const recheck = async () => {
      if (++rounds > 5 || !job.logFile) return;
      const before = job.lastTurnStartSeq;
      catchUp(job);
      if (job.lastTurnStartSeq > Math.max(before, watchedSeq)) { watchedSeq = job.lastSeq; await cancelOnce(); log(`${job.id}: a new turn started after cancel; cancelled again`); }
      setTimeout(recheck, 3000);
    };
    setTimeout(recheck, 3000);
  } else if (job.child) {
    // DeepSeek's shell tools run as children of dsh: take the whole tree down.
    const { pid } = job.child;
    if (isWin && pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => job.child?.kill());
    else job.child.kill('SIGTERM');
  }
  clearTimeout(job.timer);
  finish(job, 'cancelled', `cancelled: ${why}`);
  log(`stopped ${job.id} (${why})`);
}

// Waits until the job ends, the time is up, or an approval request arrives that no report has
// shown yet (so a held approval comes back at once, and a known one does not spin the caller).
const unreported = (job) => [...job.pending.values()].some((a) => !a.reported);
function waitFor(job, seconds, onActivity) {
  if (job.status !== 'running' || unreported(job)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); clearInterval(poll); job.listeners.delete(onActivity); job.wake.delete(wake); resolve(); };
    const wake = () => { if (unreported(job)) done(); };
    const t = setTimeout(done, Math.max(1, seconds) * 1000);
    const poll = setInterval(() => { if (job.status !== 'running') done(); }, 250);
    if (onActivity) job.listeners.add(onActivity);
    job.wake.add(wake);
  });
}

function report(job) {
  const secs = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  const cursor = job.runner === 'cursor', codex = job.runner === 'codex', acp = job.runner === 'acp';
  const dsh = !cursor && !codex && (!acp || job.harnessType === 'dsh');
  const who = cursor ? 'Cursor' : codex ? 'Codex' : dsh ? 'DeepSeek' : job.harness;
  const where = cursor ? 'Cursor CLI, headless (continue the chat with worker_run session_id)'
    : codex ? 'Codex app-server, streamed (continue the thread with worker_run session_id)'
      : acp ? `ACP, streamed from a long-lived ${dsh ? 'dsh' : job.harness} agent process (continue with worker_run session_id)`
        : job.runner === 'web' ? `web instance (live in ${webUi}, workspace "${job.workspace}")`
          : `headless (the session appears under 未分组 in ${webUi}, not live)`;
  const lines = [
    `status: ${job.status}${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}, ${secs}s`,
    `engine: ${dsh ? 'DeepSeek (dsh)' : acp ? `${job.harness} (ACP)` : who}${job.routing ? ` (${job.routing})` : ''}`,
    `job: ${job.id} | session: ${job.sessionId || '(not yet)'} | cwd: ${job.cwd}`,
    `runner: ${where}`,
    `permission: ${cursor ? 'Cursor auto-review: safe tool calls run, the rest are refused (listed under BLOCKED)'
      : codex ? job.permission ?? '(not set yet)'
        : acp ? (dsh ? 'dsh acp profile: workspace-write sandbox; a call that needs approval returns as APPROVAL NEEDED (no reviewer model on this runner)'
          : job.harness === 'opencode' ? 'OpenCode: edits inside the project run; shell commands other than read-only ones, and anything outside the project, return as APPROVAL NEEDED'
            : `${job.harness}'s own settings; its permission requests return as APPROVAL NEEDED`)
          : job.runner === 'web' ? job.permission ?? '(not set yet)' : 'headless default (Auto review needs the web instance)'}`,
  ];
  if (codex) {
    if (job.model) lines.push(`model: ${job.model}`);
    const u = job.usage;
    if (u) lines.push(`tokens: in ${u.inputTokens ?? 0} (cached ${u.cachedInputTokens ?? 0}), out ${u.outputTokens ?? 0} (reasoning ${u.reasoningOutputTokens ?? 0})`);
    lines.push(`Codex usage: ${usageLine(job.codexUsage ?? job.codex?.limits, job.codex?.account)}`);
  } else if (acp) {
    if (job.model) lines.push(`model: ${job.model}`);
    if (job.context?.size) lines.push(`context: ${job.context.used} of ${job.context.size} tokens`);
  } else if (cursor) {
    lines.push(`model: ${job.cursorModel}${job.actualModel && job.actualModel !== job.cursorModel ? ` -> ${job.actualModel}` : ''}`);
    const u = job.usage;
    if (u) lines.push(`tokens: in ${u.inputTokens ?? 0}, out ${u.outputTokens ?? 0}, cache read ${u.cacheReadTokens ?? 0}, cache write ${u.cacheWriteTokens ?? 0}`);
    lines.push(`Cursor quota: ${job.quotaExhausted ? 'the plan limit was hit' : quotaLine(job.quotaAfter ?? readQuota(), job.cursorModel)}`);
  } else if (job.model) lines.push(`model: ${job.model}`);
  if (job.fallbackFrom) lines.push(`handed over from ${job.fallbackFrom}: Cursor hit its plan limit there`);
  if (job.status === 'running') {
    if (job.pending.size) {
      for (const a of job.pending.values()) {
        a.reported = true;
        lines.push(`APPROVAL NEEDED (approval_id ${a.id}): ${describeApproval(job, a)}`);
        if (a.reason) lines.push(`  reviewer: ${a.reason}`);
      }
      lines.push(`${who} is paused until this is answered: worker_approve(job_id "${job.id}", decision allow|reject)${job.runner === 'web' ? `, or the user answers in ${webUi}` : ''}.`);
    } else {
      // Seen only in the session log: the approval stream did not deliver it (yet).
      for (const a of job.approvals.values()) if (!viaStream(job, a)) lines.push(`WAITING FOR THE USER: approve or reject "${a.toolName}" in ${webUi}${a.reason ? ` (reviewer: ${a.reason})` : ''}`);
      lines.push(`still running: call worker_wait with job_id "${job.id}" (or worker_cancel).`);
    }
    // What happened since the last report on this job: the worker's text (») and tool calls (·).
    const fresh = job.feed.slice(job.feedSeen);
    job.feedSeen = job.feed.length;
    if (fresh.length) lines.push(`activity since the last report (${fresh.length} lines${fresh.length > 40 ? ', last 40 shown' : ''}):`, ...fresh.slice(-40).map((l) => '  ' + (l.length > 300 ? l.slice(0, 297) + '...' : l)));
  }
  if (job.approvalLog.length) lines.push('approvals:', ...job.approvalLog.slice(-10).map((a) => '  - ' + a));
  if (job.calls.length) {
    const counts = {};
    for (const c of job.calls) { const k = c.split(':')[0]; counts[k] = (counts[k] || 0) + 1; }
    lines.push(`tool calls (${job.calls.length}${job.failedCalls ? `, ${job.failedCalls} failed` : ''}): ` + Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(', '));
    lines.push(...job.calls.slice(-25).map((c) => '  - ' + c));
  }
  if (job.written.size) lines.push(`files written/edited: ${[...job.written].join(', ')}`);
  if (job.blocked?.length) lines.push('BLOCKED by Cursor auto-review (these did not run):', ...job.blocked.map((b) => '  - ' + b));
  if (job.errors.length) lines.push('errors:', ...job.errors.map((e) => '  - ' + e));
  if (job.status === 'failed' && job.stderr.trim()) lines.push('stderr (tail):', job.stderr.trim().split('\n').slice(-12).join('\n'));
  if (job.final != null) lines.push('', `--- ${who} final message ---`, job.final);
  else if (job.status !== 'running' && job.lastText) lines.push('', `--- ${who} last message (no end of turn) ---`, job.lastText);
  return lines.join('\n');
}

// ---------------------------------------------------------------- MCP tools
// The harnesses usable on this host, as the tool descriptions list them.
function engineList() {
  return Object.entries(harnesses()).filter(([, h]) => !harnessMissing(h)).map(([name, h]) => {
    const kind = h.type === 'cursor' ? 'Cursor CLI' : h.type === 'codex' ? 'Codex, streamed' : h.type === 'dsh' ? 'DeepSeek Harness, streamed' : 'ACP agent, streamed';
    return `${name} (${kind}${h.model ? `, model ${h.model}` : ''})`;
  });
}
const tools = () => [
  {
    name: 'worker_run',
    description: 'Hand a coding/research task to a worker agent and get its result. engine=auto (default) uses Cursor (the Cursor CLI in its Auto model mode) '
      + `while the Cursor plan keeps at least ${CURSOR_MIN_LEFT}% of its pool, and DeepSeek Harness otherwise (with the model configured for it); `
      + `engine=<name> forces one of the configured harnesses: ${engineList().join('; ')}. The result says which engine ran and why. `
      + 'While the worker runs, its text and tool calls are streamed as progress, and every report lists the activity since the previous one. '
      + 'Codex and ACP harnesses pause on a call that needs approval the same way DeepSeek does (APPROVAL NEEDED, answered with worker_approve). '
      + 'The worker works inside `cwd` with its own file and shell tools and returns a final message; review its changes yourself afterwards. '
      + 'Give a self-contained spec: goal, files it may touch, files it must not touch, acceptance commands. '
      + 'Cursor runs with its auto-review: safe tool calls run, the rest are refused and listed under BLOCKED (run one yourself only if the task needs it and the user agrees). '
      + 'DeepSeek runs in the machine\'s dsh web instance when one is up (live in that web UI), otherwise headless; web sessions use dsh\'s Auto review at maximum reasoning effort, '
      + 'and when its reviewer rejects a call, DeepSeek pauses and this returns at once with APPROVAL NEEDED (the command, the reviewer\'s reason, an approval_id): answer it with worker_approve. '
      + 'Waits up to wait_seconds; if still running, returns a job_id for worker_wait. Pass session_id to continue an earlier session (a Cursor chat id, or a dsh session-… id).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The full task specification for the worker.' },
        cwd: { type: 'string', description: 'Absolute path of the project directory the worker works in.' },
        engine: { type: 'string', enum: ['auto', ...Object.keys(harnesses())], description: `auto (default): Cursor while its quota has ${CURSOR_MIN_LEFT}%+ left, else DeepSeek. Otherwise a harness name.` },
        model: { type: 'string', description: 'Model for this task, overriding the harness\'s configured one. Give it only when the user names a model: a Cursor model id (named models draw on the API pool rather than Auto\'s), a Codex model, or a model the ACP harness offers (e.g. soclaas/x-test-2).' },
        session_id: { type: 'string', description: 'Optional session to continue (from an earlier result); it continues on the harness that owns it.' },
        wait_seconds: { type: 'integer', minimum: 1, maximum: 3000, description: 'How long to wait before returning a job_id (default depends on the client).' },
        runner: { type: 'string', enum: ['auto', 'acp', 'web', 'headless'], description: 'DeepSeek only. auto (default): ACP (streamed, warm process); web: the dsh web instance (live in its web UI, Auto review); headless: one process per task.' },
      },
      required: ['task', 'cwd'],
      additionalProperties: false,
    },
    annotations: { title: 'Run a worker task (Cursor / DeepSeek)', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'worker_wait',
    description: 'Keep waiting for a running job started by worker_run, then report its status and final message.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, wait_seconds: { type: 'integer', minimum: 1, maximum: 3000 } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Wait for a worker job', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'worker_approve',
    description: 'Answer an APPROVAL NEEDED request from a worker_run / worker_wait result: the worker (DeepSeek, Codex or an ACP harness) wants to run a tool call that needs a decision and waits for it. '
      + 'allow runs that one call once; reject refuses it and the worker carries on without it. Decide as the user would: allow what the task clearly needs and what stays inside its project; '
      + 'reject what the task does not need or what reaches outside it (deleting or overwriting data outside cwd, git push, deploying, system-wide installs, sending data off the machine, touching credentials). '
      + 'If you cannot tell, ask the user first. Afterwards keeps waiting like worker_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        decision: { type: 'string', enum: ['allow', 'reject'] },
        approval_id: { type: 'string', description: 'Which request, when the job has more than one pending.' },
        wait_seconds: { type: 'integer', minimum: 1, maximum: 3000 },
      },
      required: ['job_id', 'decision'],
      additionalProperties: false,
    },
    annotations: { title: 'Answer a DeepSeek approval', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'worker_cancel',
    description: 'Stop a running worker job. Its session stays and can be continued with worker_run(session_id).',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
    annotations: { title: 'Cancel a worker job', destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'worker_jobs',
    description: 'List worker jobs started in this session with their status, engine/runner and session ids, and the current Cursor quota.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List worker jobs', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'worker_usage',
    description: 'Plan usage of the worker harnesses: for Codex on a ChatGPT subscription the rate-limit windows (5h, weekly: percent used, reset time), the remaining credit balance '
      + 'and the rate-limit reset credits, read live from the Codex app-server; for Cursor the plan pools (refresh=true re-reads them, which takes about half a minute). '
      + 'Harnesses without a plan quota (DeepSeek Harness, other ACP agents) are listed with their model.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Also re-read the Cursor quota (slow).' } }, additionalProperties: false },
    annotations: { title: 'Worker plan usage', readOnlyHint: true, openWorldHint: true },
  },
];

async function usageReport(refresh) {
  const lines = [];
  for (const [name, h] of Object.entries(harnesses())) {
    const missing = harnessMissing(h);
    if (missing) lines.push(`${name}: ${missing}`);
    else if (h.type === 'codex') { const srv = codexServer(h); lines.push(`${name} (Codex): ${usageLine(await srv.usage(), srv.account)}`); }
    else if (h.type === 'cursor') lines.push(`${name} (Cursor): ${quotaLine(refresh ? await probeQuota() : readQuota(), h.model || CURSOR_MODEL)}`);
    else lines.push(`${name}: no plan quota to read (model ${h.model ?? 'the harness default'})`);
  }
  return lines.join('\n');
}

// dsh (DeepSeek): streamed over ACP by default; by its web instance or headless when asked for
// (or when continuing a session-… id, which belongs to those runners).
async function startDeepseekJob(args, why, h = harnesses().deepseek ?? { type: 'dsh' }) {
  const bad = dshCwdProblem(args.cwd);
  if (bad) return { error: bad };
  let want = args.runner || h.runner || 'auto';
  if (want === 'auto' && args.session_id?.startsWith('session-')) want = 'legacy';
  // dsh's reviewer model (Auto review) exists only in its web profile: "approvals": "self" means
  // the web instance when one is up; without one the ACP runner asks Claude.
  if (want === 'auto' && h.approvals === 'self' && !args.session_id) {
    if (await webAvailable()) want = 'legacy';
    else why += '; no dsh web instance for Auto review, so approvals come to Claude';
  }
  if (want === 'auto' || want === 'acp') {
    let down = null;
    try { await acpAgent('deepseek', launchSpec(h)).start(); } catch (e) { down = e.message; }
    if (!down) return startAcpJob('deepseek', h, args, why);
    if (want === 'acp') return { error: `dsh's ACP profile did not start: ${down}` };
    why += `; ACP unavailable (${down}), so not streamed`;
  }
  let job;
  if (want === 'headless') job = startHeadlessJob(args);
  else if (await webAvailable()) job = await startWebJob(args);
  else if (want === 'web') return { error: `no dsh web instance answers at ${WEB_BASE} (token from ${webTokenFile()})` };
  else job = startHeadlessJob(args);
  job.routing = why;
  return job;
}
// Wait on a job; a Cursor task that ran into the plan limit under engine=auto goes to DeepSeek,
// and a finished Cursor task waits (briefly) for the quota reading it triggered.
async function waitJob(job, seconds, progress, bind) {
  const until = Date.now() + seconds * 1000;
  if (job.fallbackId) job = jobs.get(job.fallbackId);
  await waitFor(job, seconds, progress);
  if (job.usageRead) await Promise.race([job.usageRead, new Promise((r) => setTimeout(r, 8000))]); // Codex usage after the turn
  if (job.runner !== 'cursor' || job.status === 'running') return job;
  if (job.quotaExhausted && job.autoEngine && !job.fallbackId) {
    const fb = await startDeepseekJob({ task: job.task, cwd: job.cwd }, `DeepSeek because Cursor hit its plan limit on ${job.id}`);
    if (fb.error) job.errors.push(`could not hand the task to DeepSeek: ${fb.error}`);
    else { job.fallbackId = fb.id; fb.fallbackFrom = job.id; }
  }
  if (job.fallbackId) {
    const fb = jobs.get(job.fallbackId);
    bind(fb);
    await waitFor(fb, Math.max(1, (until - Date.now()) / 1000), progress);
    return fb;
  }
  if (quotaProbe) await Promise.race([quotaProbe, new Promise((r) => setTimeout(r, 30000))]);
  return job;
}

async function callTool(name, args, progress, bind) {
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  const wait = (v) => Math.min(3000, Math.max(1, Number(v) || defaultWait));
  if (name === 'worker_run') {
    if (typeof args.task !== 'string' || !args.task.trim()) return text('task is required', true);
    const bad = checkCwd(args.cwd);
    if (bad) return text(bad, true);
    const hs = harnesses();
    const model = args.model || hs.cursor?.model || CURSOR_MODEL;
    // A session continues on the harness that owns it: recorded when it was started, else told
    // from the id (dsh web/headless ids start with "session-", OpenCode's with "ses_").
    const owner = args.session_id && (readSessions()[args.session_id]?.harness
      ?? (args.session_id.startsWith('session-') ? 'deepseek' : args.session_id.startsWith('ses_') ? 'opencode' : 'cursor'));
    const fallback = process.env.CLAUDE_WORKERS_ENGINE || loadConfig().default || 'auto';
    const want = args.engine || owner || fallback;
    if (want !== 'auto' && !hs[want]) return text(`unknown engine "${want}". Configured here: auto, ${Object.keys(hs).join(', ')} (harnesses are set in ${CONFIG_FILE})`, true);
    const h = hs[want];
    const why = args.engine ? `${want} as asked` : owner ? `continuing a ${owner} session` : `the default engine is ${want}`;
    let job;
    if (h && h.type !== 'cursor') {
      const missing = harnessMissing(h);
      if (missing) return text(`${want} cannot take this task: ${missing}`, true);
      job = h.type === 'dsh' ? await startDeepseekJob(args, why, h)
        : h.type === 'codex' ? await startCodexJob(want, h, args, why)
          : await startAcpJob(want, h, args, why);
    } else {
      const no = await cursorUnavailable(model);
      if (!no) job = startCursorJob(args, model, args.engine === 'cursor' ? 'Cursor as asked' : args.session_id ? 'continuing a Cursor chat' : `Cursor has quota left`);
      else if (want !== 'auto') return text(`Cursor cannot take this task: ${no}`, true);
      else job = await startDeepseekJob(args, `DeepSeek because ${no}`);
      job.autoEngine = want === 'auto';
    }
    if (job.error) return text(job.error, true);
    bind(job);
    job = await waitJob(job, wait(args.wait_seconds), progress, bind);
    return text(report(job), job.status === 'failed');
  }
  if (name === 'worker_wait') {
    let job = jobs.get(args.job_id);
    if (!job) return text(`no such job: ${args.job_id} (jobs live only as long as this MCP server; the session itself persists)`, true);
    bind(job);
    job = await waitJob(job, wait(args.wait_seconds), progress, bind);
    return text(report(job), job.status === 'failed');
  }
  if (name === 'worker_approve') {
    const job = jobs.get(args.job_id);
    if (!job) return text(`no such job: ${args.job_id}`, true);
    if (!['allow', 'reject'].includes(args.decision)) return text('decision must be allow or reject', true);
    const pending = [...job.pending.values()];
    const a = args.approval_id ? job.pending.get(args.approval_id) : pending.length === 1 ? pending[0] : null;
    if (!a) {
      return text(pending.length
        ? `${job.id} has ${pending.length} pending approvals; pass approval_id: ${pending.map((p) => p.id).join(', ')}`
        : `${job.id} has no pending approval (answered in the web UI, withdrawn, or never asked).\n\n${report(job)}`, pending.length > 0);
    }
    const value = args.decision === 'allow' ? 'allowed-once' : 'rejected';
    if (a.answer) { // held by this server for an ACP or Codex harness
      a.answer(args.decision === 'allow');
      job.pending.delete(a.id);
      job.approvalLog.push(`${value} by worker_approve: ${describeApproval(job, a)}${a.reason ? `\n      reason given: ${a.reason}` : ''}`);
    } else {
      try { await answerEvent(a.id, { kind: 'result', value }); }
      catch (e) { return text(`could not answer (${e.message}); the user can answer in ${webUi}`, true); }
      job.pending.delete(a.id);
      if (a.callId) job.answered.add(a.callId); // the session log's approval/decided records the outcome
      else job.approvalLog.push(`${value} by worker_approve: ${describeApproval(job, a)}`);
    }
    bind(job);
    await waitFor(job, wait(args.wait_seconds), progress);
    return text(report(job), job.status === 'failed');
  }
  if (name === 'worker_cancel') {
    const job = jobs.get(args.job_id);
    if (!job) return text(`no such job: ${args.job_id}`, true);
    await stopJob(job, 'worker_cancel');
    return text(report(job));
  }
  if (name === 'worker_jobs') {
    const quota = cursorCommand() ? `Cursor quota: ${quotaLine(readQuota(), CURSOR_MODEL)}` : 'Cursor CLI: not installed on this host';
    if (!jobs.size) return text(`no worker jobs in this session\n${quota}`);
    return text([...jobs.values()].map((j) => `${j.id}  ${j.status}  ${j.harness ? `${j.harness}/` : ''}${j.runner}  session=${j.sessionId || '-'}  cwd=${j.cwd}  calls=${j.calls.length}`
      + (j.pending.size ? `  APPROVAL NEEDED ×${j.pending.size}` : '') + (j.fallbackId ? `  -> ${j.fallbackId}` : '')).join('\n') + `\n${quota}\n(worker_usage shows every harness's plan usage)`);
  }
  if (name === 'worker_usage') return text(await usageReport(args.refresh === true));
  return text(`unknown tool: ${name}`, true);
}

// ---------------------------------------------------------------- JSON-RPC loop
async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    const client = String(params.clientInfo?.name || '');
    if (!process.env.CLAUDE_WORKERS_DEFAULT_WAIT && /claude-code|claude code/i.test(client)) defaultWait = 540;
    log(`client=${client || '?'} wait=${defaultWait}s web=${WEB_BASE} token=${webTokenFile()} dsh_home=${DSH_HOME} headless=${dshCommand().cmd}`);
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'claude-workers', title: 'Claude Workers', version: VERSION },
      instructions: 'Use these tools only when the user asks to hand work to a worker (Cursor, DeepSeek / dsh, Codex, OpenCode or another configured harness). worker_run hands a task to Cursor while its plan has quota, '
        + 'DeepSeek otherwise, or to the harness named in `engine`; review the resulting changes yourself before reporting them. A result saying APPROVAL NEEDED means the worker is paused on a tool call that needs a decision: '
        + 'answer it with worker_approve (ask the user when you cannot tell whether the task needs it). BLOCKED lists Cursor tool calls its auto-review refused. worker_usage shows plan usage (Codex limits and credits, Cursor pools).',
    } });
  }
  if (method === 'notifications/cancelled') {
    const job = jobs.get(inflight.get(params.requestId));
    if (job) await stopJob(job, 'the tool call was cancelled');
    return;
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: tools() } });
  if (method === 'tools/call') {
    const token = params._meta?.progressToken;
    let n = 0;
    const progress = token === undefined ? undefined
      : (message) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } });
    try {
      const result = await callTool(params.name, params.arguments || {}, progress, (job) => inflight.set(id, job.id));
      return send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `claude-workers error: ${err.message}` }], isError: true } });
    } finally { inflight.delete(id); }
  }
  if (id !== undefined && method) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  handle(msg).catch((err) => log('handler error:', err.stack || err.message));
}).on('close', () => {
  // The client went away: stop headless children; web-run tasks keep going in the web UI,
  // where held approvals stay answerable.
  for (const j of jobs.values()) if (j.child) j.child.kill();
  for (const { agent } of acpAgents.values()) agent.stop();
  codexHeld?.server.stop();
  events.ws?.close();
  process.exit(0);
});
