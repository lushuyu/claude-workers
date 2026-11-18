---
description: Hand a task to a worker (Cursor while its quota lasts, else DeepSeek) and review the result
argument-hint: <task>
---
Use the `claude-workers:worker` subagent to hand this task to a worker (`worker_run` with the default engine: Cursor in Auto mode while the Cursor plan keeps 30%+ of its quota, DeepSeek otherwise) and review the result. The project directory is the current working directory unless the task names another. Pass the request through faithfully and add the context the subagent needs: it does not see this conversation.

Task: $ARGUMENTS
