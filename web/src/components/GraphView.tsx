// The one renderer for every map of the brain: the Brain page's map, Home's living brain, the answer's lit path in Chat
// and Ask, onboarding and a person's profile. A force graph (react-force-graph-2d) that grows in place: node and link
// objects are kept and mutated, never recreated, because the library stores positions on them. The explanation path is
// lit in gold with travelling particles; what the team is reading right now breathes in gold. Labels are drawn in one
// pass after the nodes, most important first, and a label that would collide with one already drawn is left out (hover
// a node to read it), so dense neighbourhoods stay legible. Offscreen, the drawing pauses.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { EdgeRef, NodeRef } from "@shared/contracts";
import { oklch } from "../lib/color";
import { rankRadius } from "../lib/brain-map";
import { COMMUNITY_HUES, chromaFor, hueFor } from "../lib/labels";
import { kindName, relPhrase } from "./brain-words";

export interface GNodeIn extends NodeRef { rank?: number; community?: number; weight?: number }

interface GNode extends GNodeIn { born: number; deg: number; ph: number }
interface GLink { key: string; type: string; source: string | GNode; target: string | GNode; from: string; to: string }
type PNode = NodeObject<GNode>;

export interface GraphViewProps {
  nodes: GNodeIn[];
  edges: EdgeRef[];
  path?: { nodes: NodeRef[]; edges: EdgeRef[] };
  focusId?: string;
  citedIds?: string[];
  /** Nodes to bring forward (the rest dim); the view zooms to them. */
  highlightIds?: string[];
  /** Nodes being read right now: ringed in gold and labelled, without dimming the rest. */
  activeIds?: string[];
  colorBy?: "label" | "community";
  /** Size nodes by PageRank (rank) instead of by how connected they are on screen. */
  sizeBy?: "rank" | "degree";
  /** With sizeBy "rank": the smallest and largest radius, on a square-root curve so the few big things stand out. */
  rankScale?: [number, number];
  dark: boolean;
  reducedMotion: boolean;
  onNodeClick?: (id: string) => void;
  /** A tap on empty space (closes a side panel). */
  onBackgroundClick?: () => void;
  height?: number;
  centerId?: string;
  /** "auto": the important ones and whatever fits; "all": every one that fits; "none": only the path, the focus and what is being read. */
  labels?: "auto" | "all" | "none";
  /** With labels "auto": label things at least this important at the first zoom (more appear as you zoom in). */
  labelMinRank?: number;
  ariaLabel: string;
  fitPadding?: number;
  /** Keep the whole graph in view while it grows (onboarding, a run in progress, "Watch it grow"), until the user pans or zooms. */
  followGrowth?: boolean;
  /** The closest a fit may zoom in, so two or three nodes do not fill the screen. */
  maxFitZoom?: number;
  /** false: a picture to look at (no zoom, pan, drag or taps), for Home's living brain. */
  interactive?: boolean;
  /** Keep moving gently after the layout settles (Home's living brain). Off with reduced motion. */
  drift?: boolean;
  /** Change it to start the layout over (a replay that grows the map from nothing). */
  layoutKey?: string;
}

const keyOf = (e: { from: string; type: string; to: string }) => `${e.from}|${e.type}|${e.to}`;
const idOf = (x: string | GNode | undefined) => (typeof x === "string" ? x : x?.id ?? "");

/** Pull every node gently toward the centre, so separate components stay in frame instead of drifting apart. */
function gravity(strength: number) {
  let nodes: PNode[] = [];
  const force = (alpha: number) => {
    for (const n of nodes) {
      n.vx = (n.vx ?? 0) - (n.x ?? 0) * strength * alpha;
      n.vy = (n.vy ?? 0) - (n.y ?? 0) * strength * alpha;
    }
  };
  force.initialize = (ns: PNode[]) => { nodes = ns; };
  return force;
}

/** A slow sway that does not fade with the layout: each node circles its place by a few pixels, out of step with the rest. */
function wander(amp: number) {
  let nodes: PNode[] = [];
  const force = () => {
    const t = performance.now() / 1000;
    for (const n of nodes) {
      n.vx = (n.vx ?? 0) + Math.cos(t * 0.55 + n.ph) * amp;
      n.vy = (n.vy ?? 0) + Math.sin(t * 0.43 + n.ph * 1.7) * amp;
    }
  };
  force.initialize = (ns: PNode[]) => { nodes = ns; };
  return force;
}

export default function GraphView({
  nodes, edges, path, focusId, citedIds, highlightIds, activeIds, colorBy = "label", sizeBy = "rank", rankScale, dark, reducedMotion, onNodeClick,
  onBackgroundClick, height, centerId, labels = "auto", labelMinRank = 0.5, ariaLabel, fitPadding = 36, followGrowth = false, maxFitZoom = 2.6,
  interactive = true, drift = false, layoutKey,
}: GraphViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<PNode, LinkObject<GNode, GLink>> | undefined>(undefined);
  const nodeMap = useRef(new Map<string, GNode>());
  const linkMap = useRef(new Map<string, GLink>());
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [size, setSize] = useState({ w: 0, h: height ?? 0 });
  const hoverRef = useRef<string | null>(null);
  const fitCount = useRef("");
  const userMoved = useRef(false);
  const grownTo = useRef(0);
  const growTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const laidOutFor = useRef(layoutKey);
  const moving = drift && !reducedMotion;
  const big = nodes.length > 150;

  /** Fit everything (or a subset) in view, then back off if that zoomed in too far. */
  const fit = (ms: number, filter?: (n: PNode) => boolean, pad = fitPadding) => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.zoomToFit(ms, pad, filter);
    setTimeout(() => { if (fgRef.current && fgRef.current.zoom() > maxFitZoom) fgRef.current.zoom(maxFitZoom, reducedMotion ? 0 : 250); }, ms + 30);
  };

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e!.contentRect.width), h: height ?? Math.floor(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  // merge incoming nodes/edges into the persistent objects
  useEffect(() => {
    let changed = false;
    const want = new Set(nodes.map((n) => n.id));
    const now = performance.now();
    const restart = laidOutFor.current !== layoutKey;
    laidOutFor.current = layoutKey;
    if (restart || (nodeMap.current.size && ![...nodeMap.current.keys()].some((id) => want.has(id)))) {
      // a different graph altogether (or asked to start over): drop the old layout, and fit it again
      nodeMap.current.clear();
      linkMap.current.clear();
      fitCount.current = "";
      grownTo.current = 0;
      if (!restart) userMoved.current = false;
      changed = true;
    }
    // the first drawing arrives quietly; only what is added after it ripples in (a replay starts from nothing, so it ripples)
    const quiet = nodeMap.current.size === 0 && !restart;
    for (const n of nodes) {
      const ex = nodeMap.current.get(n.id);
      if (ex) {
        if (ex.name !== n.name || ex.rank !== n.rank || ex.weight !== n.weight || ex.community !== n.community) { Object.assign(ex, n); changed = true; }
        continue;
      }
      const g: GNode = { ...n, born: quiet ? now - 5000 : now, deg: 0, ph: Math.random() * Math.PI * 2 };
      // start next to a neighbour already on screen, so new nodes grow out of the graph instead of flying in
      const link = edges.find((e) => (e.from === n.id && nodeMap.current.has(e.to)) || (e.to === n.id && nodeMap.current.has(e.from)));
      const anchor = link ? (nodeMap.current.get(link.from === n.id ? link.to : link.from) as PNode | undefined) : undefined;
      if (anchor?.x !== undefined && anchor.y !== undefined) {
        (g as PNode).x = anchor.x + (Math.random() - 0.5) * 20;
        (g as PNode).y = anchor.y + (Math.random() - 0.5) * 20;
      }
      if (n.id === centerId) { (g as PNode).fx = 0; (g as PNode).fy = 0; }
      nodeMap.current.set(n.id, g);
      changed = true;
    }
    for (const id of [...nodeMap.current.keys()]) if (!want.has(id)) { nodeMap.current.delete(id); changed = true; }
    const wantLinks = new Set<string>();
    for (const e of edges) {
      if (!nodeMap.current.has(e.from) || !nodeMap.current.has(e.to) || e.from === e.to) continue;
      const k = keyOf(e);
      wantLinks.add(k);
      if (!linkMap.current.has(k)) { linkMap.current.set(k, { key: k, type: e.type, source: e.from, target: e.to, from: e.from, to: e.to }); changed = true; }
    }
    for (const k of [...linkMap.current.keys()]) if (!wantLinks.has(k)) { linkMap.current.delete(k); changed = true; }
    if (changed) {
      const deg = new Map<string, number>();
      for (const l of linkMap.current.values()) { deg.set(l.from, (deg.get(l.from) ?? 0) + 1); deg.set(l.to, (deg.get(l.to) ?? 0) + 1); }
      for (const n of nodeMap.current.values()) n.deg = deg.get(n.id) ?? 0;
      setData({ nodes: [...nodeMap.current.values()], links: [...linkMap.current.values()] });
    }
  }, [nodes, edges, centerId, layoutKey]);

  const pathNodes = useMemo(() => new Set(path?.nodes.map((n) => n.id) ?? []), [path]);
  const pathOrder = useMemo(() => new Map(path?.nodes.map((n, i) => [n.id, i]) ?? []), [path]);
  const pathLinks = useMemo(() => {
    const s = new Set<string>();
    for (const e of path?.edges ?? []) { s.add(`${e.from}|${e.to}`); s.add(`${e.to}|${e.from}`); }
    return s;
  }, [path]);
  const cited = useMemo(() => new Set(citedIds ?? []), [citedIds]);
  const hl = useMemo(() => new Set(highlightIds ?? []), [highlightIds]);
  const active = useMemo(() => new Set(activeIds ?? []), [activeIds]);
  const dimmed = (id: string) => hl.size > 0 && !hl.has(id) && !pathNodes.has(id);
  const isPathLink = (l: GLink) => pathLinks.has(`${idOf(l.source)}|${idOf(l.target)}`);

  // a big map's links are many and fine: fainter, so the things stand out
  const linkAlpha = Math.max(0.3, Math.min(1, 420 / Math.max(1, data.links.length)));
  const colors = useMemo(() => ({
    ink: dark ? oklch(0.95, 0.014, 265) : oklch(0.23, 0.07, 270),
    ink2: dark ? oklch(0.86, 0.022, 265) : oklch(0.33, 0.06, 270),
    muted: dark ? oklch(0.74, 0.035, 266) : oklch(0.47, 0.032, 268),
    halo: dark ? oklch(0.185, 0.045, 272) : oklch(0.985, 0.006, 85),
    haloSoft: dark ? oklch(0.185, 0.045, 272, 0.85) : oklch(0.985, 0.006, 85, 0.85),
    link: dark ? oklch(0.5, 0.05, 268, linkAlpha) : oklch(0.78, 0.02, 75, linkAlpha),
    linkFaint: dark ? oklch(0.48, 0.05, 268, 0.2) : oklch(0.8, 0.02, 75, 0.25),
    gold: dark ? oklch(0.79, 0.13, 85) : oklch(0.72, 0.125, 85),
    goldInk: dark ? oklch(0.83, 0.12, 86) : oklch(0.52, 0.11, 80),
    focus: dark ? oklch(0.76, 0.12, 268) : oklch(0.48, 0.16, 268),
    sim: oklch(0.62, 0.14, 65),
  }), [dark, linkAlpha]);

  const fill = (n: GNode) => {
    if (colorBy === "community") return oklch(dark ? 0.72 : 0.6, 0.11, COMMUNITY_HUES[(n.community ?? 0) % COMMUNITY_HUES.length]!);
    return oklch(dark ? 0.74 : 0.62, chromaFor(n.label), hueFor(n.label));
  };
  const radius = (n: GNode) => {
    if (n.id === centerId) return Math.max(9, rankScale?.[1] ?? 0);
    if (rankScale && sizeBy === "rank" && n.rank !== undefined) return rankRadius(n.rank, rankScale[0], rankScale[1]);
    const w = n.weight ?? (sizeBy === "rank" ? n.rank : undefined) ?? Math.min(1, n.deg / 6);
    return 3.2 + w * 4.5;
  };

  // focus a node when asked (citation chip, search result)
  useEffect(() => {
    if (!focusId) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      const n = nodeMap.current.get(focusId) as PNode | undefined;
      if (n?.x !== undefined && n.y !== undefined && fgRef.current) {
        fgRef.current.centerAt(n.x, n.y, reducedMotion ? 0 : 650);
        fgRef.current.zoom(Math.max(2.2, fgRef.current.zoom()), reducedMotion ? 0 : 650);
      } else if (tries++ < 12) timer = setTimeout(go, 200);
    };
    go();
    return () => clearTimeout(timer);
  }, [focusId, reducedMotion]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // a big map spreads out more, so its neighbourhoods read as neighbourhoods rather than one knot
    fg.d3Force("charge")?.strength?.(big ? -150 : -120);
    fg.d3Force("link")?.distance?.((l: GLink) => (isPathLink(l) ? 52 : big ? 54 : 40));
    fg.d3Force("gravity", gravity(0.06));
    fg.d3Force("wander", moving ? wander(0.014) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, pathLinks, size.w > 0, moving]);

  // offscreen (scrolled away, a hidden tab): stop drawing until it is back
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => {
      const fg = fgRef.current;
      if (!fg || !e) return;
      if (e.isIntersecting) fg.resumeAnimation(); else fg.pauseAnimation();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [size.w > 0]);

  // bring a highlighted set into view
  useEffect(() => {
    if (!hl.size) return;
    // again once things that were just added have found their place
    const go = () => fit(reducedMotion ? 0 : 600, (n) => hl.has((n as GNode).id), 56);
    const timers = [setTimeout(go, 80), setTimeout(go, 1100)];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl, reducedMotion]);

  // a path that arrives after the layout settled: show all of it
  useEffect(() => {
    if (!pathNodes.size || userMoved.current || focusId) return;
    const t = setTimeout(() => fit(reducedMotion ? 0 : 700), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathNodes, reducedMotion, fitPadding, focusId]);

  // a growing graph: refit every little while as new nodes arrive, so nothing grows out of frame
  useEffect(() => {
    if (!followGrowth || userMoved.current || focusId || hl.size || pathNodes.size) return;
    if (data.nodes.length === grownTo.current || growTimer.current) return;
    growTimer.current = setTimeout(() => {
      growTimer.current = undefined;
      grownTo.current = nodeMap.current.size;
      if (!userMoved.current) fit(reducedMotion ? 0 : 450);
    }, 420);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, followGrowth, focusId, hl, pathNodes, reducedMotion]);
  useEffect(() => () => clearTimeout(growTimer.current), []);

  // a big first drawing takes a while to settle (longer on a phone): bring it into view early, before the engine stops
  const hasData = data.nodes.length > 0;
  useEffect(() => {
    if (!hasData || moving || !big) return;
    const timers = [1200, 2800].map((ms) => setTimeout(() => { if (!userMoved.current && !focusId && !hl.size && !pathNodes.size) fit(reducedMotion ? 0 : 500); }, ms));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasData, layoutKey]);

  // a drifting graph never stops its engine, so it is fitted on a clock instead
  useEffect(() => {
    if (!moving || !data.nodes.length) return;
    const timers = [setTimeout(() => fit(0), 450), setTimeout(() => fit(900), 1800), setTimeout(() => fit(1200), 4200)];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, data.nodes.length, size.w, size.h]);

  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number) => {
    const fs = 11 / scale;
    const hover = hoverRef.current;
    type Rect = [number, number, number, number];
    const placed: Rect[] = [];
    const overlaps = (r: Rect, p: Rect) => r[0] < p[0] + p[2] && r[0] + r[2] > p[0] && r[1] < p[1] + p[3] && r[1] + r[3] > p[1];
    // labels keep off other nodes as well as off each other
    const dots: (Rect & { id?: string })[] = [];
    for (const g of nodeMap.current.values()) {
      const n = g as PNode;
      if (n.x === undefined || n.y === undefined || dimmed(n.id)) continue;
      // on a big map the tiny dots do not keep a label away; the bigger ones do
      if (big && radius(n) * scale < 4.5) continue;
      const r = radius(n) + 1.5 / scale;
      const box = [n.x - r, n.y - r, r * 2, r * 2] as Rect & { id?: string };
      box.id = n.id;
      dots.push(box);
    }
    const hit = (r: Rect, self?: string) => placed.some((p) => overlaps(r, p)) || dots.some((d) => d.id !== self && overlaps(r, d));
    const ranked: { n: PNode; pri: number }[] = [];
    // zooming in brings in the next things down: at twice the zoom, things half as important
    const floor = labelMinRank / Math.max(1, scale / 1.2) ** 2;
    for (const g of nodeMap.current.values()) {
      const n = g as PNode;
      if (n.x === undefined || n.y === undefined || dimmed(n.id)) continue;
      let pri = -1;
      if (n.id === focusId) pri = 100;
      else if (n.id === hover) pri = 90;
      else if (pathNodes.has(n.id)) pri = 80 - (pathOrder.get(n.id) ?? 0) * 0.1;
      else if (hl.has(n.id)) pri = 70;
      else if (active.has(n.id)) pri = 75;
      else if (labels === "none") pri = -1;
      else if (n.id === centerId) pri = 65;
      else if (labels === "all") pri = 20 + (n.rank ?? n.weight ?? 0);
      else if ((n.rank ?? 0) >= floor || (n.weight ?? 0) >= 0.75 || scale > 2.2) pri = 10 + (n.weight ?? n.rank ?? 0) * 10 + n.deg * 0.1;
      if (pri >= 0) ranked.push({ n, pri });
    }
    ranked.sort((a, b) => b.pri - a.pri);
    const fg = fgRef.current;
    const tl = fg?.screen2GraphCoords(0, 0), br = fg?.screen2GraphCoords(size.w, size.h);
    const m = 4 / scale;
    const view = tl && br ? { x0: tl.x + m, y0: tl.y + m, x1: br.x - m, y1: br.y - m } : { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const { n, pri } of ranked) {
      // a small picture with labels "none" names at most three of what is being read
      if (labels === "none" && pri < 80 && placed.length >= 3) break;
      const strong = pri >= 70;
      const inPath = pathNodes.has(n.id);
      ctx.font = `${strong ? 600 : 500} ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
      const max = inPath ? 26 : 30;
      const name = n.name.length > max ? n.name.slice(0, max - 2).trimEnd() + "…" : n.name;
      const text = inPath && pathOrder.has(n.id) ? `${pathOrder.get(n.id)! + 1}. ${name}` : name;
      const w = ctx.measureText(text).width + 4 / scale;
      const h = fs * 1.25;
      const r = radius(n);
      const gap = 2 / scale;
      const options: Rect[] = [
        [n.x! - w / 2, n.y! + r + gap, w, h],              // below
        [n.x! - w / 2, n.y! - r - gap - h, w, h],          // above
        [n.x! + r + gap * 2, n.y! - h / 2, w, h],          // right
        [n.x! - r - gap * 2 - w, n.y! - h / 2, w, h],      // left
      ];
      // keep labels inside the canvas: nudge sideways rather than run off an edge
      for (const o of options) {
        if (o[0] < view.x0) o[0] = view.x0;
        if (o[0] + o[2] > view.x1) o[0] = view.x1 - o[2];
      }
      const usable = options.filter((o) => o[1] >= view.y0 && o[1] + o[3] <= view.y1);
      let rect = usable.find((o) => !hit(o, n.id)) ?? null;
      // the path and the node in focus are always labelled: take the spot that covers the least
      if (!rect && pri >= 80) {
        const cost = (o: Rect) => placed.filter((p) => overlaps(o, p)).length * 3 + dots.filter((d) => d.id !== n.id && overlaps(o, d)).length;
        rect = [...(usable.length ? usable : options)].sort((a, b) => cost(a) - cost(b))[0]!;
      }
      if (!rect) continue;
      placed.push(rect);
      const tx = rect[0] + w / 2, ty = rect[1] + 0.5 / scale;
      ctx.lineWidth = 3.2 / scale;
      ctx.lineJoin = "round";
      ctx.strokeStyle = colors.haloSoft;
      ctx.strokeText(text, tx, ty);
      ctx.fillStyle = inPath || (active.has(n.id) && pri === 75) ? colors.goldInk : strong ? colors.ink : colors.ink2;
      ctx.fillText(text, tx, ty);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="graph-view"
      style={height ? { height } : undefined}
      role="img"
      aria-label={ariaLabel}
      onWheel={() => { if (interactive) userMoved.current = true; }}
      onPointerDown={() => { if (interactive) userMoved.current = true; }}
    >
      {size.w > 0 && size.h > 0 && (
        <ForceGraph2D<GNode, GLink>
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          autoPauseRedraw={false}
          cooldownTicks={moving ? Infinity : reducedMotion ? 80 : 200}
          cooldownTime={moving ? Infinity : 15000}
          warmupTicks={reducedMotion ? 80 : 12}
          d3VelocityDecay={0.32}
          minZoom={0.3}
          maxZoom={6}
          enableZoomInteraction={interactive}
          enablePanInteraction={interactive}
          enableNodeDrag={interactive}
          enablePointerInteraction={interactive}
          nodeRelSize={4}
          nodeVal={(n) => radius(n) ** 2 / 16}
          nodeLabel={(n) => `${kindName(n.label)} · ${n.name}`}
          linkLabel={(l) => relPhrase(l.type, "out")}
          onNodeHover={(n) => { hoverRef.current = n ? n.id : null; if (wrapRef.current) wrapRef.current.style.cursor = n && onNodeClick ? "pointer" : ""; }}
          onNodeClick={(n) => onNodeClick?.(n.id)}
          onBackgroundClick={() => onBackgroundClick?.()}
          onEngineStop={() => {
            // fit once per shape of the graph: when nodes arrive, and again once a path has settled
            const key = `${data.nodes.length}:${pathNodes.size}`;
            if (focusId || hl.size || userMoved.current || fitCount.current === key) return;
            fitCount.current = key;
            fit(reducedMotion ? 0 : 500);
          }}
          linkColor={(l) => (isPathLink(l) ? colors.gold : hl.size && (dimmed(idOf(l.source)) || dimmed(idOf(l.target))) ? colors.linkFaint : colors.link)}
          linkWidth={(l) => (isPathLink(l) ? 2.6 : 1)}
          linkDirectionalParticles={(l) => (isPathLink(l) && !reducedMotion ? 3 : 0)}
          linkDirectionalParticleWidth={3.6}
          linkDirectionalParticleSpeed={0.007}
          linkDirectionalParticleColor={() => colors.gold}
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={(n, ctx, scale) => {
            const node = n as PNode;
            const x = node.x ?? 0, y = node.y ?? 0;
            const r = radius(n);
            const inPath = pathNodes.has(n.id);
            const dim = dimmed(n.id);
            const age = performance.now() - n.born;
            ctx.globalAlpha = 1;
            if (age < 1400 && !reducedMotion) {
              // a new node arrives with a gold ripple
              const k = age / 1400;
              ctx.beginPath();
              ctx.arc(x, y, r + 2 + k * 10, 0, Math.PI * 2);
              ctx.strokeStyle = colors.gold;
              ctx.globalAlpha = 0.55 * (1 - k);
              ctx.lineWidth = 1.5 / scale + 0.6;
              ctx.stroke();
              ctx.globalAlpha = 1;
            }
            if (inPath) {
              ctx.beginPath();
              ctx.arc(x, y, r + 3.2, 0, Math.PI * 2);
              ctx.fillStyle = colors.gold;
              ctx.globalAlpha = 0.35;
              ctx.fill();
              ctx.globalAlpha = 1;
            }
            if (active.has(n.id) && !inPath) {
              // being read right now: a soft gold glow and a ring that breathes
              const t = reducedMotion ? 0.5 : (Math.sin(performance.now() / 260 + n.ph) + 1) / 2;
              ctx.beginPath();
              ctx.arc(x, y, r + 3 + t * 5, 0, Math.PI * 2);
              ctx.fillStyle = colors.gold;
              ctx.globalAlpha = 0.16 * (1 - t) + 0.06;
              ctx.fill();
              ctx.beginPath();
              ctx.arc(x, y, r + 2.6 + t * 1.6, 0, Math.PI * 2);
              ctx.strokeStyle = colors.gold;
              ctx.lineWidth = 1.8 / Math.min(scale, 1.6);
              ctx.globalAlpha = 0.65 + 0.35 * t;
              ctx.stroke();
              ctx.globalAlpha = 1;
            }
            if (dim) ctx.globalAlpha = 0.16;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = n.id === centerId ? colors.ink : fill(n);
            ctx.fill();
            if (dim) { ctx.globalAlpha = 1; return; }
            ctx.lineWidth = inPath ? 1.6 : 1;
            ctx.strokeStyle = inPath ? colors.goldInk : colors.halo;
            ctx.stroke();
            if (!dim && (n.id === focusId || cited.has(n.id) || hl.has(n.id))) {
              ctx.beginPath();
              ctx.arc(x, y, r + (n.id === focusId ? 5 : 2.4), 0, Math.PI * 2);
              ctx.strokeStyle = n.id === focusId ? colors.focus : colors.ink;
              ctx.lineWidth = (n.id === focusId ? 2 : 1) / Math.min(scale, 2);
              ctx.setLineDash(n.id === focusId ? [] : [2, 2]);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            if (n.simulated) {
              ctx.beginPath();
              ctx.arc(x, y, r + 1.6, 0, Math.PI * 2);
              ctx.setLineDash([1.5, 1.5]);
              ctx.strokeStyle = colors.sim;
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.setLineDash([]);
            }
            ctx.globalAlpha = 1;
          }}
          onRenderFramePost={drawLabels}
          nodePointerAreaPaint={(n, color, ctx) => {
            const node = n as PNode;
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, radius(n) + 3, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
          }}
        />
      )}
    </div>
  );
}
