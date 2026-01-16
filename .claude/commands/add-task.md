---
argument-hint: [task description]
description: Add a task to the list
model: claude-opus-4-5-20251101
---

Define the severity of the task - don't ask user about it - figure out yourself.
The status: Backlog
Add this new task to TASKS.md file with proper (next) number.
Reformat $1 to be proper task description.

If there is a similar task already added, notify user about it and ask if we should continue adding the new task.

Do not propose the solution in the ticket description if user not requested or provided own solution in the $1.
