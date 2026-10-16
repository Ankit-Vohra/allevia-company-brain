// Issue #28: a FalkorDB restart must not crash the bot or the server. A fake client stands in for the database and
// answers LOADING (still reading its data back), ECONNREFUSED (not listening yet) or a reset socket, so these tests prove:
// reads and never-ran writes are sent again until the database is back; a write that may have run is never sent twice;
// a database that stays down ends in DatabaseWakingUp with the owner's sentence; the Discord bot and the API say that
// sentence instead of failing; and the process guard logs an outage instead of exiting.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import type { Graph } from "falkordb";
import { GraphHandle, pingServer } from "../../src/graph/client.js";
import { DatabaseWakingUp, dbOutage, isDbUnavailable, untilAwake, WAKING_UP_MESSAGE } from "../../src/graph/waking.js";
import { crashGuardHandlers } from "../../src/util/crash-guard.js";
import { AlleviaBot, type ButtonPort, type CommandPort, type MessagePort, type Outgoing } from "../../src/discord/bot.js";
import { harness, type Harness } from "../server/harness.js";

// What node-redis and Node actually throw while the server restarts.
const loading = () => Object.assign(new Error("LOADING Redis is loading the dataset in memory"), { name: "SimpleError" });
const refused = () => Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6390"), { code: "ECONNREFUSED" })], ""), { code: "ECONNREFUSED" });
const reset = () => Object.assign(new Error("Socket closed unexpectedly"), { name: "SocketClosedUnexpectedlyError" });

// A fake database: each call takes the next scripted failure, then answers.
function fakeDb(script: Array<() => Error>) {
  const calls: Array<"query" | "roQuery"> = [];
  const next = async (via: "query" | "roQuery") => {
    calls.push(via);
    const fail = script.shift();
    if (fail) throw fail();
    return { data: [{ ok: 1 }] };
  };
  const g = { query: () => next("query"), roQuery: () => next("roQuery") } as unknown as Graph;
  return { g, calls };
}

// A fake clock, so waiting out a restart takes no real time.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const handle = (g: Graph, waitMs = 20_000) => new GraphHandle("allevia_stub", g, undefined, { waitMs, ...clock() });

describe("which errors mean the database is restarting", () => {
  it("knows LOADING, a refused connection and a reset socket, and nothing else", () => {
    expect(dbOutage(loading())).toBe("never_ran");
    expect(dbOutage(refused())).toBe("never_ran");
    expect(dbOutage(new Error("The client is closed"))).toBe("never_ran");
    expect(dbOutage(reset())).toBe("maybe_ran");
    expect(dbOutage(new Error("wrapped", { cause: loading() }))).toBe("never_ran");
    expect(dbOutage(new Error("Query timed out"))).toBeNull();
    expect(dbOutage(new Error("errMsg: Invalid input 'X'"))).toBeNull();
    expect(isDbUnavailable(new DatabaseWakingUp())).toBe(true);
  });
});

describe("GraphHandle waits out a restart", () => {
  it("sends a read again while the database is LOADING, then answers", async () => {
    const db = fakeDb([loading, loading, refused]);
    expect(await handle(db.g).roQuery("MATCH (n:Entity) RETURN n.id AS id LIMIT 1")).toEqual([{ ok: 1 }]);
    expect(db.calls).toEqual(["roQuery", "roQuery", "roQuery", "roQuery"]);
  });

  it("sends a write again when the server never took it (ECONNREFUSED, LOADING)", async () => {
    const db = fakeDb([refused, loading]);
    expect(await handle(db.g).query("MERGE (n:Entity {id:'x'}) RETURN n.id AS id")).toEqual([{ ok: 1 }]);
    expect(db.calls).toHaveLength(3);
  });

  it("never sends a write twice once it may have run (the socket broke after it was sent)", async () => {
    const db = fakeDb([reset]);
    await expect(handle(db.g).query("CREATE (n:Entity {id:'x'})")).rejects.toThrow(DatabaseWakingUp);
    expect(db.calls).toEqual(["query"]);
  });

  it("sends a read again after a reset socket", async () => {
    const db = fakeDb([reset]);
    expect(await handle(db.g).roQuery("MATCH (n:Entity) RETURN n.id AS id LIMIT 1")).toEqual([{ ok: 1 }]);
  });

  it("gives up with the owner's sentence when the database stays down", async () => {
    const db = fakeDb(Array.from({ length: 1000 }, () => loading));
    const e = await handle(db.g, 10_000).roQuery("MATCH (n:Entity) RETURN n.id AS id LIMIT 1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DatabaseWakingUp);
    expect((e as Error).message).toBe(WAKING_UP_MESSAGE);
    expect(db.calls.length).toBeGreaterThan(3);
    expect(db.calls.length).toBeLessThan(30); // a growing pause, not a busy loop
  });

  it("does not retry an ordinary failure", async () => {
    let n = 0;
    const g = { roQuery: async () => { n++; throw new Error("errMsg: Invalid input"); } } as unknown as Graph;
    await expect(handle(g).roQuery("MATCH (n:Entity) RETURN n.id AS id LIMIT 1")).rejects.toThrow(/Invalid input/);
    expect(n).toBe(1);
  });

  it("untilAwake with no wait fails at once with DatabaseWakingUp", async () => {
    await expect(untilAwake(async () => { throw refused(); }, { waitMs: 0 })).rejects.toThrow(DatabaseWakingUp);
  });
});

describe("the readiness PING before connecting", () => {
  let server: Server;
  let port = 0;
  let reply = "+PONG\r\n";
  beforeAll(async () => {
    server = createServer((s) => s.on("data", () => s.write(reply)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("passes when the server answers PONG", async () => {
    reply = "+PONG\r\n";
    await expect(pingServer(`redis://127.0.0.1:${port}`)).resolves.toBeUndefined();
  });

  it("fails with LOADING while the server reads its data back", async () => {
    reply = "-LOADING Redis is loading the dataset in memory\r\n";
    const e = await pingServer(`redis://127.0.0.1:${port}`).catch((x: unknown) => x);
    expect(dbOutage(e)).toBe("never_ran");
  });

  it("fails with ECONNREFUSED when nothing listens", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const p = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const e = await pingServer(`redis://127.0.0.1:${p}`).catch((x: unknown) => x);
    expect(dbOutage(e)).toBe("never_ran");
  });
});

describe("the Discord bot while the database restarts", () => {
  const GUILD = "100000000000000001";
  const CHANNEL = "200000000000000002";
  const down = () => handle(fakeDb(Array.from({ length: 1000 }, () => loading)).g, 0);
  const bot = () => new AlleviaBot({ tenant: "mini", guildId: GUILD, channelId: CHANNEL, webBase: "http://x", graph: down(),
    ask: async () => { throw new DatabaseWakingUp(); }, log: () => {} });
  const text = (m: Outgoing) => (typeof m === "string" ? m : m.content);

  it("answers /brief and /approvals in plain words instead of failing", async () => {
    for (const name of ["brief", "approvals"]) {
      const said: Array<{ m: string; ephemeral: boolean }> = [];
      const c: CommandPort = {
        command: name, guildId: GUILD, channelId: CHANNEL, threadParentId: null, userId: "1", isOwner: true,
        defer: async () => {}, respond: async (m, o) => { said.push({ m: text(m), ephemeral: !!o?.ephemeral }); },
        followUp: async () => ({ id: "p", edit: async () => {} }), thread: () => null, createThread: async () => { throw new Error("no"); },
      };
      await bot().onCommand(c);
      expect(said).toEqual([{ m: WAKING_UP_MESSAGE, ephemeral: true }]);
    }
  });

  it("replies to a message, and a button, with the same sentence", async () => {
    const replies: string[] = [];
    const m: MessagePort = {
      id: "m1", guildId: GUILD, channelId: CHANNEL, threadParentId: null, authorId: "1", authorIsBot: false, authorIsOwner: true, system: false,
      content: "How are enquiries this week?", thread: () => null,
      startThread: async () => ({ id: "t1", send: async () => ({ id: "p", edit: async () => {} }) }),
      reply: async (o) => { replies.push(text(o)); },
    };
    await bot().onMessage(m);
    expect(replies).toEqual([WAKING_UP_MESSAGE]);

    const said: string[] = [];
    const b: ButtonPort = { customId: "allevia:approve:appr:x", guildId: GUILD, userId: "1", isOwner: true,
      reply: async (t) => { said.push(t); }, update: async () => {} };
    await bot().onButton(b);
    expect(said).toEqual([WAKING_UP_MESSAGE]);
  });
});

describe("the process guard", () => {
  it("logs a database outage and carries on; any other uncaught error stops the process", () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const h = crashGuardHandlers({ log: (l) => lines.push(l), exit: (c) => exits.push(c) });
    h.onException(loading());
    h.onRejection(refused());
    h.onRejection(new DatabaseWakingUp(loading()));
    expect(exits).toEqual([]);
    expect(lines.every((l) => /database is restarting/.test(l))).toBe(true);
    h.onRejection(new Error("lost promise"));
    expect(exits).toEqual([]);
    h.onException(new TypeError("x is not a function"));
    expect(exits).toEqual([1]);
  });
});

describe("the API while the database restarts", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h.cleanup(); });

  it("answers 503 with the owner's sentence, not a 500", async () => {
    const app = h.make({ listTenants: async () => { throw loading(); } });
    const res = await app.request("/api/tenants");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: WAKING_UP_MESSAGE });
  });
});
