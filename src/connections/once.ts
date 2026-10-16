// One read at a time per business and connection: a second ask while the first is still running gets the first one's answer
// (the first look right after connecting and a "read now" tap must not write the same numbers twice at once).
const running = new Map<string, Promise<unknown>>();

export function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const have = running.get(key) as Promise<T> | undefined;
  if (have) return have;
  const p = fn().finally(() => { if (running.get(key) === p) running.delete(key); });
  running.set(key, p);
  return p;
}
