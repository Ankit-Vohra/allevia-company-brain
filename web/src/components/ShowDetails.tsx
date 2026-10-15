// One quiet "Show details" expander (the owner-first rule: the essentials up top in plain words, the process and the
// fine print one click away). A native <details>, so it works with the keyboard and screen readers as it is; the
// children render only once it is open.
import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import "./show-details.css";

export function ShowDetails({ children, label = "Show details", openLabel = "Hide details" }: { children: ReactNode; label?: string; openLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="show-details" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="show-details-btn">
        <Icon name="chevron-right" size={14} className="show-details-chev" />
        {open ? openLabel : label}
      </summary>
      {open && <div className="show-details-body">{children}</div>}
    </details>
  );
}
