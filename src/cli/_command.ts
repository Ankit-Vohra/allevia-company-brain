// The CLI command contract. Every file in src/cli/ (except "_" helpers) exports `commands: Command[]`; src/cli.ts
// discovers them, so adding a command is a one-file change.
export interface Command {
  name: string;      // e.g. "ask", "db:check"
  usage: string;     // e.g. 'ask <tenant> "<question>" [--model haiku]'
  summary: string;   // one line for `help`
  run(args: string[]): Promise<number | void>; // exit code (default 0)
}
