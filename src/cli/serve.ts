// `serve`: the API and the built web app on one port (spec §11.1). Runs until Ctrl-C.
import { parseArgs } from "node:util";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "serve",
    usage: "serve [--port 8787] [--host 127.0.0.1] [--model haiku] [--public] [--api-only]",
    summary: "Serve the API and the web app (web/dist); --public is the read-only demo",
    async run(args) {
      const { values } = parseArgs({
        args,
        options: {
          port: { type: "string" }, host: { type: "string" }, model: { type: "string" },
          public: { type: "boolean" }, "api-only": { type: "boolean" },
        },
      });
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
        console.error(`--port must be a TCP port, got "${values.port}"`);
        return 2;
      }
      const { startServer, untilStopped } = await import("../server/main.js");
      const { close } = await startServer({
        ...(port ? { port } : {}), ...(values.host ? { host: values.host } : {}), ...(values.model ? { model: values.model } : {}),
        ...(values.public ? { publicMode: true } : {}), ...(values["api-only"] ? { staticDir: null } : {}),
      });
      await untilStopped(close);
      return 0;
    },
  },
];
