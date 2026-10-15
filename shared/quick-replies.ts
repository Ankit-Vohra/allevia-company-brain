// Quick questions the team asks the owner, with tap-able answers. The skills write them on their own line:
//   Quick question: What should this sell? [Free site visit] [Kitchen redesign] [Other]
// Discord shows the options as buttons and the web app as chips; tapping one sends it as the owner's next message in
// the same thread.
export interface QuickQuestion { question: string; options: string[] }

const LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?quick question:?(?:\*\*)?:?\s*(.+?\?)\s*((?:\[[^[\]\n]{1,40}\]\s*){2,4})\s*$/gim;

export function quickReplies(text: string, max = 3): QuickQuestion[] {
  const out: QuickQuestion[] = [];
  for (const m of text.matchAll(LINE)) {
    const options = [...m[2]!.matchAll(/\[([^[\]\n]{1,40})\]/g)].map((o) => o[1]!.trim()).filter(Boolean);
    if (options.length >= 2) out.push({ question: m[1]!.trim(), options });
    if (out.length >= max) break;
  }
  return out;
}
