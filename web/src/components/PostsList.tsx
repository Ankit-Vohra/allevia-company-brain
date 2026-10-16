// Your posts: what is set for later, what went out and what did not, each with the one thing the owner can do about it. Cancel while a
// post waits for its time; Try again when it did not go out (and, when it may have gone out anyway, "It isn't there, post it again" only
// after they have looked). The words come from the server, the same ones Discord shows.
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import type { PostView } from "../types-ext";
import { Icon } from "./Icon";
import "./posts.css";

const STATE: Record<PostView["status"], string> = {
  scheduled: "Set for", publishing: "Being posted", published: "Posted", failed: "Did not go out", cancelled: "Cancelled", dry_run: "Would have posted",
};

/** One post and its buttons. `onChanged` gets the post as it stands after a tap. */
export function PostLine({ tenantId, post, onChanged, quiet }: { tenantId: string; post: PostView; onChanged: (p: PostView) => void; quiet?: boolean }) {
  const [busy, setBusy] = useState<null | "cancel" | "retry">(null);
  const [said, setSaid] = useState<string | null>(null);
  const run = async (what: "cancel" | "retry") => {
    setBusy(what);
    setSaid(null);
    try {
      const r = what === "cancel" ? await api.publishCancel(tenantId, post.id) : await api.publishRetry(tenantId, post.id, post.checkFirst);
      setSaid(r.message);
      if (r.post) onChanged(r.post);
    } catch (e) {
      setSaid((e as Error).message || "That did not go through. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const done = post.status === "published";
  return (
    <div className={`post-line is-${post.status}${quiet ? " is-quiet" : ""}`}>
      <p className="post-state">
        <Icon name={done ? "check" : post.status === "failed" ? "warn" : post.status === "scheduled" ? "clock" : "send"} size={14} />
        <b>{STATE[post.status]}{post.status === "scheduled" ? ` ${post.when}` : done ? ` ${post.when}` : ""}</b>
        <span className="post-where"> · {post.where}</span>
      </p>
      {post.failure && <p className="post-why">{post.failure}</p>}
      {post.checkFirst && <p className="post-why">Look at your account first. If it isn't there, post it again.</p>}
      <div className="post-actions">
        {done && post.url && <a className="btn btn-ghost btn-sm" href={post.url} target="_blank" rel="noreferrer noopener">See the post</a>}
        {post.canCancel && <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run("cancel")}>{busy === "cancel" ? "Cancelling…" : "Cancel this post"}</button>}
        {post.canRetry && <button type="button" className="btn btn-gold btn-sm" disabled={busy !== null} onClick={() => void run("retry")}>{busy === "retry" ? "Trying…" : post.checkFirst ? "It isn't there, post it again" : "Try again"}</button>}
        {post.reconnect && post.status === "failed" && <Link className="btn btn-ghost btn-sm" to={`/connections?connect=${encodeURIComponent(post.reconnect.id)}`}>Connect {post.reconnect.name} again</Link>}
      </div>
      {said && <p className="post-said" role="status">{said}</p>}
    </div>
  );
}

/** The newest posts, scheduled ones first. */
export function PostsList({ tenantId, posts, onChanged }: { tenantId: string; posts: PostView[]; onChanged: () => void }) {
  if (!posts.length) return <p className="muted small">Posts you approve for Instagram, Facebook or LinkedIn show up here, with the time they are set for.</p>;
  const order = (p: PostView) => (p.status === "scheduled" ? 0 : p.status === "failed" ? 1 : 2);
  const sorted = [...posts].sort((a, b) => order(a) - order(b) || (order(a) === 0 ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
  return (
    <ul className="posts-list">
      {sorted.map((p) => (
        <li key={p.id}>
          <p className="post-title">{p.title.replace(/^Post to [^:]*\): /, "")}</p>
          <PostLine tenantId={tenantId} post={p} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}
