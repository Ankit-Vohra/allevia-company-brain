// Team settings (product design §2.4, §8): every desk on, light or off, how much it may do alone, the owner's standing
// instructions, and the rules it learned from the owner's edits, each with a retire action. "Tell your team" turns a
// plain sentence into typed changes, shows exactly what will change as a diff, and writes nothing until Apply.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { AgentMode, DirectiveDiffLine, DirectivePreview } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { api, getPublicMode, type AgentPatch } from "../api";
import { AgentAvatar, agentDef } from "../components/bits";
import { Icon } from "../components/Icon";
import { RuleRow } from "../components/Learning";
import { avatarUrl } from "../office/sprites";
import { fmtDate } from "../lib/format";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import type { AgentView } from "../types-ext";
import { TEAM_CHANGED } from "./Office";
import "./team.css";

const MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: "full", label: "On", hint: "Works every request it is needed for" },
  { id: "light", label: "Light", hint: "Fewer, shorter checks: for a quiet season" },
  { id: "off", label: "Off", hint: "Left out of every plan until you switch it back" },
];

const AUTONOMY = [
  { level: 0, short: "Drafts", long: "Drafts only: nothing goes out without your yes." },
  { level: 1, short: "Schedules", long: "Schedules what you approved, at the right time." },
  { level: 2, short: "Publishes", long: "Publishes on its own and tells you after, in a digest." },
  { level: 3, short: "Acts", long: "Acts within the spending and posting caps you set." },
];

const EXAMPLES = [
  "No emojis on LinkedIn; switch Arjun off",
  "Tara, always mention the free first consultation",
  "Never say cheap",
  "Rohan light till the season starts",
];

const changed = () => window.dispatchEvent(new Event(TEAM_CHANGED));

export default function TeamPage() {
  const { tenant } = useApp();
  const team = useAsync(() => api.team(tenant.id), [tenant.id]);
  const [agents, setAgents] = useState<AgentView[] | undefined>();
  useEffect(() => { setAgents(team.data); }, [team.data]);
  useEffect(() => { setAgents(undefined); }, [tenant.id]);

  const list = agents ?? team.data ?? [];
  const counts = useMemo(() => ({
    on: list.filter((a) => a.enabled && a.mode === "full").length,
    light: list.filter((a) => a.enabled && a.mode === "light").length,
    off: list.filter((a) => !a.enabled).length,
    rules: new Set(list.flatMap((a) => a.learnedRules.map((r) => r.id))).size,
  }), [list]);

  // departments in reading order, each placed in the shortest column so far: a masonry that still reads left to right
  const wide = useMedia("(min-width: 1180px)");
  const mid = useMedia("(min-width: 780px)");
  const columns = useMemo(() => {
    const n = wide ? 3 : mid ? 2 : 1;
    const cols = Array.from({ length: n }, () => ({ h: 0, items: [] as Array<{ d: (typeof DEPARTMENTS)[number]; members: AgentView[] }> }));
    for (const d of DEPARTMENTS) {
      const members = list.filter((a) => a.department === d.id);
      if (!members.length) continue;
      const h = 0.4 + members.reduce((s, a) => s + 1 + 0.12 * (a.learnedRules.length + a.instructions.length), 0);
      const c = cols.reduce((best, x) => (x.h < best.h - 0.01 ? x : best), cols[0]!);
      c.items.push({ d, members });
      c.h += h;
    }
    return cols.map((c) => c.items);
  }, [list, wide, mid]);

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
  const retire = async (ruleId: string) => {
    await api.retireRule(tenant.id, ruleId);
    setAgents((xs) => xs?.map((a) => ({ ...a, learnedRules: a.learnedRules.filter((r) => r.id !== ruleId) })));
    changed();
  };

  return (
    <div className="team-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Your team</h1>
          <p className="page-lede">
            {AGENTS.length} staff in {DEPARTMENTS.length} departments. Switch a desk off or to light, set how much it may do
            on its own, or tell the whole team something once. Every change keeps the old setting in the brain, so nothing
            is lost.
          </p>
        </div>
        <dl className="kpis" aria-label="The team at a glance">
          <div className="kpi"><dt>On</dt><dd className="num">{team.data ? counts.on : "–"}</dd></div>
          <div className="kpi"><dt>Light</dt><dd className="num">{team.data ? counts.light : "–"}</dd></div>
          <div className="kpi"><dt>Off</dt><dd className="num">{team.data ? counts.off : "–"}</dd></div>
          <div className="kpi"><dt>Learned</dt><dd className="num">{team.data ? counts.rules : "–"}</dd><p>rules, from your edits</p></div>
        </dl>
      </header>

      <TellYourTeam tenantId={tenant.id} onApplied={() => { team.reload(); changed(); }} />

      {team.error && <p className="notice notice-bad" role="alert">The team did not load: {team.error}</p>}
      {!team.data && team.loading ? (
        <span className="skeleton" style={{ display: "block", height: 420 }} />
      ) : (
        <div className="depts" style={{ ["--cols" as string]: columns.length }}>
          {columns.map((col, i) => (
            <div key={i} className="dept-col">
              {col.map(({ d, members }) => (
                <section key={d.id} className="dept" style={{ ["--hue" as string]: d.hue }} aria-labelledby={`dept-${d.id}`}>
                  <header className="dept-head">
                    <h2 id={`dept-${d.id}`} className="dept-name">{d.name}</h2>
                    <p className="dept-blurb">{d.blurb}</p>
                  </header>
                  {members.map((a) => <AgentCard key={a.id} a={a} onPatch={patch} onRetire={retire} />)}
                </section>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one desk

function AgentCard({ a, onPatch, onRetire }: { a: AgentView; onPatch: (id: string, p: AgentPatch) => Promise<void>; onRetire: (ruleId: string) => Promise<void> }) {
  const def = agentDef(a.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ro = getPublicMode();
  const chief = a.id === "chief-of-staff";
  const mode: AgentMode = a.enabled ? a.mode : "off";
  const run = async (p: AgentPatch) => {
    setBusy(true);
    setError(null);
    try { await onPatch(a.id, p); } catch (e) { setError((e as Error).message || "That did not save. Try again."); } finally { setBusy(false); }
  };
  const level = AUTONOMY[Math.max(0, Math.min(3, a.autonomy))]!;

  return (
    <article className={`agent-card mode-${mode}`} aria-labelledby={`ac-${a.id}`}>
      <header className="ac-head">
        <span className="ac-portrait" aria-hidden="true"><img src={avatarUrl(a.id, 4)} width={48} height={48} alt="" /></span>
        <div className="ac-id">
          <h3 id={`ac-${a.id}`} className="ac-name">{a.name}</h3>
          <p className="ac-title">{a.title}</p>
        </div>
        <div className="seg ac-mode" role="radiogroup" aria-label={`${a.name}: on, light or off`}>
          {MODES.map((m) => {
            const refuse = chief && m.id === "off";
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className={`seg-btn${mode === m.id ? " is-on" : ""}${m.id === "off" ? " is-off-btn" : ""}`}
                disabled={busy || ro || refuse}
                title={refuse ? `${a.name} can't be switched off: the Chief of Staff plans every request and writes every answer.` : m.hint}
                onClick={() => mode !== m.id && run({ mode: m.id })}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </header>

      {!a.enabled && (
        <p className="ac-off-note"><Icon name="pause" size={14} /> Switched off{a.statusNote ? `: ${a.statusNote}` : ""}. {a.name} sits out of every plan until you switch the desk back on.</p>
      )}
      {a.enabled && a.statusNote && <p className="ac-status-note">{a.statusNote}</p>}
      {a.enabled && !a.statusNote && <p className="ac-persona">{def?.persona}</p>}

      <div className="ac-row">
        <p className="ac-label" id={`aut-${a.id}`}>On its own</p>
        <div className="ac-autonomy" role="radiogroup" aria-labelledby={`aut-${a.id}`}>
          {AUTONOMY.map((l) => (
            <button
              key={l.level}
              type="button"
              role="radio"
              aria-checked={a.autonomy === l.level}
              className={`aut-step${a.autonomy >= l.level ? " is-reached" : ""}${a.autonomy === l.level ? " is-on" : ""}`}
              disabled={busy || ro || !a.enabled}
              title={l.long}
              onClick={() => a.autonomy !== l.level && run({ autonomy: l.level })}
            >
              <span className="aut-level">L{l.level}</span>
              <span className="aut-name">{l.short}</span>
            </button>
          ))}
        </div>
        <p className="ac-help">{level.long}</p>
      </div>

      <div className="ac-block">
        <p className="ac-label">Your instructions</p>
        {a.instructions.length ? (
          <ul className="ac-instructions">
            {a.instructions.map((i) => (
              <li key={i.id}>
                <Icon name="chat" size={14} />
                <span>{i.text}{i.channel && <span className="ac-channel">{i.channel}</span>}</span>
                {i.at && <span className="ac-when">{fmtDate(new Date(i.at).toISOString())}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ac-empty">None yet. Start a line with “{a.name}, …” above.</p>
        )}
      </div>

      <div className="ac-block">
        <p className="ac-label">Learned from your edits {a.learnedRules.length > 0 && <span className="num">· {a.learnedRules.length}</span>}</p>
        {a.learnedRules.length ? (
          <ul className="ac-rules">
            {a.learnedRules.map((r) => <RuleRow key={r.id} rule={{ ...r, agents: [a.id] }} onRetire={onRetire} compact />)}
          </ul>
        ) : (
          <p className="ac-empty">Nothing yet. Edit one of {a.name}’s drafts before approving it, and the change lands here.</p>
        )}
      </div>

      <footer className="ac-foot">
        <span><b className="num">{a.stats.requests}</b> {a.stats.requests === 1 ? "request" : "requests"}</span>
        <span><b className="num">{a.stats.findings}</b> {a.stats.findings === 1 ? "finding" : "findings"}</span>
        {a.stats.proposals > 0 && <span><b className="num">{a.stats.proposals}</b> {a.stats.proposals === 1 ? "proposal" : "proposals"}</span>}
      </footer>
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
    </article>
  );
}

// ---------------------------------------------------------------- "Tell your team"

function TellYourTeam({ tenantId, onApplied }: { tenantId: string; onApplied: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<DirectivePreview | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ n: number; errors: string[] } | null>(null);
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
    <section className="tell panel" aria-labelledby="tell-title">
      <div className="tell-in">
        <div className="tell-copy">
          <h2 id="tell-title" className="tell-title">Tell your team</h2>
          <p className="tell-lede">Say it the way you would to a person. You see exactly what changes before anything is saved.</p>
        </div>
        <form className="tell-form" onSubmit={onSubmit}>
          <label htmlFor="tell-text" className="visually-hidden">Your instruction</label>
          <textarea
            id="tell-text"
            className="field tell-field"
            rows={2}
            value={text}
            placeholder="No emojis on LinkedIn; switch Arjun off till the new site launches"
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
            <button type="submit" className="btn" disabled={!text.trim() || busy !== null || ro}>
              {busy === "preview" ? "Reading…" : "Preview changes"}
            </button>
          </div>
        </form>
      </div>
      {ro && <p className="notice">This is the public demo: settings are read-only.</p>}
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
      {applied && (
        <p className="notice notice-ok" role="status">
          <Icon name="check" size={14} /> Applied {applied.n} {applied.n === 1 ? "change" : "changes"}. The office and the next request follow {applied.n === 1 ? "it" : "them"} now.
          {applied.errors.length > 0 && <> Not applied: {applied.errors.join("; ")}</>}
        </p>
      )}
      {preview && <DiffCard preview={preview} changes={changes} busy={busy === "apply"} onApply={apply} onDiscard={() => setPreview(null)} />}
    </section>
  );
}

function DiffCard({ preview, changes, busy, onApply, onDiscard }: { preview: DirectivePreview; changes: number; busy: boolean; onApply: () => void; onDiscard: () => void }) {
  return (
    <div className="diff-card" aria-labelledby="diff-title">
      <div className="diff-head">
        <h3 id="diff-title" className="diff-title">{changes ? `${changes} ${changes === 1 ? "change" : "changes"} to review` : "Nothing would change"}</h3>
        <span className="diff-parser" title={preview.parser === "rules" ? "Understood by Allevia's rules, no language model" : "The rules read part of it; Haiku read the rest, and every change was checked against your team"}>
          {preview.parser === "rules" ? "Read by rules" : "Rules + Haiku"}
        </span>
      </div>
      <p className="diff-said">“{preview.text}”</p>
      {preview.diff.length > 0 && (
        <ol className="diff-lines">
          {preview.diff.map((d) => <DiffLine key={`${d.patch}-${d.target}`} d={d} />)}
        </ol>
      )}
      {preview.unparsed.length > 0 && (
        <div className="diff-unparsed" role="note">
          <p><Icon name="warn" size={14} /> Not understood, so nothing changes for:</p>
          <ul>{preview.unparsed.map((u) => <li key={u}>“{u}”</li>)}</ul>
          <p className="diff-tip">Try naming the desk (“Tara, …”) or saying on, off, light, or always / never.</p>
        </div>
      )}
      {preview.notes.length > 0 && (
        <ul className="diff-notes" role="note">
          {preview.notes.map((n) => <li key={n}><Icon name="chat" size={14} /> {n}</li>)}
        </ul>
      )}
      <div className="diff-actions">
        <button type="button" className="btn btn-gold" onClick={onApply} disabled={busy || changes === 0}>
          <Icon name="check" size={16} /> {busy ? "Applying…" : changes ? `Apply ${changes} ${changes === 1 ? "change" : "changes"}` : "Apply"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDiscard} disabled={busy}>Discard</button>
        <p className="diff-foot">Saved as your words, with the old settings kept. <Link to="/brain">See it in the brain</Link> after.</p>
      </div>
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
        <code className="diff-target">{d.target}</code>
      </div>
    </li>
  );
}
