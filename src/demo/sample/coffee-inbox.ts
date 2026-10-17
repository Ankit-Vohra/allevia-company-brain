// The coffee demo's sample inbox and calendar: made-up people at .example addresses, nobody real. The seed records the enquiries
// in the graph (coffee.ts) and the sample Gmail and Google Calendar connections answer from the same list (connections.ts).
import type { CoffeeTimeline } from "./coffee-model.js";

const HOUR = 3_600_000;
const IST_MS = 5.5 * HOUR;

export interface SampleMail {
  key: "wholesale" | "gifting" | "complaint" | "newsletter";
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  company?: string;
  subject: string;
  body: string;
}

export const COFFEE_INBOX: readonly SampleMail[] = [
  {
    key: "wholesale", id: "sample-kettle-crumb-1", threadId: "sample-thr-kettle-crumb", fromName: "Ritika Menon", fromEmail: "ritika@kettleandcrumb.example", company: "Kettle & Crumb",
    subject: "Wholesale beans for our café in Bengaluru",
    body: "Hi, I run Kettle & Crumb, a 40-seat café in HSR Layout, Bengaluru. We want to change our house espresso and would need about 40 kg a month, roasted every two weeks. Could you share your wholesale prices and set up a tasting call this week?",
  },
  {
    key: "gifting", id: "sample-northwind-1", threadId: "sample-thr-northwind", fromName: "Arvind Rao", fromEmail: "arvind.rao@northwindlabs.example", company: "Northwind Labs",
    subject: "Diwali gift boxes for 120 people",
    body: "Hello, we are looking for coffee gift boxes for about 120 employees before Diwali. Can you add a short note from us and deliver to our two offices in Pune and Gurugram? Please send options and prices.",
  },
  {
    key: "complaint", id: "sample-upi-complaint-1", threadId: "sample-thr-upi-complaint", fromName: "Sneha Kulkarni", fromEmail: "sneha.k@mailbox.example",
    subject: "UPI payment failed but money was debited",
    body: "I tried to order two bags on your website on Tuesday evening and paid with UPI. The page said the payment timed out, but the money left my account and I got no order confirmation. Can you check and either send the order or refund me?",
  },
  {
    key: "newsletter", id: "sample-news-1", threadId: "sample-thr-news", fromName: "Coffee Trade Weekly", fromEmail: "newsletter@coffeetrade.example",
    subject: "This week in specialty coffee",
    body: "Unsubscribe any time. Green coffee prices, new roasters and a guide to cold brew.",
  },
];

/** When each sample mail arrived, from the timeline: the enquiry this morning, the gifting one two days ago, the complaint the evening after the release. */
export function sampleAt(t: Pick<CoffeeTimeline, "now" | "releaseDay">, key: SampleMail["key"]): number {
  const istMidnight = (day: string) => Date.parse(`${day}T00:00:00Z`) - IST_MS;
  switch (key) {
    case "wholesale": return t.now - 6 * HOUR;
    case "gifting": return t.now - 58 * HOUR;
    case "complaint": return istMidnight(t.releaseDay) + 24 * HOUR + 21 * HOUR + 10 * 60_000; // Tuesday 21:10 IST
    case "newsletter": return t.now - 20 * HOUR;
  }
}

/**
 * The sample calendar's busy times, in IST, by weekday (1 Monday … 5 Friday): a roastery stand-up every morning, a cupping, café
 * reviews and a supplier call. Weekends are free and are not offered (proposeTimes skips them).
 */
export const BUSY_IST: Readonly<Record<number, ReadonlyArray<[string, string]>>> = {
  1: [["09:00", "10:30"], ["13:00", "14:00"], ["16:00", "17:00"]],
  2: [["09:00", "10:30"], ["13:00", "14:00"], ["15:00", "16:30"]],
  3: [["09:00", "10:30"], ["11:00", "12:30"], ["13:00", "14:00"]],
  4: [["09:00", "10:30"], ["13:00", "14:00"], ["15:00", "16:30"]],
  5: [["09:00", "10:30"], ["13:00", "14:00"], ["17:00", "18:00"]],
};

/** Busy blocks (UTC ISO) between two instants, from BUSY_IST. */
export function busyBlocks(fromMs: number, toMs: number): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const firstDay = new Date(fromMs + IST_MS - 86_400_000).toISOString().slice(0, 10);
  for (let d = Date.parse(`${firstDay}T00:00:00Z`); d <= toMs + IST_MS; d += 86_400_000) {
    const day = new Date(d).toISOString().slice(0, 10);
    for (const [a, b] of BUSY_IST[new Date(d).getUTCDay()] ?? []) {
      const start = Date.parse(`${day}T${a}:00Z`) - IST_MS, end = Date.parse(`${day}T${b}:00Z`) - IST_MS;
      if (end > fromMs && start < toMs) out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    }
  }
  return out;
}
