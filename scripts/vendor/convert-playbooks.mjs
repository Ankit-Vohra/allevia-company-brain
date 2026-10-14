// Converts two third-party data tables to JSON for vendor/playbooks (see vendor/playbooks/NOTICE.md):
//   audit    every-app/open-seo        src/shared/audit-issues.ts  -> audit-issues.json
//   patterns conorbronsdon/avoid-ai-writing detector/patterns.js   -> patterns.json
// Usage: node scripts/vendor/convert-playbooks.mjs <audit|patterns> <upstream-source-file> <output.json>
//
// The upstream file is parsed to an AST and only literal expressions are read (strings, numbers, regex literals,
// arrays, objects, string concatenation and `new RegExp(<string>, <string>)`). Nothing from the upstream repos is
// executed. The script then checks its own output: every regex compiles, and every regex that is a literal in the
// source appears there character for character. It exits non-zero if a check fails.
//
// Parser: rolldown's `parseAst` (an ESTree parser). rolldown ships with vitest, so no direct dependency is added;
// TypeScript 7 has no stable JS AST API.
import { parseAst } from "rolldown/parseAst";
import fs from "node:fs";

const [, , mode, input, output] = process.argv;
if (!["audit", "patterns"].includes(mode) || !input || !output) {
  console.error("usage: node scripts/vendor/convert-playbooks.mjs <audit|patterns> <upstream-source-file> <output.json>");
  process.exit(2);
}
const text = fs.readFileSync(input, "utf8");
const ast = parseAst(text, { lang: input.endsWith(".ts") ? "ts" : "js" });

class Unsupported extends Error {}
const fnMarker = (name) => ({ __fn: name });
const keyOf = (p) => {
  if (p.computed) throw new Unsupported("computed key");
  if (p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "Literal") return String(p.key.value);
  throw new Unsupported(`key ${p.key.type}`);
};

function evalNode(n, env) {
  switch (n.type) {
    case "Literal":
      return n.regex ? { __re: true, source: n.regex.pattern, flags: n.regex.flags } : n.value;
    case "TemplateLiteral":
      if (n.expressions.length) throw new Unsupported("template substitution");
      return n.quasis.map((q) => q.value.cooked).join("");
    case "ParenthesizedExpression": case "TSAsExpression": case "TSSatisfiesExpression":
      return evalNode(n.expression, env);
    case "Identifier":
      if (n.name in env) return env[n.name];
      throw new Unsupported(`identifier ${n.name}`);
    case "BinaryExpression": {
      if (n.operator !== "+") throw new Unsupported(`binary op ${n.operator}`);
      const a = evalNode(n.left, env), b = evalNode(n.right, env);
      if (typeof a !== "string" || typeof b !== "string") throw new Unsupported("non-string +");
      return a + b;
    }
    case "ArrayExpression":
      return n.elements.map((e) => { if (!e || e.type === "SpreadElement") throw new Unsupported("spread/hole"); return evalNode(e, env); });
    case "ObjectExpression": {
      const o = {};
      for (const p of n.properties) {
        if (p.type !== "Property") throw new Unsupported(`object member ${p.type}`);
        const key = keyOf(p), v = p.value;
        if (p.method || v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression") o[key] = fnMarker(key);
        else if (v.type === "Identifier" && !(v.name in env)) o[key] = fnMarker(v.name); // reference to a function declaration
        else o[key] = evalNode(v, env);
      }
      return o;
    }
    case "NewExpression": {
      if (n.callee.type !== "Identifier" || n.callee.name !== "RegExp") throw new Unsupported(`new ${n.callee.type}`);
      const [src, fl] = n.arguments.map((a) => evalNode(a, env));
      if (typeof src !== "string") throw new Unsupported("RegExp arg");
      return { __re: true, composed: true, source: src, flags: typeof fl === "string" ? fl : "" };
    }
    default:
      throw new Unsupported(n.type);
  }
}

// Regex markers become {source, flags}; function markers become {__fn: name}.
function plain(v) {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    if (v.__re) return v.gated ? { source: v.source, flags: v.flags, gated: v.gated } : { source: v.source, flags: v.flags };
    if (v.__fn) return { __fn: v.__fn };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

function declarations(stmts) {
  const out = [];
  for (const st of stmts) {
    const s = st.type === "ExportNamedDeclaration" && st.declaration ? st.declaration : st;
    if (s.type === "VariableDeclaration") out.push(...s.declarations);
  }
  return out;
}

const fail = (msg) => { console.error(`CHECK FAILED: ${msg}`); process.exitCode = 1; };

if (mode === "audit") {
  let table, order;
  for (const d of declarations(ast.body)) {
    if (d.id.name === "AUDIT_ISSUE_TYPES") table = evalNode(d.init, {});
    if (d.id.name === "ISSUE_SEVERITY_ORDER") order = evalNode(d.init, {});
  }
  const issues = Object.entries(table).map(([type, d]) => ({ type, severity: d.severity, title: d.title, explanation: d.explanation, howToFix: d.howToFix }));
  if (issues.some((i) => [i.severity, i.title, i.explanation, i.howToFix].some((s) => typeof s !== "string" || !s))) fail("an issue is missing a field");
  fs.writeFileSync(output, `${JSON.stringify({ source_file: "src/shared/audit-issues.ts", severityOrder: order, issues }, null, 2)}\n`);
  console.log(`wrote ${output}: ${issues.length} issues`);
}

if (mode === "patterns") {
  const decl = declarations(ast.body).find((d) => d.id.name === "AIDetector"); // const AIDetector = (() => { ... })();
  let call = decl.init; while (call.type === "ParenthesizedExpression") call = call.expression;
  let fn = call.callee; while (fn.type === "ParenthesizedExpression") fn = fn.expression;
  const body = fn.body.body;

  const env = {}, failed = [];
  for (const s of body) if (s.type === "FunctionDeclaration") env[s.id.name] = fnMarker(s.id.name);
  for (const d of declarations(body)) {
    if (!d.init || d.id.type !== "Identifier") continue;
    try { env[d.id.name] = evalNode(d.init, env); } catch (e) { failed.push(`${d.id.name}: ${e.message}`); }
  }

  // The upstream engine reports some patterns only after logic that is not vendored. They are marked `gated` so a
  // consumer that does not reimplement that logic can leave them out instead of flagging ordinary English.
  const GATED = {
    NEGATIVE_PARALLELISM_CONTRAST: "upstream reports a contrast frame only when another negative-parallelism frame sits within 2 sentences",
    TITLE_CASE_HEADER: "upstream applies a token-count and interior-function-word filter, skips code fences and technical context",
    CONFIDENCE_CALIBRATION: "upstream reports these only when 3 or more occur in the same text",
  };

  // matchPatterns(text, TABLE | [TABLE], 'category', 'severity') calls give category -> severity and table membership.
  const cats = new Map();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "matchPatterns" && n.arguments.length === 4) {
      const [, tbl, cat, sev] = n.arguments;
      if (cat.type === "Literal" && sev.type === "Literal") {
        const names = tbl.type === "Identifier" ? [tbl.name] : tbl.type === "ArrayExpression" ? tbl.elements.map((e) => e.name) : [];
        const rec = cats.get(cat.value) ?? { severity: sev.value, groups: [] };
        if (rec.severity !== sev.value) throw new Error(`severity mismatch for ${cat.value}`);
        for (const name of names) if (!rec.groups.includes(name)) rec.groups.push(name);
        cats.set(cat.value, rec);
      }
    }
    for (const k of Object.keys(n)) if (k !== "type" && k !== "start" && k !== "end") walk(n[k]);
  };
  walk(body);

  const emitted = []; // every regex written, for the self-check
  const regexes = (name) => {
    let v = env[name];
    if (v?.__re) v = [v]; // a single regex (TITLE_CASE_HEADER) is wrapped in an array at its call site
    if (!Array.isArray(v)) throw new Error(`${name} is not an array`);
    return v.map((x) => {
      if (!x?.__re) throw new Error(`${name} has a non-regex entry`);
      const r = { __re: true, source: x.source, flags: x.flags, ...(GATED[name] ? { gated: GATED[name] } : {}) };
      emitted.push({ ...r, composed: x.composed === true });
      return r;
    });
  };
  const re = (x) => { emitted.push({ source: x.source, flags: x.flags, composed: x.composed === true }); return { __re: true, source: x.source, flags: x.flags }; };

  const categories = {};
  for (const [cat, rec] of [...cats].sort((a, b) => a[0].localeCompare(b[0]))) {
    categories[cat] = {
      severity: rec.severity, weight: env.ISSUE_WEIGHTS[cat] ?? null, label: env.TYPE_LABELS[cat] ?? null,
      groups: rec.groups, patterns: rec.groups.flatMap(regexes),
    };
  }
  const phrases = env.TIER1_PHRASES.map((p) => {
    const o = { pattern: re(p.pattern), replace: p.replace };
    if (p.filter) o.filter = true;
    if (p.clarity) o.clarity = true;
    if (p.skip) o.guard = p.skip.__fn;
    return o;
  });
  const exempt = declarations(body).find((d) => d.id.name === "TECHNICAL_EXEMPT"); // new Set([...])
  const out = {
    source_file: "detector/patterns.js",
    note: "Data tables from the avoid-ai-writing detection engine, converted from JS literals. Regexes are stored as {source, flags}; `gated` marks patterns the upstream engine reports only after extra logic that is not vendored. The detection logic itself is not vendored.",
    contextExempt: exempt.init.arguments[0].elements.map((e) => e.value),
    tiers: {
      tier1: { severity: "high", weight: env.ISSUE_WEIGHTS.tier1, mode: "always flag", words: env.TIER1, phrases },
      tier2: {
        severity: "medium", weight: env.ISSUE_WEIGHTS.tier2, mode: "flag in clusters (2+ per paragraph)", words: env.TIER2,
        conditional: env.TIER2_CONDITIONAL.map((c) => ({ word: c.word, pattern: re(c.pattern), suggestion: c.suggestion })),
      },
      tier3: {
        severity: "low", weight: env.ISSUE_WEIGHTS.tier3, mode: "flag by density", words: env.TIER3,
        phrases: regexes("TIER3_PHRASES"), phraseWeight: env.ISSUE_WEIGHTS["tier3-phrase"],
      },
    },
    categories, weights: env.ISSUE_WEIGHTS, typeLabels: env.TYPE_LABELS, severityLabels: env.SEVERITY_LABELS,
  };
  fs.writeFileSync(output, `${JSON.stringify(plain(out), null, 2)}\n`);

  // Self-check: flags are plain, every regex compiles, every literal regex is in the source verbatim.
  let literal = 0;
  for (const r of emitted) {
    if (!/^[gimsuy]*$/.test(r.flags)) fail(`flags ${r.flags}`);
    try { new RegExp(r.source, r.flags); } catch (e) { fail(`does not compile: ${r.source.slice(0, 60)} (${e.message})`); }
    if (!r.composed) { literal++; if (!text.includes(`/${r.source}/${r.flags}`)) fail(`not a literal of the source: ${r.source.slice(0, 60)}`); }
  }
  const gated = emitted.filter((r) => r.gated).length;
  console.log(`wrote ${output}: ${Object.keys(categories).length} categories, ${emitted.length} regexes (${literal} literal, ${emitted.length - literal} built with new RegExp), ${gated} gated`);
  console.log(`tier1 ${Object.keys(env.TIER1).length} words + ${phrases.length} phrases, tier2 ${Object.keys(env.TIER2).length}, tier3 ${env.TIER3.length}; unevaluated consts: ${failed.length}`);
  const claimed = new Set([...cats.values()].flatMap((c) => c.groups));
  for (const [k, v] of Object.entries(env)) if (Array.isArray(v) && /^[A-Z_0-9]+$/.test(k) && !claimed.has(k)) console.log(`not mapped to a category: ${k} (${v.length})`);
}
