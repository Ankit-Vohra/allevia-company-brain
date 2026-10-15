import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "../api";
import type { NumbersImportResult, NumbersPlan, NumbersPlanColumn, NumbersPreview } from "../types-ext";
import { Icon } from "./Icon";
import "./numbers.css";

// "Add your numbers": the owner drops a spreadsheet and we say what we found in plain words ("This looks like weekly
// enquiries, from 6 Jul to 11 Oct. OK?"). Nothing is decided for them: every column shows our guess with a way to change
// it, and a column we cannot name has to be answered before OK works. The file is sent twice (to look at, then to keep)
// so the server holds nothing in between.
type Phase = "pick" | "reading" | "review" | "saving" | "done";

interface Props {
  tenantId: string;
  /** Called once numbers were added, so the plan can reload. */
  onDone: () => void;
  onClose: () => void;
}

const ACCEPT = ".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ask = (c: NumbersPlanColumn): string => (c.metric === null ? "" : c.metric);

export function NumbersUpload({ tenantId, onDone, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("pick");
  const [file, setFile] = useState<File | undefined>();
  const [preview, setPreview] = useState<NumbersPreview | undefined>();
  const [plan, setPlan] = useState<NumbersPlan | undefined>();
  const [result, setResult] = useState<NumbersImportResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const read = async (f: File) => {
    setFile(f);
    setError(undefined);
    setPhase("reading");
    try {
      const p = await api.previewNumbers(tenantId, f);
      setPreview(p);
      setPlan(p.plan);
      setPhase("review");
    } catch (e) {
      setError((e as Error)?.message ?? "We couldn't read that file. Try another.");
      setPhase("pick");
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void read(f);
  };

  const setColumn = (index: number, patch: Partial<NumbersPlanColumn>) =>
    setPlan((p) => p && ({ ...p, columns: p.columns.map((c) => (c.index === index ? { ...c, ...patch } : c)) }));

  const unanswered = !!plan && (plan.cadence === null || plan.columns.some((c) => c.metric === null || (c.metric === "other" && !(c.label ?? "").trim())));
  const nothingKept = !!plan && plan.columns.every((c) => c.metric === "skip");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !plan || unanswered || nothingKept) return;
    setError(undefined);
    setPhase("saving");
    try {
      const r = await api.importNumbers(tenantId, file, plan);
      setResult(r);
      setPhase("done");
      onDone();
    } catch (err) {
      setError((err as Error)?.message ?? "That didn't save. Try again.");
      setPhase("review");
    }
  };

  const columns = preview?.columns ?? [];
  const headers = preview ? [preview.dateColumn.header, ...columns.map((c) => c.header)] : [];

  return (
    <section className="numbers" aria-label="Add your numbers">
      <header className="numbers-head">
        <h3 className="numbers-title">Add your numbers</h3>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>Close</button>
      </header>

      {(phase === "pick" || phase === "reading") && (
        <>
          <p className="numbers-lede">Drop a spreadsheet of your own numbers, with a row for each day or week: visits, orders, enquiries, sales. We only need the dates and the numbers.</p>
          <div
            className={`numbers-drop${over ? " is-over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
            aria-busy={phase === "reading" ? "true" : undefined}
          >
            <Icon name="file" size={18} />
            <p>{phase === "reading" ? `Reading ${file?.name ?? "your file"}...` : "Drop a .csv or .xlsx file here"}</p>
            {phase === "pick" && <button type="button" className="btn btn-gold btn-sm" onClick={() => input.current?.click()}>Choose a file</button>}
            <input ref={input} type="file" accept={ACCEPT} className="visually-hidden" aria-label="Choose a spreadsheet" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ""; }} />
          </div>
          <p className="numbers-quiet">Your file is read here and only the numbers are kept. Files with names, emails or phone numbers are turned away.</p>
        </>
      )}

      {(phase === "review" || phase === "saving") && preview && plan && (
        <form onSubmit={save} className="numbers-review">
          <p className="numbers-headline">{preview.headline}</p>
          {preview.feedsGoals?.length ? <p className="numbers-feeds">This fills in: {preview.feedsGoals.map((g) => g.name).join(", ")}.</p> : null}
          {preview.sentences.length > 0 && <ul className="numbers-notes">{preview.sentences.map((s) => <li key={s}>{s}</li>)}</ul>}

          {preview.questions.includes("date_order") && (
            <label className="numbers-ask">
              <span>Dates are written</span>
              <select value={plan.dateOrder} onChange={(e) => setPlan({ ...plan, dateOrder: e.target.value === "mdy" ? "mdy" : "dmy" })} disabled={phase === "saving"}>
                <option value="dmy">day, then month (5 Oct)</option>
                <option value="mdy">month, then day (Oct 5)</option>
              </select>
            </label>
          )}
          {preview.cadence === null && (
            <label className="numbers-ask">
              <span>Each row is</span>
              <select value={plan.cadence ?? ""} onChange={(e) => setPlan({ ...plan, cadence: e.target.value === "" ? null : (e.target.value as NumbersPlan["cadence"]) })} disabled={phase === "saving"}>
                <option value="">Pick one...</option>
                <option value="day">a day</option>
                <option value="week">a week</option>
                <option value="month">a month</option>
              </select>
            </label>
          )}
          {plan.cadence === "week" && (
            <label className="numbers-ask">
              <span>The date is the</span>
              <select value={plan.weekAnchor} onChange={(e) => setPlan({ ...plan, weekAnchor: e.target.value === "end" ? "end" : "start" })} disabled={phase === "saving"}>
                <option value="start">first day of the week</option>
                <option value="end">last day of the week</option>
              </select>
            </label>
          )}

          <ul className="numbers-cols">
            {columns.map((c) => {
              const pc = plan.columns.find((x) => x.index === c.index);
              if (!pc) return null;
              const unsure = pc.metric !== null && pc.metric === c.guess.metric && !c.guess.sure;
              return (
                <li key={c.index} className={`numbers-col${pc.metric === null ? " needs-answer" : ""}`}>
                  <span className="numbers-col-name">Column {c.letter}, “{c.header}”{c.sample.length ? <span className="numbers-col-sample"> ({c.sample.join(", ")}…)</span> : null}</span>
                  <label className="numbers-col-pick">
                    <span className="visually-hidden">What column {c.letter} is</span>
                    <select value={ask(pc)} onChange={(e) => setColumn(c.index, { metric: e.target.value === "" ? null : e.target.value })} disabled={phase === "saving"}>
                      <option value="">Pick what this is...</option>
                      {preview.metricOptions.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                      <option value="other">Something else (name it)</option>
                      <option value="skip">Leave this out</option>
                    </select>
                  </label>
                  {pc.metric === "other" && (
                    <input className="numbers-input" aria-label={`What to call column ${c.letter}`} placeholder="For example: Pints sold" maxLength={60} value={pc.label ?? ""} onChange={(e) => setColumn(c.index, { label: e.target.value })} disabled={phase === "saving"} />
                  )}
                  {unsure && <span className="numbers-hint">Not sure about this one. Change it if it's wrong.</span>}
                </li>
              );
            })}
          </ul>

          {preview.sampleRows.length > 0 && (
            <div className="numbers-sample" role="region" aria-label="The first rows of your file" tabIndex={0}>
              <table>
                <thead><tr>{headers.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
                <tbody>{preview.sampleRows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}

          {error && <p className="notice notice-bad" role="alert">{error}</p>}
          <div className="numbers-actions">
            <button type="submit" className="btn btn-gold btn-sm" disabled={unanswered || nothingKept || phase === "saving"}><Icon name="check" size={14} /> {phase === "saving" ? "Adding..." : "OK, add these"}</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setPhase("pick"); setPreview(undefined); setPlan(undefined); setError(undefined); }} disabled={phase === "saving"}>Choose another file</button>
            {unanswered && <span className="numbers-hint">Answer the highlighted questions first.</span>}
          </div>
        </form>
      )}

      {phase === "done" && result && (
        <div className="numbers-done">
          <p className="numbers-headline">{result.status === "imported" ? "Added. Here's what changed." : "Nothing new to add."}</p>
          <ul className="numbers-notes">{result.sentences.map((s) => <li key={s}>{s}</li>)}</ul>
          <div className="numbers-actions"><button type="button" className="btn btn-gold btn-sm" onClick={onClose}>Done</button></div>
        </div>
      )}

      {error && phase === "pick" && <p className="notice notice-bad" role="alert">{error}</p>}
    </section>
  );
}
