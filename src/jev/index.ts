import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JEV_CONFIG, SUBAGENT_DEPTH } from "../config";
import { JevClient, JEV_FEATURES, type JevSnapshot } from "./client";

export type { JevFeature, JevMode, JevAnswers, JevOptions } from "./client";
export const jev = new JevClient(JEV_CONFIG, { depth: SUBAGENT_DEPTH });
const ENTRY_TYPE = "lystic-jev";

function report(client: JevClient, detailed: boolean): string {
  const snapshot = client.snapshot();
  const config = client.config;
  const lines = [
    `Jev mode is ${client.mode}. The model is ${config.model}.`,
    `Jev reads the API key from ${config.apiKeyEnv}.`,
    ...JEV_FEATURES.map(feature => `${feature}: ${client.availability(feature).reason}`),
    `Jev used ${snapshot.calls}/${config.maxCallsPerSession} session requests.`,
    snapshot.goalId ? `Jev used ${snapshot.goalCalls}/${config.maxCallsPerGoal} goal requests.` : "No goal is active.",
    `Jev recorded ${snapshot.successes} successful requests, ${snapshot.errors} errors, ${snapshot.aborted} cancellations, and ${snapshot.cacheHits} cache hits.`,
    `Jev used ${snapshot.inputTokens} input tokens and ${snapshot.outputTokens} output tokens. Total request time was ${Math.round(snapshot.latencyMs)} ms.`,
  ];
  if (detailed) {
    for (const feature of JEV_FEATURES) {
      const stats = snapshot.features[feature];
      lines.push(`${feature} used ${stats.calls} requests.`);
      for (const [action, total] of Object.entries(stats.actions)) lines.push(`${feature} recorded ${action} ${total} times.`);
    }
    if (!snapshot.recent.length) lines.push("Jev has no recent decisions.");
    for (const item of snapshot.recent) {
      const scores = Object.entries(item.probabilities ?? {}).map(([name, value]) => `${name}=${value.toFixed(3)}`).join(", ");
      lines.push(`${item.feature} returned ${item.outcome} in ${Math.round(item.latencyMs)} ms${scores ? ` with ${scores}` : ""}.`);
    }
  }
  return lines.join("\n");
}

export function registerJev(pi: ExtensionAPI, client: JevClient = jev): void {
  if (SUBAGENT_DEPTH !== 0) return;
  pi.on("session_start", (_event, ctx) => {
    client.setPersistence(undefined);
    let saved: JevSnapshot | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) saved = entry.data as JevSnapshot;
    }
    client.reset(saved);
    client.setPersistence(snapshot => pi.appendEntry(ENTRY_TYPE, snapshot));
  });
  pi.on("session_shutdown", () => { client.invalidate(); client.setPersistence(undefined); });
  pi.on("session_before_switch", () => { client.invalidate(); });
  pi.on("session_before_fork", () => { client.invalidate(); });
  pi.on("session_tree", () => { client.invalidate(); });
  pi.registerCommand("jev", {
    description: "Show Jev status or the Jev decision report.",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command !== "status" && command !== "report") {
        ctx.ui.notify("Use /jev status or /jev report.", "info");
        return;
      }
      const content = report(client, command === "report");
      if (ctx.hasUI) ctx.ui.notify(content, "info");
      else pi.sendMessage({ customType: "lystic-jev-report", content, display: true });
    },
  });
}
