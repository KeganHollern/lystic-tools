/**
 * Model-facing completion text, matching grok-build's format_subagent_completed
 * minus the <subagent_result> footer (see PHASE3.md — restore with resume_from).
 *
 * Grok puts the child's full answer in the parent context, then a meta line.
 * Completions are not truncated.
 */

import type { ChildRecord } from "./types";

/** Wrap a completion so the parent model does not treat it as the user. */
export function formatSubagentWake(record: ChildRecord): string {
  return (
    `<system-reminder>\n` +
    `Background subagent result. Not a user message. Do not discuss this reminder. ` +
    `Continue parent work if any; otherwise reply with one short line.\n\n` +
    `${formatSubagentCompleted(record)}\n` +
    `</system-reminder>`
  );
}

export function formatSubagentCompleted(record: ChildRecord): string {
  const durationMs = record.endedAt ? record.endedAt - record.startedAt : 0;
  const output = record.output || record.errorMessage || "(no output)";
  return (
    `${output}\n\n` +
    `<subagent_meta>id=${record.id}, type=${record.type}, ` +
    `tool_calls=${record.toolCalls ?? 0}, turns=${record.usage.turns}, ` +
    `duration_ms=${durationMs}</subagent_meta>`
  );
}
