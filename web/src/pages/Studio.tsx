// Studio (product design §6, §8): drop a phone photo and a line about it. Tara looks at it (her boxes are drawn on the
// photo), the studio straightens and grades it (option A, free and local) and the AI editor restyles it (option B, quoted
// and shown in Studio credits), Nisha checks both against the original, Dev holds the caption to the brand's voice, and the
// owner approves one. Under the options the owner can ask for a change in their own words (light and colour are free;
// "make it festive", "a different background", "make this into an ad saying ..." use the AI editor), or try again when
// Nisha held an AI edit back. One setting: "Blur people's faces in my content" (off by default).
// The run streams as AgentEvents through the shared run store, so the office shows the content desks at work too.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import type { AgentEvent, AssessmentOverlay } from "@shared/contracts";
import { api, getMode, getPublicMode, type StudioLatest } from "../api";
import { AgentAvatar, agentDef } from "../components/bits";
import { Icon } from "../components/Icon";
import { useApp } from "../state/app";
import { runStore, useRun } from "../state/runs";
import type { NodeDetail } from "../types-ext";
import "./studio.css";

interface Folded {
  originalId?: string;
  assessment?: { verdict: string; overlays: AssessmentOverlay[] };
  variants: string[];
  reviews: Record<string, { verdict: string; note: string }>;
  proposal?: { approvalId: string; title: string };
  log: { agent: string; text: string }[];
  done: boolean;
  error?: string;
  answer?: string;      // the run's last word: for a run that ended without a card, what the owner is told and what to do
}

function fold(events: AgentEvent[]): Folded {
  const f: Folded = { variants: [], reviews: {}, log: [], done: false };
  for (const e of events) {
    if (e.type === "asset") { if (e.kind === "original") f.originalId = e.assetId; else f.variants.push(e.assetId); }
    else if (e.type === "assessment") f.assessment = { verdict: e.verdict, overlays: e.overlays };
    else if (e.type === "review") f.reviews[e.findingId] = { verdict: e.verdict, note: e.note.replace(/^Variant [A-Z]: /, "") };
    else if (e.type === "proposal") f.proposal = { approvalId: e.approvalId, title: e.title };
    else if (e.type === "agent_status") f.log.push({ agent: e.agent, text: e.text });
    else if (e.type === "final") { f.done = true; f.answer = e.answer; }
    else if (e.type === "error") f.error = e.message;
  }
  return f;
}

interface Assessment {
  subject: string; angle: string; lighting: string; clutter: string; resolution: string; verdict: string; coaching?: string;
  salvageable: string[]; locks: string[]; story: string; quality: { tiltDeg: number; exposure: string; cast: string; sharpness: string };
}
interface PayloadVariant { id: string; label: string; badge: string; note: string; aiEdited: boolean; credits?: number; request?: string; canRetry?: boolean }
interface Payload { title: string; body: string; studio: { recommended: string; altText: string; credits: number; notices?: string[]; privacy?: { people: boolean; note: string }; variants: PayloadVariant[] } }

const creditWords = (n: number): string => `about ${Number.isInteger(n) ? n : n.toFixed(1)} Studio credit${n === 1 ? "" : "s"}`;
const CHANGE_IDEAS = ["Make it warmer", "Make it festive", "A different background", "Make it an ad"];

const parse = <T,>(v: unknown): T | null => { try { return typeof v === "string" ? (JSON.parse(v) as T) : null; } catch { return null; } };
const assetSrc = (t: string, id: string, w: number) => `/api/${encodeURIComponent(t)}/assets/${encodeURIComponent(id)}?w=${w}`;

const KIND_LABEL: Record<string, string> = { lock: "Must not change", privacy: "Privacy", clutter: "Clutter", text: "Text" };
const VERDICT_LINE: Record<string, string> = {
  use: "Use as is", enhance: "Enhance: straighten, light and colour", recompose: "Recompose: needs a new crop", reshoot: "Reshoot",
};

export default function StudioPage() {
  const { tenant } = useApp();
  const live = getMode() === "live";
  const [latest, setLatest] = useState<StudioLatest["run"]>(null);
  const [runKey, setRunKey] = useState<string | undefined>();
  const record = useRun(runKey);
  const [sample, setSample] = useState<{ note: string; caption: string; url: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [nodes, setNodes] = useState<Record<string, NodeDetail | null>>({});
  const [chosen, setChosen] = useState<string | null>(null);
  const [caption, setCaption] = useState<string>("");
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState<{ contentId: string; label: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [settings, setSettings] = useState<{ blurFaces: boolean; language: string } | null>(null);
  const [changeText, setChangeText] = useState("");
  const [changing, setChanging] = useState(false);
  const [changeLog, setChangeLog] = useState<string[]>([]);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  const loadLatest = useCallback(async () => {
    try { setLatest((await api.studioLatest(tenant.id)).run); } catch { setLatest(null); }
  }, [tenant.id]);
  useEffect(() => { setRunKey(undefined); setApproved(null); setNodes({}); void loadLatest(); }, [tenant.id, loadLatest]);
  useEffect(() => { let on = true; api.studioSample(tenant.id).then((s) => { if (on) setSample(s); }); return () => { on = false; }; }, [tenant.id]);
  useEffect(() => { let on = true; api.studioSettings(tenant.id).then((x) => { if (on) setSettings(x); }).catch(() => undefined); return () => { on = false; }; }, [tenant.id]);

  const events = record?.events ?? latest?.events ?? [];
  const f = useMemo(() => fold(events), [events]);
  const running = record?.status === "running";

  // the nodes behind the events: the assessment, each variant's treatment and Nisha's numbers, the card
  const [cardVariantIds, setCardVariantIds] = useState<string[]>([]);
  const ids = useMemo(() => [...new Set([f.originalId, ...f.variants, ...cardVariantIds, f.proposal?.approvalId].filter((x): x is string => !!x))], [f.originalId, f.variants, cardVariantIds, f.proposal?.approvalId]);
  const idsKey = `${ids.join("|")}#${refresh}`;
  useEffect(() => {
    if (!ids.length || running) return;
    let on = true;
    Promise.all(ids.map((id) => api.node(tenant.id, id).catch(() => null))).then((list) => {
      if (on) setNodes(Object.fromEntries(ids.map((id, i) => [id, list[i] ?? null])));
    });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, running, tenant.id]);

  const origProps = f.originalId ? nodes[f.originalId]?.props : undefined;
  const assessment = parse<Assessment>(origProps?.assessment);
  const rawPayload = f.proposal ? nodes[f.proposal.approvalId]?.props?.payload : undefined;
  const payload = useMemo(() => parse<Payload>(rawPayload), [rawPayload]);
  const approvalStatus = String(nodes[f.proposal?.approvalId ?? ""]?.props?.status ?? latest?.approval?.status ?? "pending");
  useEffect(() => {
    if (payload) {
      setCaption((c) => c || payload.body);
      setChosen((c) => c ?? (payload.studio.recommended || null));
      setCardVariantIds(payload.studio.variants.map((v) => v.id));
    }
  }, [payload]);
  // the options as the card holds them (a reload shows the ones made later too); while the run is live, the ones streamed so far
  const shownVariants = payload?.studio.variants.length ? payload.studio.variants.map((v) => v.id) : f.variants;
  const decided = approved || (approvalStatus !== "pending" && f.proposal);
  const contentId = approved?.contentId ?? latest?.approval?.contentId ?? null;
  const isSample = !!sample && (record ? record.question === `Studio: ${sample.note}` : latest?.note === sample.note);

  const pick = (fl: File | null | undefined) => {
    if (!fl) return;
    setFile(fl);
    setPreview((p) => { if (p) URL.revokeObjectURL(p); return URL.createObjectURL(fl); });
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); };
  const start = async (photo: Blob, text: string) => {
    setFailure(null); setApproved(null); setNodes({}); setCaption(""); setChosen(null);
    setRunKey(runStore.studio(tenant.id, photo, text));
  };
  const useSample = async () => {
    if (!sample) return;
    const blob = await (await fetch(sample.url)).blob();
    setNote(sample.note);
    setFile(new File([blob], "sample.jpg", { type: "image/jpeg" }));
    setPreview(sample.url);
  };
  useEffect(() => { if (record && record.status !== "running") { void loadLatest(); } }, [record?.status, loadLatest]);
  // A photo the studio refused (a child, people it could not blur) is not kept: the page lets go of its preview too.
  useEffect(() => {
    if (f.done && !f.originalId && f.answer) { setFile(null); setPreview((p) => { if (p) URL.revokeObjectURL(p); return null; }); }
  }, [f.done, f.originalId, f.answer]);

  const approve = async () => {
    if (!f.proposal || !chosen) return;
    setApproving(true); setFailure(null);
    try {
      const r = await api.studioApprove(tenant.id, { approvalId: f.proposal.approvalId, variantId: chosen, caption });
      const label = payload?.studio.variants.find((v) => v.id === chosen)?.label ?? "";
      setApproved({ contentId: r.contentId, label });
      await loadLatest();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setApproving(false);
    }
  };

  const toggleBlur = async (on: boolean) => {
    try { setSettings(await api.studioSetSettings(tenant.id, { blurFaces: on })); } catch (e) { setFailure((e as Error).message); }
  };

  // A change in the owner's words (or "try again" on a held-back AI edit): streamed, then the card is read again.
  const askChange = async (instruction: string, retryOf?: string) => {
    if (!f.proposal || (!instruction.trim() && !retryOf) || changing) return;
    setChanging(true); setChangeLog([]); setChangeNote(null); setFailure(null);
    let made: { id: string; ok: boolean } | null = null;
    try {
      await api.studioRevise(tenant.id, { approvalId: f.proposal.approvalId, ...(retryOf ? { retryOf } : { instruction: instruction.trim() }) }, (e) => {
        if (e.type === "agent_status") setChangeLog((l) => [...l.slice(-4), e.text]);
        else if (e.type === "asset" && e.kind === "variant") made = { id: e.assetId, ok: false };
        else if (e.type === "review" && made) made = { ...made, ok: e.verdict === "ok" };
        else if (e.type === "final") setChangeNote(e.answer);
        else if (e.type === "error") setChangeNote(e.message);
      });
      setChangeText("");
      setRefresh((n) => n + 1);
      const m = made as { id: string; ok: boolean } | null;
      if (m?.ok) setChosen(m.id);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setChanging(false);
    }
  };

  const hasRun = !!f.originalId;
  return (
    <div className="studio-page">
      <header className="studio-head">
        <p className="studio-eyebrow"><Icon name="sparkle" size={14} /> Content Studio</p>
        <h1 className="page-title">A phone photo, made into a post</h1>
        <p className="studio-lede">
          Tara reads the photo and marks what must not change. You get two options: a free clean-up, and an AI edit styled for your
          business (the price is said first). Nisha checks both against the original before you see them.
        </p>
        <label className="studio-setting">
          <input type="checkbox" checked={!!settings?.blurFaces} disabled={!settings || !live || getPublicMode()} onChange={(e) => void toggleBlur(e.target.checked)} />
          <span>Blur people's faces in my content</span>
          <small>Off: people in your photos are kept as they are.</small>
        </label>
        {hasRun && !running && (
          <button type="button" className="btn btn-ghost btn-sm studio-new" onClick={() => {
            setLatest(null); setRunKey(undefined); setFile(null); setPreview(null); setNote(""); setApproved(null); setNodes({}); setCaption(""); setChosen(null);
          }}>
            <Icon name="plus" size={14} /> New photo
          </button>
        )}
        {hasRun && !running && events.length > 0 && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => {
            runStore.replay(tenant.id, f.originalId!, latest?.note ? `Studio: ${latest.note}` : "Studio", events, { paced: true });
            nav("/");
          }}>
            <Icon name="replay" size={14} /> Watch the team do it in the office
          </button>
        )}
      </header>

      <div className="studio-grid">
        <section className="studio-col" aria-label="The photo">
          {(!hasRun || file) && !running && (
            <div className={`drop${preview ? " has-photo" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
              {preview ? <img src={preview} alt="The photo you picked" className="drop-preview" /> : (
                <button type="button" className="drop-cta" onClick={() => inputRef.current?.click()} disabled={!live}>
                  <Icon name="plus" size={22} />
                  <span>Drop a photo here, or choose one</span>
                  <small>JPEG, PNG or WebP. Location data is removed on arrival.</small>
                </button>
              )}
              <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
              <label className="drop-note">
                <span>A line about it</span>
                <textarea rows={2} value={note} maxLength={500} placeholder="Which project, what you love about it" onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="drop-actions">
                <button type="button" className="btn btn-gold" disabled={!file || !live || getPublicMode()} onClick={() => file && start(file, note)}>
                  Send to Tara
                </button>
                {preview && <button type="button" className="btn btn-ghost" onClick={() => { setFile(null); setPreview(null); }}>Choose another</button>}
                {!preview && sample && <button type="button" className="btn btn-ghost" onClick={useSample}>Use the demo photo</button>}
              </div>
              {!live && <p className="studio-note">The Studio runs on the live server; this is the offline demo.</p>}
            </div>
          )}

          {hasRun && (
            <figure className="orig">
              <div className="orig-frame">
                <img src={assetSrc(tenant.id, f.originalId!, 1200)} alt="The owner's photo, as sent" />
                {showBoxes && f.assessment && (
                  <svg className="orig-boxes" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    {f.assessment.overlays.map((o, i) => (
                      <rect key={i} className={`box box-${o.kind}`} x={o.x * 100} y={o.y * 100} width={o.w * 100} height={o.h * 100} vectorEffect="non-scaling-stroke" />
                    ))}
                  </svg>
                )}
                {showBoxes && f.assessment?.overlays.map((o, i) => (
                  <span key={i} className={`box-tag box-tag-${o.kind}`}
                    style={o.x + o.w > 0.8 ? { right: `${(1 - o.x - o.w) * 100}%`, top: `${o.y * 100}%` } : { left: `${o.x * 100}%`, top: `${o.y * 100}%` }}>
                    {KIND_LABEL[o.kind] ?? o.kind}
                  </span>
                ))}
              </div>
              <figcaption>
                <span>{isSample ? sample!.caption : "Your photo, as sent (location data removed)."}</span>
                {f.assessment && (
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setShowBoxes((s) => !s)} aria-pressed={showBoxes}>
                    {showBoxes ? "Hide" : "Show"} Tara's boxes
                  </button>
                )}
              </figcaption>
            </figure>
          )}

          {f.assessment && (
            <article className="card tara">
              <header className="card-head">
                <AgentAvatar id="content-strategist" size={30} />
                <div><b>Tara</b><span>Content Strategist · her read of the photo</span></div>
                <span className={`verdict verdict-${f.assessment.verdict}`}>{VERDICT_LINE[f.assessment.verdict] ?? f.assessment.verdict}</span>
              </header>
              {assessment ? (
                <>
                  <p className="tara-subject">{assessment.subject}</p>
                  <dl className="facts">
                    <dt>Angle</dt><dd>{assessment.angle}</dd>
                    <dt>Light</dt><dd>{assessment.lighting}</dd>
                    <dt>Clutter</dt><dd>{assessment.clutter}</dd>
                    <dt>Size</dt><dd>{assessment.resolution}</dd>
                    {origProps?.tiltDeg !== undefined && (
                      <><dt>Level</dt><dd>
                        Straightened by {Math.abs(Number(origProps.tiltDeg)).toFixed(1)}°, measured from the photo's own edges
                        {origProps.tiltSource === "edges" && assessment.quality.tiltDeg !== Number(origProps.tiltDeg) ? ` (Tara read it as ${assessment.quality.tiltDeg ? `${assessment.quality.tiltDeg}°` : "level"})` : ""}.
                      </dd></>
                    )}
                  </dl>
                  <div className="lists">
                    <div><h3>Worth keeping</h3><ul>{assessment.salvageable.map((s) => <li key={s}>{s}</li>)}</ul></div>
                    <div><h3>Must not change</h3><ul>{assessment.locks.map((s) => <li key={s}>{s}</li>)}</ul></div>
                  </div>
                  {assessment.coaching && <p className="coaching"><Icon name="pen" size={14} /> Next time: {assessment.coaching}</p>}
                </>
              ) : <p className="muted small">Loading Tara's notes…</p>}
            </article>
          )}
        </section>

        <section className="studio-col" aria-label="Variants and approval">
          {(running || (hasRun && !f.done)) && (
            <ol className="worklog" aria-live="polite">
              {f.log.slice(-6).map((l, i) => (
                <li key={i}><AgentAvatar id={l.agent} size={20} /><span><b>{agentDef(l.agent)?.name}</b> {l.text}</span></li>
              ))}
              {running && <li className="worklog-live"><span className="dot" aria-hidden="true" /> working…</li>}
            </ol>
          )}
          {record?.status === "error" && <p className="studio-error" role="alert"><Icon name="warn" size={16} /> {record.error}</p>}
          {f.done && !f.proposal && f.answer && (
            <p className="studio-stop" role="status"><Icon name="warn" size={16} /> {f.answer}</p>
          )}

          {shownVariants.length > 0 && (
            <div className="variants" role="radiogroup" aria-label="Pick the version to post">
              {shownVariants.map((id) => {
                const props = nodes[id]?.props ?? {};
                const label = String(props.label ?? "");
                const card = payload?.studio.variants.find((v) => v.id === id);
                const review = f.reviews[id];
                const badge = card?.badge ?? (review ? (review.verdict === "ok" ? "unchanged" : "changed") : "pending");
                const ok = badge === "unchanged";
                const ai = card?.aiEdited ?? props.aiEdited === true;
                const credits = card?.credits ?? (typeof props.hfCredits === "number" ? props.hfCredits : undefined);
                const pick = payload?.studio.recommended === id;
                return (
                  <label key={id} className={`variant${chosen === id ? " is-chosen" : ""}${ok ? "" : " is-held"}`}>
                    <input type="radio" name="variant" value={id} checked={chosen === id} disabled={!ok || !!decided} onChange={() => setChosen(id)} />
                    <span className="variant-img"><img src={assetSrc(tenant.id, id, 720)} alt={`Option ${label}`} loading="lazy" /></span>
                    <span className="variant-head">
                      <b>{label || "…"}</b>
                      <span>{ai ? `AI edit${props.recorded === true ? " · made earlier" : credits !== undefined ? ` · ${creditWords(credits)}` : ""}` : "Free clean-up · no credits"}</span>
                      {ai && <span className="ai-tag">AI-edited</span>}
                      {pick && <span className="pick-tag">Our pick</span>}
                    </span>
                    <span className={`badge badge-${badge}`}>
                      <Icon name={ok ? "check" : badge === "pending" ? "clock" : "x"} size={14} />
                      {ok ? "Building unchanged" : badge === "pending" ? "Nisha is checking" : badge === "unchecked" ? "Not checked" : "Held back"}
                    </span>
                    {card?.request && <span className="variant-treat">You asked: {card.request}</span>}
                    {(review || card?.note) && <span className="variant-note">{(card?.note ?? review?.note ?? "").replace(/^Building unchanged · /, "").replace(/^Changed: /, "")}</span>}
                    {props.structure !== undefined && (
                      <span className="variant-nums">edges {Number(props.structure).toFixed(2)} · dHash {String(props.dhashDistance)}/64</span>
                    )}
                    {props.treatment !== undefined && <span className="variant-treat">{String(props.treatment)}</span>}
                    {card?.canRetry && !decided && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={changing || getPublicMode()} onClick={(e) => { e.preventDefault(); void askChange("", label); }}>
                        Try again{credits !== undefined ? ` (${creditWords(credits)})` : ""}
                      </button>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {f.done && payload && !decided && (
            <section className="card change" aria-label="Ask for a change">
              <header className="card-head"><div><b>Want it different?</b><span>Say it in your own words. Light and colour are free; bigger changes use the AI editor and the price is shown.</span></div></header>
              <div className="change-ideas">
                {CHANGE_IDEAS.map((idea) => (
                  <button key={idea} type="button" className="btn btn-quiet btn-sm" disabled={changing} onClick={() => setChangeText(idea === "Make it an ad" ? "Make this into an ad saying " : idea)}>{idea}</button>
                ))}
              </div>
              <form className="change-row" onSubmit={(e) => { e.preventDefault(); void askChange(changeText); }}>
                <input type="text" value={changeText} maxLength={400} disabled={changing || getPublicMode()} placeholder="For example: make it festive, or remove the pole"
                  aria-label="What would you like changed?" onChange={(e) => setChangeText(e.target.value)} />
                <button type="submit" className="btn btn-gold btn-sm" disabled={changing || !changeText.trim() || getPublicMode()}>{changing ? "Working…" : "Make it"}</button>
              </form>
              {changing && changeLog.length > 0 && <ol className="worklog" aria-live="polite">{changeLog.map((l, i) => <li key={i}><span>{l}</span></li>)}</ol>}
              {changeNote && !changing && <p className="studio-note" role="status">{changeNote}</p>}
            </section>
          )}

          {f.done && payload && (
            <article className="card approve">
              <header className="card-head">
                <AgentAvatar id="copy-editor" size={30} />
                <div><b>Dev</b><span>Brand &amp; Copy Editor · the caption, held to the voice rules</span></div>
              </header>
              <label className="caption-field">
                <span className="visually-hidden">Caption</span>
                <textarea rows={6} value={caption} disabled={!!decided} onChange={(e) => setCaption(e.target.value)} />
              </label>
              <p className="alt"><b>Alt text</b> {payload.studio.altText}</p>
              {payload.studio.privacy && <p className="studio-stop" role="note"><Icon name="warn" size={16} /> {payload.studio.privacy.note}</p>}
              {(payload.studio.notices ?? []).map((n) => <p key={n} className="studio-note" role="note">{n}</p>)}
              {decided ? (
                <p className="approved" role="status">
                  <Icon name="check" size={16} /> Approved{approved?.label ? ` variant ${approved.label}` : ""}: saved as a draft post, not published.
                  {contentId && <code>{contentId}</code>}
                </p>
              ) : (
                <div className="approve-row">
                  <button type="button" className="btn btn-gold" disabled={!chosen || approving || getPublicMode()} onClick={approve}>
                    {approving ? "Saving…" : `Approve variant ${payload.studio.variants.find((v) => v.id === chosen)?.label ?? ""}`}
                  </button>
                  <span className="credit">Saved as a draft: nothing is posted until you do it</span>
                </div>
              )}
              {failure && <p className="studio-error" role="alert">{failure}</p>}
            </article>
          )}

          {!hasRun && !running && (
            <div className="studio-empty">
              <span className="studio-avatars" aria-hidden="true">
                {["content-strategist", "fact-checker", "copy-editor"].map((a) => <AgentAvatar key={a} id={a} size={34} />)}
              </span>
              <p>Tara, Nisha and Dev are ready. Your photo stays yours: nothing is posted until you approve it, and a rejected draft costs nothing.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
