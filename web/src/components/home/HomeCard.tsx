// Home's building blocks. Home is a short list of cards; each card is one calm block with a title and a "See all" link one tap
// deeper into its full page. A card is described by a HomeCardDef and placed by `column` and `order`, so another area (Sales,
// #41) adds its own card by adding one entry to HOME_CARDS in pages/Home.tsx, with no change to the layout.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "../Icon";

export interface HomeCardProps {
  /** The card's id: its heading's id, and a stable hook for tests. */
  id: string;
  title: ReactNode;
  /** A small figure beside the title (how many are waiting, how many are connected). */
  count?: number;
  /** Where "See all" goes: the card's full page. */
  to: string;
  /** What "See all" says, when "See all" is not right ("Open the office"). */
  toLabel?: string;
  /** A quiet class for the whole card ("is-calm" when there is nothing to do). */
  tone?: "calm";
  busy?: boolean;
  children: ReactNode;
}

export function HomeCard({ id, title, count, to, toLabel = "See all", tone, busy, children }: HomeCardProps) {
  return (
    <section className={`hm-card${tone ? ` is-${tone}` : ""}`} aria-labelledby={`hm-${id}-h`} aria-busy={busy || undefined} data-home-card={id}>
      <header className="hm-card-head">
        <h2 id={`hm-${id}-h`} className="hm-card-title">
          {title}
          {count !== undefined && count > 0 && <span className="count" aria-label={`${count}`}>{count}</span>}
        </h2>
        <Link to={to} className="hm-card-link">{toLabel}<Icon name="chevron-right" size={14} /></Link>
      </header>
      {children}
    </section>
  );
}

/** A grey line while a card loads. */
export function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return <div className="hm-skel" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton" />)}</div>;
}
