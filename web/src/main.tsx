import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/theme.css";
import { detectMode } from "./api";
import { App } from "./App";
import { AUTH_PATH, wantsDemo } from "./lib/account";
import { AuthApp } from "./pages/Auth";
import { NeedsLink } from "./pages/NeedsLink";
import { AppProvider } from "./state/app";

const root = createRoot(document.getElementById("root")!);
const go = (path: string) => history.replaceState(null, "", path);

detectMode().then(({ mode, tenants, needsLink, authRequired, account }) => {
  const own = tenants.some((t) => !t.readOnly);
  const demo = tenants.some((t) => t.readOnly);
  if (authRequired) {
    const path = location.pathname;
    // An owner link in the address bar that did not open: say so (with a way to sign in instead).
    if (needsLink && !account && !own) {
      root.render(<StrictMode><NeedsLink failed={needsLink.failed} /></StrictMode>);
      return;
    }
    // Signed in already: the sign-in and sign-up pages go home.
    if (account && /^\/(?:login|signup)\/?$/.test(path)) go("/");
    // Signed out, with no business of their own: sign in (or sign up), unless they asked to look at the demo.
    else if (!account && !own && !AUTH_PATH.test(path) && !(demo && wantsDemo())) {
      go(path === "/" ? "/login" : `/login?next=${encodeURIComponent(path + location.search)}`);
    }
    if (AUTH_PATH.test(location.pathname)) {
      root.render(<StrictMode><AuthApp account={account ?? null} demo={demo} /></StrictMode>);
      return;
    }
    // Signed in with no business yet: straight to setting it up.
    if (account && !own && location.pathname === "/") go("/onboard");
  }
  root.render(
    <StrictMode>
      <AppProvider mode={mode} initialTenants={tenants} authRequired={!!authRequired} account={account ?? null}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppProvider>
    </StrictMode>,
  );
});
