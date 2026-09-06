# Subagents — not built yet (Grok Build gaps)

Track these with `resume_from`. Do not advertise them to the model until they exist.

## resume_from / send_subagent_message

Shipped as **`task_message`** (one tool):
- running/waiting → steer via inbox file
- idle (completed/failed) → new process with `--session` (saved chat)

## `<subagent_result>` footer (deferred)

Grok appends this to every completion:

```
<subagent_result>
subagent_id: …
subagent_type: …
To continue this subagent's conversation, use resume_from="…".
</subagent_result>
```

We dropped it so we do not tell the model to call an API we do not have.
When `resume_from` ships, restore this footer (and drop the extra "use task_output / /tasks" English — Grok does not say that).

Also dropped: extra English telling the parent to use `task_output` or `/tasks`.

## Other gaps

- `isolation: worktree` — git worktree per child, snapshot on finish
- `send_subagent_message` — steer or queue into a running child
- Personas — behavioral overlays with input/output contracts
- MCP inheritance
- Foreground await budget
- Cancel scoping across `/reload` for foreground children
