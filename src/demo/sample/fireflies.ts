// A sample Fireflies account for the Blue Tokai demo, so automatic meeting capture can be shown end to end without a real recorder.
// It holds one call in Fireflies' own shape (FIREFLIES_GET_TRANSCRIPT_BY_ID's data: sentences with speaker names, the attendee
// list with emails, Fireflies' summary and action items): the follow-up to the sample tasting call (shared/sample-meeting.ts,
// Fri 16 Oct), where Kettle & Crumb adds decaf, asks for a launch-day post, and reports that the wholesale reorder coupon fails at
// checkout. Everyone in it is made up, at .example addresses; the roaster's side are roles, never real people. The title and the
// first summary line say it is a sample, so everything saved from it is marked sample data.
//
// It answers through the same session shape as the real Fireflies toolkit on Composio (execute by tool name), behind the sample
// connections port (connections.ts), so `npm run cli -- meetings ingest bluetokai` runs the real capture code, start to finish.
import { ComposioError, type ComposioToolInfo } from "../../connections/composio.js";
import { FIREFLIES_TOOLS } from "../../meetings/recorders.js";

const RITIKA = { name: "Ritika Menon", email: "ritika@kettleandcrumb.example" };
const AMAN = { name: "Aman Shetty", email: "aman@kettleandcrumb.example" };
const WHOLESALE = { name: "Wholesale lead (sample role)", email: "wholesale@roaster-sample.example" };
const MARKETING = { name: "Marketing lead (sample role)", email: "marketing@roaster-sample.example" };

export const SAMPLE_FIREFLIES_ID = "sample-ff-kettle-crumb-follow-up";
/** Sat 17 Oct 2026, 11:00 IST: the day after the tasting call. */
export const SAMPLE_FIREFLIES_AT = Date.UTC(2026, 9, 17, 5, 30);

const LINES: Array<[{ name: string }, string]> = [
  [WHOLESALE, "Thanks for making time again. This is a sample call for the demo. We have your order down as 40 kg a month of the dark roast, first drop on Monday 2 November."],
  [RITIKA, "Yes, that stands. One change: some of our regulars want a decaf. Can you add 5 kg a month of the Swiss water decaf?"],
  [WHOLESALE, "We can. Decaf is Rs 1,250 per kg on the same three-month terms, so 45 kg a month in total."],
  [RITIKA, "Agreed. And we would like to pay 15 days after each delivery, not on delivery."],
  [WHOLESALE, "That works for a café your size. I will send the revised quote with the decaf and the 15-day terms by Tuesday 20 October."],
  [AMAN, "Small thing: I tried the reorder link on your wholesale page yesterday and the KETTLE10 coupon failed at checkout. It just said invalid code."],
  [WHOLESALE, "Sorry about that. We will get the wholesale checkout fixed by Wednesday 21 October so your reorders go through."],
  [RITIKA, "Thanks. We are launching the dark roast on our menu on 2 November. Could you do a post about it with us?"],
  [MARKETING, "Happily. We will post about the new roast at Kettle & Crumb on launch day, Monday 2 November, and tag you."],
  [AMAN, "I will share the opening-week menu by Friday 23 October, so the post shows the right drinks."],
  [WHOLESALE, "And the barista training: shall we fix Tuesday 3 November at 3 pm at the café?"],
  [AMAN, "Tuesday 3 November works. Before service ends at 4 pm."],
  [WHOLESALE, "Good. We will schedule the barista training for Tuesday 3 November at 3 pm."],
  [RITIKA, "Last one from me: I will send our GST details for the invoices by Monday 19 October."],
];

/** The sample call as Fireflies' FIREFLIES_GET_TRANSCRIPT_BY_ID returns it (its `data`). */
export function sampleFirefliesTranscript(): Record<string, unknown> {
  let t = 0;
  const sentences = LINES.map(([who, text], index) => {
    const start = t;
    t += 6 + Math.round(text.length / 14);
    return { index, speaker_name: who.name, speaker_id: [WHOLESALE, RITIKA, AMAN, MARKETING].indexOf(who as typeof WHOLESALE), text, raw_text: text, start_time: start, end_time: t };
  });
  return {
    id: SAMPLE_FIREFLIES_ID,
    title: "Kettle & Crumb follow-up call (sample)",
    date: SAMPLE_FIREFLIES_AT,
    dateString: new Date(SAMPLE_FIREFLIES_AT).toISOString(),
    duration: Math.round(t / 60),
    organizer_email: WHOLESALE.email,
    participants: [RITIKA.email, AMAN.email, WHOLESALE.email, MARKETING.email],
    meeting_attendees: [RITIKA, AMAN, WHOLESALE, MARKETING].map((p) => ({ displayName: p.name, email: p.email, name: p.name })),
    speakers: [WHOLESALE, RITIKA, AMAN, MARKETING].map((p, id) => ({ id, name: p.name })),
    sentences,
    summary: {
      overview: "Sample call for the demo. Kettle & Crumb adds 5 kg a month of decaf to its 40 kg dark roast order, asks for 15-day payment terms and a launch-day post, and reports that the wholesale reorder coupon fails at checkout.",
      action_items: [
        "**Wholesale lead (sample role)**", "Send the revised quote with the decaf and the 15-day terms by Tuesday 20 October (00:31)",
        "Get the wholesale checkout fixed by Wednesday 21 October (00:52)", "Schedule the barista training for Tuesday 3 November at 3 pm (01:40)",
        "**Marketing lead (sample role)**", "Post about the new roast at Kettle & Crumb on launch day, Monday 2 November (01:12)",
        "**Aman Shetty**", "Share the opening-week menu by Friday 23 October (01:20)",
        "**Ritika Menon**", "Send the GST details for the invoices by Monday 19 October (01:55)",
      ].join("\n"),
      keywords: ["decaf", "payment terms", "checkout coupon", "launch post", "barista training"],
    },
    transcript_url: `https://fireflies.example/view/${SAMPLE_FIREFLIES_ID}`,
    sample: true,
  };
}

const TOOLS: ComposioToolInfo[] = [
  { slug: FIREFLIES_TOOLS.list, name: "List transcripts", description: "Recorded calls, newest first (sample Fireflies account)." },
  { slug: FIREFLIES_TOOLS.get, name: "Get a transcript", description: "One recorded call: its sentences, attendees and summary (sample Fireflies account)." },
];

/** The sample Fireflies account, in Composio's session shape. It lists its one call whatever the dates asked for. */
export function sampleFirefliesSession() {
  return {
    toolkit: "fireflies",
    async listTools(): Promise<ComposioToolInfo[]> { return TOOLS; },
    async execute(tool: string, args: Record<string, unknown>): Promise<unknown> {
      const t = sampleFirefliesTranscript();
      switch (tool.toUpperCase()) {
        case FIREFLIES_TOOLS.list:
          return { transcripts: [{ id: t.id, title: t.title, date: t.date, duration: t.duration, organizer_email: t.organizer_email, participants: t.participants, sample: true }] };
        case FIREFLIES_TOOLS.get:
          if (args.id !== SAMPLE_FIREFLIES_ID) throw new ComposioError(`The sample Fireflies account has no transcript "${String(args.id).slice(0, 60)}".`, 404);
          return t;
        default:
          throw new ComposioError(`The sample Fireflies account has no "${tool.slice(0, 60)}". It has: ${TOOLS.map((x) => x.slug).join(", ")}.`, 400);
      }
    },
  };
}
