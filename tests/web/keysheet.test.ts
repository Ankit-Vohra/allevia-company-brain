// The paste-your-key sheet on Your tools (web/src/components/KeySheet.tsx, web/src/lib/keysheet.ts): for a tool with no sign-in
// page it says "Paste your <Tool> API key", links to where the key is found (https only), shows password-type boxes the browser
// does not remember, and promises the key is not kept. Rendered to HTML with React's server renderer, as the page would draw it.
import { describe, expect, it } from "vitest";
import { keySheetReady, keySheetWords, type KeyForm } from "../../web/src/lib/keysheet.js";

const HIGGSFIELD: KeyForm = {
  tool: "Higgsfield", hint: "https://cloud.higgsfield.ai/api-keys",
  fields: [
    { name: "generic_api_key", label: "API Key ID", help: "The key ID generated on the Higgsfield Cloud API Keys page at https://cloud.higgsfield.ai/api-keys.", secret: true },
    { name: "generic_token", label: "API Key Secret", secret: true },
  ],
};

describe("the paste-your-key sheet", () => {
  it("says what to paste and where to find it, with password boxes only", () => {
    const w = keySheetWords(HIGGSFIELD);
    expect(w.title).toBe("Paste your Higgsfield API key");
    expect(w.hint).toEqual({ href: "https://cloud.higgsfield.ai/api-keys", text: "Find it on cloud.higgsfield.ai" });
    expect(w.boxes.map((b) => [b.label, b.type, b.autoComplete])).toEqual([["API Key ID", "password", "off"], ["API Key Secret", "password", "off"]]);
    expect(w.boxes[0]!.help).toMatch(/^The key ID generated/); // Composio's own help under the box
    expect(w.boxes[1]!.help).toBeUndefined();
    expect(w.save).toBe("Save");
    expect(w.promise).toMatch(/doesn't keep it and won't show it again/);
  });

  it("one box is just 'API key'; no link without an https address; Save waits until every box is filled", () => {
    const one: KeyForm = { tool: "OneKey", fields: [{ name: "generic_api_key", label: "Generic Api Key", secret: true }], hint: "javascript:alert(1)" };
    const w = keySheetWords(one);
    expect(w.boxes.map((b) => b.label)).toEqual(["API key"]);
    expect(w.hint).toBeUndefined();
    expect(keySheetReady(HIGGSFIELD, { generic_api_key: "id" })).toBe(false);
    expect(keySheetReady(HIGGSFIELD, { generic_api_key: "id", generic_token: "   " })).toBe(false);
    expect(keySheetReady(HIGGSFIELD, { generic_api_key: "id", generic_token: "s" })).toBe(true);
  });

  it("renders as the page draws it", async () => {
    // the web app's own React (web/node_modules), loaded by path so the server's typecheck does not follow it into the .tsx
    const reactPath = "../../web/node_modules/react/index.js", serverPath = "../../web/node_modules/react-dom/server.node.js", sheetPath = "../../web/src/components/KeySheet.tsx";
    const React = (await import(reactPath)) as { createElement: (...a: unknown[]) => unknown };
    const { renderToStaticMarkup } = (await import(serverPath)) as { renderToStaticMarkup: (el: unknown) => string };
    const { KeySheet } = (await import(sheetPath)) as { KeySheet: unknown };
    const html = renderToStaticMarkup(React.createElement(KeySheet, { form: HIGGSFIELD, onSave: async () => undefined, onClose: () => undefined }));
    expect(html).toContain("<dialog");
    expect(html).toContain("Paste your Higgsfield API key");
    expect(html).toContain('href="https://cloud.higgsfield.ai/api-keys"');
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).not.toMatch(/type="text"/);
    expect(html.match(/autoComplete="off"|autocomplete="off"/gi)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save<\/button>/);
  });
});
