// Where the real vault lives on this machine, for the few tests that check structure against it (and skip when it is
// absent). Same default and override as src/config.ts. Those tests never copy vault content into the repo.
import { homedir } from "node:os";
import { join } from "node:path";

export const BRAIN_PATH = process.env.ALLEVIA_BRAIN_PATH?.replace(/^~(?=\/|$)/, homedir()) ?? join(homedir(), "aamdani-brain");
