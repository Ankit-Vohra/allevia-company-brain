// (Lives beside the helper it checks; vitest only runs tests/**/*.test.ts.)
import { describe, it, expect } from "vitest";
import { stringLiterals } from "./ts-strings.js";

describe("stringLiterals", () => {
  const texts = (s: string) => stringLiterals(s).map((l) => l.text);

  it("reads quoted strings, with escapes, and skips comments", () => {
    expect(texts(`const a = "x\\"y"; // 'no'\n/* "no" */ const b = 'z\\n';`)).toEqual(['x"y', "z\n"]);
  });

  it("reads a template with its ${…} as a placeholder, and the strings inside the expression on their own", () => {
    expect(texts("const q = `MATCH (n) ${f(\"inner\")} RETURN n`;")).toEqual(["inner", "MATCH (n) __EXPR__ RETURN n"]);
  });

  it("nests templates and keeps braces of an expression balanced", () => {
    expect(texts("`a ${ {k: 1}.k + `b${2}` } c`")).toEqual(["b__EXPR__", "a __EXPR__ c"]);
  });

  it("does not take a quote inside a regex literal for a string", () => {
    expect(texts(`const r = /['"]/g; const s = "after";`)).toEqual(["after"]);
  });

  it("treats / after a value as division, so the next quote still opens a string", () => {
    expect(texts(`const x = a / b; const s = "after";`)).toEqual(["after"]);
  });

  it("numbers lines from 1", () => {
    expect(stringLiterals(`a;\n\nb = "x";`)[0]).toEqual({ text: "x", line: 3 });
  });
});
