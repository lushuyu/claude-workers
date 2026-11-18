// Agent Client Protocol (ACP) client: one long-lived agent process per harness, many sessions.
// Works with any ACP agent started over stdio (`dsh --profile acp`, `opencode acp`, ...).
// The process stays up between tasks, so a task starts without a cold boot, and everything the
// agent does arrives as `session/update` events while it happens.
import os from 'node:os';
import { StdioRpc } from './stdio-rpc.mjs';

// Select options may be grouped; values may be JSON (dsh: '["soclaas","x-test-2"]').
const flat = (opt) => (opt?.options || []).flatMap((o) => (Array.isArray(o.options) ? o.options : [o]));
export const plainValue = (v) => { try { const j = JSON.parse(v); if (Array.isArray(j)) return j.join('/'); } catch {} return String(v ?? ''); };
function pickOption(opt, want) {
  const all = flat(opt), w = String(want).toLowerCase();
  return all.find((o) => o.value === want) || all.find((o) => plainValue(o.value).toLowerCase() === w)
    || all.find((o) => String(o.name || '').toLowerCase() === w);
}

export class AcpAgent {
  // spec: { cmd, args, env, shell }
  constructor(name, spec, log = () => {}) {
    Object.assign(this, { name, spec, log, rpc: null, ready: null, caps: {}, info: null, sinks: new Map(), muted: new Set() });
  }

  start() {
    if (this.ready && !this.rpc?.closed) return this.ready;
    const rpc = this.rpc = new StdioRpc({
      ...this.spec, cwd: os.homedir(),
      onNotify: (method, p) => {
        if (method !== 'session/update' || this.muted.has(p.sessionId)) return;
        this.sinks.get(p.sessionId)?.update(p.update ?? {});
      },
      onRequest: (method, p) => {
        const sink = this.sinks.get(p.sessionId);
        if (method === 'session/request_permission' && sink) return sink.permission(p);
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
        throw Object.assign(new Error(`method not supported by this client: ${method}`), { code: -32601 });
      },
      onClose: (why) => {
        this.log(`${this.name}: ${why}`);
        for (const s of this.sinks.values()) s.closed(why);
        this.sinks.clear();
      },
    });
    this.ready = rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'claude-workers', version: '1' },
    }, 90000).then((r) => { this.caps = r?.agentCapabilities ?? {}; this.info = r?.agentInfo ?? null; return r; });
    this.ready.catch(() => { rpc.kill(); });
    return this.ready;
  }

  // Opens (or continues) a session and applies model / effort / other config options.
  // Returns { sessionId, model, notes }. Throws when the asked model is not offered.
  async open({ cwd, sessionId, model, effort, options = {} }, sink) {
    await this.start();
    const rpc = this.rpc, sc = this.caps.sessionCapabilities ?? {};
    let res, id = sessionId;
    if (id) {
      this.sinks.set(id, sink);
      if (sc.resume) res = await rpc.request('session/resume', { sessionId: id, cwd, mcpServers: [] });
      else if (this.caps.loadSession) {
        // session/load replays the old conversation as updates: not this task's activity.
        this.muted.add(id);
        try { res = await rpc.request('session/load', { sessionId: id, cwd, mcpServers: [] }, 120000); } finally { this.muted.delete(id); }
      } else { this.sinks.delete(id); throw new Error(`${this.name} cannot continue an earlier session (no resume/load in its ACP capabilities)`); }
    } else {
      res = await rpc.request('session/new', { cwd, mcpServers: [] });
      id = res.sessionId;
      this.sinks.set(id, sink);
    }
    let config = res?.configOptions ?? [];
    const notes = [];
    const set = async (opt, want, what) => {
      const hit = pickOption(opt, want);
      if (!hit) return false;
      if (hit.value !== opt.currentValue) {
        const r = await rpc.request('session/set_config_option', { sessionId: id, configId: opt.id, value: hit.value });
        if (r?.configOptions) config = r.configOptions;
      }
      notes.push(`${what} ${plainValue(hit.value)}`);
      return true;
    };
    const modelOpt = () => config.find((o) => o.category === 'model') ?? config.find((o) => o.id === 'model');
    let current = null;
    if (model) {
      const opt = modelOpt();
      if (opt) {
        if (!(await set(opt, model, 'model'))) {
          this.sinks.delete(id);
          throw new Error(`${this.name} does not offer model "${model}". It offers: ${flat(opt).map((o) => plainValue(o.value)).join(', ')}`);
        }
      } else if (res?.models?.availableModels) { // older ACP: session/set_model
        const hit = res.models.availableModels.find((m) => m.modelId === model || m.name === model);
        if (!hit) { this.sinks.delete(id); throw new Error(`${this.name} does not offer model "${model}". It offers: ${res.models.availableModels.map((m) => m.modelId).join(', ')}`); }
        if (hit.modelId !== res.models.currentModelId) await rpc.request('session/set_model', { sessionId: id, modelId: hit.modelId });
        current = hit.modelId;
      } else notes.push(`model "${model}" not applied: ${this.name} has no model option`);
    }
    if (effort) {
      const opt = config.find((o) => o.category === 'thought_level');
      if (opt && !(await set(opt, effort, 'reasoning'))) notes.push(`reasoning "${effort}" not offered (kept ${plainValue(opt.currentValue)})`);
    }
    for (const [k, v] of Object.entries(options)) {
      const opt = config.find((o) => o.id === k);
      if (!opt || !(await set(opt, v, k))) notes.push(`option ${k}=${v} not applied`);
    }
    const mo = modelOpt();
    current ??= mo ? plainValue(mo.currentValue) : (res?.models?.currentModelId ?? null);
    return { sessionId: id, model: current, notes };
  }

  // Runs one turn; resolves with the stop reason (end_turn, cancelled, max_tokens, refusal, ...).
  async prompt(sessionId, text) {
    const r = await this.rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 0);
    return r ?? {};
  }
  cancel(sessionId) { this.rpc?.notify('session/cancel', { sessionId }); }
  release(sessionId) { this.sinks.delete(sessionId); }
  stop() { this.rpc?.kill(); }
}
