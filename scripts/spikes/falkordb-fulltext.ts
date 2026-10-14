import { FalkorDB } from "falkordb";
const db = await FalkorDB.connect({ socket: { host: "127.0.0.1", port: 6390 } });
const g = db.selectGraph("spike_ft");
try { await g.delete(); } catch {}
await g.query(`CREATE (:Doc {id:'a', body:'reels drove signups in Raipur'}), (:Doc {id:'b', body:'search console sitemap error'}), (:Doc {id:'c', body:'signup funnel drop'})-[:R]->(:Doc {id:'d', body:'x'})`);
for (const [name, q] of [
  ["create_fulltext_ddl", `CREATE FULLTEXT INDEX FOR (d:Doc) ON (d.body)`],
  ["create_fulltext_proc1", `CALL db.idx.fulltext.createNodeIndex({label:'Doc'}, 'body')`],
  ["query_fulltext", `CALL db.idx.fulltext.queryNodes('Doc', 'signup*') YIELD node, score RETURN node.id AS id, score`],
  ["shortestPath_in_return", `MATCH (a:Doc {id:'c'}),(b:Doc {id:'d'}) RETURN length(shortestPath((a)-[:R*]->(b))) AS len`],
  ["db_indexes", `CALL db.indexes() YIELD label, properties, types RETURN label, properties, types`],
] as const) {
  try { const r = await g.query(q); console.log(name, "ok", JSON.stringify(r.data ?? r.metadata).slice(0, 200)); }
  catch (e) { console.log(name, "FAIL", (e as Error).message.slice(0, 200)); }
}
await g.delete(); await db.close();
