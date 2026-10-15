# Plugging Allevia into Jarvis (MCP)

Allevia ships a read-only MCP server that exposes one business's company brain to another agent. Jarvis, the founder's
Discord agent, will use it in phase 2 to answer from Allevia's graph: decisions and why they were made, who owns what,
what breaks if something fails, and metric trends, with the sources behind each answer.

Nothing in Jarvis changes during the hackathon. This page is the recipe for when it does.

## What it is

- **Read-only.** It registers only the 11 read tools below. The server refuses to start if a write tool (`remember`,
  `propose_action`, or anything flagged as a write) is ever added to its list. Every call also runs in read-only mode,
  and `cypher` uses `GRAPH.RO_QUERY` behind its own write guard. Nothing an MCP client sends can change the graph.
- **One tenant per server.** `--tenant aamdani` binds the server to the graph `allevia_aamdani`, which must already
  exist. A client cannot reach another business. To serve two businesses, run two servers.
- **Results are JSON.** Each tool returns its `ToolResult`, `{data, nodes, edges, sources, note?}`, as text content and
  as `structuredContent`. `nodes` and `sources` carry the ids and titles to cite. A mistake the model can fix (an
  unknown id, a refused write) comes back with `data.error` and `isError: true`.

| Tool | What it answers |
|---|---|
| `search` | Full-text plus vector search over entities and document chunks. Start here to find ids. |
| `get_entity` | One node: its properties, current neighbours by type, and how many versions it has (`asOf` for time travel). |
| `neighbors` | Typed one- or two-hop expansion. |
| `find_paths` | Shortest paths between two entities. |
| `trace_decision` | A decision, its evidence and sources, who decided, what it affects, and what it superseded. |
| `who_owns` / `who_knows` | The current owner, and people ranked by what they know about something. |
| `impact_of` | "What breaks if…": downstream dependencies, with a betweenness score. |
| `metric_trend` | A metric's observations over time, with deltas. |
| `recall` | Earlier Allevia threads and the owner's notes about some entities. |
| `cypher` | Read-only Cypher (5 s timeout, 200 rows) for anything the other tools miss. |

## Run it

On the machine that runs FalkorDB (port 6390) and has this repo with `npm install` done:

```sh
npm run cli -- mcp --tenant aamdani                         # stdio: what Claude Code launches
npm run cli -- mcp --tenant aamdani --http --port 8788      # Streamable HTTP at http://127.0.0.1:8788/mcp
```

- `--no-vectors` skips the local embedding model and searches full-text only. Without the model files in `models/`,
  the server runs full-text only anyway; it never downloads anything.
- Over stdio, stdout carries only MCP frames. Logs go to stderr. When launching through npm, use `npm run --silent`,
  because npm otherwise prints its `> allevia cli` banner to stdout.
- The HTTP mode is stateless, binds to 127.0.0.1, and refuses requests whose `Host` or `Origin` is not a loopback name.

The server needs no secrets. It reads `ALLEVIA_FALKORDB_URL` (default `redis://127.0.0.1:6390`) and, optionally,
`ALLEVIA_MODELS_DIR`.

## Add it to Jarvis's Claude Code

Jarvis's Claude Code reads MCP servers from the project's `.mcp.json` (or `claude mcp add`). Replace `/path/to/allevia`
with the checkout's path.

**Same machine as FalkorDB (stdio):**

```json
{
  "mcpServers": {
    "allevia": {
      "command": "/path/to/allevia/node_modules/.bin/tsx",
      "args": ["/path/to/allevia/src/cli.ts", "mcp", "--tenant", "aamdani"],
      "env": { "ALLEVIA_FALKORDB_URL": "redis://127.0.0.1:6390" }
    }
  }
}
```

The equivalent command line:

```sh
claude mcp add allevia --scope project --env ALLEVIA_FALKORDB_URL=redis://127.0.0.1:6390 -- \
  /path/to/allevia/node_modules/.bin/tsx /path/to/allevia/src/cli.ts mcp --tenant aamdani
```

**Jarvis on another box (stdio over SSH).** The graph stays on the Allevia machine and nothing listens on the network.
`allevia-host` is an SSH alias in Jarvis's `~/.ssh/config`:

```json
{
  "mcpServers": {
    "allevia": {
      "command": "ssh",
      "args": ["-T", "allevia-host", "cd /path/to/allevia && node_modules/.bin/tsx src/cli.ts mcp --tenant aamdani"]
    }
  }
}
```

**Or over HTTP through an SSH tunnel.** Start `--http --port 8788` on the Allevia machine, then on Jarvis's box run
`ssh -N -L 8788:127.0.0.1:8788 allevia-host`. Keep the same port number on both ends, because the server checks the
`Host` header. Then add:

```json
{ "mcpServers": { "allevia": { "type": "http", "url": "http://127.0.0.1:8788/mcp" } } }
```

Allow the tools in Jarvis's settings (`"allow": ["mcp__allevia__*"]`). They are all read-only, so they are safe to
allow without a prompt.

## Check it

- `claude mcp list` should show `allevia` as connected, with 11 tools.
- Ask Jarvis "use allevia to search for instagram". It should call `mcp__allevia__search` and cite node ids from the
  result.
- A write attempt such as `cypher` with `CREATE …` comes back refused, and the graph is unchanged.
