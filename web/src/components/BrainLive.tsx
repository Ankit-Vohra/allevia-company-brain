// The living brain: the business's real FalkorDB graph, drawn small and moving, for the top of Home (and anywhere a page
// wants the brain in view). A tap opens the Brain page. This is the shared slot: the Brain builder fills it in; pages only
// place it, with the business's id and a height.
export interface BrainLiveProps { tenant: string; height?: number }

export default function BrainLive({ height = 220 }: BrainLiveProps) {
  return <div className="brain-live" style={{ height }} aria-hidden="true" />;
}
