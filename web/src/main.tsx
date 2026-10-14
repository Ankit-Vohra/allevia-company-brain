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
import { detectMode } from "./api";
import { App } from "./App";
import { AppProvider } from "./state/app";

const root = createRoot(document.getElementById("root")!);

detectMode().then(({ mode, tenants }) => {
  root.render(
    <StrictMode>
      <AppProvider mode={mode} initialTenants={tenants}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppProvider>
    </StrictMode>,
  );
});
