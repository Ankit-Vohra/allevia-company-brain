// Channel nodes shared by the playbooks and simulated-ads sources, so both write the same id, name and platform for a
// given channel (MERGE on id then never flaps between sources). Callers add their own provenance (src/asOf/simulated).
import type { NodeInput } from "../../graph/upsert.js";
import { entityId } from "../../util/ids.js";

export type ChannelKey = "instagram" | "website" | "meta-ads" | "google-ads" | "google-search";

const CHANNELS: Record<ChannelKey, { name: string; platform: string }> = {
  instagram: { name: "Instagram", platform: "instagram" },
  website: { name: "Website", platform: "web" },
  "meta-ads": { name: "Meta Ads", platform: "meta" },
  "google-ads": { name: "Google Ads", platform: "google" },
  "google-search": { name: "Google Search", platform: "google" },
};

export const channelId = (key: ChannelKey): string => entityId("Channel", key);

export function channelNode(key: ChannelKey, extra: Partial<Pick<NodeInput, "props" | "src" | "asOf" | "simulated" | "summary">> = {}): NodeInput {
  const c = CHANNELS[key];
  return { type: "Channel", id: channelId(key), name: c.name, ...extra, props: { platform: c.platform, ...extra.props } };
}
