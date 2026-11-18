# claude-workers: worker harnesses for Claude, over MCP

Let Claude Code (or any MCP client) hand a task to another coding agent, watch it work, answer
its approval requests and read its plan usage. It drives DeepSeek Harness, OpenCode, Codex,
Cursor and any agent that speaks the Agent Client Protocol (ACP).

It is not tied to a model provider. Providers (SoCLaaS, DeepSeek, OpenAI, ...) are configured
in the harness; here you only name the model the harness should use.

Claude itself is left alone: no gateway, no `ANTHROPIC_BASE_URL`, no translation proxy. Your
Claude subscription, Remote Control and the desktop and mobile apps keep working as they do.

```
Claude ──MCP──> claude-workers ──ACP───────> dsh --profile acp   (DeepSeek Harness: SoCLaaS, DeepSeek, ...)
                        ├─ACP──────────────> opencode acp        (any provider OpenCode has)
                        ├─ACP──────────────> your own agent
                        ├─app-server───────> codex app-server    (your Codex login; usage and credits)
                        ├─CLI──────────────> Cursor `agent -p`
                        └─CLI (or SSH)─────> t3 thread           (a T3 Code server: the task becomes a thread there)
```

## What you get

- **Streaming.** DeepSeek Harness, Codex and OpenCode run in long-lived processes, so a task
  starts without a cold boot. The worker's text and tool calls arrive as MCP progress
  notifications while it works, and every report lists the activity since the previous one.
- **Several harnesses, one tool.** `worker_run(engine: "deepseek" | "codex" | "opencode" | ...)`.
  Which model each harness uses is set in a config file, not in code.
- **Approvals.** A tool call that needs a decision comes back to Claude as `APPROVAL NEEDED`
  and is answered with `worker_approve`, or is left to the harness's own reviewer where it has one.
- **Plan usage.** `worker_usage` shows Codex's rate-limit windows (5h, weekly), remaining credits
  and reset credits, and Cursor's plan pools.
- **Sessions.** Every result carries a `session_id`; pass it back to continue the conversation.

## Requirements

- Node.js 22.15 or newer. No npm dependencies.
- At least one harness, installed and logged in the way it normally is:
  - DeepSeek Harness (`dsh`), with SoCLaaS or another provider configured in it
  - OpenCode (`opencode`), with the provider configured (`opencode models` should list the model)
  - Codex CLI (`codex`), logged in with ChatGPT or an API key
  - Cursor CLI (`agent`), logged in
- This server never reads a harness's credentials. Each harness makes its own authenticated calls.

Developed and tested on Windows 11 with Claude Code. Linux, macOS and WSL paths exist in the code
but have had less testing.

## Install

### Claude Code (plugin: MCP server, subagents, slash commands, routing skill)

```
/plugin marketplace add lushuyu/claude-workers
/plugin install claude-workers@claude-workers
```

Then `/worker <task>`, `/deepseek <task>`, `/cursor [model] <task>`, or just ask Claude to hand a
task to DeepSeek / Codex / OpenCode.

### Any other MCP client (MCP server only)

```json
{
  "mcpServers": {
    "dsh": { "command": "node", "args": ["/path/to/repo/plugins/claude-workers/mcp/server.mjs"] }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `worker_run(task, cwd, engine?, model?, session_id?, wait_seconds?)` | Run a task in `cwd`. Returns the final message, or a `job_id` when `wait_seconds` runs out. |
| `worker_wait(job_id)` | Keep waiting; reports what happened since the last report. |
| `worker_approve(job_id, decision)` | Answer an `APPROVAL NEEDED`: `allow` or `reject`. |
| `worker_cancel(job_id)` | Stop a task. Its session can be continued later. |
| `worker_jobs()` | Jobs of this server process. |
| `worker_usage(refresh?)` | Plan usage per harness. |

## Configuration

`~/.claude-workers/config.json` (or the file named by `CLAUDE_WORKERS_CONFIG`). It is re-read when it changes.
The built-in harnesses (`deepseek`, `codex`, `opencode`, `cursor`) need no entry; an entry
overrides their fields. See [config.example.json](plugins/claude-workers/config.example.json).

```json
{
  "default": "deepseek",
  "harnesses": {
    "deepseek": { "model": "soclaas/x-test-2", "effort": "max" },
    "opencode": { "model": "soclaas/qwen3.8:27b" },
    "codex": { "effort": "high" },
    "my-agent": { "type": "acp", "command": "my-agent", "args": ["acp"], "model": "provider/model" },
    "cursor": { "disabled": true }
  }
}
```

- `default`: the engine used when `worker_run` names none. `auto` (the built-in default) means
  Cursor while its plan has quota left, DeepSeek otherwise.
- Per harness: `model` (unset: the harness's own default model), `effort`, `approvals`, `disabled`. For your own: `type` (`acp`), `command`,
  `args`, `env`, and `options` (ACP config options by id).
- `deepseek`: `runner` = `acp` (default) | `web` | `headless`.
- `codex`: `sandbox`, `approval`. Unset fields follow `~/.codex/config.toml`.
- `opencode`: `permission` replaces the OpenCode permission set described below.
- `t3` type: `ssh` (an ssh host that runs the T3 Code server; omit when it runs on this host), `provider` and
  `model` (T3's provider instance id and model slug), `command` (path to `t3`), `baseDir`,
  `addProject` (`false` to refuse adding `cwd` to T3 as a project when it is not one yet).
- `webUi`: the address where you open your dsh web instance, shown in reports of the web runner.

A model name is matched against what the harness offers (`soclaas/x-test-2` matches dsh's
`["soclaas","x-test-2"]`). Asking for a model the harness does not offer fails the task and
lists the ones it does; the server never switches models on its own.

### Who approves

`"approvals": "claude" | "self"` per harness.

- `claude`: a tool call that needs approval comes back as `APPROVAL NEEDED` and Claude decides.
- `self`: the harness's own reviewer model decides, and the report lists its decisions.

Only a harness that has a reviewer can be `self`. The others always ask Claude.

| Harness | Default | What `self` uses |
| --- | --- | --- |
| `codex`, ChatGPT subscription login | `self` | Codex auto-review |
| `codex`, API-key login | `claude` | Codex auto-review |
| `deepseek` | `claude` | the dsh web instance's Auto review, when one is running |
| `opencode` | `claude` | none: always Claude |
| other ACP agents | `claude` | none known: whatever the agent asks goes to Claude |

What triggers a request differs by harness:

- **DeepSeek Harness (ACP)** runs in its workspace-write sandbox. Calls that stay inside the
  project run; a call that needs to leave it asks.
- **Codex** follows its sandbox and approval policy.
- **OpenCode** has no sandbox and by default runs everything unasked. This server therefore
  starts it with `OPENCODE_PERMISSION`: edits inside the project and read-only shell commands
  run; every other shell command, and anything outside the project, asks.

### T3 Code

A `t3` harness hands the task to a [T3 Code](https://github.com/pingdotgg/t3code) server instead of
running an agent itself: `worker_run(engine: "t3")` starts a thread there with `t3 thread start`,
follows it with `t3 thread show`, and continues it with `t3 thread send`. `cwd` is a path on the T3
host; `model` may be given as `provider/model` (for example `claudeAgent/claude-sonnet-5-5`).

- No credentials are involved: the CLI talks to the server on its own host. Over SSH, your ssh
  config and agent do the authentication.
- T3's CLI reports agent messages, not tool calls, so the activity list has text only.
- A thread started this way runs in T3's own runtime mode (full access by default). Requests it
  raises are answered in T3; `worker_approve` does not apply. `worker_cancel` stops watching, but
  the CLI cannot interrupt the thread.
- Queues, forks, child agents and the rest of T3's orchestration stay in T3's own MCP server and UI.

## Caveats

- The Codex app-server is marked experimental by Codex, and its protocol may change.
- Cursor has no usage API; its quota is read from the CLI's `/usage` screen in a pseudo-terminal.
- How much of the progress stream a client shows is up to the client. The activity list in each
  report does not depend on it.
- Jobs live as long as the server process. Sessions persist in the harness and can be continued.

## Layout

```
plugins/claude-workers/mcp/server.mjs     MCP server: tools, routing, reports, Cursor and dsh web/headless runners
plugins/claude-workers/mcp/acp.mjs         ACP client
plugins/claude-workers/mcp/codex.mjs       Codex app-server client and usage formatting
plugins/claude-workers/mcp/stdio-rpc.mjs   JSON-RPC over a child process's stdio
plugins/claude-workers/agents, commands, skills    Claude Code subagents, slash commands and the routing skill
```

## License

MIT
