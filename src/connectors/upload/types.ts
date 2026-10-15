// The shapes the spreadsheet upload hands to a surface (the web app today, Discord later). They mirror
// web/src/types-ext.ts; change both together.
import type { DateOrder } from "./dates.js";

export type Cadence = "day" | "week" | "month";

// What the owner confirms. `metric` is a catalogue key (metrics.ts), "skip" (leave the column out), "other" (the owner's
// own name for it, in `label`), or null while it still needs an answer (the preview's guess for a column it cannot name).
export interface PlanColumn { index: number; metric: string | null; label?: string }

export interface UploadPlan {
  dateColumn: number;
  dateOrder: DateOrder;
  cadence: Cadence | "ranges" | null;   // "ranges": every row carries its own first and last day
  weekAnchor: "start" | "end";          // a weekly row's date is the first or the last day of that week
  columns: PlanColumn[];
}

export interface PreviewColumn {
  index: number;
  letter: string;                       // the spreadsheet's own letter, so the owner can find it: "C"
  header: string;
  sample: string[];
  guess: { metric: string | null; label: string | null; sure: boolean };
}

export type Question = "date_order" | "cadence" | "metrics";

export interface MetricOption { key: string; label: string }

export interface Preview {
  fileName: string;
  fileHash: string;
  sheet?: string;
  otherSheets?: string[];
  rowCount: number;                     // rows with a date
  dateColumn: { index: number; letter: string; header: string };
  dateOrderGuessed: boolean;
  cadence: Cadence | null;              // what the rows look like, null when we cannot tell
  from: string;                         // first day covered
  to: string;                           // last day covered
  columns: PreviewColumn[];             // the number columns the owner is asked about
  leftOut: Array<{ index: number; header: string; reason: string }>;
  skippedRows: number;                  // rows with no date
  blanks: number;                       // blank number cells, kept blank
  duplicates: number;                   // rows that repeat another row's date
  headline: string;                     // "This looks like weekly enquiries, from 6 Jul to 11 Oct. OK?"
  sentences: string[];                  // the rest, in plain words
  sampleRows: string[][];               // the first three rows: the date and the number columns only
  questions: Question[];                // what must be answered before importing
  metricOptions: MetricOption[];
  plan: UploadPlan;                     // the guess, ready to send back as it is or edited
  feedsGoals?: Array<{ id: string; name: string }>; // filled by the server from the business's own goals
}

export interface SeriesPoint {
  metric: string;                       // the key it is stored under
  label: string;
  windowStart: string;
  windowEnd: string;
  value: number;
  header: string;
}

export interface Series {
  points: SeriesPoint[];
  rowCount: number;
  skippedRows: number;
  blanks: number;
  duplicates: number;
  negatives: number;                    // counts below zero, left out
  from: string | null;
  to: string | null;
}
