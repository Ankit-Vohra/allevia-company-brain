// Systems and the work queue: connectors (name and status only) and how many PENDING items are open.
// Tasks belong to the brain source (it reads PENDING.md from the vault through the privacy filter), so this mapper
// emits no Task nodes from brain_pending: only counts by owner, and items under a sensitive heading are not counted.
import { entityId } from "../../../util/ids.js";
import { arr, str, type ChannelKey, type Mapper } from "./builder.js";
import { SENSITIVE_SECTION } from "./privacy.js";

// connectors_status names -> the channel that obviously depends on it.
const CONNECTOR_CHANNEL: Record<string, ChannelKey> = {
  instagram: "instagram", facebook: "facebook", youtube: "youtube", search_console: "google-search",
  play: "app-android", app_store: "app-ios",
};

const connectorsStatus: Mapper = (b, { data: d }) => {
  for (const c of arr(d.connectors)) {
    const name = str(c.connector);
    if (!name || !/^[a-z0-9_-]{1,40}$/i.test(name)) continue;
    // The registry source's id format (entityId("System", name)), so both sources land on one node. Name and status
    // only: messages and details can carry hosts, ids and account names.
    const id = b.node("System", entityId("System", name), name, { kind: "connector", status: str(c.status) ?? "unknown" });
    const ch = CONNECTOR_CHANNEL[name];
    if (ch) b.edge(b.channel(ch), "DEPENDS_ON", id);
  }
};

const ownerBucket = (owner: string | undefined): "founder" | "agent" | "other" =>
  /^founder$/i.test(owner ?? "") ? "founder" : /^agent$/i.test(owner ?? "") ? "agent" : "other";

const brainPending: Mapper = (b, { data: d }) => {
  const counts = { founder: 0, agent: 0, other: 0 };
  let sensitive = 0;
  for (const it of arr(d.items)) {
    if (it.done === true) continue;
    if (SENSITIVE_SECTION.test(str(it.section) ?? "")) { sensitive++; continue; }
    counts[ownerBucket(str(it.owner))]++;
  }
  b.count("sensitive_section_item", sensitive);
  b.obs(b.business, "pending_open_items", counts.founder + counts.agent + counts.other, { unit: "count" });
  for (const [owner, n] of Object.entries(counts)) b.obs(b.business, `pending_open_items_${owner}`, n, { unit: "count" });
};

export const SYSTEM_MAPPERS: Record<string, Mapper> = { connectors_status: connectorsStatus, brain_pending: brainPending };
