import { Suspense, lazy, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router";
import { TopBar, TabBar } from "./components/TopBar";
import HomePage from "./pages/Home";

const OfficePage = lazy(() => import("./pages/Office").then((m) => ({ default: m.OfficePage })));
const AskPage = lazy(() => import("./pages/Ask"));
const ChatPage = lazy(() => import("./pages/Chat"));
const BrainPage = lazy(() => import("./pages/Brain"));
const InsightsPage = lazy(() => import("./pages/Insights"));
const ApprovalsPage = lazy(() => import("./pages/Approvals"));
const OnboardPage = lazy(() => import("./pages/Onboard"));
const ProgramPage = lazy(() => import("./pages/Program"));
const PlanPage = lazy(() => import("./pages/Plan"));
const StudioPage = lazy(() => import("./pages/Studio"));
const TeamPage = lazy(() => import("./pages/Team"));
const ConnectionsPage = lazy(() => import("./pages/Connections"));
const ConnectedPage = lazy(() => import("./pages/Connections").then((m) => ({ default: m.ConnectedPage })));

const TITLES: Record<string, string> = {
  "/": "Home", "/office": "Office", "/chat": "Chat", "/ask": "Ask", "/brain": "Brain", "/insights": "Insights", "/approvals": "Approvals", "/onboard": "Add a business",
  "/studio": "Studio", "/team": "Your team", "/plan": "Plan and credits", "/program": "Your growth plan", "/connections": "Your tools", "/connected": "Connected",
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
            <Route path="/" element={<HomePage />} />
            <Route path="/office" element={<OfficePage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:who" element={<ChatPage />} />
            <Route path="/chat/:who/:sessionId" element={<ChatPage />} />
            <Route path="/ask" element={<AskPage />} />
            <Route path="/ask/:sessionId" element={<AskPage />} />
            <Route path="/brain" element={<BrainPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/onboard" element={<OnboardPage />} />
            <Route path="/studio" element={<StudioPage />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/program" element={<ProgramPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/connected" element={<ConnectedPage />} />
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
