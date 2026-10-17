// What the team is reading right now, for the Brain map and Home's living brain: the things each working person's latest
// look-up returned, from every run this tab follows. On the live server a question still working there (asked in another
// tab, on Discord, by a morning job) is attached through GET /turns/live, the way the Office does, so its events stream
// in here too. Nothing is made up: no run working, nothing pulses.
import { useEffect, useMemo, useRef } from "react";
import { api, getMode, getPublicMode } from "../api";
import { NOT_READING, mergeReading, readingNow, type Reading } from "../lib/brain-map";
import { runStore, useRunStore } from "./runs";

const LOOK_MS = 8000;

export function useReadingNow(tenant: string, enabled = true): Reading {
  const snap = useRunStore();

  useEffect(() => {
    if (!enabled || getMode() !== "live" || getPublicMode()) return;
    let live = true;
    const look = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      api.liveTurns(tenant).then((list) => {
        if (!live) return;
        for (const t of list.slice(0, 2)) runStore.attach(tenant, t);
      }, () => {});
    };
    look();
    const id = setInterval(look, LOOK_MS);
    return () => { live = false; clearInterval(id); };
  }, [tenant, enabled]);

  // the same things in the same order keep the same object, so the map does not redraw for every streamed word
  const last = useRef<Reading>(NOT_READING);
  return useMemo(() => {
    if (!enabled) return NOT_READING;
    const list: Reading[] = [];
    for (const key of snap.order) {
      const r = snap.runs.get(key);
      if (r && r.tenant === tenant && r.status === "running") list.push(readingNow(r.events));
    }
    const next = mergeReading(list);
    const same = next.ids.length === last.current.ids.length && next.ids.every((id, i) => id === last.current.ids[i])
      && next.who.join() === last.current.who.join();
    if (!same) last.current = next;
    return last.current;
  }, [snap, tenant, enabled]);
}
