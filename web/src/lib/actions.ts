// What each kind of proposed action is called, its icon, and what approving it actually does. One vocabulary for the
// Approvals page, the Ask page and the office log, so "Approve" always means the same thing.
import type { ActionKind } from "@shared/contracts";
import type { IconName } from "../components/Icon";

export const ACTION: Record<ActionKind, { label: string; icon: IconName; effect: (target?: string) => string; done: string }> = {
  // Where a fix lands is the business's choice (GET /api/:t/actions/target): its tasks in the app by default, or its own GitHub repo.
  github_issue: {
    label: "Fix for your website", icon: "file",
    effect: () => "Approving adds this fix to your tasks (or opens an issue, if you chose GitHub). Nothing on the website changes until someone ships the fix.",
    done: "Fix added",
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
  calendar_event: {
    label: "Calendar meeting", icon: "clock",
    effect: () => "Approving adds the meeting to your Google Calendar. The guest, if one is named, gets an invitation.",
    done: "Meeting added",
  },
  email_send: {
    label: "Email", icon: "chat",
    effect: () => "Approving sends this email from your Gmail address. Nothing is sent before you approve.",
    done: "Email sent",
  },
};
