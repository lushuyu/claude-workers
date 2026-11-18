// Codex through its app-server (`codex app-server`, JSON-RPC over stdio): one long-lived
// process, threads and turns streamed as notifications, approvals as requests from the server,
// and the account's plan usage (rate-limit windows, credits) through account/rateLimits/read.
// Nothing here reads Codex's stored login: the app-server does the authenticated calls itself.
import os from 'node:os';
import { StdioRpc } from './stdio-rpc.mjs';

const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval']);

export class CodexServer {
  // spec: { cmd, args, env, shell }
  constructor(spec, log = () => {}) {
    Object.assign(this, { spec, log, rpc: null, ready: null, sinks: new Map(), limits: null, account: null });
  }

  start() {
    if (this.ready && !this.rpc?.closed) return this.ready;
    const rpc = this.rpc = new StdioRpc({
      ...this.spec, args: [...(this.spec.args || []), 'app-server'], cwd: os.homedir(),
      onNotify: (method, p) => {
        if (method === 'account/rateLimits/updated' && p.rateLimits) this.limits = { ...(this.limits ?? {}), rateLimits: p.rateLimits, readAt: Date.now() };
        else if (method === 'account/updated') this.account = { ...(this.account ?? {}), ...p };
        const tid = p.threadId ?? p.conversationId;
        if (tid) this.sinks.get(tid)?.event(method, p);
      },
      onRequest: (method, p) => {
        const sink = this.sinks.get(p.threadId ?? p.conversationId);
        if (APPROVALS.has(method)) {
          // v1 approvals answer approved/denied, v2 accept/decline.
          const v1 = method === 'execCommandApproval' || method === 'applyPatchApproval';
          if (!sink) return { decision: v1 ? 'denied' : 'decline' };
          return sink.approval(method, p).then((allow) => ({ decision: v1 ? (allow ? 'approved' : 'denied') : (allow ? 'accept' : 'decline') }));
        }
        throw Object.assign(new Error(`method not supported by this client: ${method}`), { code: -32601 });
      },
      onClose: (why) => {
        this.log(`codex: ${why}`);
        for (const s of this.sinks.values()) s.closed(why);
        this.sinks.clear();
      },
    });
    this.ready = rpc.request('initialize', { clientInfo: { name: 'claude-workers', title: 'Claude Workers', version: '1' } }, 60000)
      .then((r) => { rpc.notify('initialized', {}); return r; });
    this.ready.catch(() => { rpc.kill(); });
    return this.ready;
  }

  // Starts a thread (or resumes one). Settings left out fall back to ~/.codex/config.toml.
  async open({ cwd, threadId, model, sandbox, approval, reviewer }, sink) {
    await this.start();
    const p = { cwd, ...(model ? { model } : {}), ...(sandbox ? { sandbox } : {}), ...(approval ? { approvalPolicy: approval } : {}), ...(reviewer ? { approvalsReviewer: reviewer } : {}) };
    const r = threadId ? await this.rpc.request('thread/resume', { threadId, ...p }, 120000) : await this.rpc.request('thread/start', p, 120000);
    const id = r?.thread?.id ?? threadId;
    this.sinks.set(id, sink);
    const sb = r?.sandbox?.type ?? r?.sandbox?.mode ?? (typeof r?.sandbox === 'string' ? r.sandbox : null);
    const ap = typeof r?.approvalPolicy === 'string' ? r.approvalPolicy : r?.approvalPolicy ? 'granular' : null;
    return { threadId: id, model: r?.model ?? model ?? null, effort: r?.reasoningEffort ?? null, sandbox: sb, approval: ap, reviewer: r?.approvalsReviewer ?? reviewer ?? null };
  }
  async turn(threadId, text, { model, effort } = {}) {
    const r = await this.rpc.request('turn/start', { threadId, input: [{ type: 'text', text }], ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, 120000);
    return r?.turn?.id ?? null;
  }
  interrupt(threadId, turnId) { return this.rpc?.request('turn/interrupt', { threadId, turnId }, 15000).catch(() => {}); }
  release(threadId) { this.sinks.delete(threadId); }
  stop() { this.rpc?.kill(); }

  // 'chatgpt' for a ChatGPT subscription login, 'apiKey' etc. otherwise; null when unknown.
  async accountType() {
    try {
      await this.start();
      this.account = (await this.rpc.request('account/read', { refreshToken: false }, 30000))?.account ?? this.account;
    } catch {}
    return this.account?.type ?? null;
  }

  // Plan usage as the app-server reports it. { error } when it cannot be read (API-key login, offline).
  async usage() {
    try {
      await this.start();
      this.account = (await this.rpc.request('account/read', { refreshToken: false }, 30000))?.account ?? this.account;
      const r = await this.rpc.request('account/rateLimits/read', undefined, 30000);
      this.limits = { ...r, readAt: Date.now() };
      return this.limits;
    } catch (e) {
      const key = this.account?.type && this.account.type !== 'chatgpt';
      return { error: key ? `Codex is logged in with ${this.account.type}, not a ChatGPT subscription: there is no plan usage to read` : e.message };
    }
  }
}

const when = (sec) => {
  if (!sec) return '?';
  const d = new Date(sec * 1000), today = new Date().toDateString() === d.toDateString();
  const hm = d.toTimeString().slice(0, 5);
  return today ? hm : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
};
const span = (mins) => (mins === 300 ? '5h' : mins === 10080 ? 'weekly' : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`);

// One line: plan, each rate-limit window, the credit balance, the reset credits.
export function usageLine(u, account) {
  if (!u) return 'not read yet';
  if (u.error) return `unknown (${u.error})`;
  const rl = u.rateLimits ?? {}, parts = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (w) parts.push(`${span(w.windowDurationMins)} window ${w.usedPercent}% used (${Math.max(0, 100 - w.usedPercent)}% left, resets ${when(w.resetsAt)})`);
  }
  const c = rl.credits;
  if (c) parts.push(`credits: ${c.unlimited ? 'unlimited' : c.hasCredits ? Number(c.balance).toFixed(2) : 'none'}`);
  const n = u.rateLimitResetCredits?.availableCount;
  if (n) parts.push(`${n} rate-limit reset credit${n > 1 ? 's' : ''} available`);
  if (rl.rateLimitReachedType) parts.push(`LIMIT REACHED: ${rl.rateLimitReachedType}`);
  if (rl.spendControlReached) parts.push('spend control reached');
  if (u.ordinaryUsageAllowed === false) parts.push('ordinary usage not allowed now');
  const plan = rl.planType ?? account?.planType;
  return `${plan ? `${plan} plan, ` : ''}${parts.join('; ') || 'no figures'} (read ${new Date(u.readAt).toTimeString().slice(0, 5)})`;
}
