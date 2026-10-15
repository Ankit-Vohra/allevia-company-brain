// What Tara's boxes say about the people in a photo (product design §6 step 2; content trial 2026-10-15).
// Tara marks any person, face, number plate or house number as a `privacy` box. The studio reads those boxes, not the
// photo, so the rule is a pure function of her assessment:
// - a plate or a house number is blurred wherever it is kept;
// - a person is blurred, flagged to the owner on the card, and the unblurred original is never written to disk;
// - a possible minor stops the run: nothing is kept and nothing is made;
// - people Tara could not place (a "people" photo with no privacy box) cannot be blurred, so the run stops too.
// Only boxes Tara marked as privacy count: a kids' room with nobody in it is a kids' room, not a child in the photo.
import type { AssessmentOverlay } from "../../shared/contracts.js";
import type { PhotoAssessment } from "./assess.js";

const PERSON = /\b(?:person|people|man|men|woman|women|human|face|faces|figure|someone|pedestrian|worker|workers|staff|owner|client|visitor|portrait|group|crowd|resident|guest|customer|passer-?by)\b/i;
const MINOR = /\b(?:child|children|kid|kids|boy|boys|girl|girls|baby|babies|infant|toddler|minor|teen|teens|teenager|schoolchild|schoolchildren|student|students|young)\b/i;

export type StopReason = "minor" | "unlocated";

export interface PrivacyRead {
  boxes: AssessmentOverlay[];   // the privacy boxes, in 0..1 coordinates of the whole photo
  people: boolean;
  minor: boolean;
  located: boolean;             // every person has a box to blur
  stop?: StopReason;
}

export function readPrivacy(a: Pick<PhotoAssessment, "overlays" | "subjectKind">): PrivacyRead {
  const boxes = a.overlays.filter((o) => o.kind === "privacy");
  const minor = boxes.some((o) => MINOR.test(o.note));
  const peopleBoxes = boxes.some((o) => PERSON.test(o.note) || MINOR.test(o.note));
  const people = peopleBoxes || a.subjectKind === "people";
  const located = !people || peopleBoxes;
  const stop: StopReason | undefined = minor ? "minor" : people && !located ? "unlocated" : undefined;
  return { boxes, people, minor, located, ...(stop ? { stop } : {}) };
}

// The owner's words for each stop (docs/owner-words.md: plain, one next step).
export const STOP_MESSAGE: Record<StopReason, string> = {
  minor: "This photo shows a child, so the studio can't use it. Nothing was kept and nothing was made. Send a photo without a child in it.",
  unlocated: "This photo is of people, and the studio could not mark where they are to blur them, so it can't use it. Nothing was kept and nothing was made. Send a photo without people in it.",
};

// What the approval card tells the owner when the photo had something to blur.
export function privacyNote(p: PrivacyRead): string {
  if (p.people) return "A person is in this photo. Their face is blurred in every version, and the original photo with the person was not kept.";
  return "Number plates and house numbers in this photo are blurred in every version and in the copy we keep.";
}
