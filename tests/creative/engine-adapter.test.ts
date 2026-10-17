// The creating tools use the Studio's real Higgsfield engine (one login, one ledger, the same caps): a picture drawn from a
// description is quoted first, made with no file handed to the CLI, recorded in the ledger; a clip is priced before it is made;
// every decline becomes plain words and never a picture. Fake CLI: no credits are spent.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { higgsfieldCreativeEngine } from "../../src/creative/wiring.js";
import { EngineUnavailable } from "../../src/creative/ports.js";
import { CreditLedger } from "../../src/studio/credits.js";
import { HiggsfieldEngine } from "../../src/studio/higgsfield.js";
import { fakeCli, type FakeCliOpts } from "../helpers/fake-higgsfield.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function rig(cli: FakeCliOpts = {}) {
  const png = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#aa8866" } }).png().toBuffer();
  const fake = fakeCli(cli);
  const ledger = new CreditLedger(tmp("allevia-cr-data-"), { now: () => Date.parse("2026-10-15T09:00:00Z") });
  const hf = new HiggsfieldEngine({ cli: fake.run, ledger, caps: { run: 5, daily: 25 }, balanceFloor: 20, tmpRoot: tmp("allevia-cr-tmp-"), fetchImage: async () => png, timeouts: { account: 1000, cost: 1000, create: 1000, wait: 2000 } });
  return { fake, ledger, engine: higgsfieldCreativeEngine(hf, "kestrel_oak"), png };
}

describe("the creating tools on the Studio's Higgsfield engine", () => {
  it("draws a picture from a description: quoted, created with no input file, in the ledger", async () => {
    const r = await rig({ status: "completed" });
    expect(await r.engine.status()).toMatchObject({ ok: true });
    expect(await r.engine.quote({ prompt: "warm lamps on a table", aspect: "4:5" })).toBe(2);
    const img = await r.engine.generate({ prompt: "warm lamps on a table", aspect: "4:5" });
    expect(img).toMatchObject({ engine: "higgsfield", credits: 2, recorded: false });
    const create = r.fake.calls.find((c) => c.includes("create"))!;
    expect(create).not.toContain("--image");
    expect(create[create.indexOf("--aspect_ratio") + 1]).toBe("4:5");
    expect(r.ledger.entries()).toMatchObject([{ credits: 2, status: "done", tenant: "kestrel_oak" }]);
  });

  it("prices a clip before making one", async () => {
    const r = await rig({ status: "completed" });
    expect(await r.engine.quoteClip!({ seconds: 5, aspect: "9:16" })).toBeGreaterThan(0);
    expect(r.ledger.spentOn()).toBe(0);
  });

  it("turns every decline into plain words, and makes nothing", async () => {
    const missing = await rig({ missing: true });
    expect(await missing.engine.status()).toMatchObject({ ok: false, reason: "no_cli", plain: "pictures aren't switched on yet" });
    const out = await rig({ loggedIn: false });
    expect(await out.engine.status()).toMatchObject({ ok: false, reason: "not_signed_in" });
    await expect(out.engine.generate({ prompt: "x y z", aspect: "1:1" })).rejects.toThrow(EngineUnavailable);
  });
});
