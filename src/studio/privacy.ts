// What Tara's boxes say about the people in a photo (product design §6 step 2; founder's decision, 2026-10-15).
// Tara marks any person, face, number plate or house number as a `privacy` box. The studio reads those boxes, not the
// photo, so the rule is a pure function of her assessment and one business setting:
// - People are kept as they are. It is the owner's own photo and content, and the owner is responsible for having
//   permission (the Terms say so). The business setting "Blur people's faces in my content" (off by default) blurs
//   every person Tara marked, in everything made and in the copy that is kept.
// - A plate or a house number is always blurred wherever it is kept.
// - A photo that seems to include a child is not stopped: it gets the free local clean-up only, never an AI edit, and
//   the people in it are blurred in everything kept and made (so nothing unblurred is stored, as before).
// - With the setting on, people Tara could not place (a "people" photo with no box) cannot be blurred, so the run stops.
// Only boxes Tara marked as privacy count: a kids' room with nobody in it is a kids' room, not a child in the photo.
import type { AssessmentOverlay } from "../../shared/contracts.js";
import type { PhotoAssessment } from "./assess.js";

const PERSON = /\b(?:person|people|man|men|woman|women|human|face|faces|figure|someone|pedestrian|worker|workers|staff|owner|client|visitor|portrait|group|crowd|resident|guest|customer|passer-?by)\b/i;
const MINOR = /\b(?:child|children|kid|kids|boy|boys|girl|girls|baby|babies|infant|toddler|minor|teen|teens|teenager|schoolchild|schoolchildren|student|students|young)\b/i;

export type StopReason = "unlocated";

export interface PrivacyOptions {
  /** The business's setting "Blur people's faces in my content" (default off). */
  blurFaces?: boolean;
}

export interface PrivacyRead {
  /** Every privacy box, in 0..1 coordinates of the whole photo. */
  boxes: AssessmentOverlay[];
  /** The boxes that are people (a subset of `boxes`). */
  personBoxes: AssessmentOverlay[];
  /** The boxes to blur: plates and numbers always, people when the setting is on or a child is in the photo. */
  blur: AssessmentOverlay[];
  people: boolean;
  minor: boolean;
  blurPeople: boolean;
  /** Every person has a box to blur. */
  located: boolean;
  /** A child is in the photo: local clean-up only, never an AI edit. */
  localOnly: boolean;
  stop?: StopReason;
}

export function readPrivacy(a: Pick<PhotoAssessment, "overlays" | "subjectKind">, opts: PrivacyOptions = {}): PrivacyRead {
  const boxes = a.overlays.filter((o) => o.kind === "privacy");
  const personBoxes = boxes.filter((o) => PERSON.test(o.note) || MINOR.test(o.note));
  const minor = boxes.some((o) => MINOR.test(o.note));
  const people = personBoxes.length > 0 || a.subjectKind === "people";
  const located = !people || personBoxes.length > 0;
  const blurPeople = !!opts.blurFaces || minor;
  const blur = boxes.filter((o) => blurPeople || !personBoxes.includes(o));
  const stop: StopReason | undefined = opts.blurFaces && people && !located ? "unlocated" : undefined;
  return { boxes, personBoxes, blur, people, minor, blurPeople, located, localOnly: minor, ...(stop ? { stop } : {}) };
}

// The owner's words for each stop (docs/owner-words.md: plain, one next step).
export const STOP_MESSAGE: Record<StopReason, string> = {
  unlocated: "Your setting blurs people's faces, and the studio could not mark where the people in this photo are, so it can't use it. Nothing was kept and nothing was made. Send a photo where people are easier to see, or turn the setting off.",
};

// The one plain sentence said when a photo has a child in it.
export const CHILD_NOTICE = "I kept this one to a simple clean-up; AI edits aren't used on photos with children. Faces are blurred in what we keep.";

// What the approval card tells the owner when something in the photo was blurred or limited.
export function privacyNote(p: PrivacyRead): string {
  if (p.minor) return "A child is in this photo, so it only got the simple clean-up (no AI edit), and faces are blurred in every version and in the copy we keep.";
  if (p.people && p.blurPeople) return "A person is in this photo. Their face is blurred in every version and in the copy we keep, because your setting blurs people's faces.";
  return "Number plates and house numbers in this photo are blurred in every version and in the copy we keep.";
}
