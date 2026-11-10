import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Leads } from './pages/Leads';
import { Sessions } from './pages/Sessions';
import { Callbacks } from './pages/Callbacks';
import { SessionDialer } from './pages/SessionDialer';
import { CallLog } from './pages/CallLog';
import { Settings } from './pages/Settings';
import { Admin } from './pages/Admin';

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-accent" />
        Loading…
      </div>
    </div>
  );
}

/** Waits for auth to resolve before deciding anything — no redirect loops. */
function Guard({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Splash />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function OnlyLoggedOut({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Splash />;
  if (me) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/admin" element={<Admin />} />
      <Route
        path="/login"
        element={
          <OnlyLoggedOut>
            <Login />
          </OnlyLoggedOut>
        }
      />
      <Route
        element={
          <Guard>
            <Shell />
          </Guard>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/callbacks" element={<Callbacks />} />
        <Route path="/sessions/:id" element={<SessionDialer />} />
        <Route path="/calls" element={<CallLog />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
