// The top bar's two behaviours: a hairline once the page has scrolled (an IntersectionObserver on a sentinel, no scroll listener) and
// the menu on a phone. Also the reduced-motion and data-saver checks every script here uses.
export const reduceMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const saveData = (): boolean => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
export const isPhone = (): boolean => window.matchMedia("(max-width: 52rem)").matches;

export function initChrome(): void {
  const nav = document.querySelector<HTMLElement>("[data-nav]");
  if (!nav) return;
  const sentinel = document.createElement("div");
  sentinel.setAttribute("aria-hidden", "true");
  sentinel.style.cssText = "position:absolute;top:0;left:0;width:1px;height:8px;pointer-events:none";
  document.body.prepend(sentinel);
  new IntersectionObserver(([e]) => nav.classList.toggle("is-stuck", !!e && !e.isIntersecting)).observe(sentinel);
  const btn = nav.querySelector<HTMLButtonElement>("[data-nav-menu]");
  btn?.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => { nav.classList.remove("is-open"); btn?.setAttribute("aria-expanded", "false"); }));
}
