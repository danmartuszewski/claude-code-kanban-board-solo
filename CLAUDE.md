# Claude Code Instructions

This project uses a Kanban board system for task management. Tasks are stored in `TASKS.md`.

## Working on Tasks

1. Read the task from `TASKS.md`
2. Change status to "In Progress" before starting
3. Complete the work
4. Change status to "Done" and add a resolution note

## Task Format

```markdown
1. Task title

    Severity: High
    Status: In Progress

    Task description...

    Resolution: Brief note about what was done.
```

## Available Commands

- `/add-task [description]` - Add a new task
- `/do-task [number]` - Work on a specific task
- `/list-tasks` - Show all tasks

## Running the Kanban Board

```bash
node taskboard.js
```

Opens at http://localhost:4000
