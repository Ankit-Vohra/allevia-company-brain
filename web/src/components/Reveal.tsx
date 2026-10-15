// Progressive disclosure, the way Claude shows its thinking: one quiet line that opens to the detail. The answer and
// the next action stay on the page; the process, the evidence and anything technical sit behind a Reveal.
import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export function Reveal({
  label, openLabel, summary, children, defaultOpen = false, open: controlled, onToggle, className, tone = "quiet",
}: {
  /** What the closed line says, e.g. "Show how the team worked". */
  label: ReactNode;
  /** What it says once open (defaults to `label`). */
  openLabel?: ReactNode;
  /** A short muted note after the label, e.g. "4 staff · 32 s". */
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
  /** "quiet" is a text line; "row" is a full-width row with a hairline, for lists of sections. */
  tone?: "quiet" | "row";
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const id = useId();
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setOwn(next);
    onToggle?.(next);
  };
  return (
    <div className={`reveal reveal-${tone}${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
      <button type="button" className="reveal-btn" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <Icon name="chevron-right" size={14} className="reveal-chevron" />
        <span className="reveal-label">{open ? openLabel ?? label : label}</span>
        {summary && <span className="reveal-summary">{summary}</span>}
      </button>
      {open && (
        <div className="reveal-body" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}
