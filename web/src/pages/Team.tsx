// Your team: say what you want in plain words ("Tell your team"), see exactly what would change, and apply it. Below,
// one quiet row per person with an on/off switch; open a row to set how busy they are, how much they do without asking,
// your instructions to them and what they learned from your edits. Switching someone on or off redraws the office.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentMode, DirectiveDiffLine, DirectivePreview } from "@shared/contracts";
import { AGENTS, teamOf } from "@shared/roster";
import { api, getPublicMode, type AgentPatch } from "../api";
import { AgentAvatar } from "../components/bits";
import { Icon } from "../components/Icon";
import { RuleRow } from "../components/Learning";
import { Reveal } from "../components/Reveal";
import { TeamPeople } from "../components/TeamPeople";
import { fmtDate } from "../lib/format";
import { useApp, useAsync } from "../state/app";
import type { AgentView } from "../types-ext";
import { TEAM_CHANGED } from "./Office";
import "./team.css";

const MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: "full", label: "Fully on", hint: "Works on every request they are needed for" },
  { id: "light", label: "Light touch", hint: "Fewer, shorter checks. Good for a quiet season" },
  { id: "off", label: "Resting", hint: "Left out of every plan until you switch them back on" },
];

const AUTONOMY = [
  { level: 0, short: "Drafts", long: "Drafts only. Nothing goes out without your yes." },
  { level: 1, short: "Schedules", long: "Schedules what you approved, at the right time." },
  { level: 2, short: "Publishes", long: "Publishes on their own and tells you after, in a short note." },
  { level: 3, short: "Acts", long: "Acts on their own, within the spending and posting limits you set." },
];

const EXAMPLES = [
  "No emojis on LinkedIn; switch Techie off",
  "Miss Influencer, always mention the free first consultation",
  "Never say cheap",
  "Growth Hacker, go light till the season starts",
];

const changed = () => window.dispatchEvent(new Event(TEAM_CHANGED));
/** The roster's one-liners were written for staff; say "what we know" where they say "the graph". */
const plain = (s?: string) => (s ?? "").replace(/\bthe graph\b/gi, "what we know");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function TeamPage() {
  const { tenant, authRequired } = useApp();
  const team = useAsync(() => api.team(tenant.id), [tenant.id]);
  const [agents, setAgents] = useState<AgentView[] | undefined>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => { setAgents(team.data); }, [team.data]);
  useEffect(() => { setAgents(undefined); setOpenId(null); }, [tenant.id]);

  const list = agents ?? team.data ?? [];
  const working = list.filter((a) => a.enabled).length;

  // every learned rule once, with the people who follow it
  const rules = useMemo(() => {
    const m = new Map<string, AgentView["learnedRules"][number] & { agents: string[] }>();
    for (const a of list) for (const r of a.learnedRules) {
      const have = m.get(r.id);
      if (have) have.agents.push(a.id); else m.set(r.id, { ...r, agents: [a.id] });
    }
    return [...m.values()];
  }, [list]);

  const patch = async (id: string, p: AgentPatch) => {
    const before = agents;
    const { statusNote: _note, ...shown } = p; // the note waits for the server's answer
    setAgents((xs) => xs?.map((a) => (a.id === id ? { ...a, ...shown, ...(p.mode ? { enabled: p.mode !== "off" } : {}) } : a)));
    try {
      const next = await api.setAgent(tenant.id, id, p);
      setAgents((xs) => xs?.map((a) => (a.id === id ? next : a)));
      changed();
    } catch (e) {
      setAgents(before);
      throw e;
    }
  };
  const removeNote = async (id: string) => {
    await api.retireSkillNote(tenant.id, id);
    team.reload();
    changed();
  };
  const retire = async (ruleId: string) => {
    await api.retireRule(tenant.id, ruleId);
    setAgents((xs) => xs?.map((a) => ({ ...a, learnedRules: a.learnedRules.filter((r) => r.id !== ruleId) })));
    changed();
  };

  return (
    <div className="team-page">
      <header className="tm-head">
        <h1 className="page-title">Your team</h1>
        {team.data && <p className="page-lede"><b>{working} of {list.length}</b> are working for you.</p>}
      </header>

      <TellYourTeam tenantId={tenant.id} prefill={prefill} onApplied={() => { team.reload(); changed(); }} />

      {/* with sign-in on, the people who can open this business (not on a demo, which nobody here is in) */}
      {authRequired && !tenant.readOnly && <TeamPeople tenantId={tenant.id} tenantName={tenant.name} />}

      {team.error && <p className="notice notice-bad" role="alert">Your team did not load: {team.error}</p>}
      {!team.data && team.loading ? (
        <span className="skeleton" style={{ display: "block", height: 420 }} />
      ) : (
        <section className="tm-list-wrap" aria-label="The people on your team">
          <ul className="tm-list">
            {list.map((a) => (
              <PersonRow
                key={a.id}
                a={a}
                open={openId === a.id}
                onToggle={() => setOpenId(openId === a.id ? null : a.id)}
                onPatch={patch}
                onRetire={retire}
                onRemoveNote={removeNote}
                onTell={() => setPrefill({ text: `${a.name}, `, n: Date.now() })}
              />
            ))}
          </ul>
        </section>
      )}

      {team.data && (
        <Reveal label="Things your team learned from your edits" summary={rules.length ? String(rules.length) : "none yet"}>
          {rules.length ? (
            <ul className="tm-rules">
              {rules.map((r) => <RuleRow key={r.id} rule={r} onRetire={retire} />)}
            </ul>
          ) : (
            <p className="tm-empty">Nothing yet. Change a draft before you approve it, and what you changed shows up here, so the next draft gets it right.</p>
          )}
        </Reveal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one person

function PersonRow({ a, open, onToggle, onPatch, onRetire, onRemoveNote, onTell }: {
  a: AgentView; open: boolean; onToggle: () => void;
  onPatch: (id: string, p: AgentPatch) => Promise<void>; onRetire: (ruleId: string) => Promise<void>; onRemoveNote: (id: string) => Promise<void>; onTell: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ro = getPublicMode();
  const uid = useId();
  const chief = a.id === "chief-of-staff";
  const mode: AgentMode = a.enabled ? a.mode : "off";
  const agentDef = AGENTS.find((d) => d.id === a.id);
  const run = async (p: AgentPatch) => {
    setBusy(true);
    setError(null);
    try { await onPatch(a.id, p); } catch (e) { setError((e as Error).message || "That did not save. Try again."); } finally { setBusy(false); }
  };
  const level = AUTONOMY[Math.max(0, Math.min(3, a.autonomy))]!;
  const status = mode === "off"
    ? `Resting${a.statusNote ? ` ${a.statusNote}` : ""}`
    : a.statusNote ?? (mode === "light" ? "Working with a light touch" : plain(agentDef?.persona));
  const refuse = chief ? `${a.name} can't rest: ${a.name} plans every request and writes every answer.` : undefined;

  return (
    <li className={`tm-row mode-${mode}${open ? " is-open" : ""}`}>
      <div className="tm-line">
        <button type="button" className="tm-open" aria-expanded={open} aria-controls={`${uid}-detail`} onClick={onToggle}>
          <AgentAvatar id={a.id} size={40} />
          <span className="tm-id">
            <span className="tm-name">{a.name}<span className="tm-role">{teamOf(a.id) ?? a.title}</span></span>
            <span className="tm-status">{status}</span>
          </span>
          <Icon name="chevron-right" size={16} className="tm-chevron" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={mode !== "off"}
          aria-label={`${a.name} is ${mode === "off" ? "resting" : "working"}. Switch ${mode === "off" ? "on" : "off"}`}
          title={refuse ?? (mode === "off" ? `Switch ${a.name} on` : `Let ${a.name} rest`)}
          className="tm-switch"
          disabled={busy || ro || (chief && mode !== "off")}
          onClick={() => run({ mode: mode === "off" ? "full" : "off" })}
        >
          <span className="tm-switch-knob" />
        </button>
      </div>

      {open && (
        <div className="tm-detail" id={`${uid}-detail`}>
          <section className="tm-block" aria-labelledby={`${uid}-mode`}>
            <h3 id={`${uid}-mode`} className="tm-label">How busy {a.name} is</h3>
            <div className="tm-choices" role="radiogroup" aria-labelledby={`${uid}-mode`}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  className={`tm-choice${mode === m.id ? " is-on" : ""}`}
                  disabled={busy || ro || (chief && m.id === "off")}
                  title={chief && m.id === "off" ? refuse : m.hint}
                  onClick={() => mode !== m.id && run({ mode: m.id })}
                >{m.label}</button>
              ))}
            </div>
            <p className="tm-help">{MODES.find((m) => m.id === mode)?.hint}.</p>
          </section>

          <section className="tm-block" aria-labelledby={`${uid}-aut`}>
            <h3 id={`${uid}-aut`} className="tm-label">How much {a.name} does without asking</h3>
            <div className="tm-choices" role="radiogroup" aria-labelledby={`${uid}-aut`}>
              {AUTONOMY.map((l) => (
                <button
                  key={l.level}
                  type="button"
                  role="radio"
                  aria-checked={a.autonomy === l.level}
                  className={`tm-choice${a.autonomy === l.level ? " is-on" : ""}`}
                  disabled={busy || ro || !a.enabled}
                  title={l.long}
                  onClick={() => a.autonomy !== l.level && run({ autonomy: l.level })}
                >{l.short}</button>
              ))}
            </div>
            <p className="tm-help">{level.long}</p>
          </section>

          <section className="tm-block" aria-labelledby={`${uid}-ins`}>
            <h3 id={`${uid}-ins`} className="tm-label">What you told {a.name}</h3>
            {a.instructions.length ? (
              <ul className="tm-instructions">
                {a.instructions.map((i) => (
                  <li key={i.id}>
                    <span>{i.text}{i.channel && <span className="tm-channel">{i.channel}</span>}</span>
                    {i.at && <span className="tm-when">{fmtDate(new Date(i.at).toISOString())}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tm-help">Nothing yet.</p>
            )}
            {!ro && <button type="button" className="btn btn-ghost btn-sm tm-tell" onClick={onTell}>Tell {a.name} something</button>}
          </section>

          {a.skills && a.skills.length > 0 && (
            <Reveal label={`How ${a.name} works`} summary={`${plural(a.skills.length, "skill", "skills")} · ${plural(a.tools?.length ?? 0, "thing", "things")} ${a.name} can use`}>
              <ul className="tm-skills">
                {a.skills.map((s) => (
                  <li key={s.id}>
                    <p className="tm-skill-name">{s.name}{s.source === "business" && <span className="tm-channel">your own</span>}</p>
                    <p className="tm-help">{s.when}.</p>
                    <p className="tm-skill-tags">
                      {s.makes ? <span>Makes: {s.makes}</span> : <span>Looks and explains; makes nothing</span>}
                      {s.needsOk && <span>Waits for your OK</span>}
                    </p>
                    {s.rules.length > 0 && (
                      <ul className="tm-skill-rules" aria-label={`Your rules for ${s.name}`}>
                        {s.rules.map((r) => (
                          <li key={r.id}>
                            <span>{r.text}{r.channel && <span className="tm-channel">{r.channel}</span>}</span>
                            {!ro && <button type="button" className="btn btn-quiet btn-sm" onClick={() => onRemoveNote(r.id).catch((e) => setError((e as Error).message || "That did not save. Try again."))}>Remove</button>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.learned.length > 0 && <p className="tm-help">Learned from your edits: {s.learned.join(" ")}</p>}
                  </li>
                ))}
              </ul>
              {a.tools && a.tools.length > 0 && (
                <>
                  <h3 className="tm-label">What {a.name} can look at and do</h3>
                  <ul className="tm-tools">{a.tools.map((t) => <li key={t.name}>{t.words}</li>)}</ul>
                </>
              )}
              {!ro && <button type="button" className="btn btn-ghost btn-sm tm-tell" onClick={onTell}>Change how {a.name} works</button>}
            </Reveal>
          )}

          <Reveal label={`Things ${a.name} learned from your edits`} summary={a.learnedRules.length ? String(a.learnedRules.length) : "none yet"}>
            {a.learnedRules.length ? (
              <ul className="tm-rules">
                {a.learnedRules.map((r) => <RuleRow key={r.id} rule={{ ...r, agents: [a.id] }} onRetire={onRetire} compact />)}
              </ul>
            ) : (
              <p className="tm-empty">Nothing yet. Change one of {a.name}’s drafts before you approve it, and the change lands here.</p>
            )}
          </Reveal>

          <p className="tm-foot">
            {plural(a.stats.requests, "request", "requests")} handled
            {a.stats.findings > 0 && <> · {plural(a.stats.findings, "thing", "things")} noticed</>}
            {a.stats.proposals > 0 && <> · {plural(a.stats.proposals, "idea", "ideas")} suggested</>}
          </p>
          {!a.enabled && <p className="tm-help">While resting, {a.name} sits out of every plan until you switch them back on.</p>}
          {error && <p className="notice notice-bad" role="alert">{error}</p>}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- "Tell your team"

function TellYourTeam({ tenantId, prefill, onApplied }: { tenantId: string; prefill: { text: string; n: number } | null; onApplied: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<DirectivePreview | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ n: number; errors: string[] } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const ro = getPublicMode();
  useEffect(() => { setText(""); setPreview(null); setApplied(null); setError(null); }, [tenantId]);

  const params = new URLSearchParams(location.search);
  const seeded = params.get("say");
  useEffect(() => {
    if (!seeded) return;
    setText(seeded);
    if (params.get("preview") === "1") void doPreview(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded]);

  // "Tell Miss Influencer something" in a person's row: start the sentence here and put the cursor at its end
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    setPreview(null);
    const el = field.current;
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus({ preventScroll: true });
      requestAnimationFrame(() => el.setSelectionRange(prefill.text.length, prefill.text.length));
    }
  }, [prefill]);

  async function doPreview(t = text) {
    if (!t.trim()) return;
    setBusy("preview");
    setError(null);
    setApplied(null);
    try { setPreview(await api.previewDirective(tenantId, t.trim())); } catch (e) { setError((e as Error).message || "That did not go through."); } finally { setBusy(null); }
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void doPreview(); };
  const apply = async () => {
    if (!preview) return;
    setBusy("apply");
    setError(null);
    try {
      const out = await api.applyDirective(tenantId, preview.id);
      setApplied({ n: out.diff.filter((d) => d.op !== "same").length, errors: out.errors ?? [] });
      setPreview(null);
      setText("");
      onApplied();
    } catch (e) {
      setError((e as Error).message || "That did not apply.");
    } finally {
      setBusy(null);
    }
  };
  const changes = preview?.diff.filter((d) => d.op !== "same").length ?? 0;

  return (
    <section className="tell" aria-labelledby="tell-title">
      <h2 id="tell-title" className="tell-title">Tell your team</h2>
      <p className="tell-lede">Say it the way you would to a person. You will see what changes before anything is saved.</p>
      <form className="tell-form" onSubmit={onSubmit}>
        <label htmlFor="tell-text" className="visually-hidden">What do you want your team to know or do?</label>
        <textarea
          id="tell-text"
          ref={field}
          className="field tell-field"
          rows={3}
          value={text}
          placeholder="No emojis on LinkedIn, and let Techie rest till the new site launches"
          onChange={(e) => { setText(e.target.value); if (preview) setPreview(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void doPreview(); } }}
          disabled={ro}
        />
        <div className="tell-actions">
          <div className="tell-examples" aria-label="Examples">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="suggest-chip" onClick={() => { setText(x); setPreview(null); }} disabled={ro}>{x}</button>
            ))}
          </div>
          <button type="submit" className="btn btn-gold tell-go" disabled={!text.trim() || busy !== null || ro}>
            {busy === "preview" ? "Reading…" : "Preview changes"}
          </button>
        </div>
      </form>
      {ro && <p className="notice tell-note">This is the public demo, so settings are view-only.</p>}
      {error && <p className="notice notice-bad tell-note" role="alert">{error}</p>}
      {applied && (
        <p className="notice notice-ok tell-note" role="status">
          <Icon name="check" size={14} /> Done. {plural(applied.n, "change", "changes")} saved, and your team {applied.n === 1 ? "follows it" : "follows them"} from now on.
          {applied.errors.length > 0 && <> Not applied: {applied.errors.join("; ")}</>}
        </p>
      )}
      {preview && <DiffCard preview={preview} changes={changes} busy={busy === "apply"} onApply={apply} onDiscard={() => setPreview(null)} />}
    </section>
  );
}

export function DiffCard({ preview, changes, busy, onApply, onDiscard }: { preview: DirectivePreview; changes: number; busy: boolean; onApply: () => void; onDiscard: () => void }) {
  return (
    <div className="diff-card" aria-labelledby="diff-title">
      <h3 id="diff-title" className="diff-title">{changes ? `${plural(changes, "change", "changes")} to check` : "Nothing would change"}</h3>
      <p className="diff-said">“{preview.text}”</p>
      {preview.diff.length > 0 && (
        <ol className="diff-lines">
          {preview.diff.map((d) => <DiffLine key={`${d.patch}-${d.target}`} d={d} />)}
        </ol>
      )}
      {preview.unparsed.length > 0 && (
        <div className="diff-unparsed" role="note">
          <p><Icon name="warn" size={14} /> We did not understand this part, so nothing changes for it:</p>
          <ul>{preview.unparsed.map((u) => <li key={u}>“{u}”</li>)}</ul>
          <p className="diff-tip">Try starting with a name (“Miss Influencer, …”) or saying on, off, light, or always / never.</p>
        </div>
      )}
      {preview.notes.length > 0 && (
        <ul className="diff-notes" role="note">
          {preview.notes.map((n) => <li key={n}><Icon name="chat" size={14} /> {n}</li>)}
        </ul>
      )}
      <div className="diff-actions">
        <button type="button" className="btn btn-gold" onClick={onApply} disabled={busy || changes === 0}>
          <Icon name="check" size={16} /> {busy ? "Saving…" : changes ? `Save ${changes === 1 ? "this change" : `these ${changes} changes`}` : "Save"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDiscard} disabled={busy}>Never mind</button>
        <p className="diff-foot">Your old settings are kept, so nothing is lost.</p>
      </div>
      <Reveal label="Show how this was read" className="diff-how">
        <p className="diff-parser">{preview.parser === "rules" ? "Read with fixed rules, no language model." : "Fixed rules read part of it and a language model read the rest. Every change was checked against your team."}</p>
        <ul className="diff-targets">
          {preview.diff.map((d) => <li key={`${d.patch}-${d.target}`}><code>{d.target}</code></li>)}
        </ul>
      </Reveal>
    </div>
  );
}

const OP: Record<DirectiveDiffLine["op"], { text: string; cls: string }> = {
  change: { text: "Change", cls: "badge-gold" },
  add: { text: "Add", cls: "badge-ok" },
  same: { text: "Already so", cls: "badge-ink" },
};

function DiffLine({ d }: { d: DirectiveDiffLine }) {
  const agentId = d.target.startsWith("agent:allevia-") ? d.target.slice("agent:allevia-".length) : undefined;
  const who = /^Instruction for (.+?)(?: on (.+))?$/.exec(d.label);
  const names = who ? who[1]!.split(", ") : [];
  const avatars = agentId ? [agentId] : names.map((n) => AGENTS.find((a) => a.name === n)?.id).filter((x): x is string => !!x);
  return (
    <li className={`diff-line op-${d.op}`}>
      <span className={`badge ${OP[d.op].cls}`}>{OP[d.op].text}</span>
      <div className="diff-what">
        <p className="diff-label">
          {avatars.length > 0 && <span className="diff-avatars">{avatars.map((a) => <AgentAvatar key={a} id={a} size={20} />)}</span>}
          {d.label}
        </p>
        <p className="diff-change">
          {d.before !== undefined && <><del>{d.before}</del><Icon name="send" size={13} className="diff-arrow" /></>}
          <ins>{d.after}</ins>
        </p>
      </div>
    </li>
  );
}
