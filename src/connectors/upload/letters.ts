// A column's spreadsheet letter: 0 -> "A", 26 -> "AA". The owner finds "column C" on their own screen.
export function letterOf(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
