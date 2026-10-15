// docker-compose.yml, the code and the docs agree on the FalkorDB server settings (src/graph/server-config.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { DEFAULT_READ_TIMEOUT_MS, MAX_PAGE } from "../../src/graph/client.js";
import { SERVER_CONFIG, configDrift, falkordbArgs } from "../../src/graph/server-config.js";
import { readSource, sourceFiles } from "../helpers/ts-strings.js";

const compose = parse(readFileSync("docker-compose.yml", "utf8")) as { services: { falkordb: { environment: Record<string, string> } } };
const composeArgs = compose.services.falkordb.environment.FALKORDB_ARGS!;

describe("FalkorDB server settings", () => {
  it("are what docker-compose.yml starts the server with", () => {
    expect(composeArgs).toBe(falkordbArgs());
  });

  it("leave room for the longest time budget the code sends", () => {
    // TIMEOUT above TIMEOUT_MAX is refused by the server, not clamped: the librarian's 120 s algorithm budget needs 120 s
    const budgets = sourceFiles("src").flatMap((f) => [...readSource(f).matchAll(/\b(?:ALGO|GRAPH|QUERY)_TIMEOUT_MS\s*=\s*([\d_]+)/g)].map((m) => Number(m[1]!.replace(/_/g, ""))));
    expect(budgets.length).toBeGreaterThan(0);
    expect(SERVER_CONFIG.TIMEOUT_MAX).toBeGreaterThanOrEqual(Math.max(...budgets, DEFAULT_READ_TIMEOUT_MS));
    expect(SERVER_CONFIG.TIMEOUT_DEFAULT).toBeGreaterThanOrEqual(DEFAULT_READ_TIMEOUT_MS);
  });

  it("keep a result page under RESULTSET_SIZE (rows past it vanish silently)", () => {
    expect(SERVER_CONFIG.RESULTSET_SIZE).toBeGreaterThan(MAX_PAGE);
  });

  it("are the numbers the code's comments quote", () => {
    const text = ["src/graph/client.ts", "src/graph/projection.ts", "src/graph/algorithms.ts", "src/graph/tenants.ts"].map((f) => readSource(f)).join("\n");
    expect(text).toMatch(/RESULTSET_SIZE \(10,000/);
    expect(text).not.toMatch(/MAX_QUEUED_QUERIES \(25/); // the compose file sets 500
  });

  it("reports a server that differs", () => {
    expect(configDrift({ ...SERVER_CONFIG })).toEqual([]);
    expect(configDrift({ ...SERVER_CONFIG, TIMEOUT_MAX: 0, CACHE_SIZE: "25" })).toEqual([
      { name: "TIMEOUT_MAX", want: 120_000, have: 0 },
      { name: "CACHE_SIZE", want: 256, have: "25" },
    ]);
    expect(configDrift({}).map((d) => d.name)).toEqual(Object.keys(SERVER_CONFIG));
  });
});
