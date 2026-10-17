// The people who can open this business (with sign-in on), on the Your team page: the owner and their teammates, the seats the
// plan gives, and, for the owner, "Invite someone": a link that lets one more person in, once, for 7 days. There is no email
// sender, so the owner copies the link and sends it themselves.
import { useState } from "react";
import { accountApi, type MembersPage } from "../lib/account";
import { ApiError } from "../lib/sse";
import { useAsync } from "../state/app";
import { Icon } from "./Icon";

export function TeamPeople({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const people = useAsync<MembersPage>(() => accountApi.members(tenantId), [tenantId]);
  const [invite, setInvite] = useState<{ url: string; copied?: boolean } | null>(null);
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});

  const make = async () => {
    setState({ busy: true });
    try {
      const r = await accountApi.createInvite(tenantId);
      setInvite({ url: `${location.origin}${r.link}` });
      setState({});
      people.reload();
    } catch (e) {
      setState({ error: e instanceof ApiError ? e.message : "The invite could not be made. Try again in a moment." });
    }
  };
  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setInvite({ ...invite, copied: true });
    } catch { /* the field is selectable: the owner can copy it by hand */ }
  };

  const d = people.data;
  if (people.error && !d) return null; // a demo or an owner link without accounts: nothing to show here
  const used = d ? d.members.length + d.invited : 0;
  return (
    <section className="tm-people" aria-labelledby="tm-people-h">
      <div className="tm-people-head">
        <div>
          <h2 id="tm-people-h" className="section-title">People who can open {tenantName}</h2>
          <p className="tm-people-lede">
            {d?.canInvite
              ? "Teammates can ask, write drafts and say OK. Only you change the plan, your tools and the team."
              : "Teammates can ask, write drafts and say OK. The owner invites people."}
          </p>
        </div>
        {d && <p className="tm-people-seats num">{used} of {d.seats} seats{d.invited ? ` · ${d.invited} invite${d.invited === 1 ? "" : "s"} not used yet` : ""}</p>}
      </div>
      {!d ? (
        <span className="skeleton" style={{ display: "block", height: 64 }} />
      ) : (
        <ul className="tm-people-list">
          {d.members.map((m) => (
            <li key={m.id}>
              <span className="tm-people-name">{m.name}{m.you ? <span className="tm-people-you"> (you)</span> : null}</span>
              <span className="tm-people-email">{m.email}</span>
              <span className={`badge ${m.role === "owner" ? "badge-gold" : "badge-ink"}`}>{m.role === "owner" ? "Owner" : "Teammate"}</span>
            </li>
          ))}
        </ul>
      )}
      {d?.canInvite && (
        <div className="tm-people-invite">
          {invite ? (
            <>
              <label className="label">
                Send this link to the person you want to invite
                <span className="tm-people-link">
                  <input className="field" readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} aria-describedby="tm-invite-note" />
                  <button type="button" className="btn btn-gold" onClick={() => void copy()}>{invite.copied ? <><Icon name="check" size={14} /> Copied</> : "Copy link"}</button>
                </span>
              </label>
              <p id="tm-invite-note" className="tm-people-note">It works once, for 7 days. Whoever opens it joins as a teammate.</p>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setInvite(null)}>Done</button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => void make()} disabled={state.busy}>
              <Icon name="plus" size={15} /> {state.busy ? "Making the link…" : "Invite someone"}
            </button>
          )}
          {state.error && <p className="notice notice-bad" role="alert">{state.error}</p>}
        </div>
      )}
    </section>
  );
}
