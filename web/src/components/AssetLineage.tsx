// "How this was made" on the Studio page: a photo's history drawn as four short steps, from what the graph holds about it (your photo, the
// options made from it, your OK, the post). Compact on purpose: a thin rail, a line of words per step, small pictures where there are
// pictures, and the cost and the rules it followed behind one "More". The words come from web/src/lib/lineage.ts.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { lineageStory, type LineageStory, type StoryAsset } from "../lib/lineage";
import { agentDef } from "./bits";
import { Icon } from "./Icon";

const thumb = (tenant: string, id: string) => `/api/${encodeURIComponent(tenant)}/assets/${encodeURIComponent(id)}?w=120`;
const CHECK_WORD: Record<NonNullable<StoryAsset["check"]>, string> = { ok: "Checked", held: "Held back", unchecked: "Not checked" };

/** `rootId` is the owner's photo (or any picture in its chain); `refreshKey` changes when something happened (an OK, a change, a clip). */
export function AssetLineage({ tenant, rootId, refreshKey }: { tenant: string; rootId: string; refreshKey: string }) {
  const [story, setStory] = useState<LineageStory | null>(null);
  useEffect(() => {
    let on = true;
    api.assetLineage(tenant, rootId)
      .then((l) => { if (on) setStory(l ? lineageStory(l, (id) => agentDef(id)?.name) : null); })
      .catch(() => { if (on) setStory(null); }); // a history that cannot be read is no history, not an error on the page
    return () => { on = false; };
  }, [tenant, rootId, refreshKey]);
  return story ? <LineageCard tenant={tenant} story={story} /> : null;
}

/** The card itself: pictures, words and the "More" fold. Pure, so it can be looked at without a server. */
export function LineageCard({ tenant, story }: { tenant: string; story: LineageStory }) {
  const more = useMemo(() => [story.cost, ...(story.followed.length ? [`It followed your rules: ${story.followed.join(", ")}.`] : []), ...story.checks].filter((x): x is string => !!x), [story]);
  return (
    <section className="card lineage" aria-label="How this was made">
      <header className="card-head"><div><b>How this was made</b><span>From your photo to the post</span></div></header>
      <ol className="lineage-steps">
        {story.steps.map((s) => (
          <li key={s.key} className={`lineage-step is-${s.state}`}>
            <span className="lineage-dot" aria-hidden="true">{s.state === "done" ? <Icon name="check" size={12} /> : s.state === "waiting" ? <Icon name="clock" size={12} /> : null}</span>
            <div className="lineage-body">
              <p className="lineage-line"><b>{s.title}</b> <span>{s.line}</span></p>
              {s.assets.length > 0 && (
                <ul className="lineage-pics">
                  {s.assets.map((a) => (
                    <li key={a.id} className={a.chosen ? "is-chosen" : a.check && a.check !== "ok" ? "is-held" : ""}>
                      <img src={thumb(tenant, a.id)} alt={a.label ? (a.label === "Your photo" ? "Your photo" : `Option ${a.label}`) : "Picture"} loading="lazy" width={44} height={44} />
                      {a.label && a.label !== "Your photo" && <b>{a.label}</b>}
                      {a.check && <small>{a.chosen ? "Your pick" : CHECK_WORD[a.check]}</small>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
      {more.length > 0 && (
        <details className="lineage-more">
          <summary>More</summary>
          <ul>{more.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
