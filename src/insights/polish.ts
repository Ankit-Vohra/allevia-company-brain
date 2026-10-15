// Optional Haiku polish for template text (a recommendation's "why", the brief). Off unless a runner is passed. The
// model may reword; it may not change a figure: every number in its version must already be in the template or the
// allowed numbers, and every [[id]] citation must survive, or the template is kept.
import { extractCitations, findNumbers, isGrounded } from "../agent/checks.js";
import type { LlmRunner } from "../ingest/llm.js";

const SCHEMA = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 4000 } } };

export interface PolishInput { text: string; instruction: string; numbers?: number[]; model?: string }

export function sameFigures(original: string, polished: string, extra: number[] = []): boolean {
  const allowed = [...findNumbers(original).flatMap((m) => [m.value * m.scale, m.percent ? m.value / 100 : m.value]), ...extra];
  if (!findNumbers(polished).every((m) => isGrounded(m, allowed))) return false;
  const cites = new Set(extractCitations(polished));
  return extractCitations(original).every((c) => cites.has(c));
}

export async function polishText(runner: LlmRunner, input: PolishInput): Promise<{ text: string; polished: boolean }> {
  try {
    const out = (await runner.structured({
      model: input.model ?? "haiku",
      system: `You edit short business notes for a busy owner. ${input.instruction} Keep every number exactly as written, keep every [[id]] tag, add no new facts or numbers. Plain words, no hype, no emoji.`,
      prompt: input.text,
      schema: SCHEMA,
    })) as { text?: unknown };
    const text = typeof out?.text === "string" ? out.text.trim() : "";
    if (text && text.length <= input.text.length * 2 + 200 && sameFigures(input.text, text, input.numbers)) return { text, polished: true };
  } catch {
    // polish is optional: the template stands
  }
  return { text: input.text, polished: false };
}
