// The living brain: the business's real FalkorDB graph, drawn small and gently moving, for the top of Home (and anywhere
// a page wants the brain in view). What the team is reading right now breathes in gold, and one line says how much the
// team knows. A tap opens the Brain page. Light: this shell is tiny, the renderer loads on its own after first paint,
// only the 90 most important things are fetched, drawing pauses offscreen, and reduced motion keeps it still.
// Pages only place it, with the business's id and a height.
import { Suspense, lazy, useMemo } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { agentDef } from "./bits";
import { centreOf, decodeMap, knowsLine, pickForMap, readingWords, HIDDEN_AT_FIRST } from "../lib/brain-map";
import { useApp, useAsync } from "../state/app";
import { useReadingNow } from "../state/reading";
import "./brain-live.css";

const GraphView = lazy(() => import("./GraphView"));

export interface BrainLiveProps { tenant: string; height?: number }

const SMALL = 90;

export default function BrainLive({ tenant, height = 220 }: BrainLiveProps) {
  const { effectiveTheme, reducedMotion } = useApp();
  const map = useAsync(() => api.brainMap(tenant, SMALL).then(decodeMap), [tenant]);
  const reading = useReadingNow(tenant);

  const shown = useMemo(() => {
    if (!map.data) return undefined;
    const have = new Set(map.data.nodes.map((n) => n.id));
    const extra = reading.nodes.filter((n) => !have.has(n.id)).map((n) => ({ ...n, rank: 0.05 }));
    const picked = pickForMap([...map.data.nodes, ...extra], [...map.data.edges, ...reading.edges], { cap: SMALL + extra.length, hidden: HIDDEN_AT_FIRST, keep: new Set(reading.ids) });
    // only things with a link: a lone dot far from the rest makes the fit zoom out until the brain is a small knot
    const linked = new Set(picked.edges.flatMap((e) => [e.from, e.to]));
    return { ...picked, nodes: picked.nodes.filter((n) => linked.has(n.id) || reading.ids.includes(n.id)) };
  }, [map.data, reading]);
  const centre = useMemo(() => (map.data ? centreOf(map.data.nodes) : undefined), [map.data]);

  const who = reading.who.map((a) => agentDef(a)?.name ?? a);
  const line = map.data ? knowsLine(map.data.totals.things) : undefined;
  const now = readingWords(who, reading.ids.length);
  const label = `${line ?? "What your team knows"}${now ? `. ${now} now` : ""}. Open the map.`;

  return (
    <Link to="/brain" className="brain-live" style={{ height }} aria-label={label}>
      <span className="brain-live-canvas" aria-hidden="true">
        {shown && shown.nodes.length > 0 ? (
          <Suspense fallback={<span className="brain-live-rest" />}>
            <GraphView
              nodes={shown.nodes}
              edges={shown.edges}
              centerId={centre}
              activeIds={reading.ids}
              sizeBy="rank"
              rankScale={[2, 7]}
              labels="none"
              interactive={false}
              drift
              dark={effectiveTheme === "dark"}
              reducedMotion={reducedMotion}
              fitPadding={14}
              maxFitZoom={5}
              ariaLabel=""
            />
          </Suspense>
        ) : (
          <span className={`brain-live-rest${map.error ? "" : " is-loading"}`} />
        )}
      </span>
      <span className="brain-live-line">
        {line ? <b>{line}</b> : map.error ? <b>What your team knows</b> : <span className="skeleton brain-live-skel" />}
        {now && <span className="brain-live-now"><span className="brain-live-dot" />{now}</span>}
      </span>
    </Link>
  );
}
