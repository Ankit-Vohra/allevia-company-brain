// A short sample call for the Blue Tokai demo (docs/demo-bluetokai.md), to show "Remember this meeting" live: the tasting call
// that follows the sample inbox's wholesale enquiry (src/demo/sample/coffee-inbox.ts, Ritika Menon of Kettle & Crumb, 40 kg a
// month). Everyone in it is made up, at .example addresses; the roaster's side is a role, never a real person. It says it is a
// sample in its first line, so what the team saves from it is marked as sample data. Pure data: the web app reads it too.

export const SAMPLE_MEETING_TENANT = "bluetokai";

export const SAMPLE_MEETING_NOTES = `Sample transcript (made up for the demo, nobody real)
Tasting call: Kettle & Crumb wholesale order, Friday 16 October 2026
On the call: Ritika Menon (owner, Kettle & Crumb, ritika@kettleandcrumb.example), Aman Shetty (head barista, Kettle & Crumb, aman@kettleandcrumb.example), and our Wholesale lead (sample role)

Ritika: We tasted the three samples with the team. The dark roast won. It holds up in milk, which is most of what we sell.
Wholesale lead: Good. For 40 seats, what volume are you planning?
Ritika: About 40 kg a month. Two drops of 20 kg, every two weeks, so it stays fresh.
Wholesale lead: We can do that. At 40 kg a month the price is Rs 1,150 per kg for the first three months, then we review it together.
Ritika: That works. Let's start with the delivery on Monday 2 November.
Aman: Deliveries have to come before 8 am, before we open.
Wholesale lead: Fine. I'll send the written quote and the supply agreement by Tuesday 20 October, and book a barista training session at the café in the week of 2 November.
Ritika: I'll confirm the delivery window and the billing address by Wednesday 21 October.
Aman: I'll send you our grinder model by Monday 19 October so you can suggest a grind setting.

Agreed: the dark roast as the house espresso; 40 kg a month in two drops of 20 kg; Rs 1,150 per kg for three months, then a review; first delivery Monday 2 November, before 8 am.`;

/** What the owner sends to have the team remember the sample call. */
export const SAMPLE_MEETING_ASK = `Remember this meeting:\n\n${SAMPLE_MEETING_NOTES}`;
