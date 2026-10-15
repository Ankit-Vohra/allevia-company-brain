// Server-sent events over fetch (EventSource cannot POST). Parses `event:` / `data:` blocks separated by a blank line,
// which is how the API frames every event (`event: <type>\ndata: <json>\n\n`); comment lines (`: ping`, the server's
// keepalive) are skipped.

export interface SseMessage { event: string; data: string; id?: string }

/** An API error: the server's JSON `{error}` sentence when it sent one, and the HTTP status. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function errorFrom(res: Response, path: string): Promise<ApiError> {
  let message = `${path} answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) message = body.error;
  } catch { /* not JSON: keep the status line */ }
  return new ApiError(message, res.status);
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n?/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const msg = parseBlock(block);
        if (msg) yield msg;
      }
    }
    buf += decoder.decode();
    const tail = parseBlock(buf.trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseMessage | null {
  if (!block) return null;
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}

/** POST a JSON body and stream back parsed JSON events. */
export async function postSse<T>(
  url: string,
  body: unknown,
  onEvent: (e: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res, url);
  if (!res.body) throw new ApiError(`${url} sent no stream`, res.status);
  for await (const msg of readSse(res.body, signal)) {
    try {
      onEvent(JSON.parse(msg.data) as T);
    } catch {
      // a malformed line is skipped rather than ending the stream
    }
  }
}
