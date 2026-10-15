// `mcp`: Allevia's read-only MCP server for one tenant (spec §10; docs/jarvis-integration.md). stdio by default, so an
// MCP client (Jarvis's Claude Code) can run it as a command; `--http` serves Streamable HTTP on 127.0.0.1 instead.
// On stdio, stdout belongs to the protocol: everything this process would print goes to stderr.
import { parseArgs } from "node:util";
import type { Command } from "./_command.js";

const USAGE = "mcp --tenant <slug> [--http] [--port 8788] [--no-vectors]";

// Anything that logs with console.log/info/debug (a library, a warning) would corrupt the MCP stream on stdout.
function stdoutToStderr(): void {
  const toErr = (...xs: unknown[]) => { console.error(...xs); };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

// A check of `Authorization: Bearer <token>` against the owner tokens: valid for this business, or the operator's.
export async function bearerFor(tenant: string): Promise<(req: Request) => Promise<boolean>> {
  const { verifyToken, OPERATOR_SCOPE } = await import("../auth/tokens.js");
  return async (req) => {
    const m = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "");
    const v = m ? await verifyToken(m[1]) : null;
    return !!v && (v.scope === tenant || v.scope === OPERATOR_SCOPE);
  };
}

export const commands: Command[] = [
  {
    name: "mcp",
    usage: USAGE,
    summary: "Serve the read-only graph tools for one tenant over MCP (stdio; --http for Streamable HTTP)",
    async run(args) {
      const { values } = parseArgs({
        args,
        options: {
          tenant: { type: "string" }, http: { type: "boolean" }, port: { type: "string" }, host: { type: "string" },
          "no-vectors": { type: "boolean" },
        },
      });
      const http = values.http === true;
      if (!http) stdoutToStderr();
      const tenant = values.tenant?.trim();
      if (!tenant) { console.error(`Usage: npm run cli -- ${USAGE}`); return 2; }
      const port = Number(values.port ?? 8788);
      if (!(Number.isInteger(port) && port > 0 && port < 65536)) { console.error(`--port must be a TCP port, got "${values.port}"`); return 2; }

      const { tenantGraph, localEmbedder } = await import("../agent/wiring.js");
      const graph = await tenantGraph(tenant);
      const embedQuery = values["no-vectors"] ? undefined : await localEmbedder();
      const opts = { tenant, graph, ...(embedQuery ? { embedQuery } : {}) };
      const mcp = await import("../mcp/server.js");
      const how = `${mcp.MCP_TOOL_NAMES.length} read-only tools, ${embedQuery ? "full-text + vector" : "full-text"} search`;

      if (http) {
        // With ALLEVIA_AUTH=1 the HTTP transport needs this business's owner token (or the operator's) as a bearer token.
        // stdio has no caller to ask: whoever can run this command is the operator, as with every other CLI command.
        const authorize = (await import("../config.js")).loadConfig().authRequired ? await bearerFor(tenant) : undefined;
        const { url, close } = await mcp.serveHttp({ ...opts, port, ...(authorize ? { authorize } : {}), ...(values.host ? { host: values.host } : {}) });
        console.error(`Allevia MCP (${tenant}, ${how}) on ${url}`);
        const { untilStopped } = await import("../server/main.js");
        await untilStopped(close);
        return 0;
      }
      console.error(`Allevia MCP (${tenant}, ${how}) on stdio`);
      await mcp.serveStdio(opts);
      return 0;
    },
  },
];
