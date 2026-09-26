# lystic-tools

This package adds web search, page fetch, subagents, autonomous goals, and optional Jev checks to [pi](https://github.com/badlogic/pi-mono).

## Install

Use this command to install from GitHub:

```bash
pi install git:github.com/KeganHollern/lystic-tools
```

Use this command to install from a local clone.
A local path install does not install npm dependencies.
Run `npm install` in the clone first:

```bash
cd /absolute/path/to/lystic-tools
npm install
pi install /absolute/path/to/lystic-tools
```

The config file is `~/.pi/agent/lystic-tools.yaml`.
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
Optional Jev checks can defer routine notices until the next parent turn.
The full report stays available through `task_output` and `/tasks`.
Goal roles (planner, skeptics, idea guy, summarizer) are normal subagents.
They appear in `/tasks`.

## Optional Jev features

[Jev](https://docs.typesafe.ai/introduction) answers small questions about evidence.
The extension uses its answers for these optional features:

- `completionCheck` compares observed failures and unfinished work in the completion claim with the goal's acceptance criteria.
  The check runs before the skeptic panel starts.
  A clear contradiction sends the evidence back to the worker for 1 correction round per panel cycle.
  Uncertain results use the normal panel. Only the skeptic panel can approve completion.
- `stuckDetection` checks repeated failures across goal rounds.
  A clear lack of progress starts the idea-guy subagent earlier, with at least 3 rounds between Jev interventions.
- `evidenceSelection` selects verbatim sections from large `web_fetch` and `task_output` results.
  It preserves errors, summary sections, and access to the full local output.
  Small results, oversized requests, and uncertain sections keep their current text.
- `wakeTriage` defers routine child notices without an extra parent turn.
  Failures and the last result for an idle parent still cause an immediate turn.
  Goal-role notices follow the goal controller's rules.

All Jev calls run in the root session.
Children keep the parent's model. Jev does not select agent models.
Users without a Jev key keep the normal agent behavior.

### Set the API key variable

Set your TypeSafe API key in `TYPESAFE_API_KEY` before you start `pi`.
To use another variable, set its name in the config:

```yaml
jev:
  enabled: auto
  apiKeyEnv: MY_TYPESAFE_KEY
  mode: active
  model: jev-1.13.0
  timeoutMs: 1500
  maxCallsPerGoal: 30
  maxCallsPerSession: 100
  maxInputChars: 24000
  features:
    completionCheck: true
    stuckDetection: true
    evidenceSelection: true
    wakeTriage: true
```

`apiKeyEnv` contains the variable name, not the key.
Its default is `TYPESAFE_API_KEY`.
The other values above are the defaults.
Use `/reload` after a config change.

- `enabled: auto` uses Jev when the configured key exists.
- `enabled: false` or `mode: off` stops all Jev requests.
- `mode: active` applies enabled features.
- `mode: shadow` records Jev decisions and keeps the current agent behavior.
  Shadow mode still sends requests and uses TypeSafe credits.
- Each feature accepts `false` to disable it separately.

API errors, timeouts, absent keys, and spent request budgets use the current agent behavior.
Repeated API errors pause requests for a short period.
The extension discards stale goal decisions after a pause, clear, or session change.

### Select result excerpts

Both `web_fetch` and `task_output` accept an optional `focus` string.
For example, use `focus: "Find the retry limits and timeout behavior"`.
Without `focus`, web fetch uses the current goal and latest user request.
Task output uses the child's task prompt.
An excerpt includes a path to the full local result.
Jev never writes a replacement summary.

### Inspect Jev

Use `/jev status` to check the key variable, mode, feature availability, and request budgets.
Use `/jev report` to see request counts, token use, elapsed time, errors, decisions, and applied actions.
The report survives `/reload` through metadata in the Pi session.
It does not contain request text or API keys.

Requests go to the official TypeSafe API at `https://api.typesafe.ai/v1/systemone`.
They contain selected task text, criteria, and result excerpts.
The client removes known credentials and common secret patterns before each request.
This filter cannot identify every form of sensitive content.
Use `enabled: false` for work that must stay local.

## Development

The development checks need Node.js 22.19 or newer.
Run these commands to check a change:

```bash
npm install
npm test
npm run typecheck
```

The tests use local fixtures and mock HTTP responses. They do not need a Jev key.

## License

This package uses the MIT license.
