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
| `task_output` | Wait for or read subagent results. |
| `kill_task` | Kill a subagent and its process group. |

`/tasks` opens a tree of running and finished subagents.

## Subagents

A child is a separate `pi` process with its own context window. At `maxDepth` (default 2), `task` tools are not registered.

Completions wake the parent as a steered `<system-reminder>` (not a user message).

## License

MIT
