---
name: deepseek-routing
description: >-
  Routing rule for handing work to a worker agent (Cursor or DeepSeek). Use whenever the user
  asks to hand a task off - to Cursor, Grok, DeepSeek, dsh, DeepSeek Harness or "a worker"
  (e.g. "派给 cursor", "交给 deepseek", "让 dsh 跑", "派活", "ask DeepSeek") - delegate it to the
  dsh:worker subagent (dsh:deepseek when DeepSeek is named), or call dsh_run directly for a
  one-off question. When the user does not ask for a hand-off, do the work with the current model.
---

# Worker routing

- **The user did not ask to hand the work off** → do the work yourself with the current model. Do not suggest or ask about models and do not dispatch.
- **The user asked to hand it off** →
  - implementation, debugging, refactoring, bounded research: use the Agent tool with `subagent_type: "dsh:worker"`, or `"dsh:deepseek"` when the user named DeepSeek / dsh. Give it the absolute project directory, a self-contained brief (it does not see this conversation) and the engine or model the user named, if any. Independent pieces can go to several subagents in parallel, each in its own directory or git worktree.
  - a quick question or web lookup: call `dsh_run` directly, with a scratch directory as `cwd`.
  - Engine: leave it to `dsh_run`'s default (Cursor in Auto mode while the Cursor plan keeps 30%+ of its pool, DeepSeek otherwise) unless the user named one: DeepSeek / dsh → `engine: "deepseek"`; Cursor → `engine: "cursor"`; a specific Cursor model (e.g. Grok 4.7) → `engine: "cursor"` with `model` (e.g. `grok-4.7-high`; `agent models` lists them). Named Cursor models draw on the plan's API pool, Auto on its own pool.
  - Other harnesses, only when the user names them: Codex → `engine: "codex"`; OpenCode → `engine: "opencode"`; any other name configured in `~/.dsh-mcp/config.json`. Each uses the model set for it there; pass `model` only when the user names one.
  - Plan usage ("Codex 还剩多少", "credits"): `dsh_usage` (Codex 5h / weekly windows, credit balance, reset credits; Cursor pools).
- Relay the subagent's review summary: which engine ran and why, the model Cursor's Auto resolved to and the quota line, the `session_id` (and the `web UI` line for DeepSeek).
- Streaming: DeepSeek (over ACP), Codex and OpenCode stream their text and tool calls as progress, and every `dsh_run` / `dsh_wait` report lists the activity since the previous one, so a short `wait_seconds` gives a live view of a long task.
- Approvals (Codex, ACP harnesses): a call that needs a decision comes back as `APPROVAL NEEDED` too, answered the same way. Who decides is the harness's `"approvals"` setting in `~/.dsh-mcp/config.json`: `claude` (default for DeepSeek, OpenCode and other ACP agents, which have no reviewer of their own on this path) or `self` (default for Codex on a ChatGPT subscription: its auto-review decides and the report lists its decisions). OpenCode asks for every shell command that is not read-only.
- Approvals (DeepSeek): web sessions run under dsh's Auto review. A `dsh_run` / `dsh_wait` result with `APPROVAL NEEDED` means DeepSeek is paused on a tool call its reviewer rejected. Answer it with `dsh_approve` (allow what the task clearly needs inside its project; reject what reaches outside it). When a subagent hands one back undecided, or you cannot tell, ask the user, then answer with `dsh_approve` using the `job_id` and `approval_id` it reported.
- Cursor has no approval step when headless: its auto-review refuses risky calls, and the result lists them under `BLOCKED`. Ask the user before running any of them yourself.

## What the engines are

- **Cursor**: the Cursor CLI (`agent`; one login per host) on the user's Cursor plan. `dsh_run` runs `agent -p` headless with `--auto-review`; the model defaults to `auto`, and the model Auto picked is read from the CLI's chat store. Quota is read from the CLI's `/usage` screen after every Cursor task and at least every 30 minutes (`dsh_jobs` shows it); below 30% left, tasks go to DeepSeek, and a run that hits the plan limit is handed to DeepSeek. Each run's tokens are logged to `~/.cursor/dsh-mcp/usage-*.jsonl`.
- **DeepSeek**: DeepSeek Harness CLI. Default model `soclaas/x-test-2` = DeepSeek V4.1 Flash 1017 through SoCLaaS (NUS SoC gateway), unlimited, at reasoning effort `max` (levels off/low/high/max); also `x-test-1` (GLM 5.3 Flash) and `qwen3.8:27b`. It has `web_search` / `web_fetch` (DeepSeek Search/Fetch API).
  - Config: `~/.dsh/profiles/{headless,web}/cordis.patch.yml`; keys in `~/.dsh/.credentials.yaml` (never read or print them).
  - By default `dsh_run` talks to a long-lived `dsh --profile acp` process (streamed, no cold start; workspace-write sandbox; the session is stored under `~/.dsh/sessions` like any other). `runner: "web"` (or `"runner": "web"` for `deepseek` in `~/.dsh-mcp/config.json`) uses the web instance instead:
  - With the web runner, where the host runs a dsh web instance, that instance executes the task: the session appears live in the web UI, in the workspace for `cwd`. Elsewhere it runs headless and the session shows under 未分组 in the desktop app, not live.
  - Without this plugin's MCP server the same works from a shell: `cd <project> && dsh headless --json "<spec>"` (NDJSON events; trust the `final` event, not the exit code; `--session-id <id>` continues).
