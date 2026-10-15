// Force graph (react-force-graph-2d) that grows in place: node and link objects are kept and mutated, never recreated,
// because the library stores positions on them. The explanation path is lit in gold with travelling particles. Labels
// are drawn in one pass after the nodes, most important first, and a label that would collide with one already drawn
// is left out (hover a node to read it), so dense neighbourhoods stay legible.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { EdgeRef, NodeRef } from "@shared/contracts";
import { oklch } from "../lib/color";
import { COMMUNITY_HUES, hueFor } from "../lib/labels";

export interface GNodeIn extends NodeRef { rank?: number; community?: number; weight?: number }

interface GNode extends GNodeIn { born: number; deg: number }
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
  colorBy?: "label" | "community";
  /** Size nodes by PageRank (rank) instead of by how connected they are on screen. */
  sizeBy?: "rank" | "degree";
  dark: boolean;
  reducedMotion: boolean;
  onNodeClick?: (id: string) => void;
  height?: number;
  centerId?: string;
  labels?: "auto" | "all";
  ariaLabel: string;
  fitPadding?: number;
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

export default function GraphView({
  nodes, edges, path, focusId, citedIds, highlightIds, colorBy = "label", sizeBy = "rank", dark, reducedMotion, onNodeClick, height, centerId,
  labels = "auto", ariaLabel, fitPadding = 36,
}: GraphViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<PNode, LinkObject<GNode, GLink>> | undefined>(undefined);
  const nodeMap = useRef(new Map<string, GNode>());
  const linkMap = useRef(new Map<string, GLink>());
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [size, setSize] = useState({ w: 0, h: height ?? 0 });
  const hoverRef = useRef<string | null>(null);
  const fitCount = useRef(0);
  const userMoved = useRef(false);

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
    if (nodeMap.current.size && ![...nodeMap.current.keys()].some((id) => want.has(id))) {
      // a different graph altogether: start over, and fit it again
      nodeMap.current.clear();
      linkMap.current.clear();
      fitCount.current = 0;
      userMoved.current = false;
    }
    for (const n of nodes) {
      const ex = nodeMap.current.get(n.id);
      if (ex) {
        if (ex.name !== n.name || ex.rank !== n.rank || ex.weight !== n.weight || ex.community !== n.community) { Object.assign(ex, n); changed = true; }
        continue;
      }
      const g: GNode = { ...n, born: nodeMap.current.size === 0 ? now - 5000 : now, deg: 0 };
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
  }, [nodes, edges, centerId]);

  const pathNodes = useMemo(() => new Set(path?.nodes.map((n) => n.id) ?? []), [path]);
  const pathOrder = useMemo(() => new Map(path?.nodes.map((n, i) => [n.id, i]) ?? []), [path]);
  const pathLinks = useMemo(() => {
    const s = new Set<string>();
    for (const e of path?.edges ?? []) { s.add(`${e.from}|${e.to}`); s.add(`${e.to}|${e.from}`); }
    return s;
  }, [path]);
  const cited = useMemo(() => new Set(citedIds ?? []), [citedIds]);
  const hl = useMemo(() => new Set(highlightIds ?? []), [highlightIds]);
  const dimmed = (id: string) => hl.size > 0 && !hl.has(id) && !pathNodes.has(id);
  const isPathLink = (l: GLink) => pathLinks.has(`${idOf(l.source)}|${idOf(l.target)}`);

  const colors = useMemo(() => ({
    ink: dark ? oklch(0.95, 0.014, 265) : oklch(0.23, 0.07, 270),
    ink2: dark ? oklch(0.86, 0.022, 265) : oklch(0.33, 0.06, 270),
    muted: dark ? oklch(0.74, 0.035, 266) : oklch(0.47, 0.032, 268),
    halo: dark ? oklch(0.185, 0.045, 272) : oklch(0.976, 0.006, 265),
    haloSoft: dark ? oklch(0.185, 0.045, 272, 0.85) : oklch(0.976, 0.006, 265, 0.85),
    link: dark ? oklch(0.48, 0.05, 268) : oklch(0.8, 0.02, 265),
    linkFaint: dark ? oklch(0.48, 0.05, 268, 0.25) : oklch(0.8, 0.02, 265, 0.35),
    gold: dark ? oklch(0.79, 0.13, 85) : oklch(0.72, 0.125, 85),
    goldInk: dark ? oklch(0.83, 0.12, 86) : oklch(0.52, 0.11, 80),
    focus: dark ? oklch(0.76, 0.12, 268) : oklch(0.48, 0.16, 268),
    sim: oklch(0.62, 0.14, 65),
  }), [dark]);

  const fill = (n: GNode) => {
    const hue = colorBy === "community" ? COMMUNITY_HUES[(n.community ?? 0) % COMMUNITY_HUES.length]! : hueFor(n.label);
    const c = n.label === "Document" || n.label === "Chunk" ? 0.035 : 0.11;
    return oklch(dark ? 0.72 : 0.6, c, hue);
  };
  const radius = (n: GNode) => {
    if (n.id === centerId) return 9;
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
    fg.d3Force("charge")?.strength?.(-120);
    fg.d3Force("link")?.distance?.((l: GLink) => (isPathLink(l) ? 52 : 40));
    fg.d3Force("gravity", gravity(0.06));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, pathLinks, size.w > 0]);

  // bring a highlighted set into view
  useEffect(() => {
    if (!hl.size) return;
    const t = setTimeout(() => fgRef.current?.zoomToFit(reducedMotion ? 0 : 600, 56, (n) => hl.has((n as GNode).id)), 80);
    return () => clearTimeout(t);
  }, [hl, reducedMotion]);

  // a path that arrives after the layout settled: show all of it
  useEffect(() => {
    if (!pathNodes.size || userMoved.current || focusId) return;
    const t = setTimeout(() => fgRef.current?.zoomToFit(reducedMotion ? 0 : 700, fitPadding), 900);
    return () => clearTimeout(t);
  }, [pathNodes, reducedMotion, fitPadding, focusId]);

  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number) => {
    const fs = 11 / scale;
    const hover = hoverRef.current;
    const placed: [number, number, number, number][] = [];
    const hit = (r: [number, number, number, number]) => placed.some((p) => r[0] < p[0] + p[2] && r[0] + r[2] > p[0] && r[1] < p[1] + p[3] && r[1] + r[3] > p[1]);
    const ranked: { n: PNode; pri: number }[] = [];
    for (const g of nodeMap.current.values()) {
      const n = g as PNode;
      if (n.x === undefined || n.y === undefined || dimmed(n.id)) continue;
      let pri = -1;
      if (n.id === focusId) pri = 100;
      else if (n.id === hover) pri = 90;
      else if (pathNodes.has(n.id)) pri = 80 - (pathOrder.get(n.id) ?? 0) * 0.1;
      else if (hl.has(n.id)) pri = 70;
      else if (n.id === centerId) pri = 65;
      else if (labels === "all") pri = 20 + (n.rank ?? n.weight ?? 0);
      else if ((n.rank ?? 0) >= 0.5 || (n.weight ?? 0) >= 0.75 || scale > 2.2) pri = 10 + (n.weight ?? n.rank ?? 0) * 10 + n.deg * 0.1;
      if (pri >= 0) ranked.push({ n, pri });
    }
    ranked.sort((a, b) => b.pri - a.pri);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const { n, pri } of ranked) {
      const strong = pri >= 70;
      const inPath = pathNodes.has(n.id);
      ctx.font = `${strong ? 600 : 500} ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
      const name = n.name.length > 30 ? n.name.slice(0, 28) + "…" : n.name;
      const text = inPath && pathOrder.has(n.id) ? `${pathOrder.get(n.id)! + 1}. ${name}` : name;
      const w = ctx.measureText(text).width + 4 / scale;
      const h = fs * 1.25;
      const r = radius(n);
      const below: [number, number, number, number] = [n.x! - w / 2, n.y! + r + 2 / scale, w, h];
      const above: [number, number, number, number] = [n.x! - w / 2, n.y! - r - 2 / scale - h, w, h];
      const rect = !hit(below) ? below : !hit(above) ? above : pri >= 90 ? below : null;
      if (!rect) continue;
      placed.push(rect);
      const tx = n.x!, ty = rect[1] + 0.5 / scale;
      ctx.lineWidth = 3.2 / scale;
      ctx.lineJoin = "round";
      ctx.strokeStyle = colors.haloSoft;
      ctx.strokeText(text, tx, ty);
      ctx.fillStyle = inPath ? colors.goldInk : strong ? colors.ink : colors.ink2;
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
      onWheel={() => { userMoved.current = true; }}
      onPointerDown={() => { userMoved.current = true; }}
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
          cooldownTicks={reducedMotion ? 80 : 200}
          warmupTicks={reducedMotion ? 80 : 12}
          d3VelocityDecay={0.32}
          minZoom={0.3}
          maxZoom={6}
          nodeRelSize={4}
          nodeVal={(n) => radius(n) ** 2 / 16}
          nodeLabel={(n) => `${n.label} · ${n.name}`}
          linkLabel={(l) => l.type}
          onNodeHover={(n) => { hoverRef.current = n ? n.id : null; if (wrapRef.current) wrapRef.current.style.cursor = n && onNodeClick ? "pointer" : ""; }}
          onNodeClick={(n) => onNodeClick?.(n.id)}
          onEngineStop={() => {
            if (focusId || hl.size || userMoved.current || fitCount.current === data.nodes.length) return;
            fitCount.current = data.nodes.length;
            fgRef.current?.zoomToFit(reducedMotion ? 0 : 500, fitPadding);
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
            if (dim) ctx.globalAlpha = 0.18;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = n.id === centerId ? colors.ink : fill(n);
            ctx.fill();
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
