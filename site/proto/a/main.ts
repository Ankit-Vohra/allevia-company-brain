// Prototype A: the home page with the 3D brain. The scene is a separate chunk loaded once the page is parsed and the browser is idle,
// so the headline, the buttons and the still picture of the brain paint first.
import "../shared/entry.ts";
import "../shared/home.css";
import "../shared/pages.css";
import "./a.css";
import { initHome } from "../shared/home-client.ts";
import { isPhone } from "../shared/chrome.ts";
import { copyExtent, heroLayout } from "./hero-layout.ts";

initHome();
const hero = document.querySelector<HTMLElement>("[data-hero]");
if (hero) {
  // Place the still brain exactly where the 3D scene will put it, before the stage fades in, so nothing moves when the scene starts.
  const stage = hero.querySelector<HTMLElement>("[data-stage]");
  if (stage) {
    const place = () => {
      if (stage.classList.contains("is-live")) return; // the scene has taken over and keeps these values itself
      const r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const l = heroLayout(r.width, r.height, copyExtent(hero, r.left), isPhone());
      stage.style.setProperty("--bx", `${l.cx.toFixed(1)}px`);
      stage.style.setProperty("--by", `${l.cy.toFixed(1)}px`);
      stage.style.setProperty("--k", l.k.toFixed(4));
      stage.classList.add("is-placed");
    };
    place();
    new ResizeObserver(place).observe(stage);
    void document.fonts?.ready.then(place);
  }
  const go = () => import("./hero3d.ts").then((m) => m.startHero(hero)).catch((e) => { console.error(e); hero.classList.add("hero--nogl"); });
  if ("requestIdleCallback" in window) (window as unknown as { requestIdleCallback: (f: () => void, o?: object) => void }).requestIdleCallback(go, { timeout: 800 });
  else setTimeout(go, 60);
}
