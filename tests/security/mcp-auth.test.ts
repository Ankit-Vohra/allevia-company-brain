// The MCP server over HTTP with ALLEVIA_AUTH=1: bound to one business, and only that business's owner token (or the
// operator's) is let in. Without the flag it is loopback-only, as before.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueToken, revokeToken } from "../../src/auth/tokens.js";
import { bearerFor } from "../../src/cli/mcp.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { createMcpHttpApp } from "../../src/mcp/server.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { seededGraph } from "../helpers/tools.js";

const metaGraph = testGraphName();
const saved = process.env.ALLEVIA_META_GRAPH;
let g: GraphHandle;
let tokenA: string;
let tokenB: string;
let tokenOp: string;
let revoked: string;

const PORT = 8798;
const call = (app: ReturnType<typeof createMcpHttpApp>, headers: Record<string, string> = {}) =>
  app.request(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: `127.0.0.1:${PORT}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

beforeAll(async () => {
  process.env.ALLEVIA_META_GRAPH = metaGraph;
  ({ g } = await seededGraph());
  const meta = await openGraphByName(metaGraph);
  await meta.query("CREATE (:Tenant {slug:'test_mcp_a', name:'A', graph:'x', businessId:'b', ontologyVersion:1, createdAt:1, updatedAt:1}), (:Tenant {slug:'test_mcp_b', name:'B', graph:'x', businessId:'b', ontologyVersion:1, createdAt:1, updatedAt:1})", {});
  tokenA = (await issueToken("test_mcp_a")).token;
  tokenB = (await issueToken("test_mcp_b")).token;
  tokenOp = (await issueToken("operator")).token;
  const r = await issueToken("test_mcp_a");
  revoked = r.token;
  await revokeToken({ tokenId: r.tokenId });
});
afterAll(async () => {
  if (saved === undefined) delete process.env.ALLEVIA_META_GRAPH; else process.env.ALLEVIA_META_GRAPH = saved;
  await (await openGraphByName(metaGraph)).drop();
  await g.drop();
  await closeAll();
});

describe("MCP over HTTP with owner links", () => {
  it("lets in the business's own token and the operator's, and nobody else", async () => {
    const app = createMcpHttpApp({ tenant: "test_mcp_a", graph: g, port: PORT, now: () => SEED_NOW, authorize: await bearerFor("test_mcp_a") });
    expect((await call(app)).status).toBe(401);
    expect((await call(app, { authorization: `Bearer ${tokenA}` })).status).toBe(200);
    expect((await call(app, { authorization: `Bearer ${tokenOp}` })).status).toBe(200);
    for (const authorization of [`Bearer ${tokenB}`, `Bearer ${revoked}`, tokenA, `Bearer ${tokenA} x`, "Bearer", "Basic x", `Bearer ${tokenA}x`]) {
      expect((await call(app, { authorization })).status, authorization.slice(0, 20)).toBe(401);
    }
  });

  it("a token in the URL or a made-up header does not count", async () => {
    const app = createMcpHttpApp({ tenant: "test_mcp_a", graph: g, port: PORT, now: () => SEED_NOW, authorize: await bearerFor("test_mcp_a") });
    const res = await app.request(`http://127.0.0.1:${PORT}/mcp?key=${tokenA}&token=${tokenA}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: `127.0.0.1:${PORT}`, "x-api-key": tokenA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("without the flag nothing is asked for (local development), and the loopback rules still apply", async () => {
    const app = createMcpHttpApp({ tenant: "test_mcp_a", graph: g, port: PORT, now: () => SEED_NOW });
    expect((await call(app)).status).toBe(200);
    expect((await call(app, { host: "evil.example:8798" })).status).toBe(403);
  });
});
