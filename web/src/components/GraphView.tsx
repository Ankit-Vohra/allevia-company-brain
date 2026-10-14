// Force graph (react-force-graph-2d) that grows in place: node and link objects are kept and mutated, never recreated,
// because the library stores positions on them. The explanation path is lit in gold with travelling particles.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { EdgeRef, NodeRef } from "@shared/contracts";
import { oklch } from "../lib/color";
import { COMMUNITY_HUES, hueFor } from "../lib/labels";

export interface GNodeIn extends NodeRef { rank?: number; community?: number; weight?: number }

interface GNode extends GNodeIn { born: number; deg: number }
interface GLink { key: string; type: string; source: string | GNode; target: string | GNode; from: string; to: string }

export interface GraphViewProps {
  nodes: GNodeIn[];
  edges: EdgeRef[];
  path?: { nodes: NodeRef[]; edges: EdgeRef[] };
  focusId?: string;
  citedIds?: string[];
  colorBy?: "label" | "community";
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

export default function GraphView({
  nodes, edges, path, focusId, citedIds, colorBy = "label", dark, reducedMotion, onNodeClick, height, centerId, labels = "auto", ariaLabel, fitPadding = 36,
}: GraphViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<NodeObject<GNode>, LinkObject<GNode, GLink>> | undefined>(undefined);
  const nodeMap = useRef(new Map<string, GNode>());
  const linkMap = useRef(new Map<string, GLink>());
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [size, setSize] = useState({ w: 0, h: height ?? 0 });
  const [hover, setHover] = useState<string | null>(null);
  const fitted = useRef(false);

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
    for (const n of nodes) {
      const ex = nodeMap.current.get(n.id);
      if (ex) {
        if (ex.name !== n.name || ex.rank !== n.rank || ex.weight !== n.weight) { Object.assign(ex, n); changed = true; }
        continue;
      }
      const g: GNode = { ...n, born: nodeMap.current.size === 0 ? now - 5000 : now, deg: 0 };
      // start next to a neighbour already on screen, so new nodes grow out of the graph instead of flying in
      const link = edges.find((e) => (e.from === n.id && nodeMap.current.has(e.to)) || (e.to === n.id && nodeMap.current.has(e.from)));
      const anchor = link ? (nodeMap.current.get(link.from === n.id ? link.to : link.from) as NodeObject<GNode> | undefined) : undefined;
      if (anchor?.x !== undefined && anchor.y !== undefined) {
        (g as NodeObject<GNode>).x = anchor.x + (Math.random() - 0.5) * 20;
        (g as NodeObject<GNode>).y = anchor.y + (Math.random() - 0.5) * 20;
      }
      if (n.id === centerId) { (g as NodeObject<GNode>).fx = 0; (g as NodeObject<GNode>).fy = 0; }
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
  const isPathLink = (l: GLink) => pathLinks.has(`${idOf(l.source)}|${idOf(l.target)}`);

  const colors = useMemo(() => ({
    ink: dark ? oklch(0.95, 0.014, 265) : oklch(0.23, 0.07, 270),
    muted: dark ? oklch(0.74, 0.035, 266) : oklch(0.47, 0.032, 268),
    halo: dark ? oklch(0.185, 0.045, 272) : oklch(0.976, 0.006, 265),
    link: dark ? oklch(0.48, 0.05, 268) : oklch(0.8, 0.02, 265),
    gold: dark ? oklch(0.79, 0.13, 85) : oklch(0.72, 0.125, 85),
    goldInk: dark ? oklch(0.83, 0.12, 86) : oklch(0.52, 0.11, 80),
    focus: dark ? oklch(0.76, 0.12, 268) : oklch(0.48, 0.16, 268),
  }), [dark]);

  const fill = (n: GNode) => {
    const hue = colorBy === "community" ? COMMUNITY_HUES[(n.community ?? 0) % COMMUNITY_HUES.length]! : hueFor(n.label);
    const c = n.label === "Document" || n.label === "Chunk" ? 0.035 : 0.11;
    return oklch(dark ? 0.72 : 0.6, c, hue);
  };
  const radius = (n: GNode) => {
    if (n.id === centerId) return 9;
    const w = n.weight ?? n.rank ?? Math.min(1, n.deg / 6);
    return 3.2 + w * 4.5;
  };

  // focus a node when asked (citation chip, search result)
  useEffect(() => {
    if (!focusId) return;
    let tries = 0;
    const go = () => {
      const n = nodeMap.current.get(focusId) as NodeObject<GNode> | undefined;
      if (n?.x !== undefined && n.y !== undefined && fgRef.current) {
        fgRef.current.centerAt(n.x, n.y, reducedMotion ? 0 : 650);
        fgRef.current.zoom(Math.max(2.2, fgRef.current.zoom()), reducedMotion ? 0 : 650);
      } else if (tries++ < 10) setTimeout(go, 200);
    };
    go();
  }, [focusId, reducedMotion]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength?.(-110);
    const link = fg.d3Force("link");
    link?.distance?.((l: GLink) => (isPathLink(l) ? 34 : 42));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, pathLinks]);

  // refit while the graph is small and growing
  useEffect(() => { if (data.nodes.length <= 3) fitted.current = false; }, [data.nodes.length]);

  return (
    <div ref={wrapRef} className="graph-view" style={height ? { height } : undefined} role="img" aria-label={ariaLabel}>
      {size.w > 0 && size.h > 0 && (
        <ForceGraph2D<GNode, GLink>
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          autoPauseRedraw={false}
          cooldownTicks={reducedMotion ? 60 : 180}
          warmupTicks={reducedMotion ? 60 : 8}
          d3VelocityDecay={0.32}
          minZoom={0.4}
          maxZoom={6}
          nodeRelSize={4}
          nodeVal={(n) => radius(n) ** 2 / 16}
          nodeLabel={(n) => `${n.label} · ${n.name}`}
          linkLabel={(l) => l.type}
          onNodeHover={(n) => setHover(n ? n.id : null)}
          onNodeClick={(n) => onNodeClick?.(n.id)}
          onEngineStop={() => {
            if (!fitted.current && !focusId) { fgRef.current?.zoomToFit(reducedMotion ? 0 : 500, fitPadding); fitted.current = true; }
          }}
          linkColor={(l) => (isPathLink(l) ? colors.gold : colors.link)}
          linkWidth={(l) => (isPathLink(l) ? 2.6 : 1)}
          linkDirectionalParticles={(l) => (isPathLink(l) && !reducedMotion ? 3 : 0)}
          linkDirectionalParticleWidth={3.6}
          linkDirectionalParticleSpeed={0.007}
          linkDirectionalParticleColor={() => colors.gold}
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={(n, ctx, scale) => {
            const node = n as NodeObject<GNode>;
            const x = node.x ?? 0, y = node.y ?? 0;
            const r = radius(n);
            const inPath = pathNodes.has(n.id);
            const age = performance.now() - n.born;
            if (age < 1400 && !reducedMotion) {
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
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = n.id === centerId ? colors.ink : fill(n);
            ctx.fill();
            ctx.lineWidth = inPath ? 1.6 : 1;
            ctx.strokeStyle = inPath ? colors.goldInk : colors.halo;
            ctx.stroke();
            if (n.id === focusId || cited.has(n.id)) {
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
              ctx.strokeStyle = oklch(0.62, 0.14, 65);
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.setLineDash([]);
            }
            const showLabel = labels === "all" || inPath || n.id === focusId || n.id === hover || n.id === centerId || cited.has(n.id) || (n.rank ?? 0) >= 0.55 || (n.weight ?? 0) >= 0.8 || scale > 2.4;
            if (showLabel) {
              const fs = 11 / scale;
              ctx.font = `${inPath || n.id === focusId ? 600 : 500} ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              const text = n.name.length > 34 ? n.name.slice(0, 32) + "…" : n.name;
              const label = inPath && pathOrder.has(n.id) ? `${pathOrder.get(n.id)! + 1}. ${text}` : text;
              ctx.lineWidth = 3 / scale;
              ctx.strokeStyle = colors.halo;
              ctx.strokeText(label, x, y + r + 2.5);
              ctx.fillStyle = inPath ? colors.goldInk : colors.ink;
              ctx.fillText(label, x, y + r + 2.5);
            }
          }}
          nodePointerAreaPaint={(n, color, ctx) => {
            const node = n as NodeObject<GNode>;
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
