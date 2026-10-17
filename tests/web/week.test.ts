// Home's "Your team this week" row (web/src/lib/week.ts, web/src/components/home/WeekRow.tsx): five plain counts from
// GET /api/:t/week, each a link to its list (Needs your OK's history, Chat, the Brain); practice runs said apart; a quiet
// week is plain zeros and one calm line; nothing at all when the counts cannot be read. Rendered with React's server renderer.
import { describe, expect, it } from "vitest";
import type { WeekDto } from "../../shared/week.js";
import { ownerJargon } from "../../src/agent/style.js";
import { CHAT_PATH, DECIDED_PATH, GROWTH_PATH, quietWeek, weekItemLabel, weekItems, weekLine } from "../../web/src/lib/week.js";

const busy: WeekDto = { since: "2026-10-10T00:00:00.000Z", days: 7, approved: 4, sent: { done: 3, practice: 2 }, filed: { done: 1, practice: 0 }, learned: 12, answered: 1 };
const quiet: WeekDto = { since: "2026-10-10T00:00:00.000Z", days: 7, approved: 0, sent: { done: 0, practice: 0 }, filed: { done: 0, practice: 0 }, learned: 0, answered: 0 };

async function render(week: WeekDto | null | undefined): Promise<string> {
  // the web app's own React (web/node_modules), loaded by path so the server's typecheck does not follow it into the .tsx
  const reactPath = "../../web/node_modules/react/index.js", serverPath = "../../web/node_modules/react-dom/server.node.js";
  const routerPath = "../../web/node_modules/react-router/dist/development/index.js", rowPath = "../../web/src/components/home/WeekRow.tsx";
  const React = (await import(reactPath)) as { createElement: (...a: unknown[]) => unknown };
  const { renderToStaticMarkup } = (await import(serverPath)) as { renderToStaticMarkup: (el: unknown) => string };
  const { MemoryRouter } = (await import(routerPath)) as { MemoryRouter: unknown };
  const { WeekRow } = (await import(rowPath)) as { WeekRow: unknown };
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(WeekRow, { week })));
}

describe("your team this week, in words", () => {
  it("says five counts, each opening its list, with practice runs apart", () => {
    const items = weekItems(busy);
    expect(items.map((i) => [i.key, i.n, i.label, i.to, i.note])).toEqual([
      ["approved", 4, "drafts approved", DECIDED_PATH, undefined],
      ["sent", 3, "sent or booked", DECIDED_PATH, "2 practice runs"],
      ["filed", 1, "fix or task filed", DECIDED_PATH, undefined],
      ["learned", 12, "new facts learned", GROWTH_PATH, undefined],
      ["answered", 1, "question answered", CHAT_PATH, undefined],
    ]);
    expect(DECIDED_PATH).toBe("/approvals?show=decided");
    expect(GROWTH_PATH).toBe("/brain?tab=growth");
    expect(weekItemLabel(items[1]!)).toBe("3 sent or booked this week, plus 2 practice runs");
    expect(weekLine(busy)).toBeNull();
    for (const i of items) expect(ownerJargon(`${i.label} ${i.note ?? ""}`), i.label).toEqual([]);
  });

  it("a quiet week is plain zeros and one calm line; a practice run alone is not quiet", () => {
    expect(quietWeek(quiet)).toBe(true);
    expect(weekItems(quiet).map((i) => i.n)).toEqual([0, 0, 0, 0, 0]);
    expect(weekLine(quiet)).toMatch(/^A quiet week so far\./);
    expect(ownerJargon(weekLine(quiet)!)).toEqual([]);
    const practiced = { ...quiet, filed: { done: 0, practice: 1 } };
    expect(quietWeek(practiced)).toBe(false);
    expect(weekItems(practiced)[2]!.note).toBe("1 practice run");
  });
});

describe("the row on Home", () => {
  it("renders five links with the numbers, the labels and the practice note", async () => {
    const html = await render(busy);
    expect(html).toContain("Your team this week");
    expect(html.match(/<a /g)).toHaveLength(5);
    expect(html).toContain('href="/approvals?show=decided"');
    expect(html).toContain('href="/brain?tab=growth"');
    expect(html).toContain('href="/chat"');
    expect(html).toMatch(/data-week="sent"[^>]*>.*?>3<.*?sent or booked.*?2 practice runs/);
    expect(html).toContain('aria-label="12 new facts learned this week"');
    expect(html).not.toContain("quiet week");
  });

  it("a quiet week shows zeros calmly; loading is a skeleton; an error leaves Home alone", async () => {
    const q = await render(quiet);
    expect(q.match(/class="hm-week-n num">0</g)).toHaveLength(5);
    expect(q).toContain("A quiet week so far.");
    const loading = await render(undefined);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("skeleton");
    expect(loading).not.toContain("<a ");
    expect(await render(null)).toBe("");
  });
});
