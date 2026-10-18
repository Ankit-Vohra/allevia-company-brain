// Who picks up a meeting's action item: the founder's own examples, the other side's promises, and a named colleague's item.
import { describe, expect, it } from "vitest";
import { routeAction, routeTask } from "../../src/meetings/route.js";

describe("routeTask: the desk whose job it is", () => {
  it("sends each kind of work to the right AI teammate", () => {
    const cases: Array<[string, string]> = [
      ["Send the quote", "sales-lead"],
      ["Send the revised quote with the decaf and the 15-day terms", "sales-lead"],
      ["Follow up with Kettle & Crumb next week", "sales-lead"],
      ["Fix the checkout", "tech-lead"],
      ["Get the wholesale checkout fixed so the KETTLE10 coupon works", "tech-lead"],
      ["Update the wholesale page", "tech-lead"],
      ["Post about the new roast", "content-strategist"],
      ["Write three Instagram captions for launch week", "content-strategist"],
      ["Run a small ad campaign near the café", "growth-marketer"],
      ["The app crashed for some users: look into the outage", "oncall-engineer"],
      ["Push the new build to the Play Store", "qa-release"],
      ["Share the monthly revenue report", "coe-lead"],
      ["Investigate why traffic dropped last week", "data-analyst"],
      ["Schedule the barista training for Tuesday", "ops-manager"],
      ["Book the delivery van", "ops-manager"],
    ];
    for (const [text, agent] of cases) expect(routeTask(text).agent, text).toBe(agent);
    expect(routeTask("Book the delivery van").matched).toBe(false);
    expect(routeTask("Fix the checkout").why).toMatch(/Techie/);
  });
});

describe("routeAction: a teammate, or a person", () => {
  it("leaves the other side's promise with them", () => {
    expect(routeAction({ text: "Send the GST details for the invoices", side: "them", person: true })).toBeNull();
    expect(routeAction({ text: "Send the signed agreement", side: "them", person: true })).toBeNull();
  });
  it("gives the business's own work to a teammate, Taskmaster when no desk fits", () => {
    expect(routeAction({ text: "Send the quote", side: "us", person: false })).toMatchObject({ agent: "sales-lead", matched: true });
    expect(routeAction({ text: "Schedule the barista training", side: "us", person: false })).toMatchObject({ agent: "ops-manager" });
  });
  it("a named colleague keeps what is no desk's plain job, and hands over what is", () => {
    expect(routeAction({ text: "Schedule the barista training", side: "us", person: true })).toBeNull();
    expect(routeAction({ text: "Post about the new roast", side: "us", person: true })).toMatchObject({ agent: "content-strategist" });
    expect(routeAction({ text: "Fix the checkout", side: "unknown", person: true })).toMatchObject({ agent: "tech-lead" });
  });
});
