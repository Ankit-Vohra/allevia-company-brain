// Switches for the prototype site, read when the site is built (never in the browser). The pricing page is hidden for now (the founder's
// request, 17 Oct 2026): with the switch off there is no /pricing/ page, no Pricing in the top bar or the footer, and no plans on the home
// page. Everything that draws them stays in the repo; set ALLEVIA_SITE_PRICING=1 for a build to bring all of it back.
// A function, not a constant, so a test can turn it on and off.
export const pricingVisible = (): boolean => process.env.ALLEVIA_SITE_PRICING === "1";
