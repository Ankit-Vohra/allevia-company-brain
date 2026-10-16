// Query shapes that crash FalkorDB 6.0.2, found by reading the Cypher text. A crash restarts the server and discards
// every write it had not saved yet, for every agent at once, so GraphHandle refuses such a query before sending it
// (assertSafeQuery) and a test holds every query in src/ to the same rule (tests/graph/cypher-sources.test.ts).
// Evidence and minimal reproductions: docs/notes/falkordb-nan-crash.md and docs/notes/falkordb-reply-compact-panic.md.
//
// 1. A sort that can tie. When rows tie on the key, 6.0.2 orders them by comparing the rest of the row, and comparing
//    maps in which some rows have a null where others have a value (every NODE() map: `asOf`, `simulated`) is not a
//    total order. Rust's sort panics on that once it has 21 or more rows ("user-provided comparison function does
//    not correctly implement a total order"). It needs a full sort (a LIMIT takes another path), and whether a given
//    set of rows trips it depends on the rows and their count, so a query can pass for months. Scalar columns, and
//    lists, did not trip it. Rule: the LAST key of every ORDER BY is unique (`x.id`, `id(x)`, an alias of one, or a
//    pair of ids), or the keys are the grouping columns of an aggregation, so rows never tie.
// 2. A NaN in a sort key (0.0/0.0, sqrt(-1), log(-1) ...) breaks the same comparator, whatever else is in the key list.
//    Cypher float division by zero is NaN (0/0) or ±Infinity; integer division by zero is an error. Infinity sorts
//    fine; NaN does not. Rule: guard every division (CASE WHEN d = 0 OR d IS NULL THEN null ELSE x / d END) or drop
//    NaN first (WHERE x = x). Aggregates over NaN (avg, percentileCont, max, min) are harmless.
//
// This is text analysis, not a parser: it knows the shapes this codebase writes. It errs toward refusing, and a
// refused query says what to add.
import { UnsafeQuery } from "./errors.js";

const LITERALS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

// Blanks string literals, backtick names and comments with spaces, keeping every offset.
export function blankLiterals(q: string): string {
  return q.replace(LITERALS, (m) => " ".repeat(m.length));
}

const ORDER_BY = /(?<![\w.$`])ORDER\s+BY(?![\w`])/gi;
// A word that ends the keys of an ORDER BY.
const CLAUSE_END = new Set([
  "LIMIT", "SKIP", "RETURN", "WITH", "MATCH", "UNWIND", "OPTIONAL", "WHERE", "CALL", "UNION", "CREATE", "MERGE", "SET",
  "DELETE", "DETACH", "REMOVE", "FOREACH", "YIELD", "ORDER",
]);

export interface SortClause { keys: string[]; at: number }

const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();
const direction = /\s+(?:ASC|ASCENDING|DESC|DESCENDING)$/i;

// Every ORDER BY of the query, with its keys (direction words removed) and where it starts.
export function sortClauses(cypher: string): SortClause[] {
  const b = blankLiterals(cypher);
  const out: SortClause[] = [];
  for (const m of b.matchAll(ORDER_BY)) {
    const raw: string[] = [];
    let depth = 0;
    let start = m.index + m[0].length;
    let i = start;
    for (; i < b.length; i++) {
      const c = b[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break; // the bracket that holds this clause (a CALL { … } subquery) closes it
        depth--;
      } else if (depth === 0 && c === ";") break;
      else if (depth === 0 && c === ",") {
        raw.push(b.slice(start, i));
        start = i + 1;
      } else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[\w.$`]/.test(b[i - 1] ?? " ")) {
        const word = /^[A-Za-z_]\w*/.exec(b.slice(i))![0];
        if (CLAUSE_END.has(word.toUpperCase())) break;
        i += word.length - 1;
      }
    }
    raw.push(b.slice(start, i));
    out.push({ keys: raw.map((k) => tidy(k)).filter(Boolean), at: m.index });
  }
  return out;
}

const ID_FORM = /^(?:[A-Za-z_]\w*\.(?:id|slug)|id\([A-Za-z_]\w*\))$/;

// The expression an alias is defined as, nearest definition before `before`: `<expr> AS alias` in a RETURN or WITH.
function aliasExpr(b: string, alias: string, before: number): string | null {
  let found: number | null = null;
  for (const m of b.matchAll(new RegExp(`(?<![\\w.$\`])AS\\s+${alias}(?![\\w\`])`, "gi"))) if (m.index < before) found = m.index;
  if (found === null) return null;
  // Walk back to the start of the column: a top-level comma, or the clause keyword that opens the projection.
  let depth = 0;
  let i = found - 1;
  for (; i >= 0; i--) {
    const c = b[i]!;
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && c === ",") break;
    else if (depth === 0 && /\w/.test(c) && !/[\w.$`]/.test(b[i - 1] ?? " ")) {
      // `i` is the first character of a word: is it a keyword that opens the projection?
      if (/^(?:RETURN|WITH|UNWIND|DISTINCT)(?![\w`])/i.test(b.slice(i))) {
        i += /^\w+/.exec(b.slice(i))![0].length - 1; // the column starts after this word
        break;
      }
    }
  }
  let expr = tidy(b.slice(i + 1, found));
  for (let prev = ""; prev !== expr;) { // RETURN DISTINCT x: keep stripping the leading words
    prev = expr;
    expr = expr.replace(/^(?:RETURN|WITH|DISTINCT|UNWIND)\s+/i, "");
  }
  return expr;
}

// An id, or a `+` chain of ids and literals ('|' between two ids): unique per row of a MATCH that binds each node once.
function uniqueExpr(expr: string): boolean {
  const parts = expr.split("+").map((p) => p.replace(/\s+/g, ""));
  const ids = parts.filter((p) => ID_FORM.test(p));
  return ids.length > 0 && parts.every((p) => p === "" || ID_FORM.test(p));
}

function uniqueKey(key: string, b: string, at: number): boolean {
  const k = key.replace(direction, "").replace(/\s+/g, "");
  if (ID_FORM.test(k)) return true;
  if (/^[A-Za-z_]\w*$/.test(k)) {
    const def = aliasExpr(b, k, at);
    return def !== null && uniqueExpr(def);
  }
  return false;
}

const AGGREGATE = /(?<![\w.$`])(?:count|collect|sum|min|max|avg|stDev|stDevP|percentileCont|percentileDisc)\s*\(/i;

// Top-level comma-separated columns of a projection.
function columns(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map(tidy).filter(Boolean);
}

// The RETURN or WITH this ORDER BY (at `at`) belongs to: its columns, and whether it is RETURN DISTINCT. Null when none.
function owningProjection(b: string, at: number): { cols: string[]; distinct: boolean } | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = b[i]!;
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") depth--;
    else if (depth === 0 && /\w/.test(c) && !/[\w.$`]/.test(b[i - 1] ?? " ")) {
      const word = /^\w+/.exec(b.slice(i))![0].toUpperCase();
      if (word === "RETURN" || (word === "WITH" && !/(?:STARTS|ENDS)\s+$/i.test(b.slice(0, i)))) {
        let text = b.slice(i + word.length, at);
        const distinct = /^\s*DISTINCT\b/i.test(text);
        if (distinct) text = text.replace(/^\s*DISTINCT\b/i, "");
        return { cols: columns(text), distinct };
      }
    }
  }
  return null;
}

const split = (col: string): { expr: string; alias: string } => {
  const m = /^(.*?)\s+AS\s+([A-Za-z_]\w*)$/is.exec(col);
  return m ? { expr: tidy(m[1]!), alias: m[2]! } : { expr: col, alias: col };
};

// Rule G: a projection that groups (it aggregates, or is RETURN DISTINCT) has one row per grouping-column tuple, so
// ORDER BY keys that name every grouping column (by alias or expression) leave no two rows tied.
function groupedUnique(b: string, c: SortClause): boolean {
  const p = owningProjection(b, c.at);
  if (!p || !p.cols.length || p.cols.some((x) => x === "*")) return false;
  const grouping = p.cols.filter((x) => p.distinct || !AGGREGATE.test(x));
  if (!p.distinct && grouping.length === p.cols.length) return false; // no aggregate: not grouped
  const keys = new Set(c.keys.map((k) => k.replace(direction, "").replace(/\s+/g, " ").trim()));
  return grouping.every((x) => { const s = split(x); return keys.has(s.alias) || keys.has(s.expr); });
}

// One line per ORDER BY whose last key can tie. [] when every sort ends in a unique key (or in the grouping keys).
export function unsafeSorts(cypher: string): string[] {
  const b = blankLiterals(cypher);
  return sortClauses(cypher)
    .filter((c) => !c.keys.length || !(uniqueKey(c.keys[c.keys.length - 1]!, b, c.at) || groupedUnique(b, c)))
    .map((c) => `ORDER BY ${c.keys.join(", ")}`);
}

const NAN_FUNCTIONS = /(?<![\w.$`])(sqrt|log|log10|acos|asin|pow)\s*\(/gi;
const ZERO_TEST = /\bWHEN\b[^]*?(?:=\s*0(?:\.0+)?(?![\w.])|<>\s*0|!=\s*0|>\s*0|<=\s*0|<\s*1\b|\bIS\s+(?:NOT\s+)?NULL\b)/i;
const NONZERO_LITERAL = /^\s*(\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

// The CASE … END that holds offset `at`, as the text from CASE up to `at`; null when none does.
function enclosingCase(b: string, at: number): string | null {
  const stack: number[] = [];
  for (const m of b.slice(0, at).matchAll(/(?<![\w.$`])(CASE|END)(?![\w`])/gi)) {
    if (m[1]!.toUpperCase() === "CASE") stack.push(m.index);
    else stack.pop();
  }
  const open = stack.at(-1);
  return open === undefined ? null : b.slice(open, at);
}

// The variables and property paths a denominator is made of: `n.b` -> [n.b], `toFloat(i % 5)` -> [i]. `rest` starts
// right after the `/`.
function denominatorNames(rest: string): string[] {
  let i = 0;
  while (/\s/.test(rest[i] ?? "")) i++;
  let depth = 0;
  let j = i;
  for (; j < rest.length; j++) {
    const c = rest[j]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[\w.$]/.test(c)) break;
  }
  return [...rest.slice(i, j).matchAll(/(?<![\w.$`])([A-Za-z_$][\w$]*(?:\.[A-Za-z_]\w*)*)(?!\s*\(|[\w.$`])/g)].map((m) => m[1]!);
}

// True when the text names one of the variables (or when there are none to name: a constant denominator).
const mentionsAny = (text: string, names: string[]): boolean =>
  !names.length || names.some((n) => new RegExp(`(?<![\\w.$\`])${n.replace(/[.$]/g, "\\$&")}(?![\\w\`])`).test(text));

// A comparison of a value with itself is false only for NaN (and null): `WHERE x = x` is the NaN filter.
const SELF_EQUALITY = /(?<![\w.$`])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*=\s*\1(?![\w.`])/;

// Operations in a query that sorts, whose result can be NaN and that nothing guards: a division whose denominator is
// not a non-zero literal and not under a CASE WHEN that tests it, sqrt/log/log10/acos/asin/pow, and `^`. [] when the
// query does not sort, or filters with `x = x`.
export function nanRisks(cypher: string): string[] {
  const b = blankLiterals(cypher);
  if (!new RegExp(ORDER_BY.source, "i").test(b) || SELF_EQUALITY.test(b)) return [];
  const risks: string[] = [];
  for (let i = b.indexOf("/"); i >= 0; i = b.indexOf("/", i + 1)) {
    const rest = b.slice(i + 1);
    const lit = NONZERO_LITERAL.exec(rest);
    const zero = lit !== null && Number(lit[0]) === 0;
    if (lit && !zero) continue;
    if (!zero) {
      if (/(?<![\w.$`])WHERE\b[^]*?(?:<>|!=|>)\s*0/i.test(b)) continue; // a filter on the denominator
      const kase = enclosingCase(b, i);
      // A CASE guards the division only if it tests the denominator: a zero-or-null test that names what it divides by.
      if (kase && ZERO_TEST.test(kase) && mentionsAny(kase, denominatorNames(rest))) continue;
    }
    risks.push(`division ${tidy(b.slice(Math.max(0, i - 24), i + 24))}`);
  }
  for (const m of b.matchAll(NAN_FUNCTIONS)) risks.push(`${m[1]!.toLowerCase()}()`);
  if (b.includes("^")) risks.push("^");
  return risks;
}

// 3. A RETURN that aggregates next to a grouping key that is an expression which can be null. FalkorDB 6.0.2 panics
//    building the reply (reply.rs:655, `Option::unwrap()` on None, in reply_compact) for, among others,
//    `RETURN count(c) AS n, c.phone AS p` and `RETURN c.address AS a, c.phone AS p, max(c.id) AS m` when c.phone is
//    missing, and for `RETURN 'a' AS a, null AS p, max(c.id) AS m`. Whether a given shape panics depends on the column
//    order and the plan, so a query can pass in tests and crash on data with a missing property. The same keys bound
//    first by a WITH and returned as bare variables never panicked (docs/notes/falkordb-reply-compact-panic.md).
//    Rule: in a RETURN with an aggregate, every other column is a bare variable, an id (`x.id`, `id(x)`), a non-null
//    literal or a coalesce(...); anything else (a property, a function of one) is grouped in a WITH first:
//    `WITH c.phone AS phone, count(c) AS n RETURN phone, n`.
const RETURN_CLAUSE = /(?<![\w.$`])RETURN(?![\w`])/gi;
const PROJECTION_END = /^(?:ORDER|SKIP|LIMIT|UNION)$/i;
const SAFE_KEY = /^(?:[A-Za-z_]\w*|[A-Za-z_]\w*\.id|(?:id|labels|type|properties)\([A-Za-z_]\w*\)|-?\d+(?:\.\d+)?|true|false|)$/i;

// A map or list literal (never null, even holding nulls) or a coalesce(...): the bracket that opens it closes at the end.
function nonNullWrapper(expr: string): boolean {
  const open = /^coalesce\s*\(/i.exec(expr)?.[0].length ?? (expr.startsWith("{") || expr.startsWith("[") ? 1 : 0);
  if (!open) return false;
  let depth = 0;
  for (let i = open - 1; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return i === expr.length - 1; }
  }
  return false;
}

// The RETURN columns of the query that put an aggregate beside a key that can be null; [] when there are none.
export function nullableGroupKeys(cypher: string): string[] {
  const b = blankLiterals(cypher);
  const out: string[] = [];
  for (const m of b.matchAll(RETURN_CLAUSE)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < b.length; i++) {
      const c = b[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (depth === 0 && c === ";") break;
      else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[\w.$`]/.test(b[i - 1] ?? " ")) {
        const word = /^[A-Za-z_]\w*/.exec(b.slice(i))![0];
        if (PROJECTION_END.test(word)) break;
        i += word.length - 1;
      }
    }
    const cols = columns(b.slice(m.index + m[0].length, i));
    if (!cols.some((c) => AGGREGATE.test(c))) continue;
    for (const col of cols) {
      if (AGGREGATE.test(col)) continue;
      const expr = col.replace(/\s+AS\s+[A-Za-z_]\w*\s*$/i, "").replace(/^DISTINCT\s+/i, "").trim();
      if (!SAFE_KEY.test(expr) && !nonNullWrapper(expr)) out.push(`RETURN … ${tidy(col)} beside an aggregate`);
    }
  }
  return out;
}

// For queries an agent writes (the cypher tool): the same query with each RETURN that nullableGroupKeys flags turned into
// `WITH <its columns> RETURN <their aliases>`, which returns the same rows and columns. A column without an alias gets
// its own text as a backtick alias, so the column keeps its name. Unchanged when nothing is flagged.
export function groupInWith(cypher: string): string {
  if (!nullableGroupKeys(cypher).length) return cypher;
  const b = blankLiterals(cypher);
  const edits: Array<{ from: number; to: number; text: string }> = [];
  for (const m of b.matchAll(RETURN_CLAUSE)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let i = start;
    for (; i < b.length; i++) {
      const c = b[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (depth === 0 && c === ";") break;
      else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[\w.$`]/.test(b[i - 1] ?? " ")) {
        const word = /^[A-Za-z_]\w*/.exec(b.slice(i))![0];
        if (PROJECTION_END.test(word)) break;
        i += word.length - 1;
      }
    }
    if (!nullableGroupKeys(`RETURN ${b.slice(start, i)}`).length) continue;
    // split the ORIGINAL text at the blanked text's top-level commas (same offsets)
    const parts: string[] = [];
    let d = 0;
    let from = start;
    for (let k = start; k < i; k++) {
      const c = b[k]!;
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") d--;
      else if (c === "," && d === 0) { parts.push(cypher.slice(from, k)); from = k + 1; }
    }
    parts.push(cypher.slice(from, i));
    let distinct = "";
    const cols = parts.map((p) => p.trim()).filter(Boolean).map((p, n) => {
      let col = p;
      if (n === 0 && /^DISTINCT\s+/i.test(col)) { distinct = "DISTINCT "; col = col.replace(/^DISTINCT\s+/i, ""); }
      const as = /\s+AS\s+([A-Za-z_]\w*|`[^`]+`)\s*$/i.exec(col);
      return as ? { expr: col.slice(0, as.index), alias: as[1]! } : { expr: col, alias: `\`${col.replace(/`/g, "")}\`` };
    });
    // the RETURN's own ORDER BY / SKIP / LIMIT move onto the WITH (where the sort rule wants a grouped sort), up to
    // the end of the query, a closing bracket, a semicolon or a UNION
    let j = i;
    for (let dd = 0; j < b.length; j++) {
      const c = b[j]!;
      if (c === "(" || c === "[" || c === "{") dd++;
      else if (c === ")" || c === "]" || c === "}") { if (dd === 0) break; dd--; }
      else if (dd === 0 && c === ";") break;
      else if (dd === 0 && /^UNION(?![\w`])/i.test(b.slice(j)) && !/[\w.$`]/.test(b[j - 1] ?? " ")) break;
    }
    const tail = cypher.slice(i, j).trim();
    const trail = /\s*$/.exec(cypher.slice(start, j))![0];
    edits.push({ from: m.index, to: j, text: `WITH ${distinct}${cols.map((c) => `${c.expr} AS ${c.alias}`).join(", ")}${tail ? ` ${tail}` : ""} RETURN ${cols.map((c) => c.alias).join(", ")}${trail}` });
  }
  let out = cypher;
  for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

const checked = new Map<string, string | null>(); // query text -> why it is refused (null: fine); query texts repeat
const CHECKED_MAX = 5_000;

// Throws UnsafeQuery, with the fix first (the cypher tool shows the model the first 300 characters of the message).
export function assertSafeQuery(cypher: string): void {
  let why = checked.get(cypher);
  if (why === undefined) {
    const sorts = unsafeSorts(cypher);
    const nans = sorts.length ? [] : nanRisks(cypher);
    const keys = sorts.length || nans.length ? [] : nullableGroupKeys(cypher);
    why = keys.length
      ? `Group in a WITH first and return bare variables (WITH x, count(y) AS n RETURN x.prop AS prop, n): FalkorDB 6.0 crashes replying to a RETURN that aggregates beside a key that can be null. Refused: ${keys[0]}`
      : sorts.length
      ? `Add , x.id as the last sort key (x.id, id(x), or an alias of one) so rows never tie: FalkorDB 6.0 crashes sorting tied rows. Refused: ${sorts[0]}`
      : nans.length
        ? `Guard the sorted value: CASE WHEN d = 0 OR d IS NULL THEN null ELSE x / d END, or WHERE x = x before ORDER BY: FalkorDB 6.0 crashes sorting NaN. Refused: ${nans[0]}`
        : null;
    if (checked.size >= CHECKED_MAX) checked.clear();
    checked.set(cypher, why);
  }
  if (why) throw new UnsafeQuery(why);
}
