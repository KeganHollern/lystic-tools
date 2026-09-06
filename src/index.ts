import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebSearch } from "./web/search";
import { registerWebFetch } from "./web/fetch";
import { registerSubagents } from "./subagents/index";

export default function (pi: ExtensionAPI) {
  registerWebSearch(pi);
  registerWebFetch(pi);
  registerSubagents(pi);
}
