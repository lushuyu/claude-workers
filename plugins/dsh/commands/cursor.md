---
description: Hand a task to Cursor (Cursor CLI) and review the result
argument-hint: [model] <task>
---
Use the `dsh:worker` subagent to hand this task to Cursor (`dsh_run` with `engine: "cursor"`) and review the result. If the arguments start with a Cursor model id (for example `grok-4.7-high`), pass it as `model`; otherwise Cursor uses its Auto mode. The project directory is the current working directory unless the task names another. Pass the request through faithfully and add the context the subagent needs: it does not see this conversation.

Task: $ARGUMENTS
