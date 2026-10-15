import { Suspense, lazy, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router";
import { TopBar, TabBar } from "./components/TopBar";
import { OfficePage } from "./pages/Office";

const AskPage = lazy(() => import("./pages/Ask"));
const BrainPage = lazy(() => import("./pages/Brain"));
const InsightsPage = lazy(() => import("./pages/Insights"));
const ApprovalsPage = lazy(() => import("./pages/Approvals"));
const OnboardPage = lazy(() => import("./pages/Onboard"));
const SoonPage = lazy(() => import("./pages/Soon"));

const TITLES: Record<string, string> = {
  "/": "Office", "/ask": "Ask", "/brain": "Brain", "/insights": "Insights", "/approvals": "Approvals", "/onboard": "Add a business",
  "/studio": "Studio", "/team": "Tell your team", "/plan": "Plan and usage", "/program": "Your 90 days",
};

export function App() {
  const loc = useLocation();
  useEffect(() => {
    const base = "/" + (loc.pathname.split("/")[1] ?? "");
    document.title = `${TITLES[base] ?? "Allevia"} · Allevia`;
  }, [loc.pathname]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <TopBar />
      <main id="main" className="main" tabIndex={-1}>
        <Suspense fallback={<div className="page-loading" aria-busy="true"><span className="skeleton" /></div>}>
          <Routes>
            <Route path="/" element={<OfficePage />} />
            <Route path="/ask" element={<AskPage />} />
            <Route path="/ask/:sessionId" element={<AskPage />} />
            <Route path="/brain" element={<BrainPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/onboard" element={<OnboardPage />} />
            <Route path="/studio" element={<SoonPage id="studio" />} />
            <Route path="/team" element={<SoonPage id="team" />} />
            <Route path="/plan" element={<SoonPage id="plan" />} />
            <Route path="/program" element={<SoonPage id="program" />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      <TabBar />
    </div>
  );
}

function NotFound() {
  return (
    <div className="page-pad">
      <h1 className="page-title">Nothing filed under this address.</h1>
      <p className="muted" style={{ marginTop: 8 }}>Try the Office, or ask your team a question.</p>
    </div>
  );
}
