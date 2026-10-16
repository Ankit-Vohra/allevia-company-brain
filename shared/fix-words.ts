// What a "fix" card is about, in the owner's words (docs/owner-words.md). Every fix is one kind of card (`github_issue`: a
// to-do for whoever builds the thing), but the thing is not always the website: an app crash, a release problem or a Play
// Store warning is about the app. The label and the lines under it follow the subject, so an app crash is never "a fix
// for your website". Shared by the web app, the Discord cards and today's note, so all three say the same.
//
// The subject is read from the title's own prefix (the detectors write "SEO: ...", "App: ...", "Android: ...", "Release
// check: ...", "Funnel: ...") and, for the app, the target the detector sets ("Sentry"). Anything that does not say
// otherwise is the website, which is what almost every fix is. A funnel drop could be the site or the app, so it is
// "a fix to hand over" rather than a guess.

export type FixSubject = "website" | "app" | "other";

const APP_TITLE = /^\s*(?:app|android|ios|release check)\b\s*[:\-]/i;
const OTHER_TITLE = /^\s*funnel\b\s*[:\-]/i;
const APP_TARGET = /^\s*(?:sentry|crashlytics|play console|app store connect)\b/i;

export function fixSubject(title: string | undefined, target?: string): FixSubject {
  const t = title ?? "";
  if (APP_TITLE.test(t) || (target !== undefined && APP_TARGET.test(target))) return "app";
  if (OTHER_TITLE.test(t)) return "other";
  return "website";
}

/** What the card is, lower case, for a sentence or a Discord card: "a fix for your website". */
export const FIX_LABEL: Record<FixSubject, string> = {
  website: "a fix for your website",
  app: "a fix for your app",
  other: "a fix to hand over",
};

/** The same, starting a line: "A fix for your app". */
export const fixLabelCap = (s: FixSubject): string => FIX_LABEL[s].replace(/^./, (c) => c.toUpperCase());

/** Who the fix goes to as a to-do. */
export const FIX_BUILDER: Record<FixSubject, string> = {
  website: "whoever builds your website",
  app: "whoever builds your app",
  other: "whoever builds it",
};

/** The reassurance that nothing has changed yet. */
export const FIX_UNCHANGED: Record<FixSubject, string> = {
  website: "Nothing on your site changes yet.",
  app: "Nothing in your app changes yet.",
  other: "Nothing is changed yet.",
};
