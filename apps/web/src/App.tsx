import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { Dashboard } from "./pages/Dashboard";
import { History } from "./pages/History";
import { Dictionary } from "./pages/Dictionary";
import { Settings } from "./pages/Settings";
import { Diagnostics } from "./pages/Diagnostics";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/history", label: "History", end: false },
  { to: "/dictionary", label: "Dictionary", end: false },
  { to: "/settings", label: "Settings", end: false },
  { to: "/diagnostics", label: "Diagnostics", end: false },
];

function NotFound() {
  return (
    <div className="card">
      <div className="card-body">
        <h2>Page not found</h2>
        <p className="muted">
          This dashboard has five pages: dashboard, history, dictionary, settings and diagnostics.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <div className="app">
          <header className="app-header">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M8 1a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4A2.5 2.5 0 0 1 8 1Z" />
                  <path d="M3.5 7a.75.75 0 0 1 1.5 0 3 3 0 0 0 6 0 .75.75 0 0 1 1.5 0 4.5 4.5 0 0 1-3.75 4.44V14h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5H7.25v-2.56A4.5 4.5 0 0 1 3.5 7Z" />
                </svg>
              </span>
              LocalVoiceFlow
            </div>
            <nav className="nav">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </header>

          <main className="app-main">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/history" element={<History />} />
              <Route path="/dictionary" element={<Dictionary />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/diagnostics" element={<Diagnostics />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>

          <footer className="app-footer">
            <span>Runs entirely on this Mac. Audio is processed locally.</span>
          </footer>
        </div>
      </BrowserRouter>
    </ToastProvider>
  );
}
