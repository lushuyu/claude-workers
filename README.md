# dsh: worker harnesses for Claude, over MCP

Let Claude Code (or any MCP client) hand a task to another coding agent, watch it work, answer
its approval requests and read its plan usage. Built for running SoCLaaS models through
DeepSeek Harness or OpenCode from inside Claude, and it works the same way for Codex, Cursor and
any agent that speaks the Agent Client Protocol (ACP).

Claude itself is left alone: no gateway, no `ANTHROPIC_BASE_URL`, no translation proxy. Your
Claude subscription, Remote Control and the desktop and mobile apps keep working as they do.

```
Claude ──MCP──> dsh-mcp ──ACP──────────────> dsh --profile acp   (DeepSeek Harness: SoCLaaS, DeepSeek, ...)
                        ├─ACP──────────────> opencode acp        (any provider OpenCode has)
                        ├─ACP──────────────> your own agent
                        ├─app-server───────> codex app-server    (your Codex login; usage and credits)
                        └─CLI──────────────> Cursor `agent -p`
```

## What you get

- **Streaming.** DeepSeek Harness, Codex and OpenCode run in long-lived processes, so a task
  starts without a cold boot. The worker's text and tool calls arrive as MCP progress
  notifications while it works, and every report lists the activity since the previous one.
- **Several harnesses, one tool.** `dsh_run(engine: "deepseek" | "codex" | "opencode" | ...)`.
  Which model each harness uses is set in a config file, not in code.
- **Approvals.** A tool call that needs a decision comes back to Claude as `APPROVAL NEEDED`
  and is answered with `dsh_approve`, or is left to the harness's own reviewer where it has one.
- **Plan usage.** `dsh_usage` shows Codex's rate-limit windows (5h, weekly), remaining credits
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
/plugin marketplace add lushuyu/dsh-mcp
/plugin install dsh@shuyu-dsh
```

Then `/worker <task>`, `/deepseek <task>`, `/cursor [model] <task>`, or just ask Claude to hand a
task to DeepSeek / Codex / OpenCode.

### Any other MCP client (MCP server only)

```json
{
  "mcpServers": {
    "dsh": { "command": "node", "args": ["/path/to/repo/plugins/dsh/mcp/dsh-mcp.mjs"] }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `dsh_run(task, cwd, engine?, model?, session_id?, wait_seconds?)` | Run a task in `cwd`. Returns the final message, or a `job_id` when `wait_seconds` runs out. |
| `dsh_wait(job_id)` | Keep waiting; reports what happened since the last report. |
| `dsh_approve(job_id, decision)` | Answer an `APPROVAL NEEDED`: `allow` or `reject`. |
| `dsh_cancel(job_id)` | Stop a task. Its session can be continued later. |
| `dsh_jobs()` | Jobs of this server process. |
| `dsh_usage(refresh?)` | Plan usage per harness. |

## Configuration

`~/.dsh-mcp/config.json` (or the file named by `DSH_MCP_CONFIG`). It is re-read when it changes.
The built-in harnesses (`deepseek`, `codex`, `opencode`, `cursor`) need no entry; an entry
overrides their fields. See [config.example.json](plugins/dsh/config.example.json).

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

- `default`: the engine used when `dsh_run` names none. `auto` (the built-in default) means
  Cursor while its plan has quota left, DeepSeek otherwise.
- Per harness: `model`, `effort`, `approvals`, `disabled`. For your own: `type` (`acp`), `command`,
  `args`, `env`, and `options` (ACP config options by id).
- `deepseek`: `runner` = `acp` (default) | `web` | `headless`.
- `codex`: `sandbox`, `approval`. Unset fields follow `~/.codex/config.toml`.
- `opencode`: `permission` replaces the OpenCode permission set described below.
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

## Caveats

- The Codex app-server is marked experimental by Codex, and its protocol may change.
- Cursor has no usage API; its quota is read from the CLI's `/usage` screen in a pseudo-terminal.
- How much of the progress stream a client shows is up to the client. The activity list in each
  report does not depend on it.
- Jobs live as long as the server process. Sessions persist in the harness and can be continued.

## Layout

```
plugins/dsh/mcp/dsh-mcp.mjs     MCP server: tools, routing, reports, Cursor and dsh web/headless runners
plugins/dsh/mcp/acp.mjs         ACP client
plugins/dsh/mcp/codex.mjs       Codex app-server client and usage formatting
plugins/dsh/mcp/stdio-rpc.mjs   JSON-RPC over a child process's stdio
plugins/dsh/agents, commands, skills    Claude Code subagents, slash commands and the routing skill
```

## License

MIT
