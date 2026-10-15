// Two more synthetic facts on top of seedMini, so the demo company shows why depth matters: the Instagram connector's
// failure reaches a weekly reel batch at hop 3 and the Diwali launch week at hop 4, which a one-hop look (a join)
// never sees. Both are tasks with an owner, so "who owns it" has an answer. Synthetic data only.
//   system:ig-connector <-DEPENDS_ON- system:reel-publisher <-DEPENDS_ON- system:reel-scheduler
//     <-DEPENDS_ON- task:weekly-reel-batch -BLOCKS-> task:diwali-launch
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { D } from "./seed-graph.js";

export async function seedDepthChain(g: GraphHandle): Promise<void> {
  const at = D("2026-10-05");
  await upsertNode(g, { type: "Task", id: "task:weekly-reel-batch", name: "Weekly reel batch", summary: "Film and queue the week's two reels",
    props: { status: "open" }, src: "document:systems-notes", asOf: "2026-10-05" }, at);
  await upsertNode(g, { type: "Task", id: "task:diwali-launch", name: "Diwali launch week", summary: "Festive hiring push across Instagram and the website",
    props: { status: "open" }, src: "document:pending", asOf: "2026-10-12" }, at);
  await upsertEdge(g, { from: "task:weekly-reel-batch", type: "DEPENDS_ON", to: "system:reel-scheduler", src: "document:systems-notes" }, at);
  await upsertEdge(g, { from: "task:weekly-reel-batch", type: "BLOCKS", to: "task:diwali-launch", src: "document:pending" }, at);
  await upsertEdge(g, { from: "person:priya", type: "OWNS", to: "task:weekly-reel-batch" }, at);
  await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:diwali-launch" }, at);
}
