// "Needs your OK", on Home: the first three drafts as compact rows (what it is, who made it, how big), each with OK and Look.
// Look opens the whole draft in a sheet with Approve, Change and No thanks: the same call as the Approvals page and the Discord
// buttons (POST /api/:t/approvals/:id), so an edit becomes a habit the team keeps on every door. The rest wait on Approvals.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { getPublicMode } from "../../api";
import { type Group, splitOlder } from "../../lib/group";
import { firstFew, plainTitle, type WaitingItem } from "../../lib/home";
import type { Approval, Tenant } from "../../types-ext";
import { ApprovalRow, Decided } from "../approval/ApprovalRow";
import { decideDraft, type Done, type Payload } from "../approval/decide";
import { DraftView } from "../approval/Draft";
import { Icon } from "../Icon";
import { Sheet } from "../Sheet";

export function NeedsOk({ tenant, groups, stakes, loading, error }: {
  tenant: Tenant;
  /** The drafts waiting, with repeats of one idea folded into one group (lib/group.ts). */
  groups: Group<WaitingItem<Approval>>[];
  /** The idea's figure for each draft that came from one, by approval id. */
  stakes: ReadonlyMap<string, string>;
  loading: boolean;
  error?: string;
}) {
  const [done, setDone] = useState<Done[]>([]);
  const [look, setLook] = useState<string | null>(null);
  useEffect(() => { setDone([]); setLook(null); }, [tenant.id]);
  const items = groups.map((g) => g.lead);
  // this week's first; a group whose newest draft is over a week old waits on the Needs your OK page, under Older
  const { recent, older } = splitOlder(groups, (w) => w.approval.createdAt);
  const { shown } = firstFew([...recent, ...older], 3);
  const readOnly = getPublicMode();
  const open = items.find((w) => w.approval.id === look);

  const decide = async (a: Approval, d: "approve" | "reject", edited?: Payload) => {
    const r = await decideDraft(tenant.id, a, d, edited);
    setDone((x) => [r, ...x].slice(0, 2));
    setLook(null);
  };

  const calm = !loading && !error && items.length === 0;
  return (
    <section className="hm-sec" aria-labelledby="hm-ok-h" aria-busy={loading && !items.length || undefined} data-home-card="waiting">
      <header className="hm-sec-head">
        {/* the count is in the status line above and in the top bar; it is not said a third time here */}
        <h2 id="hm-ok-h" className="hm-sec-title">Needs your OK</h2>
        {items.length > 0 && <Link to="/approvals" className="hm-sec-link">See all<Icon name="chevron-right" size={14} /></Link>}
      </header>
      {error && <p className="notice notice-bad" role="alert">Your drafts did not load: {error}</p>}
      {loading && !items.length && !done.length && <div className="hm-skel" aria-hidden="true"><span className="skeleton" /><span className="skeleton" /></div>}
      {shown.length > 0 && (
        <ul className="ap-list">
          {shown.map(({ lead: w, items: copies }) => (
            <ApprovalRow
              key={w.approval.id} a={w.approval} big={w.big} stake={stakes.get(w.approval.id)} readOnly={readOnly} repeats={copies.length}
              onOk={(a) => decide(a, "approve")} onLook={(a) => setLook(a.id)}
            />
          ))}
        </ul>
      )}
      {done.map((d) => <Decided key={d.id} d={d} tenantId={tenant.id} onPost={(p) => setDone((xs) => xs.map((x) => (x.id === d.id ? { ...x, post: p } : x)))} />)}
      {calm && <p className="hm-calm"><span className="hm-calm-icon" aria-hidden="true"><Icon name="check" size={16} /></span>Nothing needs you right now.</p>}
      <Sheet open={!!open} onClose={() => setLook(null)} label={open ? plainTitle(open.approval.title) : "Draft"}>
        {open && (
          <DraftView
            key={open.approval.id} a={open.approval} why={open.why} big={open.big} stake={stakes.get(open.approval.id)}
            tz={tenant.timeZone} locale={tenant.locale} tenantId={tenant.id} readOnly={readOnly} onDecide={decide}
          />
        )}
      </Sheet>
    </section>
  );
}
