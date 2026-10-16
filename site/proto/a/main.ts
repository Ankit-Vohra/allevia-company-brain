// Prototype A: the home page with the 3D brain. The scene is a separate chunk loaded once the page is parsed and the browser is idle,
// so the headline, the buttons and the still picture of the brain paint first.
import "../shared/entry.ts";
import "../shared/home.css";
import "../shared/pages.css";
import "./a.css";
import { initHome } from "../shared/home-client.ts";

initHome();
const hero = document.querySelector<HTMLElement>("[data-hero]");
if (hero) {
  const go = () => import("./hero3d.ts").then((m) => m.startHero(hero)).catch((e) => { console.error(e); hero.classList.add("hero--nogl"); });
  if ("requestIdleCallback" in window) (window as unknown as { requestIdleCallback: (f: () => void, o?: object) => void }).requestIdleCallback(go, { timeout: 800 });
  else setTimeout(go, 60);
}
