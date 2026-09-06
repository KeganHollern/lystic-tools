# lystic-tools

This package adds web search, page fetch, and subagents to [pi](https://github.com/badlogic/pi-mono).

## Install

Use this command to install from GitHub:

```bash
pi install git:github.com/KeganHollern/lystic-tools
```

Use this command to install from a local clone:

```bash
pi install /absolute/path/to/lystic-tools
```

The configuration file is `~/.pi/agent/lystic-tools.yaml`.
Copy `lystic-tools.yaml.example` to that path.
Then edit the file.

## Tools

You can use these tools:

- `web_search` searches the web.
- `web_fetch` gets allowed documentation URLs as markdown.
- `task` starts a subagent.
- `task_list` lists the immediate child subagents.
- `task_output` waits for or reads subagent results.
- `task_kill` stops a subagent.
- `task_message` sends a message to a live subagent or resumes an idle subagent.

The `/tasks` command shows the subagents.

## Subagents

A subagent is a separate `pi` process.
The default `maxDepth` is 2.
When a subagent completes, it wakes the parent as a `<system-reminder>`.

## License

This package uses the MIT license.
