// Onboard: paste a website, watch the company brain grow. The stream (POST /api/onboard) reports stages, the pages it
// reads and the nodes it writes; the graph on the right grows node by node, and the run ends with a receipt of what
// was done and a way into the new office.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type { EdgeRef, NodeRef, OnboardEvent } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { api } from "../api";
import { AgentAvatar } from "../components/bits";
import { Icon } from "../components/Icon";
import { currencySymbol, fmtMs, fmtNum, guessRegion } from "../lib/format";
import { hueFor } from "../lib/labels";
import { useMedia } from "../lib/useMedia";
import { useApp } from "../state/app";
import "./onboard.css";

const GraphView = lazy(() => import("../components/GraphView"));

type Stage = Extract<OnboardEvent, { type: "stage" }>["stage"];
const STAGES: { id: Stage; title: string; idle: string }[] = [
  { id: "crawl", title: "Read the website", idle: "Every public page, as a visitor sees it" },
  { id: "brand", title: "Pick out the brand", idle: "Colours, type and the voice you write in" },
  { id: "seo", title: "Check search health", idle: "42 checks on every page" },
  { id: "understand", title: "Understand the business", idle: "Who you serve, what you sell, what they need" },
  { id: "playbooks", title: "Attach playbooks", idle: "Proven methods for your kind of business" },
  { id: "index", title: "Index for search", idle: "So every answer can cite a source" },
  { id: "done", title: "Brief the team", idle: "Ten staff, eight departments, one brain" },
];

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
];

const PLURAL: Record<string, [string, string]> = {
  Page: ["page", "pages"], BrandAsset: ["brand asset", "brand assets"], BrandRule: ["voice rule", "voice rules"], Rule: ["SEO issue", "SEO issues"],
  Product: ["service", "services"], Audience: ["audience", "audiences"], Need: ["customer need", "customer needs"], Playbook: ["playbook", "playbooks"],
  Channel: ["channel", "channels"], Business: ["business", "businesses"], Chunk: ["passage", "passages"],
};
const plural = (label: string, n: number) => `${fmtNum(n)} ${(PLURAL[label] ?? [label.toLowerCase(), `${label.toLowerCase()}s`])[n === 1 ? 0 : 1]}`;

const pathOf = (url: string) => {
  try { return new URL(url).pathname; } catch { return url; }
};

const hostOf = (url: string) => {
  try { return new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ""); } catch { return url; }
};

interface RunState {
  stage?: Stage;
  texts: Partial<Record<Stage, string>>;
  pages: { url: string; title: string }[];
  nodes: NodeRef[];
  edges: EdgeRef[];
  done?: { tenant: string; counts: Record<string, number> };
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export default function OnboardPage() {
  const { refreshTenants, setTenant, effectiveTheme, reducedMotion } = useApp();
  const nav = useNavigate();
  const params = new URLSearchParams(location.search);
  const [name, setName] = useState(params.get("name") ?? "");
  const [url, setUrl] = useState(params.get("url") ?? "");
  const [instagram, setInstagram] = useState(params.get("instagram") ?? "");
  const [country, setCountry] = useState(() => params.get("country") ?? (params.get("url") ? guessRegion(params.get("url")!).country : "United Kingdom"));
  const countryTouched = useRef(!!params.get("country"));
  const [run, setRun] = useState<RunState | null>(null);
  const abort = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);
  const narrow = useMedia("(max-width: 900px)");

  const region = REGIONS.find((r) => r.country === country) ?? REGIONS[0]!;
  const running = !!run && !run.done && !run.error;

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
    const state: RunState = { texts: {}, pages: [], nodes: [], edges: [], startedAt: Date.now() };
    setRun({ ...state });
    const seen = new Set<string>();
    const onEvent = (e: OnboardEvent) => {
      if (e.type === "stage") { state.stage = e.stage; state.texts = { ...state.texts, [e.stage]: e.text }; }
      else if (e.type === "page") state.pages = [...state.pages, { url: e.url, title: e.title }];
      else if (e.type === "nodes") {
        const fresh = e.nodes.filter((n) => !seen.has(n.id));
        fresh.forEach((n) => seen.add(n.id));
        state.nodes = [...state.nodes, ...fresh];
        state.edges = [...state.edges, ...e.edges];
      } else if (e.type === "done") { state.done = { tenant: e.tenant, counts: e.counts }; state.endedAt = Date.now(); }
      else if (e.type === "error") { state.error = e.message; state.endedAt = Date.now(); }
      setRun({ ...state });
    };
    try {
      await api.onboard({ name: name.trim() || hostOf(url), url: url.trim(), instagram: instagram.trim() || undefined, ...region }, onEvent, { signal: ctrl.signal });
      if (state.done) await refreshTenants();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      state.error = (err as Error).message || "The set-up stopped before it finished.";
      setRun({ ...state });
    }
  };

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (autoStarted.current || params.get("go") !== "1" || !url) return;
    autoStarted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void start(); };
  const openOffice = (path: string) => { if (run?.done) setTenant(run.done.tenant); nav(path); };

  const stageIndex = run?.stage ? STAGES.findIndex((s) => s.id === run.stage) : -1;
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of run?.nodes ?? []) c[n.label] = (c[n.label] ?? 0) + 1;
    return c;
  }, [run?.nodes]);
  const centerId = run?.nodes.find((n) => n.label === "Business")?.id;
  const bizName = name.trim() || (url ? hostOf(url) : "Your business");

  return (
    <div className="onboard-page">
      <div className="onboard-left">
        <header>
          <h1 className="page-title">Brief a new team</h1>
          <p className="page-lede">
            Paste the website. Allevia reads it, builds the company brain and briefs ten staff in about two minutes.
            Nothing is posted or changed anywhere.
          </p>
        </header>

        {!run || run.error ? (
          <form className="onboard-form panel" onSubmit={onSubmit} aria-label="Set up a business">
            <label className="label">
              Website
              <input className="field" inputMode="url" autoComplete="url" placeholder="yourstudio.co.uk" value={url} onChange={(e) => onUrl(e.target.value)} required />
            </label>
            <label className="label">
              Business name
              <input className="field" autoComplete="organization" placeholder="As your customers know it" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="form-row">
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
            </div>
            <p className="form-note">
              Money will show in <b>{currencySymbol(region.currency)} {region.currency}</b> and dates as {region.locale === "en-US" ? "Oct 15" : "15 Oct"}.
            </p>
            {run?.error && <p className="notice notice-bad" role="alert">{run.error} Check the address and try again.</p>}
            <button type="submit" className="btn btn-gold onboard-go" disabled={!url.trim()}>
              Build the brain <Icon name="send" size={16} />
            </button>
          </form>
        ) : (
          <div className="onboard-who panel">
            <span className="switcher-monogram" aria-hidden="true">{bizName.slice(0, 1).toUpperCase()}</span>
            <div>
              <p className="onboard-who-name">{bizName}</p>
              <p className="small muted">{hostOf(url)}{instagram ? ` · @${instagram.replace(/^@/, "")}` : ""} · reports in {region.currency}</p>
            </div>
            {running && <button type="button" className="btn btn-quiet btn-sm" onClick={() => { abort.current?.abort(); setRun(null); }}>Stop</button>}
          </div>
        )}

        {run?.done ? (
          <Receipt run={run} host={hostOf(url)} region={region} onOpen={openOffice} name={bizName} />
        ) : (
          <ol className="stages" aria-label="Set-up steps" aria-live="polite">
            {STAGES.map((s, i) => {
              const state = run?.done || i < stageIndex ? "done" : i === stageIndex && running ? "active" : "todo";
              return (
                <li key={s.id} className={`stage is-${state}`}>
                  <span className="stage-mark" aria-hidden="true">{state === "done" ? <Icon name="check" size={13} /> : i + 1}</span>
                  <span className="stage-text">
                    <span className="stage-title">{s.title}</span>
                    <span className="stage-sub">{run?.texts[s.id] ?? s.idle}</span>
                  </span>
                  <span className="visually-hidden">{state === "done" ? "done" : state === "active" ? "in progress" : "to do"}</span>
                </li>
              );
            })}
          </ol>
        )}

        {run && run.pages.length > 0 && !run.done && (
          <div className="pages-read">
            <h2 className="section-title">Pages read</h2>
            <ul>
              {run.pages.slice(-6).map((p) => (
                <li key={p.url}><span className="mono">{pathOf(p.url)}</span><span className="muted">{p.title}</span></li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className={`onboard-right${run ? "" : " is-idle"}`}>
        <div className="onboard-canvas-head">
          <h2 className="section-title">{run ? `${bizName}’s brain` : "The brain grows here"}</h2>
          {run && (
            <p className="small muted num" aria-live="off">
              {fmtNum(run.nodes.length)} things · {fmtNum(run.edges.length)} links
              {run.endedAt ? ` · built in ${fmtMs(run.endedAt - run.startedAt)}` : ""}
            </p>
          )}
        </div>
        <div className="onboard-canvas">
          {run && run.nodes.length > 0 ? (
            <Suspense fallback={null}>
              <GraphView
                nodes={run.nodes}
                edges={run.edges}
                centerId={centerId}
                dark={effectiveTheme === "dark"}
                reducedMotion={reducedMotion}
                labels={narrow ? "auto" : "all"}
                sizeBy="degree"
                followGrowth
                maxFitZoom={2.2}
                fitPadding={narrow ? 36 : 80}
                ariaLabel={`${bizName}'s company brain: ${run.nodes.length} things and ${run.edges.length} links so far`}
              />
            </Suspense>
          ) : (
            <div className="onboard-blank">
              <p>Every page, service, audience and brand rule becomes a node here as the team reads your site.</p>
            </div>
          )}
        </div>
        {run && Object.keys(counts).length > 0 && !run.done && (
          <ul className="tally" aria-label="Found so far">
            {Object.entries(counts).filter(([l]) => l !== "Business").map(([label, n]) => (
              <li key={label} style={{ ["--hue" as string]: hueFor(label) }}>{plural(label, n)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Receipt({ run, host, region, onOpen, name }: { run: RunState; host: string; region: (typeof REGIONS)[number]; onOpen: (path: string) => void; name: string }) {
  const c = run.done!.counts;
  const lines: string[] = [
    `Read ${plural("Page", c.Page ?? run.pages.length)} of ${host}`,
    `Picked out ${plural("BrandAsset", c.BrandAsset ?? 0)} and ${plural("BrandRule", c.BrandRule ?? 0)}`,
    `Ran 42 search checks and filed ${plural("Rule", c.Rule ?? 0)} to fix`,
    `Mapped ${plural("Product", c.Product ?? 0)}, ${plural("Audience", c.Audience ?? 0)} and what they need`,
    `Attached ${plural("Playbook", c.Playbook ?? 0)}`,
    `Indexed ${plural("Chunk", c.Chunk ?? 0)} so answers can cite them`,
  ];
  return (
    <section className="receipt panel" aria-labelledby="receipt-title">
      <div className="receipt-head">
        <h2 id="receipt-title" className="receipt-title">What we did for you</h2>
        <span className="badge badge-ok"><Icon name="check" size={13} /> Ready</span>
      </div>
      <ul className="receipt-lines">
        {lines.map((l) => <li key={l}><Icon name="check" size={14} /> {l}</li>)}
      </ul>
      <div className="receipt-team">
        <span className="receipt-avatars" aria-hidden="true">
          {AGENTS.map((a) => <AgentAvatar key={a.id} id={a.id} size={26} />)}
        </span>
        <p>{AGENTS.length} staff in {DEPARTMENTS.length} departments are briefed. Money shows in {region.currency} ({currencySymbol(region.currency)}), as a business in {region.country} reports it.</p>
      </div>
      <div className="receipt-actions">
        <button type="button" className="btn btn-gold" onClick={() => onOpen("/")}>Open {name}’s office</button>
        <button type="button" className="btn btn-ghost" onClick={() => onOpen("/brain")}><Icon name="brain" size={15} /> Explore the brain</button>
      </div>
    </section>
  );
}
