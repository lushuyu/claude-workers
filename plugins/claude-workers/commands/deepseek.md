---
description: Hand a task to DeepSeek (dsh) and review the result
argument-hint: <task>
---
Use the `claude-workers:deepseek` subagent to hand this task to DeepSeek (`worker_run` with `engine: "deepseek"`) and review the result. The project directory is the current working directory unless the task names another. Pass the request through faithfully and add the context the subagent needs: it does not see this conversation.

Task: $ARGUMENTS
