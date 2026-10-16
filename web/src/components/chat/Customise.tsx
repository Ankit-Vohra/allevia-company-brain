// Customise one person from their chat: on or resting, how busy, how much they do without asking, their tone, what you told
// them, and which skills they may use. Everything goes through the same settings and "Tell your team" routes as the Team
// page (a sentence is previewed as a diff before it is saved), so the office and Discord see the same change.
import { useEffect, useId, useRef, useState } from "react";
import type { AgentMode, DirectivePreview } from "@shared/contracts";
import { api, getPublicMode, type AgentPatch } from "../../api";
import { TONES, toneDirective, type Tone } from "../../lib/chat";
import { fmtDate } from "../../lib/format";
import { DiffCard } from "../../pages/Team";
import type { AgentView } from "../../types-ext";
import { AgentAvatar } from "../bits";
import { Icon } from "../Icon";
import { Reveal } from "../Reveal";

const MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: "full", label: "Fully on", hint: "Works on every request they are needed for" },
  { id: "light", label: "Light touch", hint: "Fewer, shorter checks. Good for a quiet season" },
];
const AUTONOMY = [
  { level: 0, short: "Drafts", long: "Drafts only. Nothing goes out without your yes." },
  { level: 1, short: "Schedules", long: "Schedules what you approved, at the right time." },
  { level: 2, short: "Publishes", long: "Publishes on their own and tells you after, in a short note." },
  { level: 3, short: "Acts", long: "Acts on their own, within the limits you set." },
];

export function Customise({ agent: a, tenantId, open, onClose, onPatch, onChanged }: {
  agent: AgentView; tenantId: string; open: boolean; onClose: () => void;
  onPatch: (p: AgentPatch) => Promise<void>; onChanged: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const ro = getPublicMode();
  const chief = a.id === "chief-of-staff";
  const mode: AgentMode = a.enabled ? a.mode : "off";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<DirectivePreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => { setPreview(null); setText(""); setSaved(null); setError(null); }, [a.id, tenantId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || "That did not save. Try again."); } finally { setBusy(false); }
  };
  const patch = (p: AgentPatch) => run(() => onPatch(p));

  const read = (sentence: string) => run(async () => {
    setSaved(null);
    setPreview(await api.previewDirective(tenantId, sentence));
  });
  const say = () => {
    const t = text.trim();
    if (!t) return;
    void read(t.toLowerCase().startsWith(a.name.toLowerCase()) ? t : `${a.name}, ${t.charAt(0).toLowerCase()}${t.slice(1)}`);
  };
  const apply = async () => {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const out = await api.applyDirective(tenantId, preview.id);
      const n = out.diff.filter((d) => d.op !== "same").length;
      setSaved(`Done. ${n} ${n === 1 ? "change" : "changes"} saved, and ${a.name} follows ${n === 1 ? "it" : "them"} from now on.`);
      setPreview(null);
      setText("");
      onChanged();
    } catch (e) {
      setError((e as Error).message || "That did not apply.");
    } finally {
      setSaving(false);
    }
  };
  const tone = (t: Tone) => void read(toneDirective(a.name, t));

  const skills = a.skills ?? [];
  const off = new Set(a.skillsOff ?? []);
  const toggleSkill = (id: string, on: boolean) => {
    if (on) off.delete(id); else off.add(id);
    return patch({ skillsOff: [...off] });
  };
  const changes = preview?.diff.filter((d) => d.op !== "same").length ?? 0;

  return (
    <dialog ref={ref} className="drawer ct-custom" aria-labelledby={`${uid}-t`} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <header className="ct-custom-head">
        <AgentAvatar id={a.id} size={40} />
        <div>
          <h2 id={`${uid}-t`}>Customise {a.name}</h2>
          <p>{a.title}. What you change here changes the office and Discord too.</p>
        </div>
        <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>

      <div className="ct-custom-body">
        {ro && <p className="notice tell-note">This is the public demo, so settings are view-only.</p>}

        <section className="ct-set">
          <div className="ct-set-row">
            <div>
              <h3 className="tm-label" id={`${uid}-on`}>{a.name} is {mode === "off" ? "resting" : "working for you"}</h3>
              <p className="tm-help">{chief ? `${a.name} plans every request and writes every answer, so ${a.name} can't rest.` : mode === "off" ? `While resting, ${a.name} sits out of every plan.` : "Switch off to let them rest."}</p>
            </div>
            <button
              type="button" role="switch" aria-checked={mode !== "off"} aria-labelledby={`${uid}-on`} className="tm-switch"
              disabled={busy || ro || (chief && mode !== "off")} onClick={() => patch({ mode: mode === "off" ? "full" : "off" })}
            ><span className="tm-switch-knob" /></button>
          </div>
        </section>

        <section className="ct-set" aria-labelledby={`${uid}-mode`}>
          <h3 className="tm-label" id={`${uid}-mode`}>How busy {a.name} is</h3>
          <div className="tm-choices" role="radiogroup" aria-labelledby={`${uid}-mode`}>
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`tm-choice${mode === m.id ? " is-on" : ""}`}
                disabled={busy || ro || mode === "off"} title={m.hint} onClick={() => mode !== m.id && patch({ mode: m.id })}>{m.label}</button>
            ))}
          </div>
          <p className="tm-help">{MODES.find((m) => m.id === mode)?.hint ?? "Resting."}</p>
        </section>

        <section className="ct-set" aria-labelledby={`${uid}-aut`}>
          <h3 className="tm-label" id={`${uid}-aut`}>How much {a.name} does without asking</h3>
          <div className="tm-choices" role="radiogroup" aria-labelledby={`${uid}-aut`}>
            {AUTONOMY.map((l) => (
              <button key={l.level} type="button" role="radio" aria-checked={a.autonomy === l.level} className={`tm-choice${a.autonomy === l.level ? " is-on" : ""}`}
                disabled={busy || ro || !a.enabled} title={l.long} onClick={() => a.autonomy !== l.level && patch({ autonomy: l.level })}>{l.short}</button>
            ))}
          </div>
          <p className="tm-help">{AUTONOMY[Math.max(0, Math.min(3, a.autonomy))]!.long}</p>
        </section>

        <section className="ct-set" aria-labelledby={`${uid}-tone`}>
          <h3 className="tm-label" id={`${uid}-tone`}>How {a.name} sounds</h3>
          <div className="tm-choices">
            {TONES.map((t) => <button key={t.id} type="button" className="tm-choice" disabled={busy || ro} onClick={() => tone(t)}>{t.label}</button>)}
          </div>
          <p className="tm-help">Pick one and you will see exactly what is saved before anything changes.</p>
        </section>

        <section className="ct-set" aria-labelledby={`${uid}-ins`}>
          <h3 className="tm-label" id={`${uid}-ins`}>What you told {a.name}</h3>
          {a.instructions.length ? (
            <ul className="tm-instructions">
              {a.instructions.map((i) => (
                <li key={i.id}>
                  <span>{i.text}{i.channel && <span className="tm-channel">{i.channel}</span>}</span>
                  {i.at && <span className="tm-when">{fmtDate(new Date(i.at).toISOString())}</span>}
                </li>
              ))}
            </ul>
          ) : <p className="tm-help">Nothing yet.</p>}
          {!ro && (
            <form className="ct-tell" onSubmit={(e) => { e.preventDefault(); say(); }}>
              <label htmlFor={`${uid}-say`} className="visually-hidden">Tell {a.name} something</label>
              <textarea id={`${uid}-say`} className="field" rows={2} value={text} placeholder={`Tell ${a.name} something, like "always mention the free first visit"`}
                onChange={(e) => { setText(e.target.value); if (preview) setPreview(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); say(); } }} />
              <button type="submit" className="btn btn-ghost btn-sm" disabled={!text.trim() || busy}>Preview</button>
            </form>
          )}
          {saved && <p className="notice notice-ok" role="status"><Icon name="check" size={14} /> {saved}</p>}
          {preview && <DiffCard preview={preview} changes={changes} busy={saving} onApply={apply} onDiscard={() => setPreview(null)} />}
        </section>

        {skills.length > 0 && (
          <section className="ct-set">
            <Reveal label={`Skills ${a.name} may use`} summary={`${skills.length - off.size} of ${skills.length} on`} defaultOpen>
              <ul className="ct-skills">
                {skills.map((s) => {
                  const on = !off.has(s.id);
                  return (
                    <li key={s.id}>
                      <div>
                        <p className="ct-skill-name">{s.name}{s.source === "business" && <span className="tm-channel">your own</span>}</p>
                        <p className="tm-help">{s.makes ? `Makes ${s.makes}.` : "Looks and explains; makes nothing."}{s.needsOk ? " Waits for your OK." : ""}</p>
                      </div>
                      <button type="button" role="switch" aria-checked={on} aria-label={`${s.name}: ${on ? "on" : "off"}`} className="tm-switch" disabled={busy || ro} onClick={() => void toggleSkill(s.id, !on)}>
                        <span className="tm-switch-knob" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Reveal>
          </section>
        )}
        {error && <p className="notice notice-bad" role="alert">{error}</p>}
      </div>
    </dialog>
  );
}
