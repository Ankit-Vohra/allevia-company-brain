// Citations drawn the way Claude and Gemini draw them (shared/citations.ts, web/src/lib/cites.ts, web/src/components/Markdown.tsx):
// the [[id]] markers become small superscript numbers at the end of their clause, one number per source however often it is
// cited, adjacent markers grouped, and one quiet "Sources (N)" row that opens the numbered list. The server's text is not
// changed. Rendered with React's server renderer.
import { describe, expect, it } from "vitest";
import type { NodeRef } from "../../shared/contracts.js";
import { citeOrder, markerText, numberCitations } from "../../shared/citations.js";
import { citeAria, citeInfo, citeSources } from "../../web/src/lib/cites.js";

const POSTER = "I made one option, [[asset:poster-1]], on approval [[approval:made-1]]. The check found a problem with it.\n\n"
  + "- **Logo:** Your logo is in the bottom left, whole and uncropped [[brand-asset:logo-1]].\n"
  + "- **Fonts:** I have no brand font files, so the text is set in Inter [[brand-asset:logo-1]].";

const nodes: Record<string, NodeRef> = {
  "asset:poster-1": { id: "asset:poster-1", label: "Asset", name: "Instagram portrait poster, weekend shifts" },
  "approval:made-1": { id: "approval:made-1", label: "Approval", name: "content draft: Instagram poster", asOf: "2026-10-16" },
  "brand-asset:logo-1": { id: "brand-asset:logo-1", label: "BrandAsset", name: "Logo: a brand mark for Shiftly", asOf: "2026-10-16" },
  "metric:signups": { id: "metric:signups", label: "Metric", name: "Weekly signups" },
};

/** Just the marker links: [1,2](#cite:...) → "^1,2". */
const marks = (md: string) => md.replace(/\[([\d,]+)\]\(#cite:[^)]*\)/g, "^$1");

describe("numbering and placement", () => {
  it("numbers sources in the order first cited; a repeated id keeps its number", () => {
    expect(citeOrder(POSTER)).toEqual(["asset:poster-1", "approval:made-1", "brand-asset:logo-1"]);
    const { md, ids } = numberCitations(POSTER);
    expect(ids).toHaveLength(3);
    expect(marks(md)).toContain("whole and uncropped.^3");
    expect(marks(md)).toContain("set in Inter.^3");
  });

  it("moves a marker from mid-sentence to the end of its clause, never leaving a chip in the read", () => {
    expect(marks(numberCitations("Option A [[asset:a]] has a festive picture. It is ready.").md)).toBe("Option A has a festive picture.^1 It is ready.");
    expect(marks(numberCitations(POSTER).md).split("\n")[0]).toBe("I made one option,^1 on approval.^2 The check found a problem with it.");
    expect(numberCitations(POSTER).md).not.toMatch(/\[\[/);
  });

  it("groups markers that sit together, each number once", () => {
    expect(marks(numberCitations("Sign-ups fell on 7 Oct. [[event:a]] [[event:b]]\n\nThe crash [[event:a]] is on the sign-up screen.").md))
      .toBe("Sign-ups fell on 7 Oct.^1,2\n\nThe crash is on the sign-up screen.^1");
    expect(marks(numberCitations("Up 12% [[metric:a]][[metric:b]][[metric:a]].").md)).toBe("Up 12%.^1,2");
  });

  it("does not stop at a decimal point or a time, and never moves into a link or code", () => {
    expect(marks(numberCitations("Reach was 3.4 times [[metric:a]] the median.").md)).toBe("Reach was 3.4 times the median.^1");
    expect(marks(numberCitations("Read it [[document:r]] [in the report](https://x.example) now").md)).toBe("Read it^1 [in the report](https://x.example) now");
    expect(numberCitations("```\n[[a:b]]\n```").md).toBe("```\n[[a:b]]\n```");
  });

  it("hides a half-streamed marker at the end", () => {
    expect(numberCitations("Sign-ups dropped [[deci").md).toBe("Sign-ups dropped ");
  });

  it("writes groups as 1, 2 or as a range 1–3", () => {
    expect(markerText([2])).toBe("2");
    expect(markerText([1, 2])).toBe("1, 2");
    expect(markerText([3, 1, 2])).toBe("1–3");
    expect(markerText([1, 3, 4])).toBe("1, 3, 4");
  });
});

describe("what a number says", () => {
  it("kind, full name, where it was read and when; approvals open the draft, the rest the map", () => {
    const src = { id: "document:funnel", title: "Sign-up funnel (analytics export)", asOf: "2026-10-15" };
    const c = citeInfo("metric:signups", 2, nodes["metric:signups"], src);
    expect(c).toMatchObject({ n: 2, kind: "Numbers", name: "Weekly signups", from: "Sign-up funnel (analytics export), read 15 Oct", open: "map" });
    expect(citeAria(c)).toBe("Source 2: Weekly signups. Sign-up funnel (analytics export), read 15 Oct");
    expect(citeInfo("approval:made-1", 1, nodes["approval:made-1"]).open).toBe("approval");
    expect(citeInfo("brand-asset:logo-1", 1).kind).toBe("Documents and notes");
    expect(citeInfo("asset:x", 1).from).toBe("Your records");
    expect(citeInfo("approval:turn:2026-10-16-ab-1", 4).name).toBe("A draft waiting for your OK");
  });

  it("finds where each thing was read: a document is its own source, one source is everyone's, else the same day", () => {
    const relA = { id: "document:rel-a", title: "Release notes 2.8.0", asOf: "2026-10-07" };
    const crash = { id: "document:crash", title: "Crash reports", asOf: "2026-10-15" };
    const funnel = { id: "document:funnel", title: "Funnel", asOf: "2026-10-15" };
    const out = citeSources([
      { nodes: [{ id: "event:rel", label: "Event", name: "2.8.0", asOf: "2026-10-07" }, { id: "event:crash", label: "Event", name: "crash", asOf: "2026-10-15" }], sources: [relA, crash] },
      { nodes: [{ id: "metric:x", label: "Metric", name: "x" }], sources: [funnel] },
      { nodes: [{ id: "feature:y", label: "Feature", name: "y", asOf: "2026-10-15" }], sources: [crash, funnel] },
    ], { [relA.id]: relA });
    expect(out["event:rel"]?.title).toBe("Release notes 2.8.0");
    expect(out["event:crash"]?.title).toBe("Crash reports");
    expect(out["metric:x"]?.title).toBe("Funnel");
    expect(out["feature:y"]).toBeUndefined(); // two sources dated that day: unsure, so none
    expect(out["document:rel-a"]?.title).toBe("Release notes 2.8.0");
  });
});

// ---- rendered ----
interface R { createElement: (...a: unknown[]) => unknown }
async function load() {
  // the web app's own React (web/node_modules), loaded by path so the server's typecheck does not follow it into the .tsx
  const reactPath = "../../web/node_modules/react/index.js", serverPath = "../../web/node_modules/react-dom/server.node.js";
  const routerPath = "../../web/node_modules/react-router/dist/development/index.js", mdPath = "../../web/src/components/Markdown.tsx";
  const React = (await import(reactPath)) as R;
  const { renderToStaticMarkup } = (await import(serverPath)) as { renderToStaticMarkup: (el: unknown) => string };
  const { MemoryRouter } = (await import(routerPath)) as { MemoryRouter: unknown };
  const md = (await import(mdPath)) as { Markdown: unknown; SourcesList: unknown };
  const render = (el: unknown) => renderToStaticMarkup(React.createElement(MemoryRouter, null, el));
  return { React, render, ...md };
}

describe("the answer, rendered", () => {
  it("draws superscript number buttons with aria-labels, no chips, and reuses a number", async () => {
    const { React, render, Markdown } = await load();
    const html = render(React.createElement(Markdown, { text: POSTER, nodes, onCite: () => {} }));
    expect(html).not.toContain("[[");
    expect(html).not.toContain("cite-name\">Instagram"); // no inline label in the read
    const buttons = [...html.matchAll(/<sup class="cite-sup"><button[^>]*aria-label="([^"]*)"[^>]*>([^<]*)<\/button><\/sup>/g)];
    expect(buttons.map((b) => b[2])).toEqual(["1", "2", "3", "3"]);
    expect(buttons[0]![1]).toBe("Source 1: Instagram portrait poster, weekend shifts. Your records");
    expect(buttons[2]![1]).toBe("Source 3: Logo: a brand mark for Shiftly. Your records, 16 Oct");
    expect(html).toContain("aria-expanded=\"false\"");
  });

  it("groups adjacent markers in one button that names every source", async () => {
    const { React, render, Markdown } = await load();
    const html = render(React.createElement(Markdown, { text: "Sign-ups fell on 7 Oct. [[event:a]] [[event:b]] [[event:c]]" }));
    expect(html).toMatch(/aria-label="Sources 1–3: 1, a; 2, b; 3, c"[^>]*>1–3<\/button>/);
  });

  it("adds one quiet Sources (N) row only when asked, and the numbered list has each source's details and action", async () => {
    const { React, render, Markdown, SourcesList } = await load();
    expect(render(React.createElement(Markdown, { text: POSTER, nodes, sourcesRow: true }))).toContain(">Sources (3)<");
    expect(render(React.createElement(Markdown, { text: POSTER, nodes }))).not.toContain("Sources (");
    expect(render(React.createElement(Markdown, { text: "No sources here.", sourcesRow: true }))).not.toContain("Sources (");
    const list = render(React.createElement(SourcesList, {
      cites: ["asset:poster-1", "approval:made-1"].map((id, i) => citeInfo(id, i + 1, nodes[id])), onCite: () => {},
    }));
    expect([...list.matchAll(/<li class="cite-list-item"><span class="cite-pop-n" aria-hidden="true">(\d)<\/span>/g)].map((m) => m[1])).toEqual(["1", "2"]);
    expect(list).toContain("Instagram portrait poster, weekend shifts");
    expect(list).toContain(">Open on the map</button>");
    expect(list).toContain(`href="/approvals#${encodeURIComponent("approval:made-1")}"`);
  });
});
