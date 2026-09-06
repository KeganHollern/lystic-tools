# lystic-tools

Web search, page fetch, and subagents for [pi](https://github.com/badlogic/pi-mono).

## Install

```bash
pi install git:github.com/KeganHollern/lystic-tools
```

Or from this clone:

```bash
pi install /absolute/path/to/lystic-tools
```

Config (optional) lives at `~/.pi/agent/lystic-tools.yaml`. Copy `lystic-tools.yaml.example` to that path and edit.

## Tools

| Tool | Role |
|---|---|
| `web_search` | xAI Responses API search (subscription OAuth, API key fallback). Includes server-side `x_search`. |
| `web_fetch` | Local GET of allowed documentation URLs as markdown. |
| `task` | Spawn a subagent: same model, thinking, and tools as the parent. |
| `task_list` | List immediate child subagents (id, description, status). |
| `task_output` | Wait for or read subagent results. |
| `task_kill` | Kill a subagent and its process group. |
| `task_message` | Steer a live subagent, or resume an idle one. |

## `/tasks`

`/tasks` opens a panel over the chat. The top is a tree of this session’s subagents. The bottom is the selected child’s chat (prompt, tools, assistant text).

Ids look like `brave-apple`. Cost is the child plus its descendants. Nested children show after you expand a parent.

**Tree**

| Key | Action |
|---|---|
| ↑ / ↓ | Move the selection |
| → | Expand children |
| ← | Collapse this row, then the parent |
| Enter | Focus the chat log |
| x | Remove the row from the tree |
| Esc / q | Close |

**Log** (after Enter)

| Key | Action |
|---|---|
| ↑ / ↓ | Scroll the chat |
| Esc | Back to the tree |
| q | Close |

The panel height stays fixed. The mid rule shows id, status, and `1–12/40` for scroll position.

## Subagents

A child is a separate `pi` process with its own context window. At `maxDepth` (default 2), `task` tools are not registered.

Completions wake the parent as a steered `<system-reminder>` (not a user message).

## License

MIT
