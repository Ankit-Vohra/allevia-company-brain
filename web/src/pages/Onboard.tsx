// Add a business: paste the website and we do the setup. A short form, then a simple seven-step progress line while the
// team reads the site (the live map of what it learns is a small card, and the technical log sits behind "Show what's
// happening"). The run ends with one clear next step, and the three goals we suggest to start with.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type { DiscordInfo, EdgeRef, NodeRef, OnboardEvent } from "@shared/contracts";
import { AGENTS } from "@shared/roster";
import { api } from "../api";
import { AgentAvatar } from "../components/bits";
import { DiscordJoin } from "../components/DiscordCard";
import { Icon } from "../components/Icon";
import { Reveal } from "../components/Reveal";
import { ConnectionsPanel } from "../components/ConnectionsPanel";
import { SuggestedRow } from "../components/SuggestedGoal";
import { currencySymbol, fmtMs, fmtNum, guessRegion } from "../lib/format";
import { hueFor } from "../lib/labels";
import { useMedia } from "../lib/useMedia";
import { useApp } from "../state/app";
import type { GoalSetup } from "../types-ext";
import "./onboard.css";

const GraphView = lazy(() => import("../components/GraphView"));

type Stage = Extract<OnboardEvent, { type: "stage" }>["stage"];

/** The seven steps, in an owner's words. `short` labels the dot; `now` is the sentence while it is happening. */
const STEPS = [
  { short: "Website", now: "Reading your website" },
  { short: "Your look", now: "Picking up your look and the way you write" },
  { short: "Google", now: "Checking how you show up on Google" },
  { short: "Your business", now: "Learning what you sell and who you serve" },
  { short: "Methods", now: "Choosing methods that suit your business" },
  { short: "Filing", now: "Filing it all, so every answer can name its source" },
  { short: "Your team", now: "Briefing your team" },
  { short: "Your tools", now: "Connecting your tools" },
];

/** Which step each stage the server can report belongs to (the newer stages fold into the nearest step). */
const STAGE_STEP: Record<Stage, number> = {
  crawl: 0, brand: 1, seo: 2, understand: 3, profile: 3, playbooks: 4, goals: 4, baseline: 4, index: 5, capabilities: 5, done: 6,
};

const REGIONS = [
  { country: "United Kingdom", currency: "GBP", locale: "en-GB", timeZone: "Europe/London" },
  { country: "United States", currency: "USD", locale: "en-US", timeZone: "America/New_York" },
  { country: "United Arab Emirates", currency: "AED", locale: "en-AE", timeZone: "Asia/Dubai" },
  { country: "Australia", currency: "AUD", locale: "en-AU", timeZone: "Australia/Sydney" },
  { country: "Canada", currency: "CAD", locale: "en-CA", timeZone: "America/Toronto" },
  { country: "Ireland", currency: "EUR", locale: "en-IE", timeZone: "Europe/Dublin" },
  { country: "New Zealand", currency: "NZD", locale: "en-NZ", timeZone: "Pacific/Auckland" },
  { country: "Singapore", currency: "SGD", locale: "en-SG", timeZone: "Asia/Singapore" },
  { country: "India", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata" },
  { country: "Spain", currency: "EUR", locale: "en-IE", timeZone: "Europe/Madrid" },
  { country: "Germany", currency: "EUR", locale: "en-IE", timeZone: "Europe/Berlin" },
  { country: "France", currency: "EUR", locale: "en-IE", timeZone: "Europe/Paris" },
  { country: "Italy", currency: "EUR", locale: "en-IE", timeZone: "Europe/Rome" },
  { country: "Netherlands", currency: "EUR", locale: "en-IE", timeZone: "Europe/Amsterdam" },
  { country: "Austria", currency: "EUR", locale: "en-IE", timeZone: "Europe/Vienna" },
];

const PLURAL: Record<string, [string, string]> = {
  Page: ["page", "pages"], BrandAsset: ["brand style", "brand styles"], BrandRule: ["writing rule", "writing rules"], Rule: ["check", "checks"], Fix: ["thing to fix", "things to fix"],
  Product: ["product or service", "products and services"], Audience: ["customer group", "customer groups"], Need: ["customer need", "customer needs"], Playbook: ["method", "methods"],
  Channel: ["channel", "channels"], Business: ["business", "businesses"], Chunk: ["passage", "passages"],
};
const plural = (label: string, n: number) => `${fmtNum(n)} ${(PLURAL[label] ?? [label.toLowerCase(), `${label.toLowerCase()}s`])[n === 1 ? 0 : 1]}`;

const pathOf = (url: string) => {
  try { return new URL(url).pathname; } catch { return url; }
};

const hostOf = (url: string) => {
  try { return new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ""); } catch { return url; }
};

/** "avsatelier.in" → "Avsatelier": a first guess at the name when the owner leaves it blank. */
const nameFromHost = (url: string) => {
  const root = hostOf(url).split(".")[0] ?? "";
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : "Your business";
};

interface RunState {
  stage?: Stage;
  step: number;
  texts: Partial<Record<Stage, string>>;
  pages: { url: string; title: string }[];
  nodes: NodeRef[];
  edges: EdgeRef[];
  done?: { tenant: string; counts: Record<string, number>; discord?: DiscordInfo };
  notes?: string[]; // plain sentences about steps that did not finish
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export default function OnboardPage() {
  const { refreshTenants, setTenant, effectiveTheme, reducedMotion, account, tenants, authRequired } = useApp();
  // a new account's first business (straight after signing up)
  const first = !!account && !tenants.some((t) => !t.readOnly);
  const nav = useNavigate();
  const params = new URLSearchParams(location.search);
  const [name, setName] = useState(params.get("name") ?? "");
  const [url, setUrl] = useState(params.get("url") ?? "");
  const [instagram, setInstagram] = useState(params.get("instagram") ?? "");
  const [country, setCountry] = useState(() => params.get("country") ?? (params.get("url") ? guessRegion(params.get("url")!).country : "United Kingdom"));
  const countryTouched = useRef(!!params.get("country"));
  const [run, setRun] = useState<RunState | null>(null);
  const [goals, setGoals] = useState<GoalSetup[]>([]);
  const [toolsDone, setToolsDone] = useState(false); // the "Connect your tools" step: connected, or skipped
  const [toolsConnected, setToolsConnected] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const narrow = useMedia("(max-width: 700px)");

  const region = REGIONS.find((r) => r.country === country) ?? REGIONS[0]!;
  const running = !!run && !run.done && !run.error;
  const bizName = name.trim() || (url ? nameFromHost(url) : "Your business");

  const onUrl = (v: string) => {
    setUrl(v);
    if (!countryTouched.current && v.includes(".")) {
      const g = guessRegion(v);
      if (REGIONS.some((r) => r.country === g.country)) setCountry(g.country);
    }
  };

  const start = async () => {
    if (!url.trim() || running) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const state: RunState = { step: -1, texts: {}, pages: [], nodes: [], edges: [], startedAt: Date.now() };
    setRun({ ...state });
    setGoals([]);
    const seen = new Set<string>();
    const onEvent = (e: OnboardEvent) => {
      if (e.type === "stage") {
        state.stage = e.stage;
        state.step = Math.max(state.step, STAGE_STEP[e.stage] ?? state.step);
        state.texts = { ...state.texts, [e.stage]: e.text };
      } else if (e.type === "page") state.pages = [...state.pages, { url: e.url, title: e.title }];
      else if (e.type === "nodes") {
        const fresh = e.nodes.filter((n) => !seen.has(n.id));
        fresh.forEach((n) => seen.add(n.id));
        state.nodes = [...state.nodes, ...fresh];
        state.edges = [...state.edges, ...e.edges];
      } else if (e.type === "done") { state.done = { tenant: e.tenant, counts: e.counts, ...(e.discord ? { discord: e.discord } : {}) }; state.endedAt = Date.now(); }
      else if (e.type === "error") {
        // a step that did not finish is a note for the end, not the end: the set-up goes on and finishes
        if (e.soft) state.notes = [...(state.notes ?? []).filter((n) => n !== e.message), e.message];
        else { state.error = e.message; state.endedAt = Date.now(); }
      }
      setRun({ ...state });
    };
    try {
      await api.onboard({ name: name.trim() || nameFromHost(url), url: url.trim(), instagram: instagram.trim() || undefined, ...region }, onEvent, { signal: ctrl.signal });
      if (state.done) await refreshTenants();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      state.error = (err as Error).message || "The set-up stopped before it finished.";
      setRun({ ...state });
    }
  };

  // ?url=…&go=1 starts straight away. No "started once" guard: React's dev-mode remount aborts the first run in the
  // cleanup, so the effect has to be free to start it again.
  useEffect(() => {
    if (params.get("go") === "1" && url) void start();
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the goals we suggest: read once the business exists (none yet is fine, the card is just left out)
  const doneTenant = run?.done?.tenant;
  const loadGoals = useCallback(() => {
    if (!doneTenant) return () => {};
    let live = true;
    api.goalSetup(doneTenant).then((g) => { if (live) setGoals(g.slice(0, 3)); }, () => {});
    return () => { live = false; };
  }, [doneTenant]);
  useEffect(() => loadGoals(), [loadGoals]);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void start(); };
  const openOffice = (path: string) => { if (run?.done) setTenant(run.done.tenant); nav(path); };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of run?.nodes ?? []) c[n.label] = (c[n.label] ?? 0) + 1;
    return c;
  }, [run?.nodes]);
  const centerId = run?.nodes.find((n) => n.label === "Business")?.id;
  const inTools = !!run?.done && !toolsDone;
  const step = run?.done ? (inTools ? STEPS.length - 1 : STEPS.length) : Math.max(0, run?.step ?? 0);

  return (
    <div className="onboard-page">
      <header className="ob-head">
        <h1 className="page-title">{run?.done ? `${bizName} is ready` : running ? `Setting up ${bizName}` : first ? "Set up your business" : "Add a business"}</h1>
        {!run || run.error ? (
          <p className="page-lede">Paste your website · about 2 minutes · nothing is posted</p>
        ) : null}
      </header>

      {authRequired && !account ? (
        // looking at the demo without an account: setting up needs one, so say that before the form, not after a refusal
        <p className="notice">To add your own business, <a href="/signup">create a free account</a> or <a href="/login">sign in</a>.</p>
      ) : !run || run.error ? (
        <form className="ob-form" onSubmit={onSubmit} aria-label="Add a business">
          <label className="label">
            Your website
            <input className="field ob-field" inputMode="url" autoComplete="url" placeholder="yourstudio.co.uk" value={url} onChange={(e) => onUrl(e.target.value)} required />
          </label>
          <label className="label">
            <span>Business name <span className="hint">optional</span></span>
            <input className="field ob-field" autoComplete="organization" placeholder="As your customers know it" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <Reveal label="More details" summary={`${region.country} · money in ${region.currency}`} className="ob-more">
            <div className="ob-more-body">
              <label className="label">
                <span>Instagram <span className="hint">optional</span></span>
                <input className="field" placeholder="@handle" value={instagram} onChange={(e) => setInstagram(e.target.value)} />
              </label>
              <label className="label">
                Where you trade
                <select className="field" value={country} onChange={(e) => { countryTouched.current = true; setCountry(e.target.value); }}>
                  {REGIONS.map((r) => <option key={r.country} value={r.country}>{r.country}</option>)}
                </select>
              </label>
              <p className="ob-note">
                Money will show in <b>{currencySymbol(region.currency)} {region.currency}</b> and dates as {region.locale === "en-US" ? "Oct 15" : "15 Oct"}.
              </p>
            </div>
          </Reveal>
          {run?.error && <p className="notice notice-bad" role="alert">{run.error} {/^We could not read /.test(run.error) ? "Check the address and try again." : "Try again in a minute."}</p>}
          <button type="submit" className="btn btn-gold ob-go" disabled={!url.trim()}>
            Set up my team <Icon name="send" size={16} />
          </button>
        </form>
      ) : null}

      {run && !run.error && (!run.done || inTools) && (
        <section className="ob-progress" aria-label="Setting up" aria-live="polite">
          <ol className="ob-steps">
            {STEPS.map((s, i) => {
              const state = i < step ? "done" : i === step ? "active" : "todo";
              return (
                <li key={s.short} className={`ob-step is-${state}`} aria-current={state === "active" ? "step" : undefined}>
                  <span className="ob-dot" aria-hidden="true">{state === "done" ? <Icon name="check" size={12} /> : i + 1}</span>
                  <span className="ob-step-label">{s.short}</span>
                  <span className="visually-hidden">{state === "done" ? ", done" : state === "active" ? ", in progress" : ", still to do"}</span>
                </li>
              );
            })}
          </ol>
          <div className="ob-now">
            <p className="ob-now-title">{STEPS[step]!.now}</p>
            <p className="ob-now-sub">Step {step + 1} of {STEPS.length} · {hostOf(url)}</p>
          </div>
          {!run.done && <button type="button" className="btn btn-quiet btn-sm ob-stop" onClick={() => { abort.current?.abort(); setRun(null); }}>Stop</button>}
        </section>
      )}

      {run?.done && run.notes?.length ? (
        <div className="notice" role="status">
          <p><b>Your team is ready, with a few loose ends.</b></p>
          <ul>{run.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      ) : null}
      {inTools && doneTenant && (
        <section className="ob-tools" aria-labelledby="ob-tools-h">
          <h2 id="ob-tools-h" className="ob-goals-title">Connect your tools</h2>
          <p className="ob-goals-lede">Optional · one tap each · best fits first</p>
          <ConnectionsPanel tenantId={doneTenant} variant="onboard" onChanged={setToolsConnected} />
          <div className="ob-cta">
            <button type="button" className="btn btn-gold" onClick={() => setToolsDone(true)}>{toolsConnected > 0 ? "Continue" : "Skip for now"}</button>
          </div>
        </section>
      )}

      {run?.done && toolsDone && (
        <Ready
          host={hostOf(url)}
          counts={run.done.counts}
          discord={run.done.discord}
          pages={run.pages.length}
          goals={goals}
          tenantId={doneTenant}
          onGoal={loadGoals}
          onOpen={openOffice}
        />
      )}

      {run && !run.error && (
        <section className="ob-graph" aria-label="What your team is learning about your business">
          <div className="ob-graph-head">
            <h2 className="ob-graph-title">{run.done ? "What your team learned" : "What your team is learning"}</h2>
            <p className="ob-graph-count num">{run.nodes.length > 0 ? `${fmtNum(run.nodes.length)} things so far` : ""}</p>
          </div>
          <div className="ob-canvas">
            {run.nodes.length > 0 ? (
              <Suspense fallback={null}>
                <GraphView
                  nodes={run.nodes}
                  edges={run.edges}
                  centerId={centerId}
                  dark={effectiveTheme === "dark"}
                  reducedMotion={reducedMotion}
                  labels="auto"
                  sizeBy="degree"
                  followGrowth
                  maxFitZoom={1.8}
                  fitPadding={narrow ? 24 : 44}
                  ariaLabel={`Map of what your team learned about ${bizName}: ${run.nodes.length} things so far`}
                />
              </Suspense>
            ) : (
              <div className="ob-blank"><p>Your pages, services and customers will appear here as your team reads your site.</p></div>
            )}
          </div>
        </section>
      )}

      {run && !run.error && (
        <Reveal label={run.done ? "Show what we did" : "Show what's happening"} summary={run.endedAt ? `done in ${fmtMs(run.endedAt - run.startedAt)}` : undefined} className="ob-log">
          <Log run={run} counts={counts} host={hostOf(url)} regionCurrency={region.currency} />
        </Reveal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- done

function Ready({ host, counts, discord, pages, goals, tenantId, onGoal, onOpen }: { host: string; counts: Record<string, number>; discord?: DiscordInfo; pages: number; goals: GoalSetup[]; tenantId?: string; onGoal: () => void; onOpen: (path: string) => void }) {
  const read = counts.Page ?? pages;
  return (
    <section className="ob-ready" aria-labelledby="ob-ready-line">
      <p id="ob-ready-line" className="ob-ready-line">
        Your team read {plural("Page", read)} of {host}, learned what you sell and who you serve, and has been briefed. {AGENTS.length} people are ready to work.
      </p>
      <span className="ob-avatars" aria-hidden="true">{AGENTS.map((a) => <AgentAvatar key={a.id} id={a.id} size={28} />)}</span>

      <DiscordJoin info={discord} />

      {goals.length > 0 && tenantId && (
        <div className="ob-goals owner-suggest">
          <h2 className="ob-goals-title">{goals.length === 1 ? "A goal to start with" : `${goals.length} goals to start with`}</h2>
          <p className="ob-goals-lede">Tap OK, or change a number. That is the whole set-up.</p>
          <ul className="owner-suggest-list">
            {goals.map((g) => g.confirmed ? (
              <li key={g.id} className="owner-suggest-row is-done">
                <div className="owner-suggest-text">
                  <span className="owner-card-name">{g.name}</span>
                  <p className="owner-suggest-title">{g.target === null ? g.name : `Get to ${fmtNum(g.target)}${g.unit ? ` ${g.unit}` : ""} a ${g.period}`}</p>
                </div>
                <span className="ob-goal-ok"><Icon name="check" size={14} /> You said OK</span>
              </li>
            ) : (
              <SuggestedRow key={g.id} s={g} tenantId={tenantId} onSet={onGoal} />
            ))}
          </ul>
        </div>
      )}

      <div className="ob-cta">
        <button type="button" className="btn btn-gold ob-open" onClick={() => onOpen("/")}>Open your office <Icon name="send" size={16} /></button>
        <button type="button" className="btn btn-quiet" onClick={() => onOpen("/ask")}>Ask your first question</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the log (behind "Show what's happening")

function Log({ run, counts, host, regionCurrency }: { run: RunState; counts: Record<string, number>; host: string; regionCurrency: string }) {
  const c = run.done?.counts;
  const steps = (Object.entries(run.texts) as [Stage, string][]).filter(([, t]) => t);
  return (
    <div className="ob-log-body">
      {steps.length > 0 && (
        <ol className="ob-log-steps">
          {steps.map(([s, t]) => <li key={s}>{t}</li>)}
        </ol>
      )}
      {Object.keys(counts).length > 0 && (
        <ul className="ob-tally" aria-label="Found so far">
          {Object.entries(counts).filter(([l]) => l !== "Business").map(([label, n]) => (
            <li key={label} style={{ ["--hue" as string]: hueFor(label) }}>{plural(label, n)}</li>
          ))}
        </ul>
      )}
      {run.pages.length > 0 && (
        <div>
          <p className="ob-log-title">Pages read on {host}</p>
          <ul className="ob-pages">
            {run.pages.slice(-12).map((p) => (
              <li key={p.url}><code>{pathOf(p.url)}</code><span>{p.title}</span></li>
            ))}
          </ul>
        </div>
      )}
      {c && (
        <ul className="ob-receipt">
          <li>Read {plural("Page", c.Page ?? run.pages.length)} of {host}</li>
          <li>Picked up {plural("BrandAsset", c.BrandAsset ?? 0)} and {plural("BrandRule", c.BrandRule ?? 0)}</li>
          <li>Ran 42 website checks and found {plural("Fix", c["rel:FAILS"] ?? 0)}</li>
          <li>Mapped {plural("Product", c.Product ?? 0)}, {plural("Audience", c.Audience ?? 0)} and what they need</li>
          <li>Chose {plural("Playbook", c.Playbook ?? 0)} for your kind of business</li>
          <li>Filed {plural("Chunk", c.Chunk ?? 0)} so answers can name their sources</li>
          <li>Money shows in {regionCurrency} ({currencySymbol(regionCurrency)}), as a business in your country reports it</li>
        </ul>
      )}
      <p className="ob-log-meta num">{fmtNum(run.nodes.length)} things · {fmtNum(run.edges.length)} connections{run.endedAt ? ` · ${fmtMs(run.endedAt - run.startedAt)}` : ""}</p>
    </div>
  );
}
