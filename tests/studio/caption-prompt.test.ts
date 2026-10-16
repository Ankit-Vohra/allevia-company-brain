// The caption prompt asks for a project-name line only when the photo belongs to a named project: told to write one with
// no project to name, the model invented the placeholder "Project name, Pune" and the owner saw it in the draft (audit #39).
import { describe, expect, it } from "vitest";
import { captionPrompt } from "../../src/studio/caption.js";
import type { PhotoAssessment } from "../../src/studio/assess.js";
import type { StudioContext } from "../../src/studio/context.js";

const ctx = (project: StudioContext["project"]): StudioContext =>
  ({ business: { id: "business:x", name: "X", city: "Pune" }, brand: {} as never, owner: null, project });
const assessment = { subject: "a pool", caption: "" } as unknown as PhotoAssessment;

describe("captionPrompt", () => {
  it("asks for the project name and place only when there is a project", () => {
    expect(captionPrompt(ctx({ contentId: "content:p", name: "Retreat" }), assessment, "")).toMatch(/project name and place on their own line/);
    const none = captionPrompt(ctx(null), assessment, "");
    expect(none).not.toMatch(/project name and place/);
    expect(none).toMatch(/Do not add a name line or any placeholder/);
  });
});
