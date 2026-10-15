// A small hover-and-focus tooltip. It is positioned `fixed` from the trigger's box, so a scrolling panel never clips it,
// and it flips below the trigger when there is no room above.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function Tip({ tip, children, className, as: Tag = "span" }: { tip: ReactNode; children: ReactNode; className?: string; as?: "span" | "li" }) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current || !tipRef.current) return;
    const r = ref.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const below = r.top - t.height - 8 < 8;
    const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
    setPos({ left, top: below ? r.bottom + 8 : r.top - t.height - 8, below });
  }, [open]);

  const show = () => setOpen(true);
  const hide = () => { setOpen(false); setPos(null); };
  return (
    <Tag
      ref={ref as never}
      className={`tip-anchor${className ? ` ${className}` : ""}`}
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => { if (e.key === "Escape") hide(); }}
    >
      {children}
      {open && (
        <span
          ref={tipRef}
          id={id}
          role="tooltip"
          className={`tip${pos?.below ? " is-below" : ""}`}
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
        >
          {tip}
        </span>
      )}
    </Tag>
  );
}
