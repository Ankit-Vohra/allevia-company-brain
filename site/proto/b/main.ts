// Prototype B: the home page with the calm diagram. The hero script is a separate chunk loaded once the page is parsed and idle.
import "../shared/entry.ts";
import "../shared/home.css";
import "../shared/pages.css";
import "./b.css";
import { initHome } from "../shared/home-client.ts";

initHome();
const hero = document.querySelector<HTMLElement>("[data-bhero]");
if (hero) {
  const go = () => import("./hero2d.ts").then((m) => m.startBHero(hero)).catch((e) => console.error(e));
  if ("requestIdleCallback" in window) (window as unknown as { requestIdleCallback: (f: () => void, o?: object) => void }).requestIdleCallback(go, { timeout: 600 });
  else setTimeout(go, 50);
}
