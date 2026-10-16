// Blocks for the pages that are mostly copy: the contact channels, the about page's company line and the demo button.
// Company facts and the demo address come from src/company.ts and src/config.ts; an empty one shows a TODO(founder)
// mark (company.ts) or hides the control (the demo).
import { COMPANY, COMMITMENTS, fact, mail } from "../company.ts";
import { CONTACT_URL, DEMO_URL } from "../config.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "Try the live demo": absent while DEMO_URL is empty. */
export function demoButton(url: string = DEMO_URL): string {
  return url ? `<a class="btn btn-ghost btn-lg" href="${esc(url)}" rel="noopener" target="_blank">Try the live demo<span class="visually-hidden"> (opens the demo in a new tab)</span></a>` : "";
}

// ---------- contact ----------

export function contactChannels(): string {
  const discord = COMPANY.discordSupportUrl.trim()
    ? `<a class="btn btn-gold" href="${esc(COMPANY.discordSupportUrl)}" rel="noopener">Join the support channel on Discord</a>`
    : `<mark class="todo">TODO(founder): the permanent invite link to the support channel on Discord</mark>`;
  return `<ul class="cards3 cards3--two">
  <li><h3>Free Brain Snapshot</h3><p>Email your website address and country. We send back what we learned about your business and five ranked fixes. It is free.</p><p class="card__act">${mail(COMPANY.email.general, "the general contact email")}</p></li>
  <li><h3>Help</h3><p>A person answers, never your AI team. We reply within ${esc(COMMITMENTS.supportReply)}.</p><p class="card__act">${discord}</p><p class="card__act">${mail(COMPANY.email.support, "the support email")}</p></li>
  <li><h3>Your data</h3><p>Email us for a copy of your data, or to have it deleted.</p><p class="card__act">${mail(COMPANY.email.privacy, "the privacy requests email")}</p><p class="card__act"><a class="link" href="/data-deletion/">How deletion works</a></p></li>
  <li><h3>Security</h3><p>Found a weakness? Tell us privately and we will fix it.</p><p class="card__act">${mail(COMPANY.email.security, "the security reports email")}</p></li>
</ul>`;
}

export function companyLine(): string {
  const reg = COMPANY.registrationNumber.trim() ? `, registration number ${esc(COMPANY.registrationNumber)}` : "";
  return `<p class="fine">Allevia is operated by ${fact(COMPANY.legalName, "the company's registered legal name")}, ${fact(COMPANY.entityType, "the kind of company")}${reg}. Registered office: ${fact(COMPANY.registeredAddress, "the registered office address")}.</p>`;
}

export function contactCta(): string {
  return `<a class="btn btn-gold btn-lg" href="${CONTACT_URL}">Get a free Brain Snapshot</a>`;
}

export function aboutFounder(): string {
  return COMPANY.founderName.trim() ? `<p class="body">Allevia was started by ${esc(COMPANY.founderName)}, who still runs it.</p>` : `<p class="body"><mark class="todo">TODO(founder): your name, for one line about who started Allevia (company.ts founderName; leave it empty to drop the line)</mark></p>`;
}

export const supportReply = (): string => esc(COMMITMENTS.supportReply);

export const securityContact = (): string => mail(COMPANY.email.security, "the security reports email");

/** While the demo has no address, say so plainly. Once DEMO_URL is set this block is empty. */
export function demoStatus(url: string = DEMO_URL): string {
  return url ? "" : `<p class="fine">The live demo is being set up. The product tour shows the same screens.</p>`;
}

/** Which businesses the public demo shows. The founder's call; the page says it is a decision, not a guess. */
export function demoData(): string {
  return `<p class="fine">The demo runs on example businesses that we load for it. <mark class="todo">TODO(founder): confirm which businesses are loaded in the public demo (a made-up sample company, and/or Aamdani and AVS Atelier with their permission), then say so here. No customer's data may be loaded.</mark></p>`;
}

export const PAGE_BLOCKS: Record<string, (current: string) => string> = {
  "about-founder": aboutFounder,
  "support-reply": supportReply,
  "security-contact": securityContact,
  "demo-status": () => demoStatus(),
  "demo-data": demoData,
  "demo-button": () => demoButton(),
  "contact-channels": contactChannels,
  "company-line": companyLine,
};
