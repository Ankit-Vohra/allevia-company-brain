// What one spreadsheet upload may cost us, and the one error type the whole upload path throws. Every message is a
// sentence an owner can act on (docs/owner-words.md): no stack, no code names.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;     // the file as it arrives
export const MAX_ROWS = 50_000;                      // rows of data, not counting the header
export const MAX_COLUMNS = 100;
export const MAX_CELL_CHARS = 1_000;                 // a longer cell is cut, never stored
export const MAX_VALUES = 20_000;                    // numbers written to the graph from one file
export const MAX_PART_BYTES = 64 * 1024 * 1024;      // one part of an XLSX once unpacked (a zip bomb stops here)
export const MAX_UNPACKED_BYTES = 96 * 1024 * 1024;  // all parts of an XLSX once unpacked
export const MAX_ZIP_ENTRIES = 400;
export const MAX_SHARED_STRINGS = 1_000_000;

export type UploadErrorCode =
  | "empty" | "no_rows" | "too_big" | "too_many_rows" | "too_many_columns" | "too_many_values" | "unreadable" | "old_excel" | "locked"
  | "unpacks_too_big" | "no_date" | "no_numbers" | "personal" | "bad_plan" | "needs_answer" | "future_only";

export class UploadError extends Error {
  override name = "UploadError";
  constructor(message: string, readonly code: UploadErrorCode) {
    super(message);
  }
}

export const num = (n: number): string => n.toLocaleString("en-US");
