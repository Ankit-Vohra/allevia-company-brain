import { describe, it, expect } from "vitest";
import { parseMarkdown, CHUNK_TARGET, CHUNK_MAX } from "../../src/ingest/markdown.js";

const VAULT = [
  "CLAUDE.md",
  "README.md",
  "00-command/PENDING.md",
  "00-command/OPERATING-MANUAL.md",
  "20-growth/channels/newsletter.md",
  "20-growth/channels/video.md",
  "10-company/overview.md",
  "30-content/videos/INDEX.md",
  "20-growth/tests/INDEX.md",
  "60-decisions/008-weekly-stock-count.md",
  "registry/agents/scout.yaml",
  "assets/diagram.png",
];

describe("title and front matter", () => {
  it("prefers front matter title, then the first # heading, then the file name", () => {
    expect(parseMarkdown("a/x.md", "---\ntitle: From front matter\n---\n# Heading\nbody").title).toBe("From front matter");
    expect(parseMarkdown("a/x.md", "intro\n\n## Sub first\n\n# Real title\nbody").title).toBe("Real title");
    expect(parseMarkdown("20-growth/channels/newsletter.md", "no headings here").title).toBe("newsletter");
    expect(parseMarkdown("a/only-sub.md", "## only h2").title).toBe("only-sub");
  });

  it("ignores a # line inside a code fence when looking for the title", () => {
    expect(parseMarkdown("a/x.md", "```sh\n# a comment\n```\n# Real\n").title).toBe("Real");
  });

  it("parses front matter with yaml: lists, nested maps and dates stay as written", () => {
    const md = "---\ntitle: T\ntags: [a, b]\nowner:\n  name: Alex\ndate: 2026-10-05\n---\n# Body\n";
    const r = parseMarkdown("x.md", md);
    expect(r.frontmatter).toEqual({ title: "T", tags: ["a", "b"], owner: { name: "Alex" }, date: "2026-10-05" });
    expect(r.sections.map((s) => s.heading)).toEqual(["Body"]);
  });

  it("survives broken, non-object and missing front matter", () => {
    expect(parseMarkdown("x.md", "---\nkey: [unclosed\n---\n# T\n").frontmatter).toEqual({});
    expect(parseMarkdown("x.md", "---\n- just\n- a list\n---\n# T\n").frontmatter).toEqual({});
    expect(parseMarkdown("x.md", "# T\n").frontmatter).toEqual({});
    expect(parseMarkdown("x.md", "---\nno closing delimiter\n# T\n").title).toBe("T");
  });

  it("handles CRLF, BOM and empty input", () => {
    const r = parseMarkdown("x.md", "﻿---\r\ntitle: Win\r\n---\r\n# H\r\ntext\r\n");
    expect(r.title).toBe("Win");
    expect(r.sections).toEqual([{ heading: "H", level: 1, text: "text" }]);
    expect(parseMarkdown("empty.md", "")).toMatchObject({ title: "empty", frontmatter: {}, sections: [], wikilinks: [], chunks: [] });
  });
});

describe("sections", () => {
  it("splits on every heading, keeps levels, and includes a preamble before the first heading", () => {
    const md = "preamble text\n\n# One\nbody one\n\n## Two\nbody two\n\n### Three\nbody three\n\n# Four\nlast";
    expect(parseMarkdown("x.md", md).sections).toEqual([
      { heading: "", level: 0, text: "preamble text" },
      { heading: "One", level: 1, text: "body one" },
      { heading: "Two", level: 2, text: "body two" },
      { heading: "Three", level: 3, text: "body three" },
      { heading: "Four", level: 1, text: "last" },
    ]);
  });

  it("does not treat # inside fences as headings and supports setext headings", () => {
    const md = "Title\n=====\ntext\n```\n# fenced\n```\nSub\n---\nmore";
    expect(parseMarkdown("x.md", md).sections.map((s) => [s.heading, s.level])).toEqual([["Title", 1], ["Sub", 2]]);
  });
});

describe("wikilinks", () => {
  it("parses plain, aliased and heading links", () => {
    const md = "See [[00-command/PENDING]], [[CLAUDE|the guide]], [[newsletter#Fixes]], [[overview#Pricing|pricing]] and ![[assets/diagram.png]].";
    expect(parseMarkdown("x.md", md).wikilinks.map(({ target, alias }) => ({ target, alias }))).toEqual([
      { target: "00-command/PENDING", alias: undefined },
      { target: "CLAUDE", alias: "the guide" },
      { target: "newsletter", alias: undefined },
      { target: "overview", alias: "pricing" },
      { target: "assets/diagram.png", alias: undefined },
    ]);
  });

  it("ignores links inside fenced and inline code", () => {
    const md = "real [[a]]\n\n```\n[[in-fence]]\n```\n\ninline `[[in-code]]` and ``double `tick` [[also-code]]`` then [[b]]\n\n~~~md\n[[tilde-fence]]\n~~~\n";
    expect(parseMarkdown("x.md", md).wikilinks.map((l) => l.target)).toEqual(["a", "b"]);
  });

  it("skips same-note anchors, empty links and unterminated brackets; handles escaped pipes (tables); dedupes", () => {
    const md = "[[#Local heading]] [[ ]] [[unterminated and [[a\\|alias]] [[a|alias]] [[a|other]] [[ spaced target ]]";
    expect(parseMarkdown("x.md", md).wikilinks.map(({ target, alias }) => [target, alias])).toEqual([
      ["a", "alias"],
      ["a", "other"],
      ["spaced target", undefined],
    ]);
  });

  it("resolves against the vault file list: exact path, root file, unique basename, path suffix", () => {
    const md = "[[00-command/PENDING]] [[CLAUDE]] [[overview]] [[channels/newsletter]] [[008-weekly-stock-count]] [[registry/agents/scout.yaml]] [[diagram.png]]";
    const links = parseMarkdown("x.md", md, VAULT).wikilinks;
    expect(links.map((l) => l.resolved)).toEqual([
      "00-command/PENDING.md",
      "CLAUDE.md",
      "10-company/overview.md",
      "20-growth/channels/newsletter.md",
      "60-decisions/008-weekly-stock-count.md",
      "registry/agents/scout.yaml",
      "assets/diagram.png",
    ]);
  });

  it("leaves ambiguous and unknown targets unresolved, and matches case-insensitively when unique", () => {
    const links = parseMarkdown("x.md", "[[INDEX]] [[nope]] [[Overview]] [[00-command/pending.md]]", VAULT).wikilinks;
    expect(links.map((l) => l.resolved)).toEqual([undefined, undefined, "10-company/overview.md", "00-command/PENDING.md"]);
  });

  it("does not set `resolved` at all when no file list is given", () => {
    const [l] = parseMarkdown("x.md", "[[CLAUDE]]").wikilinks;
    expect(l).toEqual({ target: "CLAUDE" });
    expect("resolved" in l!).toBe(false);
  });
});

describe("chunks", () => {
  const words = (n: number, seed = 1) => {
    // deterministic pseudo text of n words, 2-9 letters each
    let x = seed;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out.push("abcdefghij".slice(0, 2 + (x % 8)) + (i % 7 === 0 ? "." : ""));
    }
    return out.join(" ");
  };

  it("makes one chunk per short section and carries the nearest heading; ord is sequential across the doc", () => {
    const md = "# Doc\nintro\n\n## Part A\nalpha\n\n## Part B\nbeta\n";
    expect(parseMarkdown("x.md", md).chunks).toEqual([
      { ord: 0, heading: "Doc", text: "intro" },
      { ord: 1, heading: "Part A", text: "alpha" },
      { ord: 2, heading: "Part B", text: "beta" },
    ]);
  });

  it("gives preamble text the document title as its heading and skips empty sections", () => {
    const r = parseMarkdown("x.md", "---\ntitle: Named\n---\nbefore any heading\n\n# Empty\n\n# Full\ntext");
    expect(r.chunks).toEqual([
      { ord: 0, heading: "Named", text: "before any heading" },
      { ord: 1, heading: "Full", text: "text" },
    ]);
  });

  it("packs paragraphs to about 800 characters and never exceeds 1200", () => {
    const paras = Array.from({ length: 30 }, (_, i) => words(40, i + 3));
    const r = parseMarkdown("x.md", `# Long\n${paras.join("\n\n")}`);
    expect(r.chunks.length).toBeGreaterThan(3);
    for (const c of r.chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
      expect(c.heading).toBe("Long");
    }
    for (const c of r.chunks.slice(0, -1)) expect(c.text.length).toBeGreaterThan(CHUNK_TARGET * 0.45);
    expect(r.chunks.map((c) => c.ord)).toEqual(r.chunks.map((_, i) => i));
    // paragraph boundaries are respected: every chunk is a run of whole paragraphs
    for (const c of r.chunks) for (const p of c.text.split("\n\n")) expect(paras).toContain(p);
  });

  it("splits an over-long paragraph at sentence and word boundaries, never mid-word", () => {
    const text = words(900, 7); // one ~4.5k-character paragraph, no blank lines
    const r = parseMarkdown("x.md", `# P\n${text}`);
    expect(r.chunks.length).toBeGreaterThan(3);
    for (const c of r.chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
    const original = text.split(/\s+/);
    const rebuilt = r.chunks.flatMap((c) => c.text.split(/\s+/));
    expect(rebuilt).toEqual(original); // same words, same order, no word cut
  });

  it("splits a long table by rows and keeps each row whole", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| R${i} | ${words(12, i + 1)} |`);
    const r = parseMarkdown("x.md", `# T\n| id | text |\n|---|---|\n${rows.join("\n")}`);
    expect(r.chunks.length).toBeGreaterThan(1);
    const allLines = r.chunks.flatMap((c) => c.text.split("\n"));
    for (const row of rows) expect(allLines).toContain(row);
    for (const c of r.chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
  });

  it("keeps a fenced code block with blank lines inside as one paragraph", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    const r = parseMarkdown("x.md", `# C\nintro\n\n${code}\n\noutro`);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.text).toContain(code);
  });

  it("only when a single token exceeds the maximum does it cut (at the limit, on code points)", () => {
    const blob = "x".repeat(3000);
    const r = parseMarkdown("x.md", `# B\nbefore ${blob} after`);
    for (const c of r.chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(r.chunks.map((c) => c.text).join("").replace(/\s/g, "")).toBe(`before${blob}after`);
  });

  it("works for Devanagari text (words separated by spaces) and splits on the danda sentence mark", () => {
    const sentence = "हम हर दिन नए काम जोड़ते हैं और आपको सही नौकरी दिलाते हैं।";
    const text = Array.from({ length: 40 }, () => sentence).join(" ");
    const r = parseMarkdown("hi.md", `# हिंदी\n${text}`);
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
      expect(c.text.endsWith("।")).toBe(true);
    }
  });

  it("is fast on a megabyte of text", () => {
    const md = Array.from({ length: 2000 }, (_, i) => `## S${i}\n${words(60, i + 1)}`).join("\n\n");
    const t0 = performance.now();
    const r = parseMarkdown("big.md", md, VAULT);
    expect(r.chunks.length).toBeGreaterThan(1900);
    expect(performance.now() - t0).toBeLessThan(10_000); // generous for a loaded CI box; it takes a few hundred ms
  });
});
