// Where an approved fix lands, over HTTP: tasks by default, the business's own repo on request, never Allevia's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, post, type Harness } from "./harness.js";

describe("server: action target (integration)", () => {
  let h: Harness;
  const founders = process.env.ALLEVIA_ACTION_TENANTS;
  beforeAll(async () => {
    h = await harness();
    delete process.env.ALLEVIA_ACTION_TENANTS; // the harness makes "mini" the founder's own business; these tests are about a customer's
  }, 90_000);
  afterAll(async () => { if (founders === undefined) delete process.env.ALLEVIA_ACTION_TENANTS; else process.env.ALLEVIA_ACTION_TENANTS = founders; await h.cleanup(); });

  const get = async () => (await h.app.request("/api/mini/actions/target")).json();

  it("is tasks inside the app and on Discord until a business says otherwise", async () => {
    expect(await get()).toEqual({ target: "app", label: "Tasks inside the app and on Discord" });
  });

  it("the founder's own business shows the founder's tracker until it chooses otherwise", async () => {
    process.env.ALLEVIA_ACTION_TENANTS = "mini";
    try {
      expect(await get()).toMatchObject({ target: "github", label: expect.stringMatching(/^GitHub issues on /) });
    } finally {
      delete process.env.ALLEVIA_ACTION_TENANTS;
    }
  });

  it("a business can choose its own repo, and go back", async () => {
    const res = await post(h.app, "/api/mini/actions/target", { target: "github", repo: "kestrel-dental/website-fixes" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ target: "github", repo: "kestrel-dental/website-fixes", label: "GitHub issues on kestrel-dental/website-fixes" });
    expect(await get()).toMatchObject({ target: "github", repo: "kestrel-dental/website-fixes" });
    expect(await (await post(h.app, "/api/mini/actions/target", { target: "app" })).json()).toMatchObject({ target: "app" });
  });

  it("refuses Allevia's own repo, in plain words, and a made-up one", async () => {
    // the harness runs with the server's default repo (ALLEVIA_ACTION_REPO)
    const own = await post(h.app, "/api/mini/actions/target", { target: "github", repo: "ankit-vohra/ALLEVIA" });
    expect(own.status).toBe(400);
    expect(((await own.json()) as { error: string }).error).toMatch(/Allevia's own tracker/);
    const bad = await post(h.app, "/api/mini/actions/target", { target: "github", repo: "https://github.com/kestrel/site" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/owner\/name/);
    expect(await get()).toMatchObject({ target: "app" });
  });

  it("is refused in public mode, and the other business routes stay closed to it", async () => {
    const pub = h.make({ publicMode: true });
    expect((await post(pub, "/api/mini/actions/target", { target: "app" })).status).toBe(403);
    expect((await pub.request("/api/mini/actions/target")).status).toBe(200);
    expect((await post(h.app, "/api/nobody/actions/target", { target: "app" })).status).toBe(404);
  });
});
