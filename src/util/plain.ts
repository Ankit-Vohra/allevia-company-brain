// A name the owner reads, without the privacy filter's marker: "Supabase prod ([redacted:supabase-ref], Mumbai)" is shown as
// "Supabase prod (Mumbai)". Used where a stored name goes into a page or a card (the Brain's what-breaks panel, the structural detector).
export const plainName = (s: string): string =>
  s.replace(/\(\s*\[redacted:[a-z-]+\]\s*\)/gi, "").replace(/\[redacted:[a-z-]+\]\s*,?\s*/gi, "").replace(/\s{2,}/g, " ").trim();
