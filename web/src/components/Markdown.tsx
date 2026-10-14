// Answer markdown with [[node-id]] citations rendered as chips that can focus the node on a graph.
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NodeRef } from "@shared/contracts";
import { hueFor, labelOfId, nameOfId } from "../lib/labels";

const CITE = /\[\[([^\]\n]+)\]\]/g;

/** Turn [[id]] into links the renderer recognises; hide a half-streamed "[[deci" at the end. */
export function prepare(md: string) {
  return md.replace(/\[\[[^\]]*$/, "").replace(CITE, (_m, id: string) => `[${id}](#cite:${encodeURIComponent(id)})`);
}

export function CitationChip({ id, node, onCite, active }: { id: string; node?: NodeRef; onCite?: (id: string) => void; active?: boolean }) {
  const label = node?.label ?? labelOfId(id);
  const name = node?.name ?? nameOfId(id);
  return (
    <button
      type="button"
      className={`cite${active ? " is-active" : ""}`}
      style={{ ["--hue" as string]: hueFor(label) }}
      onClick={(e) => { e.preventDefault(); onCite?.(id); }}
      title={`${label}: ${name}\n${id}`}
      aria-label={`Source: ${label}, ${name}. Show on graph.`}
    >
      <span className="cite-dot" aria-hidden="true" />
      <span className="cite-name">{name}</span>
    </button>
  );
}

interface Props { text: string; nodes?: Record<string, NodeRef>; onCite?: (id: string) => void; activeId?: string; className?: string }

export const Markdown = memo(function Markdown({ text, nodes, onCite, activeId, className }: Props) {
  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith("#cite:")) {
        const id = decodeURIComponent(href.slice(6));
        return <CitationChip id={id} node={nodes?.[id]} onCite={onCite} active={activeId === id} />;
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
  };
  return (
    <div className={`md ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(u) => u}>
        {prepare(text)}
      </ReactMarkdown>
    </div>
  );
});
