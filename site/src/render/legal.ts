// The legal pages: Privacy Policy, Terms of Service, data deletion and the cookie note. They are written from what the
// product does today (the code, the design spec and the content and onboarding trials), and where a feature is still
// being built the text says so ("when ... opens"). Company facts and every commitment about timing come from
// src/company.ts, so there is one place to fill in and one place to change. Nothing here is legal advice: the draft
// needs a lawyer's review before it is published.
import { COMMITMENTS, COMPANY, LEGAL_UPDATED, fact, mail } from "../company.ts";
import { SITE_URL } from "../config.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Section { id: string; title: string; html: string }

const co = () => `${fact(COMPANY.legalName, "the company's registered legal name")}`;
const privacyMail = () => mail(COMPANY.email.privacy, "the privacy requests email");
const supportMail = () => mail(COMPANY.email.support, "the support email");

function doc(opts: { title: string; lead: string; summary?: string[]; sections: Section[] }): string {
  const toc = opts.sections.map((s, i) => `<li><a href="#${s.id}">${i + 1}. ${esc(s.title)}</a></li>`).join("");
  const body = opts.sections
    .map((s, i) => `<section class="legal__sec" id="${s.id}" aria-labelledby="${s.id}-h"><h2 id="${s.id}-h"><span class="legal__n">${i + 1}.</span> ${esc(s.title)}</h2>${s.html}</section>`)
    .join("");
  const summary = opts.summary
    ? `<section class="legal__short" aria-labelledby="short-h"><h2 id="short-h">The short version</h2><ul class="ticks">${opts.summary.map((x) => `<li>${x}</li>`).join("")}</ul><p class="fine">This summary is for convenience. The full text below is what applies.</p></section>`
    : "";
  return `<section class="page-head" aria-labelledby="h1"><div class="wrap page-head__in page-head__in--one"><div><h1 id="h1" class="page-head__h page-head__h--legal">${esc(opts.title)}</h1><p class="lede">${opts.lead}</p><p class="legal__date">Last updated: ${esc(LEGAL_UPDATED)}</p></div></div></section>
<section class="section legal"><div class="wrap legal__in"><nav aria-label="On this page"><details class="legal__toc" data-toc><summary class="legal__toc-h">On this page</summary><ol>${toc}</ol></details></nav><div class="legal__body">${summary}${body}</div></div></section>`;
}

const table = (head: string[], rows: string[][], cls = "") =>
  `<div class="table-wrap"><table class="ledger ledger--legal ${cls}"><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td data-label="${esc(head[i]!)}">${c}</td>`)).join("")}</tr>`)
    .join("")}</tbody></table></div>`;

// =====================================================================================================================
// Privacy Policy
// =====================================================================================================================

export function privacy(): string {
  const region = fact(COMPANY.hosting.region, "the region the servers are in");
  const sections: Section[] = [
    {
      id: "who",
      title: "Who we are",
      html: `<p>Allevia is operated by ${co()}, ${fact(COMPANY.entityType, "the kind of company")}, with its registered office at ${fact(COMPANY.registeredAddress, "the registered office address")} ("Allevia", "we", "us"). You can reach us about privacy at ${privacyMail()}.${COMPANY.privacyOfficer.trim() ? ` Our person responsible for privacy requests and complaints is ${esc(COMPANY.privacyOfficer)}.` : ""}</p>
<p>We play two roles. For what a business gives us to run its team (its website, photos, numbers, connected accounts, chats), we process the information on that business's behalf and under its instructions, and the business decides what to share. For our own website, contact requests and billing, we decide how the information is used.</p>`,
    },
    {
      id: "scope",
      title: "What this policy covers",
      html: `<p>This policy covers the Allevia website at ${esc(SITE_URL.replace(/^https?:\/\//, ""))} ("the site"), the Allevia app, the public demo, and the Allevia server and bot on Discord (together, "the service"). It does not cover other sites we link to, or the platforms you connect, such as Instagram, Google and Discord, which have their own policies.</p>`,
    },
    {
      id: "collect",
      title: "What we collect, and why",
      html: `<p>We collect only what the service needs. Here is each kind of information, where it comes from, what we use it for, and where it is kept.</p>${table(
        ["Where it comes from", "What we collect", "Why we use it", "Where it is kept"],
        [
          ["You contact us or ask for a Brain Snapshot", "Your name, email address, business name, website address, country and whatever you write to us.", "To reply, to set up your team and to support you.", "Our email and our records."],
          ["Your public website", "The text, headings, page titles, product and service names, images' addresses, and the colours and fonts of the pages we can read without logging in. Phone numbers and email addresses are removed before anything is stored.", "To learn what you sell, who it is for and how you sound; to run website checks; to propose your goals.", "Your business's own database."],
          ["Public information about your business and the competitors you name (only when public lookups are switched on)", "From your public Google Maps listing: address, opening hours, category, rating, number of reviews, and recent reviews of your business with the reviewer's first name at most (no surnames, photos or profile links; phone numbers and email addresses are removed). From public Instagram profiles of your business and the competitors you name: follower and post counts and the public likes, comments and views of recent posts. From the public ad libraries of Meta and Google: the ads a brand runs. Never private accounts or private insights.", "To know your business's basic facts from day one, to compare you with competitors you choose, and to show what their public posts and ads look like.", "Your business's own database."],
          ["What you tell your team", "Your questions and instructions, your edits to drafts, what you approve or reject, and the rules your team learns from those edits.", "To answer you, to remember what you taught it, and to improve the next draft.", "Your business's own database."],
          ["Photos and videos you upload (in the app or the Studio channel on Discord)", "The image or video, the note you add, and its size and shape. Location and device details are removed on arrival. See <a href=\"#photos\">Photos and videos</a>.", "To make clean-up versions and post captions for your approval.", "A folder of your own on our server, and a record in your business's database."],
          ["Spreadsheets and numbers you upload (this is being built)", "The figures, dates and column names in the file. Please do not upload files with your customers' personal details: we do not need them.", "To measure your goals against your own numbers.", "Your business's own database."],
          ["Accounts you connect (being built; see <a href=\"#google\">Google</a> and <a href=\"#instagram\">Instagram</a>)", "Read-only numbers: for Instagram, your profile details and post and account reach; for Search Console, clicks, impressions, search terms and pages; for Google Analytics, visits, sources and conversions; for your Google Business Profile, calls, direction requests, website clicks and reviews.", "To show how you are doing and to explain why a number moved.", "Your business's own database."],
          ["Your owner link", "A one-way fingerprint of the private link that opens your business (never the link itself), and when it was made. If you join our Discord, which Discord role your invite gave you.", "To check that a request is from your business, and to cancel the link if you ask.", "Our registry, apart from every business's own database."],
          ["Discord", "What you write and the files you attach in your business's channels, and your membership of its area. See <a href=\"#discord\">Discord</a>.", "To answer you, to show approval cards, and to give you support.", "Discord, and your business's own database."],
          ["Billing (when payments open)", "Your name, billing email, plan and whether payments went through. Card numbers go to the payment provider, never to us.", "To charge you, give refunds and meet tax law.", "Our payment provider and our records."],
          ["Visiting this site or the demo", "The usual server log: your IP address, the time, the page asked for and your browser's name. No cookies, no analytics. See <a href=\"/cookies/\">Cookies and analytics</a>.", "To keep the site working and to spot abuse.", "Our web server."],
        ],
      )}
<p>We do not collect passwords to your accounts, card numbers, or anything about your customers that you do not choose to give us. We do not buy information about you from anyone else.</p>`,
    },
    {
      id: "use",
      title: "What we do with it, and what we do not",
      html: `<p>We use information to run the service for the business it belongs to: to read your site, answer your questions, draft work for your approval, check facts, write your notes and keep the service secure and working. A person at Allevia may open your workspace to set it up and to help you.</p>
<ul class="ticks">
<li>We do <strong>not</strong> sell your information, and we do not share it for advertising.</li>
<li>We do <strong>not</strong> use one business's information for another business. Each business is its own separate database.</li>
<li>We do <strong>not</strong> use your information to train AI models. See <a href="#processors">Who handles it for us</a>.</li>
<li>We do <strong>not</strong> post, reply or change anything in your accounts without your OK on that exact item.</li>
</ul>
<p>Our reasons under privacy law, where it applies: to perform our contract with you, our legitimate interest in running and securing a business-to-business service, your consent where we ask for it (for example, when you connect an account), and legal duties such as tax records.</p>`,
    },
    {
      id: "google",
      title: "Google user data and limited use",
      html: `<p>When you connect a Google service, you choose to let Allevia read data from your own Google account. This is what we ask for, and what we do with it. These connections are being built, and each will be turned on only after Google has approved Allevia and this page is current.</p>
${table(
  ["Google service", "Permission we ask for", "What we read", "What we use it for"],
  [
    ["Search Console", "Read-only: <code>webmasters.readonly</code>, or you add our read-only account as a restricted user in Search Console", "Clicks, impressions, average position, search terms and pages for your own site", "To show your search numbers, to explain changes, and to find pages that lost visitors"],
    ["Google Analytics (GA4)", "Read-only: <code>analytics.readonly</code>, or you add our read-only account as a viewer", "Visits, where visitors come from, and the conversions you have set up", "To show your visits and sign-ups and to explain why they moved"],
    ["Google Business Profile", "<code>business.manage</code>, the only permission Google offers for these APIs. We use it to read, never to change your listing", "Calls, direction requests, website clicks and reviews for your own listing", "To show how people find and contact you. A reply to a review will only ever go out from a card you approve, and only once we add that feature"],
  ],
)}
<p>Allevia's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<p>In line with those requirements:</p>
<ul class="ticks">
<li>We use Google user data only to provide and improve the features you see in your own Allevia workspace, for you.</li>
<li>We do not transfer it to others, except to provide those features (for example, to the AI model that writes your answers, see <a href="#processors">Who handles it for us</a>), to follow the law, or as part of a sale of the business with the same protections.</li>
<li>We do not use it to serve advertising, and we do not sell it.</li>
<li>We do not use it to train generalised AI or machine-learning models.</li>
<li>People at Allevia do not read your Google data unless you ask us to look into something specific, it is needed to keep the service secure or to find a fault, the law requires it, or it is combined and anonymous.</li>
</ul>
<p>You can stop this at any time at <a href="https://myaccount.google.com/permissions" rel="noopener">myaccount.google.com/permissions</a>. We then stop reading immediately, and you can ask us to delete what we already hold (see <a href="/data-deletion/">Delete your data</a>).</p>`,
    },
    {
      id: "instagram",
      title: "Instagram and Meta data",
      html: `<p>When you connect your business's Instagram account, you let Allevia read information about that account. This is being built, and it will be turned on only after Meta has approved Allevia and this page is current.</p>
<ul class="ticks">
<li><strong>What we ask for:</strong> read-only access to your account's profile details and posts (<code>instagram_business_basic</code>) and to its insights, such as reach and follower numbers (<code>instagram_business_manage_insights</code>). We do not ask to read your messages or comments, and we do not ask to publish.</li>
<li><strong>What we use it for:</strong> to show how your posts and account are doing, to learn which of your posts worked, and to write better drafts for you. We use it only for your own account, only to provide the service to you.</li>
<li><strong>What we do not do:</strong> we do not sell Instagram data, share it with data brokers, use it for advertising or to profile people, or use it for any other business. We do not use it to train AI models.</li>
<li><strong>Publishing:</strong> Allevia does not post to Instagram today. If we add posting, we will update this page first, and a post will go out only when you approve that exact post.</li>
<li><strong>Who else sees it:</strong> the AI model that writes your answers receives the numbers it needs for a question, see <a href="#processors">Who handles it for us</a>.</li>
</ul>
<p>You can remove Allevia at any time in Instagram, under Settings, <em>Apps and websites</em>. We then stop reading, and you can ask us to delete what we already hold. The steps are on <a href="/data-deletion/">Delete your data</a>, which is the address to give Meta as our data deletion instructions.</p>`,
    },
    {
      id: "photos",
      title: "Photos and videos",
      html: `<p>Studio turns a phone photo into post options for your approval. This is how a photo is handled:</p>
<ul class="ticks">
<li><strong>On arrival,</strong> the photo is re-saved without its hidden details, so the location and device information inside it are removed. Videos you send to the Studio channel are kept as they are, and where our server can, their location and device details are removed too.</li>
<li><strong>It is kept</strong> in a folder that belongs to your business alone, and a photo is only shown to the business that uploaded it. It stays until you ask us to delete it or your workspace is deleted. We do not delete photos automatically today.</li>
<li><strong>It is looked at</strong> by an AI model, Claude, which is how the Studio decides what to straighten, what must not change and what to write. The photo is sent to Anthropic for that, see <a href="#processors">Who handles it for us</a>.</li>
<li><strong>People in photos.</strong> We keep people in your photos as you uploaded them. Each business can switch on a "blur faces" setting in the Studio, and faces are then blurred in the copies we make. We do not use photos of people to identify anyone, and we do not train any model on them.</li>
<li><strong>Children.</strong> We do not apply AI edits to photos that appear to include children. Those get a simple clean-up only: straightening, brightening and cropping.</li>
<li><strong>Number plates and house numbers</strong> that we can see are blurred in the copies we make.</li>
<li><strong>AI edits</strong> are labelled as AI-edited in the app, and a check compares each edit against your original and holds back an edit that added or removed something. Live AI picture edits for customers are not switched on yet. When they are, the photo will also go to our image-generation provider, <a href="#processors">listed below</a>, and we will tell you first.</li>
</ul>
<p>You are responsible for having the right to upload every photo and the permission of anyone shown in it. See our <a href="/terms/#content">Terms of Service</a>.</p>`,
    },
    {
      id: "discord",
      title: "Discord",
      html: `<p>You can talk to your team in Discord. Each business gets its own private area on our Discord server, and only people with that business's role, our staff and our bot can see it. The bot reads what you write in your business's channels, so it can answer, and it posts waiting approval cards and Today's note there. We store the questions and answers in your business's database. We do not write Discord names or ids into that database.</p>
<p>What you write in #support is read by a person, and a copy goes to a channel only our staff can see, so someone can answer it. Messages and files are also kept by Discord under <a href="https://discord.com/privacy" rel="noopener">Discord's privacy policy</a>. The bot does not answer direct messages.</p>`,
    },
    {
      id: "processors",
      title: "Who handles it for us",
      html: `<p>We use these companies to run the service. Each handles information only to do that job.</p>${table(
        ["Company", "What it does for us", "What it receives"],
        [
          ["Anthropic (Claude)", "The AI model that reads your website, writes answers and drafts, and looks at your photos. <mark class=\"todo\">TODO(founder): confirm the Anthropic plan and terms we run on say that customer content is not used to train models, and add the link to the data terms.</mark>", "The text, numbers and photos your team needs for a question, after sensitive details are filtered out of text."],
          ["Higgsfield", "Image generation for AI picture edits. Not used for customer photos today.", "A photo and an instruction, only once live edits are switched on and you have been told."],
          ["Discord", "The chat where you can talk to your team.", "Whatever you and the bot write in your business's channels."],
          ["Apify", "Reads public pages for us when public lookups are switched on: Google Maps listings, public Instagram profiles of businesses, the public ad libraries, and your website if it turns our own reader away.", "What to look up: a business name and town, an Instagram handle, a brand name or a website address. Nothing from your private records."],
          [`${fact(COMPANY.hosting.provider, "the hosting provider")}`, `Hosting for the site, the app and the databases, in ${region}.`, "Everything the service stores."],
          [`${fact(COMPANY.paymentProvider, "the payment provider")}`, "Takes payment when billing opens.", "Your name, billing email, plan and card details (which we never see)."],
        ],
      )}
<p>Word embeddings, which let the team search your pages by meaning, run on our own servers. Google and Meta are not our processors: they are the platforms whose data you ask us to read, and their APIs are described above. We do not use advertising networks, analytics services or data brokers. We may disclose information if the law requires it, and as part of a sale of the business with the same protections for you.</p>`,
    },
    {
      id: "where",
      title: "Where it is stored, and transfers abroad",
      html: `<p>Your business's information is stored on servers hosted by ${fact(COMPANY.hosting.provider, "the hosting provider")} in ${region}. Allevia is run from India, our team can open your workspace from there, and some of the companies in the table above are in the United States. If you are in the UK, the European Economic Area or another place with rules on sending data abroad, we rely on the standard contract terms our providers offer for those transfers. Ask us if you would like a copy.</p>`,
    },
    {
      id: "retention",
      title: "How long we keep it",
      html: `${table(
        ["What", "How long"],
        [
          ["Your business's database, photos and uploads", `While you use Allevia. If you stop and do not ask us to delete, we keep your workspace for up to ${COMMITMENTS.afterEndDays} days so you can come back, then delete it. If you ask us to delete sooner, we do (see <a href="/data-deletion/">Delete your data</a>).`],
          ["After you ask us to delete", `Gone from our live systems within ${COMMITMENTS.deleteWithinDays} days, and from our backups within ${COMMITMENTS.backupsAgeOutDays} days after that.`],
          ["Billing records", "For as long as tax and accounting law require."],
          ["Support and contact messages", "For as long as we need them to help you and to keep a record of what we agreed."],
          ["Web server logs", `${COMMITMENTS.logRetentionDays} days.`],
          ["Discord messages", "Kept by Discord until they are deleted. We remove your business's area when you leave and ask us to."],
        ],
      )}`,
    },
    {
      id: "rights",
      title: "Your rights and choices",
      html: `<p>Wherever you live, you can ask us to:</p>
<ul class="ticks">
<li>give you a copy of the information we hold about your business (we send your business's memory and your photos as files),</li>
<li>correct anything that is wrong,</li>
<li>delete everything we hold about your business,</li>
<li>stop using or restrict some of it, or object to how we use it,</li>
<li>move it to another provider, and</li>
<li>withdraw a connection or a permission you gave us.</li>
</ul>
<p>Email ${privacyMail()}. We will confirm we received your request within ${COMMITMENTS.acknowledgeWithinDays} days and complete it within ${COMMITMENTS.deleteWithinDays} days. It is free. We may ask you to confirm you are the business's owner first, so we do not hand your data to someone else. Today these requests are handled by a person, not by a button in the app.</p>
<p>Depending on where you live, the law may give you more: for example the UK and EU GDPR, the California Consumer Privacy Act, Australia's Privacy Act, the UAE's data protection law and India's Digital Personal Data Protection Act. We honour these requests whichever of those places you are in. You can also complain to your local data protection authority, and we would like the chance to put it right first.</p>
<p>If you are one of our customer's own customers, and your details are in something your business gave us, please ask that business first: it decides what it shares with us, and we act on its instructions. You can also email us and we will pass your request on.</p>`,
    },
    {
      id: "children",
      title: "Children",
      html: `<p>Allevia is for business owners and their staff, who are 18 or older. We do not knowingly collect information from children. Photos that appear to include children are handled as described under <a href="#photos">Photos and videos</a>.</p>`,
    },
    {
      id: "security",
      title: "Security",
      html: `<p>Each business is its own separate database, sensitive details are filtered from text before it is stored or sent to the AI model, photos lose their location, and nothing is posted without your OK. No system is perfectly secure, and we are not SOC 2 audited. <a href="/security/">What we do, and what we do not claim.</a></p>`,
    },
    {
      id: "changes",
      title: "Changes to this policy",
      html: `<p>We will update this page when what we do changes, and change the date at the top. If a change matters, we will tell you by email, or in the app or Discord, at least ${COMMITMENTS.changeNoticeDays} days before it takes effect.</p>`,
    },
    {
      id: "contact",
      title: "Contact us",
      html: `<p>${privacyMail()}. Post: ${co()}, ${fact(COMPANY.registeredAddress, "the registered office address")}. For help with the service, ${supportMail()}.</p>`,
    },
  ];
  return doc({
    title: "Privacy Policy",
    lead: "What Allevia collects, why, where it is kept, how long, who handles it for us, and how to get a copy or have it deleted. In plain words, because you should not need a lawyer to read it.",
    summary: [
      "We read your public website, and whatever you choose to share: questions, photos, numbers and connected accounts.",
      "Each business is its own separate database. We never mix businesses, never sell your information, and never use it to train AI models.",
      "An AI model (Claude, from Anthropic) reads what it needs to answer. Sensitive details are removed from text first.",
      "Connections to Instagram, Google Search Console, Google Analytics and Google Business Profile are read-only, and are being built.",
      `Ask for a copy, or for everything to be deleted, by email. We do it within ${COMMITMENTS.deleteWithinDays} days.`,
    ],
    sections,
  });
}

// =====================================================================================================================
// Terms of Service
// =====================================================================================================================

export function terms(): string {
  const law = fact(COMPANY.governingLaw, "the governing law and where disputes are heard");
  const sections: Section[] = [
    {
      id: "agreement",
      title: "Who we are, and this agreement",
      html: `<p>Allevia is operated by ${co()}, ${fact(COMPANY.entityType, "the kind of company")}, registered at ${fact(COMPANY.registeredAddress, "the registered office address")} ("Allevia", "we", "us"). These terms are the agreement between us and the business that uses Allevia ("you"). By asking us to set up your team, using the service or paying for it, you accept them. If you accept for a business, you confirm you can bind it.</p>
<p>The "service" means the Allevia website, app, public demo, and our Discord server and bot. Our <a href="/privacy/">Privacy Policy</a> and our <a href="/pricing/">Pricing page</a> are part of this agreement.</p>`,
    },
    {
      id: "service",
      title: "What the service is",
      html: `<p>Allevia is a team of AI staff, set up by us for your business, that reads your website and the information you share, proposes a plan, drafts work and answers your questions. It is a tool that helps you. It is not a marketing agency, an adviser or a publisher.</p>
<ul class="ticks">
<li><strong>You steer.</strong> Your team asks for your OK before anything costs money, speaks in public or moves a goal. Today it does not publish anything itself: an approved post is saved as a draft for you to publish.</li>
<li><strong>Some things are still being built.</strong> Features marked "in build" or "coming soon", including connections to Instagram and Google, spreadsheet upload, live AI picture edits, owner sign-in and in-product billing, may not be available, may change, and are provided as they are.</li>
<li><strong>Not advice.</strong> The service does not give legal, tax, financial or medical advice. Ask a qualified person.</li>
</ul>`,
    },
    {
      id: "account",
      title: "Who can use it, and your account",
      html: `<p>The service is for businesses and the people who work for them, and you must be 18 or older. You are responsible for who you invite to your team's area on Discord or give access to, and for what they do. Your business opens with its own private owner link, and whoever holds it can act for your business, so keep it private and tell us at once if it leaks, and we will cancel it and make a new one. Invites to Discord work once; do not share them. Tell us at once if you think someone has access who should not.</p>`,
    },
    {
      id: "content",
      title: "Your content, and the permission you confirm",
      html: `<p>"Your content" is what you give the service: your website's material, your instructions, photos, videos, files and numbers, and what comes from your connected accounts. It stays yours. You give us permission to store it and process it, and to have the AI model and our other providers process it, only so we can provide the service to you.</p>
<p><strong>You confirm that:</strong></p>
<ul class="ticks">
<li>you have the right to upload, edit and publish everything you give us, including the right to use every photo and video in your posts;</li>
<li>you have the permission of anyone shown in what you upload and publish, including their consent to being shown in the posts you publish, and you will get it before you publish;</li>
<li>you will not upload anything that you do not have those rights to, or that is unlawful.</li>
</ul>
<p>The Studio keeps people in your photos as you uploaded them. Each business can switch on a "blur faces" setting, which blurs faces in the copies we make. That setting helps, but it does not replace the permission you must have. We do not apply AI edits to photos that appear to include children; those get a simple clean-up only. We may refuse a file that we cannot handle safely.</p>
<p>The drafts, captions and pictures your team makes for you are yours to use, as between you and us. You are responsible for what you choose to publish.</p>`,
    },
    {
      id: "ai",
      title: "AI output",
      html: `<p>Your team's work is produced by AI. It can be wrong, incomplete or out of date. We check facts and numbers against what your team looked up, show you the sources, mark anything that fails a check as "unverified", and compare AI edits with your original photo, but we cannot promise any answer, draft or picture is correct or suitable. Read it before you say OK. Approving something makes it yours. AI-edited pictures are labelled as AI-edited, and you must not remove that label where the law or a platform requires it. Allevia does not write customer reviews or testimonials, and you must not ask it to.</p>`,
    },
    {
      id: "platforms",
      title: "Instagram, Google, Discord and other platforms",
      html: `<p>When you connect an account such as Instagram, Google Search Console, Google Analytics or a Google Business Profile, you confirm you are allowed to, and you stay bound by that platform's own terms. We ask for read-only access to numbers. You can disconnect at any time in that platform's settings. A platform may change or stop its service, or refuse us access, and we are not responsible for that. Discord's own terms apply to what you do on Discord.</p>`,
    },
    {
      id: "use",
      title: "Acceptable use",
      html: `<p>Do not use the service to:</p>
<ul class="ticks">
<li>break the law, or infringe anyone's rights;</li>
<li>create or promote adult content, weapons, tobacco or vaping, gambling, unauthorised financial promotions, prescription drugs or political advertising;</li>
<li>write fake reviews, fake testimonials or misleading claims;</li>
<li>upload photos or other material of people you do not have permission to use, or of children;</li>
<li>try to get into other businesses' areas or data, probe or disrupt the service, or avoid its limits;</li>
<li>send us passwords, card numbers or your customers' personal details that we do not need.</li>
</ul>
<p>We may refuse a request that breaks these rules, and suspend the service if you keep breaking them.</p>`,
    },
    {
      id: "fees",
      title: "Fees, refunds and cancelling",
      html: `<p>Prices, what each plan includes, the guarantees and the small print are on the <a href="/pricing/">Pricing page</a>. In short:</p>
<ul class="ticks">
<li>Everyone starts with the three-month growth plan. You get a 14-day full refund, and a delivery guarantee if we miss what we promise in the first 30 days, as set out on the Pricing page.</li>
<li>Monthly plans end at the close of the month you cancel in, with no partial refunds. Annual plans can be refunded pro rata within 30 days.</li>
<li>Studio credits are used when you approve a finished piece, never before. Unused credits roll over for one month, as the Pricing page says.</li>
<li>Prices exclude VAT, GST and sales tax, which we add where the law requires. We will tell you ${COMMITMENTS.changeNoticeDays} days before a price change affects you.</li>
<li>We guarantee what we control: the setup, the work delivered and the checks on it. We do not guarantee revenue, followers or growth.</li>
</ul>
<p>Payments are taken by ${fact(COMPANY.paymentProvider, "the payment provider")}. To cancel, ask us by email or in the support channel. If anything on this page and the Pricing page differ, the Pricing page applies to price and plan content.</p>`,
    },
    {
      id: "ours",
      title: "What is ours",
      html: `<p>We own the Allevia software, the team's design and all that comes with them. We give you the right to use the service for your own business for as long as this agreement lasts. Do not copy it, reverse-engineer it or resell it. If you give us feedback, we may use it without owing you anything.</p>`,
    },
    {
      id: "changes",
      title: "Changes to the service",
      html: `<p>We improve Allevia all the time and may add, change or remove features. If we remove something you rely on, we will tell you ahead of time where we can. The AI model, and the platforms we connect to, may change, and this can change what your team can do.</p>`,
    },
    {
      id: "end",
      title: "Stopping, suspension and what happens to your data",
      html: `<p>You can stop at any time. We may suspend or end the service if you break these terms, do not pay, or if we must for the law or for security, and we will tell you why where we can. We may also end the service entirely, with notice, in which case we refund what you paid for the time not used.</p>
<p>When the agreement ends, you can ask for a copy of your data and for it to be deleted, as set out on <a href="/data-deletion/">Delete your data</a>. If you do not ask, we keep your workspace for up to ${COMMITMENTS.afterEndDays} days and then delete it, as the Privacy Policy says. Sections that are meant to survive, such as payment, liability and governing law, do.</p>`,
    },
    {
      id: "warranty",
      title: "No warranties",
      html: `<p>To the fullest extent the law allows, the service is provided "as is" and "as available". We do not promise it will be uninterrupted, error-free or fit for a particular purpose, and we do not promise any business result. Nothing in these terms limits rights you have by law that cannot be limited.</p>`,
    },
    {
      id: "liability",
      title: "Our responsibility to you",
      html: `<p>To the fullest extent the law allows, we are not liable for indirect or consequential loss, lost profit, lost revenue or lost opportunity, or for anything caused by what you chose to publish, by a platform, or by something outside our control. Our total liability for any claim connected with the service is limited to the fees you paid us in the 12 months before the claim. Nothing here limits liability that cannot be limited by law, such as for fraud or for death or personal injury caused by negligence.</p>
<p>You will cover us against claims from others that come from your content, or from your publishing something without the right or the permission of the people in it.</p>`,
    },
    {
      id: "law",
      title: "Governing law",
      html: `<p>These terms are governed by ${law}. Please contact us first and give us the chance to put a problem right. If we cannot agree, the courts named above can decide it, except where the law gives you the right to go to your local courts.</p>`,
    },
    {
      id: "terms-changes",
      title: "Changes to these terms",
      html: `<p>We may update these terms. We will tell you at least ${COMMITMENTS.changeNoticeDays} days before a material change takes effect, by email or in the app or Discord. If you keep using the service after that, you accept the new terms; if you do not agree, you can stop and ask for a refund of the time not used.</p>`,
    },
    {
      id: "contact",
      title: "Contact us",
      html: `<p>${mail(COMPANY.email.general, "the general contact email")}. Post: ${co()}, ${fact(COMPANY.registeredAddress, "the registered office address")}.</p>`,
    },
  ];
  return doc({
    title: "Terms of Service",
    lead: "The terms for using Allevia: what the service is, what you agree to, who owns what, fees and refunds, and what happens if you stop.",
    summary: [
      "Allevia helps you. You steer: your team asks before anything costs money, speaks in public or moves a goal, and today it posts nothing by itself.",
      "Your content stays yours. You confirm you have the right to everything you upload and the permission of anyone shown in it.",
      "AI can be wrong. Read before you approve. No legal, tax or medical advice.",
      "A 14-day refund, and the other guarantees on the Pricing page. We do not guarantee growth.",
      "You can leave and take or delete your data whenever you like.",
    ],
    sections,
  });
}

// =====================================================================================================================
// Data deletion
// =====================================================================================================================

export function dataDeletion(): string {
  const sections: Section[] = [
    {
      id: "ask",
      title: "How to ask us to delete your data",
      html: `<p>Anyone can ask, and it is free. Today a person handles it, so there is no button to press. Here is what to do:</p>
<ol class="steps-list">
<li><strong>Send us an email</strong> at ${privacyMail()} with the subject "Delete my Allevia data". Say the business's name and website, and send it from the email address you gave us. If you connected an Instagram or Google account, say which one.</li>
<li><strong>Or write in #support</strong> in your business's area on Discord, if you are a customer. A person reads it.</li>
<li><strong>We confirm</strong> within ${COMMITMENTS.acknowledgeWithinDays} days. To make sure we do not delete a business's data for the wrong person, we may ask you to confirm from a channel we already know, such as the email address on file or your business's Discord area. For a connected Instagram or Google account, we can also check that you control it.</li>
<li><strong>We delete,</strong> and tell you when it is done: within ${COMMITMENTS.deleteWithinDays} days of your confirmed request.</li>
</ol>
<p>Want a copy first? Say so in the same email, and we send your business's memory and your photos as files before we delete.</p>`,
    },
    {
      id: "instagram",
      title: "If you connected Instagram (and for Meta's data deletion check)",
      html: `<ol class="steps-list">
<li>In Instagram, go to <em>Settings</em>, then <em>Apps and websites</em> (also found at instagram.com/accounts/manage_access), find Allevia and remove it. From that moment we can no longer read your account.</li>
<li>Email ${privacyMail()} with the subject "Delete my Allevia data" and your Instagram handle, so we delete the information we already hold from it.</li>
<li>We delete it within ${COMMITMENTS.deleteWithinDays} days, and email you to confirm.</li>
</ol>
<p>This page is Allevia's data deletion instructions for Meta. It stays at <code>${esc(SITE_URL)}/data-deletion/</code>.</p>`,
    },
    {
      id: "google",
      title: "If you connected Google (Search Console, Analytics or Business Profile)",
      html: `<ol class="steps-list">
<li>Go to <a href="https://myaccount.google.com/permissions" rel="noopener">myaccount.google.com/permissions</a>, choose Allevia and select <em>Delete all connections</em>. If you gave us access by adding our read-only account to Search Console or Analytics instead, remove that user in the product's own settings. We can no longer read your data.</li>
<li>Email ${privacyMail()} with the subject "Delete my Allevia data" and the Google account or property you connected, so we delete what we already hold.</li>
<li>We delete it within ${COMMITMENTS.deleteWithinDays} days, and email you to confirm.</li>
</ol>`,
    },
    {
      id: "what",
      title: "What we delete",
      html: `<p>When your business asks us to delete everything, we delete:</p>
<ul class="ticks">
<li>your business's whole database: what your team learned from your website, your conversations, your drafts, approvals, goals and the rules it learned from your edits;</li>
<li>your owner link and your business's entry in our registry, so nothing can open it again;</li>
<li>your photos and videos, every version we made of them, and the other files you uploaded;</li>
<li>the saved copies of your website, notes from setting you up, the saved drafts of approved posts, and the stored answers of the AI model for your business (each business has its own folders for these);</li>
<li>any connection to Instagram or Google, and the access tokens we hold;</li>
<li>your business's private area on Discord (the channels and the role), and the question and answer text we stored from it.</li>
</ul>
<p>You can also ask for part of this: for example, only your photos, or only an Instagram connection.</p>`,
    },
    {
      id: "keep",
      title: "What we keep, and for how long",
      html: `<ul class="ticks">
<li><strong>Billing records,</strong> because tax and accounting law require them.</li>
<li><strong>A short note that you asked,</strong> and when we did it, so we can show we did.</li>
<li><strong>Backups,</strong> which age out within ${COMMITMENTS.backupsAgeOutDays} days after the deletion. They are not used for anything else in that time.</li>
<li><strong>Messages on Discord</strong> that were not in your business's area, for example what you wrote to us in other places, stay with Discord under its own policy.</li>
</ul>`,
    },
    {
      id: "help",
      title: "Need a hand?",
      html: `<p>Write to ${privacyMail()} or ${supportMail()}. You can also read the whole <a href="/privacy/">Privacy Policy</a>.</p>`,
    },
  ];
  return doc({
    title: "Delete your data",
    lead: "How to ask Allevia to delete everything it holds about your business, how to disconnect Instagram or Google, what we delete, and how long it takes.",
    summary: [
      `Email ${privacyMail()} with the subject "Delete my Allevia data", or write in #support if you are a customer.`,
      `We confirm in ${COMMITMENTS.acknowledgeWithinDays} days and delete within ${COMMITMENTS.deleteWithinDays} days of your confirmed request.`,
      "Removing Allevia from Instagram or Google in their settings stops us reading straight away.",
      "We keep billing records the law requires, and backups age out within 35 days.",
    ],
    sections,
  });
}

// =====================================================================================================================
// Cookies and analytics
// =====================================================================================================================

export function cookies(): string {
  const sections: Section[] = [
    {
      id: "site",
      title: "This website",
      html: `<ul class="ticks">
<li><strong>No cookies.</strong> This site does not set any cookies.</li>
<li><strong>No analytics, no ads, no trackers.</strong> There is no analytics service, advertising network, social-media button or tracking pixel on this site, and nothing is loaded from other companies' servers. The fonts are served from this site.</li>
<li><strong>Nothing saved in your browser.</strong> This site does not store any setting or item in your browser.</li>
<li><strong>Server logs.</strong> Like every website, our server records the address, time and page of each request, and your browser's name. We use it to keep the site working and to spot abuse, and keep it for ${COMMITMENTS.logRetentionDays} days.</li>
</ul>`,
    },
    {
      id: "app",
      title: "The app and the live demo",
      html: `<p>The app and the live demo do not set cookies either. They keep two preferences in your browser, as the same kind of single setting: your chosen colour theme and the last business you looked at (<code>allevia.theme</code> and <code>allevia.tenant</code>). They stay in your browser.</p>`,
    },
    {
      id: "later",
      title: "If this changes",
      html: `<p>If we ever add analytics or anything that sets cookies, we will say so on this page first, tell you what it measures and why, and ask for your consent before it starts where the law requires it. Our <a href="/privacy/">Privacy Policy</a> covers everything else we collect.</p>`,
    },
  ];
  return doc({
    title: "Cookies and analytics",
    lead: "Short, because there is little to say: this site sets no cookies and runs no analytics or ads.",
    sections,
  });
}

export const LEGAL_BLOCKS: Record<string, () => string> = { privacy, terms, "data-deletion": dataDeletion, cookies };
