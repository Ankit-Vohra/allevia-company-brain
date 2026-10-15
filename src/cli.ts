// Allevia CLI: `npm run cli -- <command> [args]` (`npm run cli` alone lists the commands).
// Commands are discovered from src/cli/*.ts: each file exports `commands: Command[]` (see src/cli/_command.ts), so a
// new command is a new file (or an entry in an existing one). Files starting with "_" are helpers.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeAll } from "./graph/client.js";
import type { Command } from "./cli/_command.js";

const CLI_DIR = new URL("./cli/", import.meta.url);

export async function loadCommands(dir: URL = CLI_DIR): Promise<Command[]> {
  const files = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("_")).sort();
  const all: Command[] = [];
  for (const f of files) {
    const mod = (await import(new URL(f, dir).href)) as { commands?: Command[] };
    for (const c of mod.commands ?? []) {
      if (all.some((x) => x.name === c.name)) throw new Error(`duplicate CLI command "${c.name}" in src/cli/${f}`);
      all.push(c);
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

function help(commands: Command[]): string {
  const w = Math.max(...commands.map((c) => c.usage.length));
  return ["Usage: npm run cli -- <command> [args]", "", ...commands.map((c) => `  ${c.usage.padEnd(w)}  ${c.summary}`)].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const commands = await loadCommands();
  const [name, ...args] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log(help(commands));
    return 0;
  }
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    console.error(`Unknown command "${name}".\n\n${help(commands)}`);
    return 2;
  }
  try {
    return (await cmd.run(args)) ?? 0;
  } catch (e) {
    console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await closeAll();
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url) || pathToFileURL(invoked).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; process.exit(code); });
}
