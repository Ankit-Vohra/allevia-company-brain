// The answer's path, inside a chat reply's "How we got this": the things the answer stands on, joined by the real links
// the team followed, lit in gold and numbered in order. Drawn by the same renderer as the Brain map (GraphView), loaded
// only when "How we got this" is opened. A tap on a thing opens it on the Brain map.
import { Suspense, lazy } from "react";
import { useNavigate } from "react-router";
import type { EdgeRef, NodeRef } from "@shared/contracts";
import { useApp } from "../../state/app";

const GraphView = lazy(() => import("../GraphView"));

export function AnswerPath({ path }: { path: { nodes: NodeRef[]; edges: EdgeRef[] } }) {
  const { effectiveTheme, reducedMotion } = useApp();
  const nav = useNavigate();
  if (path.nodes.length < 2) return null;
  return (
    <section className="ct-path">
      <h4>The path to this answer</h4>
      <div className="ct-path-map">
        <Suspense fallback={<div className="skeleton" style={{ height: "100%" }} />}>
          <GraphView
            nodes={path.nodes}
            edges={path.edges}
            path={path}
            dark={effectiveTheme === "dark"}
            reducedMotion={reducedMotion}
            labels="all"
            sizeBy="degree"
            fitPadding={28}
            maxFitZoom={1.8}
            onNodeClick={(id) => nav(`/brain?node=${encodeURIComponent(id)}`)}
            ariaLabel={`The path to this answer: ${path.nodes.map((n) => n.name).join(", then ")}.`}
          />
        </Suspense>
      </div>
    </section>
  );
}
