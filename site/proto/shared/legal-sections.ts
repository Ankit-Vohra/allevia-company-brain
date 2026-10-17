// About and the legal pages (Privacy, Terms, Cookies, Data deletion) in the prototype's design. The words come from the main site's
// renderers (src/render/legal.ts), so there is one text to keep current. Two changes for the public pages:
//   - a company fact the founder has not filled in yet (src/company.ts) is said in plain words instead of the bright TODO(founder) mark;
//   - while the pricing page is hidden (flags.ts), the terms point to the plan agreed in writing instead of a Pricing page.
// A TODO mark that is not handled here fails the build, so none can reach a visitor.
import { COMPANY } from "../../src/company.ts";
import { LEGAL_BLOCKS } from "../../src/render/legal.ts";
import { pricingVisible } from "./flags.ts";
import { esc } from "./util.ts";

/** The name the site already uses in its footer, until the registered legal name is filled in. */
const tradingName = () => COMPANY.legalName.trim() || "Allevia AI";

const todo = (what: string) => new RegExp(`<mark class="todo">TODO\\(founder\\): ${what}[^<]*</mark>`, "g");

export function publicLegal(html: string): string {
  let out = html
    .replace(new RegExp(`${todo("the company.s registered legal name").source}, ${todo("the kind of company").source}`, "g"), esc(tradingName()))
    .replace(todo("the company.s registered legal name"), esc(tradingName()))
    .replace(new RegExp(`,? ?${todo("the kind of company").source}`, "g"), "")
    .replace(new RegExp(`\\s*${todo("confirm the Anthropic plan").source}`, "g"), "")
    .replace(new RegExp(`<th scope="row">${todo("the payment provider").source}</th>`, "g"), `<th scope="row">Payments</th>`)
    .replace(todo("the payment provider"), "a payment provider we will name here before billing opens");
  if (!pricingVisible()) {
    out = out
      .replace(/(?:on the|on our) <a href="\/pricing\/">Pricing page<\/a>/g, "in your written plan")
      .replace(/(?:the|our) <a href="\/pricing\/">Pricing page<\/a>/g, "your written plan")
      .replace(/on the Pricing page/g, "in your written plan")
      .replace(/the Pricing page/g, "your written plan");
  }
  const left = out.match(pricingVisible() ? /<mark class="todo">[^<]*<\/mark>|href="\/demo\/"/ : /<mark class="todo">[^<]*<\/mark>|href="\/(?:pricing|demo)\/"/);
  if (left) throw new Error(`proto: a legal page still has ${left[0]}; say it in plain words in legal-sections.ts`);
  return out;
}

const legal = (name: string) => () => {
  const make = LEGAL_BLOCKS[name];
  if (!make) throw new Error(`proto: no legal page named "${name}"`);
  return publicLegal(make());
};

function about(): string {
  const works = ["Set up from your website", "Ask in the app or on Discord, with sources", "Sales replies with three real times", "Drafts you approve with one tap"];
  const building = ["Your own tools, switched on for every business", "Posting and sending after your OK", "A login for each person"];
  const list = (items: string[]) => `<ul class="ticks">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const founder = COMPANY.founderName.trim() ? `<p>Allevia was started by ${esc(COMPANY.founderName)}, who still runs it.</p>` : "";
  return `<section class="page-head" aria-labelledby="h1"><div class="wrap"><h1 id="h1" class="page-h1"><span class="t1">Built in India,</span> <span class="t2">for founders whose business already works.</span></h1>
<p class="lede">A small team sets up your AI team and keeps it running. Aamdani, a jobs app, and AVS Atelier, an architecture studio, were the first two businesses.</p></div></section>
<section class="legal"><div class="wrap about__grid">
  <div class="about__col"><h2 class="about__h">Works today</h2>${list(works)}</div>
  <div class="about__col"><h2 class="about__h">Being built</h2>${list(building)}</div>
  <div class="about__col about__col--wide">${founder}<p class="fine">Allevia is operated by ${esc(tradingName())} from ${esc(COMPANY.registeredAddress)}. Write to us at <a href="mailto:${esc(COMPANY.email.general)}">${esc(COMPANY.email.general)}</a>.</p></div>
</div></section>`;
}

export const LEGAL_SECTIONS: Record<string, (page: string) => string> = {
  about,
  "legal-privacy": legal("privacy"),
  "legal-terms": legal("terms"),
  "legal-cookies": legal("cookies"),
  "legal-data-deletion": legal("data-deletion"),
};
