// Chat: one calm place to talk to your team. On the left, "Your team" (the whole team: Meera sends the work to the right
// people) and one entry per person, each with a dot for working, ready or resting and the conversations had with them. In
// the middle, the conversation. The same conversations are in Discord: one conversation, two doors.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { AGENTS } from "@shared/roster";
import { api, getMode, getPublicMode, type AgentPatch } from "../api";
import { AgentDrawer } from "../components/AgentDrawer";
import { AgentAvatar, agentDef, fmtAgo } from "../components/bits";
import { ChatTurn } from "../components/chat/ChatTurn";
import { Customise } from "../components/chat/Customise";
import { useThread } from "../components/chat/useThread";
import { Icon } from "../components/Icon";
import { APPROVALS_CHANGED } from "../components/TopBar";
import { CHIEF, TEAM, type Who, chatPath, dotOf, dotWords, startersFor, threadsFor, whoFrom, whoOfThread, workingNow } from "../lib/chat";
import { groupThreads } from "../lib/group";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import { runStore, useRunStore } from "../state/runs";
import type { AgentView, Approval, SessionSummary } from "../types-ext";
import { FIRST_DAY_QUESTIONS, SUGGESTIONS, TEAM_CHANGED } from "./Office";
import "./chat.css";

const TALK_KEY = "allevia.chat.talk";
const readTalk = () => { try { return localStorage.getItem(TALK_KEY) === "1"; } catch { return false; } };
const writeTalk = (on: boolean) => { try { localStorage.setItem(TALK_KEY, on ? "1" : "0"); } catch { /* storage may be blocked */ } };

const nameOf = (who: Who) => (who === TEAM ? "Your team" : agentDef(who)?.name ?? who);

export default function ChatPage() {
  const { who: whoParam, sessionId } = useParams();
  const who = whoFrom(whoParam);
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { tenant, reducedMotion, speed } = useApp();
  const snap = useRunStore();
  const narrow = useMedia("(max-width: 900px)");

  // the team's settings (on, resting, skills) and the conversations in every door
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(TEAM_CHANGED, on);
    return () => window.removeEventListener(TEAM_CHANGED, on);
  }, []);
  const team = useAsync(() => api.team(tenant.id).catch(() => [] as AgentView[]), [tenant.id, tick]);
  const threads = useAsync(() => api.sessions(tenant.id), [tenant.id, runStore.sessionsVersion]);
  const person: AgentView | undefined = who === TEAM ? undefined : team.data?.find((a) => a.id === who);

  // approvals the replies mention, answered right in the chat
  const [approvalTick, setApprovalTick] = useState(0);
  useEffect(() => {
    const on = () => setApprovalTick((t) => t + 1);
    window.addEventListener(APPROVALS_CHANGED, on);
    return () => window.removeEventListener(APPROVALS_CHANGED, on);
  }, []);
  const approvalList = useAsync(() => api.approvals(tenant.id).catch(() => [] as Approval[]), [tenant.id, approvalTick, runStore.sessionsVersion]);
  const [decided, setDecided] = useState<Record<string, Approval>>({});
  useEffect(() => { setDecided({}); }, [tenant.id]);
  const approvals = useMemo(() => {
    const m = new Map<string, Approval>((approvalList.data ?? []).map((a) => [a.id, a]));
    for (const a of Object.values(decided)) m.set(a.id, a);
    return m;
  }, [approvalList.data, decided]);

  // a new conversation starts without an id; once the run reports one, the address follows it
  const [pendingKey, setPendingKey] = useState<string | undefined>();
  useEffect(() => { setPendingKey(undefined); }, [who, tenant.id, sessionId]);
  const thread = useThread(tenant.id, sessionId, pendingKey);
  const pending = pendingKey ? snap.runs.get(pendingKey) : undefined;
  useEffect(() => {
    if (pending?.sessionId && pending.sessionId !== sessionId) nav(chatPath(who, pending.sessionId), { replace: true });
  }, [pending?.sessionId, sessionId, who, nav]);
  // a link into a thread under the wrong person is sent to the right one
  // (not while a new thread is still being set up: it has no turns and no person yet, and a question to Kabir jumped to
  // "Your team" until his answer was saved)
  useEffect(() => {
    const d = thread.detail;
    if (!d || !sessionId) return;
    const owner = whoOfThread({ agent: d.agent ?? d.running?.agent });
    if (!d.turns.length && owner === TEAM) return;
    if (owner !== who) nav(chatPath(owner, sessionId), { replace: true });
  }, [thread.detail, who, sessionId, nav]);

  // who is working this moment: the live runs in this tab and the threads the server says are running
  const working = useMemo(() => {
    const on = new Set<string>();
    for (const k of snap.order) {
      const r = snap.runs.get(k);
      if (!r || r.kind !== "live" || r.tenant !== tenant.id || r.status !== "running") continue;
      on.add(r.target ?? TEAM);
      for (const a of workingNow(r.events)) on.add(a);
    }
    for (const s of threads.data ?? []) if (s.running) on.add(s.agent ?? TEAM);
    return on;
  }, [snap, threads.data, tenant.id]);

  const [talk, setTalk] = useState(readTalk);
  const [customise, setCustomise] = useState(() => params.get("customise") === "1");
  const [profile, setProfile] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [text, setText] = useState(() => params.get("q") ?? "");
  useEffect(() => {
    if (!params.has("customise") && !params.has("q")) return;
    const next = new URLSearchParams(params);
    next.delete("customise"); next.delete("q");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { setSheet(false); }, [who, sessionId]);

  const resting = !!person && (!person.enabled || person.mode === "off");
  const send = useCallback((q: string) => {
    const question = q.trim();
    if (!question || thread.running || resting) return;
    // an address for a conversation this business does not have starts a new one rather than failing
    const sid = sessionId && (thread.detail || thread.loading) ? sessionId : undefined;
    const key = runStore.start(tenant.id, question, { sessionId: sid, ...(who !== TEAM ? { target: who } : {}) });
    if (!sid) setPendingKey(key);
    setText("");
  }, [thread.running, thread.detail, thread.loading, resting, tenant.id, sessionId, who]);
  // Home's ask box lands here as /chat/team?ask=…: the question is sent at once, and the address is cleaned so a reload does not
  // ask twice (the ref also covers React's double run of effects in development)
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const q = params.get("ask");
    if (!q || asked.current === q) return;
    asked.current = q;
    const next = new URLSearchParams(params);
    next.delete("ask");
    setParams(next, { replace: true });
    send(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onSubmit = (e: FormEvent) => { e.preventDefault(); send(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); }
  };

  const patch = async (id: string, p: AgentPatch) => {
    await api.setAgent(tenant.id, id, p);
    team.reload();
    window.dispatchEvent(new Event(TEAM_CHANGED));
  };

  // keep the newest words in view while a reply streams
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = thread.views[thread.views.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current && thread.running) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [last?.count, thread.running, reducedMotion]);
  useEffect(() => { stick.current = true; scrollRef.current?.scrollTo({ top: 0 }); }, [who, sessionId]);
  // switching "Watch the team talk" on opens the talk above the newest answer, out of sight in a long reply: bring it into view
  const talkTurnedOn = useRef(false);
  useEffect(() => {
    if (!talkTurnedOn.current) return;
    talkTurnedOn.current = false;
    const box = [...(scrollRef.current?.querySelectorAll<HTMLElement>(".ct-talk") ?? [])].pop();
    box?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }, [talk, reducedMotion]);

  const mine = threadsFor(who, threads.data);
  const title = thread.detail?.title ?? pending?.question;
  const empty = thread.turns.length === 0 && !thread.loading;
  const missing = empty && !!sessionId && !thread.detail && !pendingKey;
  // everyday jobs that the tools this business connected make possible (live server only), first in the list
  const conn = useAsync(() => (getMode() === "live" ? api.connections(tenant.id) : Promise.resolve(null)), [tenant.id]);
  const jobChips = (conn.data?.starters ?? [])
    .filter((s) => who === TEAM || who === CHIEF || s.agents.includes(who))
    .slice(0, who === TEAM ? 3 : 4).map((s) => ({ id: `job:${s.id}`, label: s.label, prompt: s.ask }));
  const baseChips = who === TEAM ? (SUGGESTIONS[tenant.id] ?? FIRST_DAY_QUESTIONS).slice(0, 4).map((s) => ({ id: s, label: s, prompt: s })) : startersFor(who, person?.skills);
  // three to start with; anything else can be typed
  const chips = [...jobChips, ...baseChips].slice(0, 3);

  const rail = (
    <Rail who={who} sessionId={sessionId} team={team.data} threads={threads.data} mine={mine} loading={threads.loading && !threads.data} working={working} onPick={() => setSheet(false)} />
  );

  return (
    <div className="chat-page">
      {!narrow && <aside className="chat-rail" aria-label="Your team and your conversations">{rail}</aside>}

      <section className="chat-main" aria-labelledby="chat-title">
        {narrow && <WhoStrip who={who} team={team.data} working={working} />}

        <header className="chat-head">
          <div className="chat-head-id">
            {who === TEAM ? <AgentAvatar id={CHIEF} size={40} /> : <AgentAvatar id={who} size={40} ring={working.has(who)} />}
            <div className="chat-head-text">
              <h1 id="chat-title" className="chat-title">{nameOf(who)}</h1>
              {who !== TEAM && (
                <p className="chat-sub">
                  <span className={`ct-dot dot-${dotOf(person, working.has(who))}`} aria-hidden="true" /> {agentDef(who)?.title} · {dotWords(dotOf(person, working.has(who)), person?.mode)}
                </p>
              )}
            </div>
          </div>
          <div className="chat-head-actions">
            {narrow && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSheet(true)} aria-haspopup="dialog"><Icon name="menu" size={15} /> Conversations</button>}
            {who === TEAM ? (
              <button
                type="button" role="switch" aria-checked={talk} className={`ct-toggle${talk ? " is-on" : ""}`}
                onClick={() => { talkTurnedOn.current = !talk; setTalk(!talk); writeTalk(!talk); }}
              >
                <span className="ct-toggle-track" aria-hidden="true"><span /></span>
                Watch the team talk
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProfile(true)}>Profile</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCustomise(true)} disabled={!person}><Icon name="pen" size={14} /> Customise</button>
              </>
            )}
            {who === TEAM && <Link to="/team" className="btn btn-quiet btn-sm">Manage</Link>}
          </div>
        </header>

        <div className="chat-scroll" ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {empty ? (
            <div className="chat-empty">
              {missing ? (
                <>
                  <h2>This conversation isn't in {tenant.name}.</h2>
                  <p className="chat-empty-persona">It may belong to another business. Pick one of your conversations, or ask something new below.</p>
                </>
              ) : who === TEAM ? (
                <>
                  <h2>Ask {tenant.name}'s team anything.</h2>
                </>
              ) : (
                <>
                  <AgentAvatar id={who} size={64} />
                  <h2>Chat with {nameOf(who)}</h2>
                  <p className="chat-empty-persona">{agentDef(who)?.persona}</p>
                </>
              )}
              {chips.length > 0 && (
                <ul className="chat-chips" aria-label={who === TEAM ? "Try one of these" : `What ${nameOf(who)} can do`}>
                  {chips.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="chat-chip" disabled={resting} onClick={() => (who === TEAM ? send(c.prompt) : setText(c.prompt))} title={c.prompt}>
                        <span>{c.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <ol className="ct-turns">
              {thread.turns.map((t, i) => (
                <ChatTurn
                  key={t.key}
                  turn={t}
                  view={thread.views[i]!}
                  who={who}
                  tenantId={tenant.id}
                  latest={i === thread.turns.length - 1}
                  talk={talk}
                  approvals={approvals}
                  onApprovalChanged={(a) => setDecided((m) => ({ ...m, [a.id]: a }))}
                  onPrefill={setText}
                  onSend={send}
                  onReplay={() => thread.replay(t, { paced: !reducedMotion, speed: () => Math.max(speed, 2) })}
                  onRetry={() => send(t.question)}
                />
              ))}
              {thread.loading && !thread.turns.length && <li className="ct-turn"><span className="skeleton ct-skel" /></li>}
            </ol>
          )}
        </div>

        {thread.running && thread.liveRun && getMode() === "live" && !getPublicMode() && (
          <p className="chat-note" role="status">{thread.liveRun.stopping ? "Stopping…" : "Keeps working if you close this tab."}</p>
        )}
        {resting ? (
          <div className="chat-resting" role="status">
            <p><b>{nameOf(who)} is resting.</b></p>
            {!getPublicMode() && <button type="button" className="btn btn-gold btn-sm" onClick={() => void patch(who, { mode: "full" })}>Switch {nameOf(who)} on</button>}
          </div>
        ) : (
          <form className="chat-composer" onSubmit={onSubmit} aria-label={who === TEAM ? "Ask your team" : `Message ${nameOf(who)}`}>
            <label htmlFor="chat-q" className="visually-hidden">{who === TEAM ? "Your message to the team" : `Your message to ${nameOf(who)}`}</label>
            <textarea
              id="chat-q" className="chat-input" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
              placeholder={who === TEAM ? (sessionId ? "Ask a follow-up…" : `Ask ${tenant.name}'s team…`) : `Message ${nameOf(who)}…`}
              disabled={thread.running}
            />
            {thread.running && thread.liveRun ? (
              <button type="button" className="btn btn-ghost" onClick={() => runStore.stop(thread.liveRun!.key)} disabled={thread.liveRun.stopping}>
                <Icon name="stop" size={14} /> {thread.liveRun.stopping ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <button type="submit" className="btn btn-gold" disabled={!text.trim() || thread.running}>Send <Icon name="send" size={16} /></button>
            )}
          </form>
        )}
        <span className="visually-hidden" aria-live="polite">{title ? `Conversation: ${title}` : ""}</span>
      </section>

      {narrow && <Sheet open={sheet} onClose={() => setSheet(false)}>{rail}</Sheet>}
      {person && (
        <Customise
          agent={person} tenantId={tenant.id} open={customise} onClose={() => setCustomise(false)}
          onPatch={(p) => patch(person.id, p)} onChanged={() => { team.reload(); window.dispatchEvent(new Event(TEAM_CHANGED)); }}
        />
      )}
      <AgentDrawer agentId={profile && who !== TEAM ? who : null} onClose={() => setProfile(false)} />
    </div>
  );
}

// ---------------------------------------------------------------- the left rail

function Dot({ dot }: { dot: ReturnType<typeof dotOf> }) {
  return <span className={`ct-dot dot-${dot}`} role="img" aria-label={dotWords(dot)} />;
}

/** At most this many recent conversations in the rail, the same question asked again folded into one row; then "Show all". */
const RECENT = 8;

function Rail({ who, sessionId, team, threads, mine, loading, working, onPick }: {
  who: Who; sessionId?: string; team?: AgentView[]; threads?: SessionSummary[]; mine: SessionSummary[]; loading: boolean; working: Set<string>; onPick: () => void;
}) {
  const people = AGENTS.filter((a) => a.id !== CHIEF);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [who]);
  const folded = groupThreads(mine);
  // "Show all" lists every conversation, repeats too, so each one stays one tap away
  const list = showAll ? mine.map((s) => ({ lead: s, items: [s] })) : folded.slice(0, RECENT);
  const entry = (id: Who, avatar: ReactNode, name: string, role: string, dot: ReturnType<typeof dotOf>) => {
    const active = who === id;
    const convos = active ? mine : [];
    return (
      <li key={id} className={`rail-entry${active ? " is-active" : ""}${dot === "off" ? " is-off" : ""}`}>
        <NavLink to={chatPath(id)} end className={() => `rail-link${active && !sessionId ? " is-current" : ""}`} aria-current={active ? "page" : undefined} onClick={onPick}>
          <span className="rail-avatar">{avatar}<Dot dot={dot} /></span>
          <span className="rail-text"><span className="rail-name">{name}</span><span className="rail-role">{dot === "off" ? "Resting" : role}</span></span>
          {threadsFor(id, threads).length > 0 && <span className="rail-count" aria-label={`${groupThreads(threadsFor(id, threads)).length} conversations`}>{groupThreads(threadsFor(id, threads)).length}</span>}
        </NavLink>
        {active && (
          <div className="rail-convos">
            <div className="rail-convos-head">
              <h3>Conversations</h3>
              <Link to={chatPath(id)} className="btn btn-quiet btn-sm" onClick={onPick}><Icon name="plus" size={13} /> New</Link>
            </div>
            {loading ? <span className="skeleton rail-skel" /> : convos.length === 0 ? (
              <p className="rail-empty">None yet.</p>
            ) : (
              <ul>
                {(active ? list : []).map(({ lead: s, items }) => (
                  <li key={s.id}>
                    <NavLink to={chatPath(id, s.id)} className={`rail-convo${s.id === sessionId ? " is-active" : ""}`} aria-current={s.id === sessionId ? "page" : undefined} onClick={onPick}>
                      <span className="rail-convo-title">{s.title}{items.length > 1 && <span className="rail-repeat" aria-label={`asked ${items.length} times`}> ×{items.length}</span>}</span>
                      <span className="rail-convo-meta">
                        {s.channel === "discord" && <><Icon name="chat" size={11} /> Discord · </>}{fmtAgo(s.lastAt)}
                        {s.running && <span className="rail-live"><span className="ct-pulse" aria-hidden="true" /> working</span>}
                      </span>
                    </NavLink>
                  </li>
                ))}
                {(showAll || folded.length > RECENT || folded.length < convos.length) && (
                  <li>
                    <button type="button" className="btn btn-quiet btn-sm rail-all" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                      {showAll ? "Show fewer" : "Show all"}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <nav className="rail" aria-label="Who to talk to">
      <h2 className="rail-title">Chat</h2>
      <ul className="rail-list">
        {entry(TEAM, <AgentAvatar id={CHIEF} size={36} />, "Your team", "Everyone", dotOf(undefined, working.has(TEAM)))}
      </ul>
      <p className="rail-label">People</p>
      <ul className="rail-list">
        {people.map((a) => {
          const s = team?.find((x) => x.id === a.id);
          return entry(a.id, <AgentAvatar id={a.id} size={36} />, a.name, a.title, dotOf(s, working.has(a.id)));
        })}
      </ul>
    </nav>
  );
}

/** On a phone the rail becomes a row of faces across the top. */
function WhoStrip({ who, team, working }: { who: Who; team?: AgentView[]; working: Set<string> }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView({ inline: "center", block: "nearest" }); }, [who]);
  const items: Array<{ id: Who; name: string; dot: ReturnType<typeof dotOf> }> = [
    { id: TEAM, name: "Team", dot: dotOf(undefined, working.has(TEAM)) },
    ...AGENTS.filter((a) => a.id !== CHIEF).map((a) => ({ id: a.id, name: a.name, dot: dotOf(team?.find((x) => x.id === a.id), working.has(a.id)) })),
  ];
  return (
    <nav className="who-strip" aria-label="Who to talk to">
      <ul ref={ref}>
        {items.map((i) => (
          <li key={i.id}>
            <NavLink to={chatPath(i.id)} end aria-current={who === i.id ? "page" : undefined} className={`who-link${who === i.id ? " is-active" : ""}${i.dot === "off" ? " is-off" : ""}`}>
              <span className="rail-avatar"><AgentAvatar id={i.id === TEAM ? CHIEF : i.id} size={34} /><Dot dot={i.dot} /></span>
              <span>{i.name}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="drawer sheet-left ct-sheet" aria-label="Conversations" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="sheet-body">
        <button type="button" className="btn btn-quiet btn-icon sheet-close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        {children}
      </div>
    </dialog>
  );
}
