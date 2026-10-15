// `db:migrate` and `db:check`: bring a tenant graph written by older code up to the current schema, and report the server's
// settings against docker-compose.yml. A throwaway registry and tenant, never the real ones.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { loadCommands } from "../../src/cli.js";
import { closeAll, openGraph, openGraphByName } from "../../src/graph/client.js";
import { ensureTenant } from "../../src/graph/tenants.js";

const slug = `test_mig_${randomBytes(4).toString("hex")}`;
const meta = `allevia_test_meta_${randomBytes(4).toString("hex")}`;

describe("db:migrate (integration)", () => {
  const saved = process.env.ALLEVIA_META_GRAPH;
  beforeAll(async () => {
    process.env.ALLEVIA_META_GRAPH = meta;
    await ensureTenant({ slug, name: "Migration test" });
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.ALLEVIA_META_GRAPH;
    else process.env.ALLEVIA_META_GRAPH = saved;
    await (await openGraph(slug)).drop();
    await (await openGraphByName(meta)).drop();
    await closeAll();
  });

  const run = async (name: string, args: string[]): Promise<{ code: number | void; out: string }> => {
    const cmd = (await loadCommands()).find((c) => c.name === name)!;
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
    const err = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); });
    try {
      return { code: await cmd.run(args), out: lines.join("\n") };
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  };

  it("labels and keys what an older writer left, and says what it did; a second run changes nothing", async () => {
    const g = await openGraph(slug);
    await g.query(`CREATE (:Entity:Decision {id:'decision:old', name:'Old decision'}),
      (:Entity:Observation {id:'obs:Signups:business:x:2026-10-01', metric:'Signups', subject:'business:x', asOf:'2026-10-01', value:3})`);
    const first = await run("db:migrate", [slug]);
    expect(first.code).toBe(0);
    expect(first.out).toContain(`${slug.padEnd(16)} allevia_${slug}: 1 labelled Searchable, 1 metricKeys, 0 duplicate nodes merged`);
    expect(first.out).toMatch(/MANDATORY OPERATIONAL/);
    expect(first.out).toMatch(/UNIQUE OPERATIONAL/);
    const second = await run("db:migrate", [slug]);
    expect(second.out).toContain("0 labelled Searchable, 0 metricKeys");
  });

  it("refuses a tenant that is not registered", async () => {
    const r = await run("db:migrate", ["nobody_here"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("No such tenant: nobody_here");
  });

  it("db:check reports the server's settings against the compose file", async () => {
    const r = await run("db:check", []);
    expect(r.out).toMatch(/Server settings: as docker-compose\.yml|Server settings differ from docker-compose\.yml: /);
  });
});
