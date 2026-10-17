import { describe, expect, it } from "vitest";
import { requestView } from "../../src/server/auth.js";
import { callerRole, requireOwner, OWNER_ONLY } from "../../src/server/roles.js";

describe("roles", () => {
  it("is the owner outside a request (auth off), and with an owner link", () => {
    expect(callerRole()).toBe("owner");
    requestView.run({ publicView: false }, () => expect(callerRole()).toBe("owner"));
  });
  it("is public in the demo view and a member when the account says so; only the owner passes requireOwner", () => {
    requestView.run({ publicView: true }, () => { expect(callerRole()).toBe("public"); expect(() => requireOwner()).toThrow(OWNER_ONLY); });
    requestView.run({ publicView: false, role: "member", userId: "u1" }, () => { expect(callerRole()).toBe("member"); expect(() => requireOwner()).toThrow(OWNER_ONLY); });
    requestView.run({ publicView: false, role: "owner", userId: "u1" }, () => expect(() => requireOwner()).not.toThrow());
  });
});
