// Spike: which FalkorDB 6.0.2 features can the agent rely on? Prints a capability table; touches only graph "spike_caps".
import { FalkorDB } from "falkordb";

const db = await FalkorDB.connect({ socket: { host: "127.0.0.1", port: 6390 } });
const g = db.selectGraph("spike_caps");
const results: Record<string, string> = {};
async function probe(name: string, fn: () => Promise<unknown>) {
  try { const r = await fn(); results[name] = "ok " + JSON.stringify(r).slice(0, 160); }
  catch (e) { results[name] = "FAIL " + String((e as Error).message).slice(0, 160); }
}
try { await g.delete(); } catch {}
await g.query(`CREATE (a:Doc {id:'a', name:'alpha', body:'reels drove signups'})-[:LINKS_TO {w:1}]->(b:Doc {id:'b', name:'beta', body:'search console sitemap'}),
  (b)-[:LINKS_TO {w:1}]->(c:Doc {id:'c', name:'gamma', body:'instagram token expiry'}), (a)-[:LINKS_TO {w:1}]->(c), (d:Doc {id:'d', name:'delta', body:'orphan'})`);
await probe("ro_query", () => g.roQuery(`MATCH (n:Doc) RETURN count(n) AS n`).then(r => r.data));
await probe("ro_query_rejects_write", () => g.roQuery(`CREATE (:X)`).then(() => "WRITE ALLOWED (bad)"));
await probe("shortestPath_fn", () => g.query(`MATCH (a:Doc {id:'a'}),(c:Doc {id:'c'}) WITH a,c MATCH p=shortestPath((a)-[:LINKS_TO*]->(c)) RETURN length(p) AS len`).then(r => r.data));
await probe("algo.SPpaths", () => g.query(`MATCH (a:Doc {id:'a'}),(c:Doc {id:'c'}) CALL algo.SPpaths({sourceNode:a, targetNode:c, relTypes:['LINKS_TO'], pathCount:2}) YIELD path RETURN length(path) AS len`).then(r => r.data));
await probe("algo.BFS", () => g.query(`MATCH (a:Doc {id:'a'}) CALL algo.BFS(a, 3, 'LINKS_TO') YIELD nodes RETURN size(nodes) AS n`).then(r => r.data));
await probe("algo.pageRank", () => g.query(`CALL algo.pageRank('Doc','LINKS_TO') YIELD node, score RETURN node.id AS id, score ORDER BY score DESC`).then(r => r.data));
await probe("algo.betweenness", () => g.query(`CALL algo.betweenness({nodeLabels:['Doc'], relationshipTypes:['LINKS_TO']}) YIELD node, score RETURN node.id AS id, score`).then(r => r.data));
await probe("algo.WCC", () => g.query(`CALL algo.WCC({nodeLabels:['Doc'], relationshipTypes:['LINKS_TO']}) YIELD node, componentId RETURN node.id AS id, componentId`).then(r => r.data));
await probe("algo.labelPropagation", () => g.query(`CALL algo.labelPropagation({nodeLabels:['Doc'], relationshipTypes:['LINKS_TO']}) YIELD node, communityId RETURN node.id AS id, communityId`).then(r => r.data));
await probe("fulltext_index", async () => { await g.query(`CALL db.idx.fulltext.createNodeIndex('Doc', 'body')`); return (await g.query(`CALL db.idx.fulltext.queryNodes('Doc', 'signups') YIELD node, score RETURN node.id AS id, score`)).data; });
await probe("vector_index", async () => {
  await g.query(`CREATE VECTOR INDEX FOR (d:Doc) ON (d.emb) OPTIONS {dimension:3, similarityFunction:'cosine'}`);
  await g.query(`MATCH (d:Doc {id:'a'}) SET d.emb = vecf32([1.0,0.0,0.0])`);
  await g.query(`MATCH (d:Doc {id:'b'}) SET d.emb = vecf32([0.0,1.0,0.0])`);
  return (await g.query(`CALL db.idx.vector.queryNodes('Doc','emb',2,vecf32([0.9,0.1,0.0])) YIELD node, score RETURN node.id AS id, score`)).data;
});
await probe("range_index", () => g.query(`CREATE INDEX FOR (d:Doc) ON (d.id)`).then(r => r.metadata));
await probe("params", () => g.query(`MATCH (d:Doc) WHERE d.id IN $ids RETURN d.id AS id`, { params: { ids: ["a", "c"] } }).then(r => r.data));
await probe("datetime_fn", () => g.query(`RETURN timestamp() AS ts, localdatetime() AS ldt`).then(r => r.data));
await probe("path_return_shape", () => g.query(`MATCH p=(a:Doc {id:'a'})-[:LINKS_TO]->(b) RETURN p LIMIT 1`).then(r => r.data));
await probe("list_graphs", () => db.list());
await g.delete();
console.table(results);
await db.close();
