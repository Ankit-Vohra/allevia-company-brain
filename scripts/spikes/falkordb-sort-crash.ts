// Reproduces the FalkorDB 6.0.2 sort crash (docs/notes/falkordb-nan-crash.md) on a THROWAWAY server, and shows which
// forms survive. A crash restarts the server and drops every graph on it, so this never touches the shared one:
//
//   docker run -d --name crashlab --restart unless-stopped -p 127.0.0.1:6391:6379 falkordb/falkordb:6.0.2
//   CRASHLAB_URL=redis://127.0.0.1:6391 npx tsx scripts/spikes/falkordb-sort-crash.ts
//   docker rm -f crashlab
//
// (`--restart unless-stopped` lets the container come back by itself after each crash; without it, start it again
// by hand when the script says it is gone.) Each case builds its own tiny graph from nothing, so no data is needed.
import { connect } from "node:net";
import { FalkorDB } from "falkordb";

const url = process.env.CRASHLAB_URL;
if (!url) {
  console.error("Set CRASHLAB_URL to a throwaway FalkorDB, e.g. redis://127.0.0.1:6391 (see the header of this file).");
  process.exit(2);
}
if (/:6390(?!\d)/.test(url)) {
  console.error("Refusing: 6390 is the shared server, and a crash there discards every agent's unsaved work.");
  process.exit(2);
}

// 25 Tasks and 25 Docs, interleaved: asOf is null on every other Task, and the two labels carry two different dates.
const MIXED = "UNWIND range(0, 24) AS i CREATE (:Entity:Task {id: 'task:s' + toString(i), asOf: CASE WHEN i % 2 = 0 THEN '2026-10-10' END}), (:Entity:Doc {id: 'doc:s' + toString(i), asOf: '2026-10-01'})";
const SAME = "UNWIND range(0, 24) AS i CREATE (:Entity:Task {id: 'task:s' + toString(i), asOf: '2026-10-10'}), (:Entity:Doc {id: 'doc:s' + toString(i), asOf: '2026-10-01'})";
const NONE = "UNWIND range(0, 49) AS i RETURN 1";
const MAP = "RETURN {id: n.id, asOf: n.asOf} AS m, score";
const SCAN = "MATCH (n:Entity) WITH n, 1.0 AS score";

const cases: Array<{ name: string; setup: string; query: string; expect: "crash" | "survive" }> = [
  { name: "tied key, map column with a null among two dates", setup: MIXED, query: `${SCAN} ${MAP} ORDER BY score ASC`, expect: "crash" },
  { name: "the same, descending", setup: MIXED, query: `${SCAN} ${MAP} ORDER BY score DESC`, expect: "crash" },
  { name: "unique last key (the fix)", setup: MIXED, query: `${SCAN} ${MAP} ORDER BY score ASC, n.id`, expect: "survive" },
  { name: "LIMIT (top-k, another code path)", setup: MIXED, query: `${SCAN} ${MAP} ORDER BY score ASC LIMIT 10`, expect: "survive" },
  { name: "scalar columns instead of a map", setup: MIXED, query: `${SCAN} RETURN n.id AS id, n.asOf AS asOf, score ORDER BY score ASC`, expect: "survive" },
  { name: "no nulls in the map", setup: SAME, query: `${SCAN} ${MAP} ORDER BY score ASC`, expect: "survive" },
  { name: "fewer than 21 rows", setup: "UNWIND range(0, 8) AS i CREATE (:Entity:Task {id: 'task:s' + toString(i), asOf: CASE WHEN i % 2 = 0 THEN '2026-10-10' END}), (:Entity:Doc {id: 'doc:s' + toString(i), asOf: '2026-10-01'})", query: `${SCAN} ${MAP} ORDER BY score ASC`, expect: "survive" },
  { name: "NaN among numbers", setup: NONE, query: "UNWIND range(0, 49) AS i WITH i, toFloat(0) / toFloat(i % 5) AS r RETURN i, r ORDER BY r ASC", expect: "crash" },
  { name: "NaN among numbers, filtered with r = r", setup: NONE, query: "UNWIND range(0, 49) AS i WITH i, toFloat(0) / toFloat(i % 5) AS r WHERE r = r RETURN i, r ORDER BY r ASC", expect: "survive" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// True once something accepts TCP connections there (a restarting server refuses them, and the client emits an
// unhandled 'error' for a refused connection before a listener can be attached).
const listening = (): Promise<boolean> => new Promise((resolve) => {
  const u = new URL(url);
  const s = connect({ host: u.hostname, port: Number(u.port || 6379) }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

async function open(): Promise<FalkorDB> {
  for (let i = 0; i < 60; i++) {
    if (await listening()) {
      await sleep(1500); // accepting connections is not yet loaded and ready
      try {
        const db = await FalkorDB.connect({ url });
        db.on("error", () => undefined); // a closed socket after a crash is the expected thing
        await db.list();
        return db;
      } catch { /* not ready yet */ }
    }
    await sleep(1000);
  }
  throw new Error("The server did not come back within a minute. Start it again (docker start crashlab) and re-run.");
}

let db = await open();
console.log(`server ${url}`);
let wrong = 0;
for (const c of cases) {
  const g = db.selectGraph("sortcrash");
  try { await g.delete(); } catch { /* none yet */ }
  if (c.setup !== NONE) await g.query(c.setup);
  let outcome: "crash" | "survive";
  try {
    await g.query(c.query);
    outcome = "survive";
  } catch {
    outcome = "crash";
  }
  console.log(`${outcome === c.expect ? "  ok " : " DIFF"}  ${outcome.padEnd(7)} ${c.name}`);
  if (outcome !== c.expect) wrong++;
  if (outcome === "crash") {
    await db.close().catch(() => undefined);
    db = await open(); // the server restarted, and with it every graph on it
  }
}
await db.close().catch(() => undefined);
console.log(wrong ? `${wrong} case(s) differ from what 6.0.2 did when this was written (another version, or a fix)` : "all cases behave as recorded for 6.0.2");
