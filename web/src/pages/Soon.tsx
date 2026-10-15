// A screen that is planned but not built yet: what it will do, who works on it, a pencil sketch of its layout, and
// something useful to do in the meantime.
import { Link } from "react-router";
import { AgentAvatar, agentDef } from "../components/bits";
import { Icon } from "../components/Icon";
import { currencySymbol } from "../lib/format";
import { type SoonId, soonById } from "../lib/soon";
import { useApp } from "../state/app";
import "./soon.css";

export default function SoonPage({ id }: { id: SoonId }) {
  const s = soonById(id);
  const { tenant } = useApp();
  return (
    <div className="soon-page">
      <div className="soon-copy">
        <p className="soon-status"><span className="soon-dot" aria-hidden="true" /> Coming soon</p>
        <h1 className="page-title soon-title">{s.title}</h1>
        <p className="soon-lede">{s.lede}</p>
        <ul className="soon-points">
          {s.points.map((p) => <li key={p}><Icon name="check" size={15} /> {p}</li>)}
        </ul>
        <div className="soon-team">
          <span className="soon-avatars" aria-hidden="true">{s.agents.map((a) => <AgentAvatar key={a} id={a} size={30} />)}</span>
          <p className="small">
            Worked by {s.agents.map((a) => agentDef(a)?.name).join(", ").replace(/, ([^,]*)$/, " and $1")}.
          </p>
        </div>
        <Link className="btn btn-ghost" to={s.meanwhile.to}>{s.meanwhile.label}</Link>
      </div>
      <figure className="soon-sketch" aria-hidden="true">
        <Sketch id={id} symbol={currencySymbol(tenant.currency)} />
        <figcaption>A sketch of the screen, not the final design.</figcaption>
      </figure>
    </div>
  );
}

function House({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return <path className="sk-ink" d={`M${x} ${y + 34 * s}V${y + 14 * s}l${18 * s} -${14 * s} ${18 * s} ${14 * s}V${y + 34 * s}ZM${x + 13 * s} ${y + 34 * s}v-${11 * s}h${10 * s}v${11 * s}`} />;
}

function Sketch({ id, symbol }: { id: SoonId; symbol: string }) {
  if (id === "studio") {
    return (
      <svg viewBox="0 0 480 300" className="sketch">
        <g transform="rotate(-7 92 150)">
          <rect className="sk-frame" x="34" y="78" width="116" height="150" rx="6" />
          <House x={74} y={120} s={1.1} />
          <path className="sk-faint" d="M44 214h96" />
        </g>
        <text className="sk-text" x="92" y="262" textAnchor="middle">your photo</text>
        <path className="sk-gold" d="M168 150h56m-10-9 10 9-10 9" />
        {[0, 1, 2].map((i) => (
          <g key={i} transform={`translate(${242 + i * 78} 70)`}>
            <rect className="sk-frame" width="66" height="96" rx="5" />
            <House x={15} y={26} s={1} />
            <circle className="sk-ok" cx="33" cy="118" r="9" />
            <path className="sk-ok-tick" d="M28.5 118.5l3 3 5.5-6" />
            <text className="sk-text" x="33" y="150" textAnchor="middle">{"ABC"[i]}</text>
          </g>
        ))}
        <path className="sk-faint" d="M242 246h222M242 262h160" />
      </svg>
    );
  }
  if (id === "plan") {
    return (
      <svg viewBox="0 0 480 300" className="sketch">
        <text className="sk-money" x="24" y="64">{symbol}</text>
        <path className="sk-faint" d="M24 84h120M24 100h86" />
        <rect className="sk-frame" x="200" y="34" width="256" height="20" rx="10" />
        <rect className="sk-gold-fill" x="200" y="34" width="150" height="20" rx="10" />
        <text className="sk-text" x="200" y="76">Studio credits this month</text>
        {[0, 1, 2, 3].map((i) => (
          <g key={i} transform={`translate(24 ${140 + i * 36})`}>
            <path className={i === 0 ? "sk-ink" : "sk-faint"} d="M0 0h432" />
            <path className="sk-faint" d="M8 20h120M300 20h40" />
            <text className="sk-text" x="424" y="25" textAnchor="end">{symbol}</text>
          </g>
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 480 300" className="sketch">
      <path className="sk-ink" d="M40 240h400" />
      {[0, 30, 60, 90].map((d, i) => (
        <g key={d} transform={`translate(${40 + i * 133.3} 240)`}>
          <path className="sk-ink" d="M0 0v8" />
          <text className="sk-text" y="28" textAnchor="middle">Day {d}</text>
        </g>
      ))}
      <path className="sk-faint" d="M40 200h400M40 150h400M40 100h400" />
      <path className="sk-gold" d="M40 214C110 206 150 186 200 170s110-44 160-62 60-30 80-36" />
      {[[40, 214], [173, 178], [307, 122], [440, 72]].map(([x, y]) => <circle key={x} className="sk-dot" cx={x} cy={y} r="6" />)}
      <text className="sk-text" x="40" y="54">First-pass approvals</text>
    </svg>
  );
}
