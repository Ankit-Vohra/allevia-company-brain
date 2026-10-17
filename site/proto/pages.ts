// The pages the prototype site builds, in one list for the build and the tests. /pricing/ is built only when the pricing switch is on
// (shared/flags.ts); its source stays in pricing/index.html.
import { pricingVisible } from "./shared/flags.ts";

const ALL = ["index", "a", "product", "integrations", "team", "pricing", "security", "faq", "contact"];

export const protoPages = (): string[] => ALL.filter((k) => k !== "pricing" || pricingVisible());
