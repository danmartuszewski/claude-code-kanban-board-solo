# Claude Kanban Board for Solo Developers

A lightweight Kanban board system designed for solo developers using [Claude Code](https://claude.ai/code). Your tasks live in a simple `TASKS.md` file - version controlled, human-readable, always with you.

<!-- TODO: Add demo GIF/screenshot here -->

## Perfect For

- Solo developers working on side projects
- Indie hackers building MVPs
- Anyone who wants Claude to autonomously work through their backlog

## Not For

- Team collaboration (tasks are local to repo)
- Complex project management (use Linear, Jira, etc. for that)

## Key Features

- **Zero dependencies** - Single Node.js file, no npm install needed
- **Git-friendly** - Tasks stored in Markdown, diffs are readable
- **Live updates** - Real-time sync via Server-Sent Events
- **Auto-pilot mode** - Claude picks up tasks when you move them to "To Do"
- **Drag & drop** - Visual Kanban board in your browser
- **Customizable** - Edit statuses and severities in the TASKS.md frontmatter

## Installation

### Option A: Clone and Customize (Recommended for new projects)

```bash
git clone https://github.com/danmartuszewski/claude-kanban-board-solo.git my-project
cd my-project
# Edit TASKS.md to add your own tasks
```

### Option B: Copy to Existing Project

Copy these files to your project root:

```
taskboard.js
taskboard.config.json
TASKS.md
.claude/commands/  (entire folder)
```

Add to your `.gitignore`:

```
claude-runs.log
```

## How to Run

1. **Start the Kanban board server:**

   ```bash
   node taskboard.js
   ```

2. **Open in browser:** http://localhost:4000

3. **Run on different port (optional):**

   ```bash
   node taskboard.js 5000
   ```

The board auto-refreshes when `TASKS.md` changes - even when Claude edits it.

## Slash Commands

Use these commands in Claude Code to manage your tasks:

| Command | Description |
|---------|-------------|
| `/add-task [description]` | Add a new task to backlog |
| `/do-task [number]` | Work on a specific task |
| `/list-tasks` | Show all tasks with status |

### Examples

```
/add-task Add user authentication with JWT
/do-task 3
/list-tasks
```

## Auto-Pilot Mode

Enable "Auto-run Claude" in the browser UI. When you drag a task from **Backlog** to **To Do**, Claude automatically starts working on it.

**How it works:**
1. You move a task to "To Do" in the browser
2. Claude Code launches automatically
3. Claude works on the task
4. Task status updates to "Done" when complete

## Task Format

Tasks are stored in `TASKS.md` using a simple Markdown format:

```markdown
---
statuses: Backlog, To Do, In Progress, Done
severities: Critical, High, Medium
---
1. Task title here

    Severity: High
    Status: To Do

    Task description with details about what needs to be done.
    Can be multiple lines.
---
2. Another task

    Severity: Medium
    Status: Backlog

    Description of the second task.
```

### Customizing Statuses and Severities

Edit the frontmatter at the top of `TASKS.md`:

```markdown
---
statuses: Backlog, To Do, In Progress, Review, Done
severities: Critical, High, Medium, Low
---
```

## Configuration

Edit `taskboard.config.json` to customize behavior:

```json
{
  "autorunEnabled": true,
  "claudeBin": "claude",
  "logPath": "claude-runs.log"
}
```

| Option | Description |
|--------|-------------|
| `autorunEnabled` | Enable/disable auto-pilot mode |
| `claudeBin` | Claude CLI command (customize flags here) |
| `logPath` | Where to log auto-run output |

## Try It Out

This repo includes an example portfolio website (`index.html`) with sample tasks. After cloning:

1. Run `node taskboard.js`
2. Open http://localhost:4000
3. See the example tasks in the Backlog
4. Move a task to "To Do" and watch Claude start working on it

<!-- ## Video Demo -->

<!-- TODO: Add YouTube embed link here -->

## Requirements

- Node.js (any recent version)
- Claude Code CLI installed

## License

MIT
