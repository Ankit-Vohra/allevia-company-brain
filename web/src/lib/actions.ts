// What each kind of proposed action is called, its icon, and what approving it actually does. One vocabulary for the
// Approvals page, the Ask page and the office log, so "Approve" always means the same thing.
import type { ActionKind } from "@shared/contracts";
import type { IconName } from "../components/Icon";

export const ACTION: Record<ActionKind, { label: string; icon: IconName; effect: (target?: string) => string; done: string }> = {
  github_issue: {
    label: "GitHub issue", icon: "github",
    effect: (t) => `Approving opens an issue${t ? ` in ${t.split(" · ")[0]}` : ""}. Nothing on the website changes until someone ships the fix.`,
    done: "Issue opened",
  },
  content_draft: {
    label: "Content draft", icon: "pen",
    effect: () => "Approving saves the draft to the content pipeline. Nothing is published.",
    done: "Draft saved",
  },
  pause_ad: {
    label: "Ad change", icon: "pause",
    effect: () => "Approving applies the change to the campaign. You can undo it from the ad account at any time.",
    done: "Change applied",
  },
  discord_post: {
    label: "Team post", icon: "chat",
    effect: (t) => `Approving posts this${t ? ` to ${t}` : ""}.`,
    done: "Posted",
  },
};
