// What the server tells its operator at start-up when its settings leave businesses open to whoever reaches the port.
import { describe, expect, it } from "vitest";
import { exposureWarnings } from "../../src/server/main.js";

describe("start-up warnings", () => {
  it("says nothing when owner links are on", () => {
    expect(exposureWarnings({ host: "0.0.0.0", publicMode: true, authRequired: true, hubEnabled: true })).toEqual([]);
  });
  it("says nothing for a local, private, hub-less development server", () => {
    expect(exposureWarnings({ host: "127.0.0.1", publicMode: false, authRequired: false })).toEqual([]);
    expect(exposureWarnings({ host: "localhost", publicMode: false, authRequired: false })).toEqual([]);
  });
  it("warns that public mode shows every registered business", () => {
    expect(exposureWarnings({ host: "127.0.0.1", publicMode: true, authRequired: false }).join(" ")).toMatch(/EVERY registered business/);
  });
  it("warns when the server listens beyond this machine with nothing in front of it", () => {
    expect(exposureWarnings({ host: "0.0.0.0", publicMode: false, authRequired: false }).join(" ")).toMatch(/listens on 0\.0\.0\.0/);
  });
  it("warns that the Discord hub hands out join links to anyone who knows a business id", () => {
    expect(exposureWarnings({ host: "127.0.0.1", publicMode: false, authRequired: false, hubEnabled: true }).join(" ")).toMatch(/Discord hub is on/);
  });
});
