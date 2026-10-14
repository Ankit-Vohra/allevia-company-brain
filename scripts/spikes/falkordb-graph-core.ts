// Spike for Milestone 1: what graph-core can lean on in FalkorDB 6.0.2 (map params, SET +=, TIMEOUT, SPpaths options,
// algorithm edge filters, result shapes). Touches only graph "spike_core".
import { FalkorDB } from "falkordb";

const db = await FalkorDB.connect({ url: "redis://127.0.0.1:6390" });
const g = db.selectGraph("spike_core");
const results: Record<string, string> = {};
async function probe(name: string, fn: () => Promise<unknown>) {
  try { const r = await fn(); results[name] = "ok " + JSON.stringify(r).slice(0, 300); }
  catch (e) { results[name] = "FAIL " + String((e as Error).message).slice(0, 300); }
}
try { await g.delete(); } catch {}
// a-b-c line via current edges, a-d-c via a closed edge (shorter alternative), e isolated
await g.query(`CREATE (a:Entity:Person {id:'a', name:'A'}), (b:Entity:Task {id:'b', name:'B'}), (c:Entity:Task {id:'c', name:'C'}),
  (d:Entity:Task {id:'d', name:'D'}), (e:Entity:Task {id:'e', name:'E'}), (f:Entity:Task {id:'f', name:'F'}),
  (a)-[:OWNS {since:1}]->(b), (b)-[:BLOCKS {since:1}]->(f), (f)-[:BLOCKS {since:1}]->(c),
  (a)-[:OWNS {since:1, until:5}]->(d), (d)-[:BLOCKS {since:1, until:5}]->(c)`);
await probe("map_param_merge", () => g.query(`MERGE (n:Entity {id:$id}) SET n += $props RETURN n.x AS x, n.y AS y, n.z AS z`,
  { params: { id: "m", props: { x: 1, y: "two \"q\" \\ नमस्ते\nline", z: ["a", "b"] } } }).then(r => r.data));
await probe("map_param_null_removes", () => g.query(`MATCH (n:Entity {id:'m'}) SET n += $props RETURN n.x AS x, keys(n) AS k`,
  { params: { props: { x: null } } }).then(r => r.data));
await probe("unwind_maps", () => g.query(`UNWIND $rows AS row MERGE (n:Entity {id: row.id}) SET n += row.props RETURN n.id AS id`,
  { params: { rows: [{ id: "u1", props: { name: "U1" } }, { id: "u2", props: { name: "U2" } }] } }).then(r => r.data));
await probe("dynamic_label_set", () => g.query(`MATCH (n:Entity {id:'u1'}) SET n:Task RETURN labels(n) AS l`).then(r => r.data));
await probe("timeout_opt", () => g.query(`UNWIND range(1, 3000000) AS x WITH x WHERE x % 7 = 0 RETURN count(x) AS c`, { TIMEOUT: 5 }).then(r => r.data));
await probe("ro_timeout_opt", () => g.roQuery(`UNWIND range(1, 3000000) AS x WITH x WHERE x % 7 = 0 RETURN count(x) AS c`, { TIMEOUT: 5 }).then(r => r.data));
await probe("sp_outgoing", () => g.query(`MATCH (a {id:'a'}),(c {id:'c'}) CALL algo.SPpaths({sourceNode:a, targetNode:c, pathCount:5}) YIELD path, pathWeight, pathCost RETURN [n IN nodes(path) | n.id] AS ids, pathWeight, pathCost`).then(r => r.data));
await probe("sp_both_from_c", () => g.query(`MATCH (a {id:'a'}),(c {id:'c'}) CALL algo.SPpaths({sourceNode:c, targetNode:a, relDirection:'both', pathCount:5}) YIELD path RETURN [n IN nodes(path) | n.id] AS ids`).then(r => r.data));
await probe("sp_incoming", () => g.query(`MATCH (a {id:'a'}),(c {id:'c'}) CALL algo.SPpaths({sourceNode:c, targetNode:a, relDirection:'incoming', pathCount:5}) YIELD path RETURN [n IN nodes(path) | n.id] AS ids`).then(r => r.data));
await probe("sp_maxLen", () => g.query(`MATCH (a {id:'a'}),(c {id:'c'}) CALL algo.SPpaths({sourceNode:a, targetNode:c, relDirection:'both', pathCount:0, maxLen:4}) YIELD path RETURN [n IN nodes(path) | n.id] AS ids`).then(r => r.data));
// cost trick: closed edges get a big cost, maxCost excludes them -- does it prune during search?
await probe("sp_cost_trick", async () => {
  await g.query(`MATCH ()-[r]->() WHERE r.until IS NOT NULL SET r.spCost = 1000000`);
  return (await g.query(`MATCH (a {id:'a'}),(c {id:'c'}) CALL algo.SPpaths({sourceNode:a, targetNode:c, relDirection:'both', pathCount:1, costProp:'spCost', maxCost:1000}) YIELD path, pathCost RETURN [n IN nodes(path) | n.id] AS ids, pathCost`)).data;
});
await probe("sp_unknown_key", () => g.query(`MATCH (a {id:'a'}),(c {id:'c'}) CALL algo.SPpaths({sourceNode:a, targetNode:c, relTypes:['OWNS','BLOCKS'], relFilter:'x'}) YIELD path RETURN length(path)`).then(r => r.data));
await probe("varlen_filtered", () => g.query(`MATCH p=(a:Entity {id:'a'})-[rs*1..4]-(c:Entity {id:'c'}) WHERE all(r IN rs WHERE r.until IS NULL) RETURN [n IN nodes(p) | n.id] AS ids ORDER BY length(p) LIMIT 3`).then(r => r.data));
await probe("shortestPath_filtered", () => g.query(`MATCH (a:Entity {id:'a'}),(c:Entity {id:'c'}) WITH a, c MATCH p = shortestPath((a)-[*..6]-(c)) WHERE all(r IN relationships(p) WHERE r.until IS NULL) RETURN [n IN nodes(p) | n.id] AS ids`).then(r => r.data));
await probe("allShortestPaths_filtered", () => g.query(`MATCH (a:Entity {id:'a'}),(c:Entity {id:'c'}) MATCH p = allShortestPaths((a)-[*..6]-(c)) WHERE all(r IN relationships(p) WHERE r.until IS NULL) RETURN [n IN nodes(p) | n.id] AS ids`).then(r => r.data));
await probe("pagerank_entity", () => g.query(`CALL algo.pageRank('Entity', null) YIELD node, score RETURN node.id AS id, score ORDER BY score DESC`).then(r => r.data));
await probe("pagerank_no_rel_arg", () => g.query(`CALL algo.pageRank('Entity') YIELD node, score RETURN node.id AS id, score`).then(r => r.data));
await probe("wcc_no_opts", () => g.query(`CALL algo.WCC({nodeLabels:['Task'], relationshipTypes:['BLOCKS']}) YIELD node, componentId RETURN node.id AS id, componentId`).then(r => r.data));
await probe("wcc_relprop_filter", () => g.query(`CALL algo.WCC({nodeLabels:['Entity'], relationshipTypes:['BLOCKS'], relationshipProperties:{until:null}}) YIELD node, componentId RETURN node.id AS id, componentId`).then(r => r.data));
await probe("betweenness_empty_rels", () => g.query(`CALL algo.betweenness({nodeLabels:['Entity']}) YIELD node, score RETURN node.id AS id, score`).then(r => r.data));
await probe("labelprop_maxiter", () => g.query(`CALL algo.labelPropagation({nodeLabels:['Entity'], relationshipTypes:['OWNS','BLOCKS'], maxIterations:10}) YIELD node, communityId RETURN node.id AS id, communityId`).then(r => r.data));
await probe("path_shape", () => g.query(`MATCH p=(a:Entity {id:'a'})-[:OWNS]->(b) RETURN p LIMIT 1`).then(r => r.data));
await probe("node_shape", () => g.query(`MATCH (a:Entity {id:'a'}) RETURN a`).then(r => r.data));
await probe("edge_shape", () => g.query(`MATCH ()-[r:OWNS]->() RETURN r LIMIT 1`).then(r => r.data));
await probe("vector_index_entity", async () => {
  await g.query(`CREATE VECTOR INDEX FOR (n:Entity) ON (n.embedding) OPTIONS {dimension:3, similarityFunction:'cosine'}`);
  return (await g.query(`CREATE VECTOR INDEX FOR (n:Entity) ON (n.embedding) OPTIONS {dimension:3, similarityFunction:'cosine'}`)).metadata;
});
await probe("fulltext_twice", async () => {
  await g.query(`CREATE FULLTEXT INDEX FOR (n:Entity) ON (n.name, n.summary)`);
  return (await g.query(`CREATE FULLTEXT INDEX FOR (n:Entity) ON (n.name)`)).metadata;
});
await probe("range_twice", async () => {
  await g.query(`CREATE INDEX FOR (n:Entity) ON (n.id)`);
  return (await g.query(`CREATE INDEX FOR (n:Entity) ON (n.id)`)).metadata;
});
await probe("db_indexes", () => g.query(`CALL db.indexes() YIELD label, properties, types, entitytype RETURN label, properties, types, entitytype`).then(r => r.data));
await probe("vecf32_param", () => g.query(`MATCH (n:Entity {id:'a'}) SET n.embedding = vecf32($v) RETURN n.id AS id`, { params: { v: [0.1, 0.2, 0.3] } }).then(r => r.data));
await probe("big_number_param", () => g.query(`RETURN $n AS n, $f AS f`, { params: { n: 1760000000000, f: 1e21 } }).then(r => r.data));
await g.delete();
for (const [k, v] of Object.entries(results)) console.log(k.padEnd(28), v);
await db.close();
