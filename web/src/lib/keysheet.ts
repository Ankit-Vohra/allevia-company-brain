// The paste-your-key sheet for a tool with no sign-in page (src/connections/composio.ts, KeyForm): what it says and which boxes it
// shows. Every box is a password-type box with nothing remembered by the browser; the key is sent once, to the server, and is never
// shown again. Kept apart from the component so the words are tested (tests/web/keysheet.test.ts).

/** What POST .../connect answers for such a tool (the same shape as KeyForm in types-ext.ts; repeated here so the server's tests can load this file). */
export interface KeyForm { tool: string; fields: Array<{ name: string; label: string; help?: string; secret: boolean }>; hint?: string }

export interface KeySheetBox { name: string; id: string; label: string; help?: string; type: "password"; autoComplete: "off" }
export interface KeySheetWords {
  title: string;
  /** Where the key is found, when the tool says. Only an https address is linked. */
  hint?: { href: string; text: string };
  boxes: KeySheetBox[];
  save: string;
  saving: string;
  promise: string;
}

const safeHref = (u: string | undefined): string | undefined => {
  if (!u) return undefined;
  try { const x = new URL(u); return x.protocol === "https:" ? x.toString() : undefined; } catch { return undefined; }
};

export function keySheetWords(form: KeyForm): KeySheetWords {
  const tool = form.tool || "this tool";
  const href = safeHref(form.hint);
  let host = "";
  try { host = href ? new URL(href).host.replace(/^www\./, "") : ""; } catch { host = ""; }
  return {
    title: `Paste your ${tool} API key`,
    ...(href ? { hint: { href, text: `Find it on ${host}` } } : {}),
    boxes: form.fields.map((f) => ({
      name: f.name, id: `key-${f.name}`, label: form.fields.length === 1 ? "API key" : f.label,
      ...(f.help ? { help: f.help } : {}),
      type: "password", autoComplete: "off",
    })),
    save: "Save",
    saving: "Checking…",
    promise: `It goes straight to ${tool} through our connection service. Allevia doesn't keep it and won't show it again.`,
  };
}

/** Every box filled in (spaces around a pasted key don't count). */
export const keySheetReady = (form: KeyForm, values: Record<string, string>): boolean => form.fields.every((f) => (values[f.name] ?? "").trim().length > 0);
