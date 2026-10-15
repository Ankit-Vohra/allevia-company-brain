// The public website's demo section: the "Try the live demo" button exists only when DEMO_URL is set, and what the /demo/
// page says the public demo does is what public mode does in the server (src/server/app.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_URL } from "../../site/src/config.js";
import { demoButton, demoStatus } from "../../site/src/render/pages-copy.js";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("the live demo button", () => {
  it("is hidden while DEMO_URL is empty, and the page says the demo is being set up", () => {
    expect(demoButton("")).toBe("");
    expect(demoStatus("")).toContain("being set up");
  });

  it("is a link that opens in a new tab once there is an address, and the status line goes away", () => {
    const html = demoButton("https://demo.example.test");
    expect(html).toContain('href="https://demo.example.test"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(demoStatus("https://demo.example.test")).toBe("");
  });

  it("escapes the address", () => {
    expect(demoButton('https://x.test/?a="b"&c=<d>')).not.toMatch(/href="[^"]*"[^>]*"b"/);
    expect(demoButton('https://x.test/?a="b"')).toContain("&quot;");
  });

  it("ships empty: no demo has been hosted by this repo", () => {
    expect(DEMO_URL).toBe("");
  });
});

describe("what the demo page says public mode does is true of the server", () => {
  const server = read("src/server/app.ts");

  it("refuses writes with the read-only message", () => {
    expect(server).toContain("This is the public read-only demo of Allevia");
    for (const route of ['app.post("/api/:t/approvals/:id"', 'app.post("/api/:t/turns/:id/stop"']) {
      const at = server.indexOf(route);
      expect(at, route).toBeGreaterThan(-1);
      expect(server.slice(at, at + 200)).toContain("refuseInPublicMode()");
    }
  });

  it("answers Ask only by replaying a recorded showcase turn, and never starts a live turn", () => {
    const at = server.indexOf('app.post("/api/:t/ask"');
    const block = server.slice(at, server.indexOf("turns.start(", at));
    expect(block).toContain("isPublic()");
    expect(block).toContain("findShowcaseTurn");
    expect(block.indexOf("isPublic()")).toBeLessThan(block.indexOf("live++"));
  });

  it("does not embed in a frame, so the site links to the demo instead of embedding it", () => {
    expect(server).toContain("secureHeaders(");
  });

  it("the demo page and the home page carry no embedded frame", () => {
    for (const f of ["site/demo/index.html", "site/index.html", "site/product/index.html"]) expect(read(f)).not.toMatch(/<iframe/i);
  });
});
