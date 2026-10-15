// Static server for the synthetic fixture site (tests/fixtures/website/site). Serves "/about" from about.html,
// replaces {{ORIGIN}} in text files with the server's own origin, records every request (path and user agent), and
// has a few special routes: /missing (404), /redirect-private (302 to a cloud metadata address), /redirect-local
// (302 to localhost on the same port) and /slow (answers after a delay).
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_DIR = fileURLToPath(new URL("./site/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".xml": "application/xml", ".txt": "text/plain", ".png": "image/png",
};

export interface SiteServer { origin: string; port: number; requests: Array<{ path: string; ua: string; method: string }>; close: () => Promise<void> }

export async function startSite(extra: Record<string, (send: (status: number, headers: Record<string, string>, body?: string | Buffer) => void) => void> = {}): Promise<SiteServer> {
  const requests: SiteServer["requests"] = [];
  let origin = "";
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push({ path, ua: String(req.headers["user-agent"] ?? ""), method: req.method ?? "GET" });
    const send = (status: number, headers: Record<string, string>, body: string | Buffer = "") => {
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (extra[path]) return extra[path]!(send);
    if (path === "/missing") return send(404, { "content-type": "text/html" }, "<h1>Not found</h1>");
    if (path === "/redirect-private") return send(302, { location: "http://169.254.169.254/latest/meta-data/" });
    if (path === "/redirect-local") return send(302, { location: `http://localhost:${new URL(origin).port}/about` });
    let file = normalize(join(SITE_DIR, decodeURIComponent(path)));
    if (!file.startsWith(SITE_DIR)) return send(403, {});
    if (!extname(file) && existsSync(`${file.replace(/\/$/, "")}.html`)) file = `${file.replace(/\/$/, "")}.html`;
    else if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return send(404, { "content-type": "text/html" }, "<h1>Not found</h1>");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const raw = readFileSync(file);
    const body = /^(text|application\/xml)/.test(type) ? raw.toString("utf8").replaceAll("{{ORIGIN}}", origin) : raw;
    res.writeHead(200, { "content-type": type });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  return { origin, port, requests, close: () => new Promise((r) => server.close(() => r())) };
}
