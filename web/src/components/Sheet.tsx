// The full thing behind a compact row: a side sheet on a wide screen, a bottom sheet on a phone. List pages stay one line per
// item (a draft, an idea) and the detail opens here. A native <dialog>: Escape closes it, focus stays inside, the page behind
// is inert, and a tap outside closes it too. The body renders only while open.
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import "./sheet.css";

export function Sheet({ open, onClose, label, children }: {
  open: boolean;
  onClose: () => void;
  /** What a screen reader hears for the sheet ("Draft 3 reels"). */
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" aria-label={label} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="sheet-top">
        <span className="sheet-grip" aria-hidden="true" />
        <button type="button" className="btn btn-quiet btn-icon sheet-close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </div>
      {open && <div className="sheet-body">{children}</div>}
    </dialog>
  );
}
