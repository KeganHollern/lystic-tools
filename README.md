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
- `goal_update` reports progress on the active goal. It is hidden until a goal starts.

The `/tasks` command shows the subagents.

## `/goal`

`/goal <objective>` starts an autonomous goal.
A planner subagent writes a plan file first.
While the planner or the idea guy runs, your messages are held back.
They ride the next worker round, so the worker sees them in context.
Then this session works in rounds.
When the session and all subagents go idle, the harness injects the next round.

The agent finishes a goal with `goal_update(completed: true)`.
A panel of skeptic subagents then tries to refute the claim.
They audit the evidence the worker saved.
When they refute, the gaps go back to the worker.
After every third failed check, an idea-guy subagent suggests untried approaches.
Blocked reports work the same way: after every 3 blocked reports the idea guy suggests ways to unblock, and 12 in a row pause the goal.
On a pass, a summarizer subagent writes the closing message.

Only a human starts goals.
The agent cannot enter goal mode by itself.

The goal pauses by itself when the model runs out of tokens or the context cannot be compacted.
Send any message when tokens are back, and the goal resumes.
Use `/goal status`, `/goal pause`, `/goal resume`, and `/goal clear` to manage the goal.
Goal state lives in `~/.pi/agent/goals/<goal-id>/` and survives `/reload`.

## Subagents

A subagent is a separate `pi` process.
The default `maxDepth` is 2.
When a subagent completes, it wakes the parent as a `<system-reminder>`.
Goal roles (planner, skeptics, idea guy, summarizer) are normal subagents.
They appear in `/tasks`.

## License

This package uses the MIT license.
