// A child process spoken to in newline-delimited JSON-RPC 2.0 over stdio, both ways:
// requests and notifications go out, and the child's own notifications and requests come in.
// Used for ACP agents (dsh, OpenCode, ...) and for the Codex app-server.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export class StdioRpc {
  // onNotify(method, params); onRequest(method, params) -> result (or throws); onClose(why)
  constructor({ cmd, args = [], env = {}, cwd, shell = false, onNotify, onRequest, onClose }) {
    this.seq = 0;
    this.waiting = new Map();
    this.stderr = '';
    this.closed = null; // why, once the process is gone
    this.child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const gone = (why) => {
      if (this.closed) return;
      this.closed = why;
      for (const { reject, timer } of this.waiting.values()) { clearTimeout(timer); reject(new Error(why)); }
      this.waiting.clear();
      onClose?.(why);
    };
    this.child.on('error', (e) => gone(`could not start ${cmd}: ${e.message}`));
    this.child.on('close', (code, signal) => gone(`${cmd} exited (${code ?? signal})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method === undefined) {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id); clearTimeout(w.timer);
        if (m.error) w.reject(Object.assign(new Error(m.error.message || JSON.stringify(m.error)), { code: m.error.code, data: m.error.data }));
        else w.resolve(m.result);
      } else if (m.id === undefined || m.id === null) {
        try { onNotify?.(m.method, m.params ?? {}); } catch {}
      } else {
        Promise.resolve().then(() => {
          if (!onRequest) throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 });
          return onRequest(m.method, m.params ?? {});
        }).then(
          (result) => this.write({ jsonrpc: '2.0', id: m.id, result: result ?? {} }),
          (e) => this.write({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32603, message: e.message } }),
        );
      }
    });
  }

  write(msg) { if (!this.closed) this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  notify(method, params) { this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); }
  // timeoutMs 0: no timeout (a prompt turn lasts as long as the task).
  request(method, params, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method}: no answer in ${timeoutMs / 1000}s`)); }, timeoutMs) : null;
      this.waiting.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  kill() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}
