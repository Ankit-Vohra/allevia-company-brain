// The microphone on the ask box and the chat box (web/src/lib/speech.ts, web/src/components/MicButton.tsx): it listens in
// the business's language, adds the spoken words after what was typed, says plainly why it stopped, and is not there at
// all where the browser has no speech recognition. Rendered with React's server renderer.
import { afterEach, describe, expect, it } from "vitest";
import { speechLang, speechProblem, speechRecognizer, transcriptOf, withSpoken } from "../../web/src/lib/speech.js";

const g = globalThis as { window?: unknown };
afterEach(() => { delete g.window; });

class FakeRecognition {}

async function render(component: "MicButton" | "AskBox", props: Record<string, unknown>): Promise<string> {
  // the web app's own React (web/node_modules), loaded by path so the server's typecheck does not follow it into the .tsx
  const reactPath = "../../web/node_modules/react/index.js", serverPath = "../../web/node_modules/react-dom/server.node.js";
  const routerPath = "../../web/node_modules/react-router/dist/development/index.js";
  const path = component === "MicButton" ? "../../web/src/components/MicButton.tsx" : "../../web/src/components/home/AskBox.tsx";
  const React = (await import(reactPath)) as { createElement: (...a: unknown[]) => unknown };
  const { renderToStaticMarkup } = (await import(serverPath)) as { renderToStaticMarkup: (el: unknown) => string };
  const { MemoryRouter } = (await import(routerPath)) as { MemoryRouter: unknown };
  const C = ((await import(path)) as Record<string, unknown>)[component];
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(C, props)));
}

describe("speech, in the business's language", () => {
  it("listens in en-IN, en-GB, en-US, en-AU, en-CA or hi-IN, and en-US for anything else", () => {
    expect(speechLang("en-IN")).toBe("en-IN");
    expect(speechLang("en-GB")).toBe("en-GB");
    expect(speechLang("en-us")).toBe("en-US");
    expect(speechLang("hi-IN")).toBe("hi-IN");
    expect(speechLang("hi")).toBe("hi-IN");
    expect(speechLang("en-AU")).toBe("en-AU");
    expect(speechLang("en-AE")).toBe("en-US");
    expect(speechLang(undefined)).toBe("en-US");
  });

  it("finds the browser's recognizer, the standard one first, and none on a browser without it", () => {
    class Std {}
    expect(speechRecognizer({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(speechRecognizer({ SpeechRecognition: Std, webkitSpeechRecognition: FakeRecognition })).toBe(Std);
    expect(speechRecognizer({})).toBeNull();
    expect(speechRecognizer(undefined)).toBeNull();
  });

  it("adds what was said after what was typed, as it is heard", () => {
    const heard = [[{ transcript: "how many" }], [{ transcript: " enquiries  this week" }]];
    expect(transcriptOf(heard)).toBe("how many enquiries  this week");
    expect(withSpoken("", transcriptOf(heard))).toBe("how many enquiries this week");
    expect(withSpoken("Quick one: ", "why did sales dip")).toBe("Quick one: why did sales dip");
    expect(withSpoken("typed", "  ")).toBe("typed");
  });

  it("says why it stopped only when the owner can do something about it", () => {
    expect(speechProblem("not-allowed")).toMatch(/Allow the microphone/);
    expect(speechProblem("audio-capture")).toBe("No microphone was found.");
    expect(speechProblem("no-speech")).toBeNull();
    expect(speechProblem("aborted")).toBeNull();
  });
});

describe("the mic button", () => {
  it("is not drawn where the browser cannot listen", async () => {
    expect(await render("MicButton", { locale: "en-IN", value: "", onText: () => undefined })).toBe("");
    const ask = await render("AskBox", { suggestions: [], locale: "en-IN" });
    expect(ask).toContain("Ask your team anything");
    expect(ask).not.toContain("mic-btn");
  });

  it("is a labelled toggle button, not pressed until the owner taps it, on Home's ask box", async () => {
    g.window = { webkitSpeechRecognition: FakeRecognition };
    const html = await render("MicButton", { locale: "en-GB", value: "", onText: () => undefined });
    expect(html).toMatch(/<button type="button" class="mic-btn"[^>]*aria-pressed="false"[^>]*aria-label="Talk instead of typing"/);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("is-listening");
    const ask = await render("AskBox", { suggestions: [], locale: "en-IN" });
    expect(ask).toMatch(/class="mic-btn"[\s\S]*type="submit"/); // the mic sits before Ask
  });
});
