// Pretty-prints an AgentEvent stream as a readable work log: who did what (agent name, coloured by department), the
// tools they called, findings, reviews, the streamed answer, the path and the checks. Used by `ask` and `replay`.
import { agentById, departmentById } from "../../shared/roster.js";
import type { AgentEvent } from "../../shared/contracts.js";

export interface WorkLogOpts { color?: boolean; write?: (s: string) => void }

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

// oklch-ish hue -> the nearest xterm-256 colour (HSL with fixed saturation/lightness is close enough for a terminal).
export function hueTo256(hue: number): number {
  const s = 0.65, l = 0.6;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const [r, g, b] = [f(0), f(8), f(4)].map((v) => Math.round(v * 5));
  return 16 + 36 * r! + 6 * g! + b!;
}

export function workLog(opts: WorkLogOpts = {}): (e: AgentEvent) => void {
  const write = opts.write ?? ((s: string) => { process.stdout.write(s); });
  const color = opts.color ?? (!!process.stdout.isTTY && !process.env.NO_COLOR);
  const sgr = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s: string) => sgr("2", s);
  const bold = (s: string) => sgr("1", s);
  const red = (s: string) => sgr("31", s);
  const green = (s: string) => sgr("32", s);
  const yellow = (s: string) => sgr("33", s);
  const who = (id: string | undefined): string => {
    if (!id) return "Allevia";
    const a = agentById(id);
    if (!a) return id;
    const d = departmentById(a.department);
    return sgr(`1;38;5;${hueTo256(d?.hue ?? 0)}`, a.name);
  };
  const role = (id: string): string => {
    const a = agentById(id);
    const d = a ? departmentById(a.department) : undefined;
    return a ? dim(`${a.title}${d ? `, ${d.name}` : ""}`) : "";
  };

  let inText = false;
  const line = (s: string) => {
    if (inText) { write("\n"); inText = false; }
    write(`${s}\n`);
  };

  return (e: AgentEvent) => {
    switch (e.type) {
      case "session":
        line(`${bold(e.question)}\n${dim(`${e.tenant} · ${e.sessionId} · ${e.turnId}`)}`);
        break;
      case "recall": {
        const lines = e.brief.split("\n").filter((l) => l.startsWith("- ")).slice(0, 3);
        line(dim(e.ids.length ? `Recall: ${e.ids.length} things we already know` : "Recall: nothing recorded yet"));
        for (const l of lines) line(dim(`  ${clip(l, 110)}`));
        break;
      }
      case "plan":
        line(`${who(e.by)} planned${e.rationale ? `: ${e.rationale}` : ""}`);
        e.steps.forEach((s, i) => line(`  ${i + 1}. ${who(s.agent)} ${s.task}${s.after?.length ? dim(` (after ${s.after.map((a) => agentById(a)?.name ?? a).join(", ")})`) : ""}`));
        break;
      case "agent_start":
        line(`> ${who(e.agent)} ${role(e.agent)}: ${e.task}`);
        break;
      case "agent_status":
        line(dim(`    ${agentById(e.agent)?.name ?? e.agent}: ${e.text}`));
        break;
      case "tool_call":
        line(dim(`    ${agentById(e.agent)?.name ?? e.agent} -> ${e.name} ${clip(JSON.stringify(e.args ?? {}), 90)}`));
        break;
      case "tool_result":
        line(dim(`    ${agentById(e.agent)?.name ?? e.agent} <- ${e.name}: ${e.summary}`));
        break;
      case "handoff":
        line(`  ${who(e.from)} hands off to ${who(e.to)}: ${dim(e.note)}`);
        break;
      case "finding":
        line(`  ${who(e.agent)} finding ${dim(e.findingId)}${e.basedOn?.length ? dim(` (builds on ${e.basedOn.join(", ")})`) : ""}`);
        for (const l of e.text.split("\n")) line(`    ${l}`);
        break;
      case "review": {
        const v = e.verdict === "ok" ? green("OK") : e.verdict === "fix" ? yellow("FIX") : red("REJECT");
        line(`  ${who(e.agent)} reviewed ${dim(e.findingId)}: ${v} ${e.note}`);
        break;
      }
      case "proposal":
        line(`  ${who(e.agent)} proposed: ${bold(e.title)} (${e.kind}) ${dim(`${e.recommendationId} -> ${e.approvalId}`)}`);
        break;
      case "agent_done":
        line(`< ${who(e.agent)} ${e.ok ? `done in ${(e.ms / 1000).toFixed(1)}s` : red(`failed after ${(e.ms / 1000).toFixed(1)}s`)}`);
        break;
      case "text":
        if (!inText) { write(`\n${bold("Answer")}\n`); inText = true; }
        write(e.delta);
        break;
      case "path":
        line(`${bold("Path")}: ${e.nodes.map((n) => n.name || n.id).join(" -> ") || dim("(none)")}`);
        break;
      case "error":
        line(red(`Error${e.agent ? ` (${agentById(e.agent)?.name ?? e.agent})` : ""}: ${e.message}`));
        break;
      case "final": {
        const c = e.checks;
        const mark = (ok: boolean, extra = "") => (ok ? green("ok") : red(`FAIL${extra}`));
        line("");
        line(`${bold("Checks")}: citations ${mark(c.citationsValid, c.invalidCitations.length ? ` (${c.invalidCitations.join(", ")})` : "")}` +
          ` · numbers ${mark(c.numbersGrounded, c.ungroundedNumbers.length ? ` (${c.ungroundedNumbers.join(", ")})` : "")}` +
          ` · simulated ${mark(c.simulatedDisclosed)} · freshness ${mark(c.freshnessDisclosed)}` +
          (c.modeDisclosed === undefined ? "" : ` · data source ${mark(c.modeDisclosed)}`));
        line(dim(`${(e.ms / 1000).toFixed(1)}s · ${e.agents.map((a) => agentById(a)?.name ?? a).join(", ") || "no agents"} · ${e.turnId}`));
        break;
      }
    }
  };
}
