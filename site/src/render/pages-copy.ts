// Blocks for the pages that are mostly copy: the three steps, the office loop, the scripted "ask your team" walkthrough,
// the Studio comparison, the contact channels and the demo button. Company facts and the demo address come from
// src/company.ts and src/config.ts; an empty one shows a TODO(founder) mark (company.ts) or hides the control (the demo).
import { COMPANY, COMMITMENTS, fact, mail } from "../company.ts";
import { CONTACT_URL, DEMO_URL } from "../config.ts";
import { STEPS } from "../content.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function stepsShort(): string {
  return `<ol class="steps3">${STEPS.map((s) => `<li class="steps3__item"><p class="steps3__n" aria-hidden="true">${s.n}</p><h3>${esc(s.title)}</h3><p>${esc(s.short)}</p></li>`).join("")}</ol>`;
}

/** The office-life loop: the poster is the first paint and the reduced-motion fallback; the loop only starts when motion is welcome and the video is in view (main.ts). */
export function officeLoop(): string {
  return `<figure class="loop" data-loop>
  <img class="loop__poster" src="/img/office-life-poster-1280.webp" width="1280" height="720" loading="lazy" decoding="async"
    alt="The office in the app at about eleven in the morning: the team at their desks, a coffee counter, a ping-pong table, and two dogs and a cat on the floor." />
  <video class="loop__video" muted loop playsinline preload="none" aria-hidden="true" tabindex="-1" data-mp4="/img/office-life.mp4"></video>
  <button class="loop__pause" type="button" hidden data-loop-pause aria-pressed="false">Pause the loop</button>
  <figcaption>A short loop of the real office, a dog on a delivery. <span class="tag">sample numbers</span></figcaption>
</figure>`;
}

/** "Try the live demo": absent while DEMO_URL is empty. */
export function demoButton(url: string = DEMO_URL): string {
  return url ? `<a class="btn btn-ghost btn-lg" href="${esc(url)}" rel="noopener" target="_blank">Try the live demo<span class="visually-hidden"> (opens the demo in a new tab)</span></a>` : "";
}

/** The scripted walkthrough: one real question from the sample business, the plan, the answer and the card. */
export function askWalkthrough(): string {
  const chip = (t: string) => `<span class="src">${esc(t)}</span>`;
  return `<div class="chat" role="group" aria-label="A scripted example: asking your team why stories were paused">
  <p class="chat__label">Scripted example. Sample business, sample numbers.</p>
  <div class="chat__turn chat__turn--you">
    <p class="chat__who">You</p>
    <p class="chat__say">Why did we pause daily stories, and what should we post instead?</p>
  </div>
  <div class="chat__turn chat__turn--team">
    <p class="chat__who">Meera, Chief of Staff</p>
    <p class="chat__say">On it. Sara looks up what we decided and why. Kabir ranks our reel hooks by reach over the last 90 days. Tara drafts three briefs, Dev checks them for voice and Nisha for facts, and Isha confirms every figure before it reaches you.</p>
    <details class="chat__how"><summary>Show how the team worked</summary><p>Seven people, about 30 seconds. Each step is on the record: who looked at what, what they found, and which reviewer checked it. A finding that fails its check is marked "unverified" instead of being hidden.</p></details>
  </div>
  <div class="chat__turn chat__turn--team">
    <p class="chat__who">Meera, the answer</p>
    <div class="chat__answer">
      <p><strong>We paused daily posts and stories on 28 Sep 2026 because almost no one saw them.</strong> Stories and feed posts reached about 24 accounts each, while reels brought 97% of our Instagram reach. ${chip("Decision 007: pause daily posts and stories")} ${chip("Reels: 97% of Instagram reach")}</p>
      <p><strong>Post reels that open on a real salary or follow a real shift.</strong> Over the last 90 days (18 reels), salary-reveal hooks got 3.4 times our median reach and day-in-the-life hooks 2.1 times. Question-to-camera hooks got 0.6 times, so drop them. ${chip("Reach by hook, 90 days")}</p>
      <p>Three briefs, checked by Dev for voice and Nisha for facts:</p>
      <ol>
        <li><strong>Seekers:</strong> "a forklift operator's real month." Open on the payslip, then the shift.</li>
        <li><strong>Seekers:</strong> "What a delivery partner takes home." Salary reveal, Hindi first, English captions.</li>
        <li><strong>Employers:</strong> "From job post to a screened shortlist." A day with one employer and the AI screening call.</li>
      </ol>
      <p><strong>Next:</strong> approve the draft below and the three reels get scripted. Figures as of 14 Oct 2026.</p>
    </div>
    <p class="chat__ok"><span class="chat__ok-label">Waiting for your OK</span> Draft 3 reels: two salary reveals and a day with the screening call <span class="chat__btn" aria-hidden="true">Review</span></p>
    <p class="chat__foot">Sources checked, seven people. "See the path" lights up the seven steps the team followed.</p>
  </div>
</div>`;
}

/** The Studio before and after: our own trial photo, three versions. */
export function studioCompare(): string {
  return `<div class="compare">
  <figure class="compare__item compare__item--before">
    <img src="/img/studio-before-480.webp" width="480" height="293" loading="lazy" decoding="async" alt="The original phone photo: a dark, bluish, tilted landscape shot of a desk with a bonsai, a shelf and three coloured pendant lamps." />
    <figcaption><strong>Your photo.</strong> Dark, blue, tilted. A deliberately rough copy of a studio's own website photo.</figcaption>
  </figure>
  <figure class="compare__item">
    <img src="/img/studio-local-480.webp" width="480" height="600" loading="lazy" decoding="async" alt="The cleaned-up version: straightened, brighter and cropped for a post, still a little grey and grainy." />
    <figcaption><strong>Cleaned up in the Studio.</strong> Straightened, brightened, cropped. Nothing added or removed.</figcaption>
  </figure>
  <figure class="compare__item">
    <img src="/img/studio-ai-480.webp" width="480" height="600" loading="lazy" decoding="async" alt="The AI-relit version: warm, clean light on the same desk, bonsai, shelf and pendant lamps, with nothing added or removed." />
    <figcaption><strong>AI relight, made ahead of time.</strong> Warm and clean, with the desk, bonsai and lamps unchanged.</figcaption>
  </figure>
</div>
<p class="fine">Photos: AVS Atelier's own public website photo, degraded on purpose for the trial. Labelled as AI-edited wherever it is used.</p>`;
}

export function examplesTable(): string {
  const rows: [string, string, string][] = [
    ["\"Why did enquiries drop this month?\"", "Kabir looks at the numbers, Isha checks them", "An answer with its sources, and an idea for what to do"],
    ["\"What should we post this week?\"", "Tara plans, Dev checks the voice, Nisha checks the facts", "Drafts on a card waiting for your OK. Never posted on their own"],
    ["\"What did we decide about pricing?\"", "Sara, who keeps the company's memory", "The decision, with who made it and the sources"],
    ["\"Is the website healthy?\"", "Arjun, Zoya and Imran in Tech", "What is wrong, in order of importance, and a note you can hand to your web designer"],
    ["Legal, tax, moving money or medical advice", "Meera", "A polite no, and who to ask instead"],
  ];
  return `<table class="ledger ledger--route"><caption class="visually-hidden">Examples of what you might say and who takes it</caption><thead><tr><th scope="col">You say</th><th scope="col">Who takes it</th><th scope="col">What comes back</th></tr></thead><tbody>${rows
    .map(([a, b, c]) => `<tr><td data-label="You say">${esc(a)}</td><td data-label="Who takes it">${esc(b)}</td><td data-label="What comes back">${esc(c)}</td></tr>`)
    .join("")}</tbody></table>`;
}

// ---------- contact ----------

export function contactChannels(): string {
  const discord = COMPANY.discordSupportUrl.trim()
    ? `<a class="btn btn-gold" href="${esc(COMPANY.discordSupportUrl)}" rel="noopener">Join the support channel on Discord</a>`
    : `<mark class="todo">TODO(founder): the permanent invite link to the support channel on Discord</mark>`;
  return `<ul class="cards3 cards3--two">
  <li><h3>Free Brain Snapshot</h3><p>Email us your website address, your country and, if you have them, your Instagram handle and Google listing. We read what is public and reply with what we learned about your business and five ranked fixes. It is free and you pay nothing first.</p><p class="card__act">${mail(COMPANY.email.general, "the general contact email")}</p></li>
  <li><h3>Support</h3><p>Customers: write in #support in your own area on Discord, where a person from our team answers (your AI team never does). Not a customer yet, or lost your invite? Use our Discord invite below, or email. We reply within ${esc(COMMITMENTS.supportReply)}.</p><p class="card__act">${discord}</p><p class="card__act">${mail(COMPANY.email.support, "the support email")}</p></li>
  <li><h3>Privacy and data requests</h3><p>To get a copy of your data, correct it or have it deleted, email us. The page "Delete your data" has the steps and what to expect.</p><p class="card__act">${mail(COMPANY.email.privacy, "the privacy requests email")}</p><p class="card__act"><a class="link" href="/data-deletion/">Delete your data</a></p></li>
  <li><h3>Security</h3><p>Found a weakness? Please tell us privately and give us a chance to fix it before sharing it. We will thank you and tell you when it is fixed.</p><p class="card__act">${mail(COMPANY.email.security, "the security reports email")}</p></li>
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
  return url ? "" : `<p class="fine">The live demo is being set up. Until it is, the product tour shows the same screens.</p>`;
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
  "steps-short": stepsShort,
  "office-loop": officeLoop,
  "demo-button": () => demoButton(),
  "ask-walkthrough": askWalkthrough,
  "studio-compare": studioCompare,
  "examples-table": examplesTable,
  "contact-channels": contactChannels,
  "company-line": companyLine,
};
