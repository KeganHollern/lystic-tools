import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebSearch } from "./web/search";
import { registerWebFetch } from "./web/fetch";
import { registerSubagents } from "./subagents/index";
import { registerJev } from "./jev/index";

export default function (pi: ExtensionAPI) {
  registerJev(pi);
  registerWebSearch(pi);
  registerWebFetch(pi);
  registerSubagents(pi);
}
