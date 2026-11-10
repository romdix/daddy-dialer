import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DialerProvider, useDialer } from '../lib/dialer';
import { BrandMark, useBrand } from '../lib/brand';
import { PhoneWidget } from './PhoneWidget';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/leads', label: 'Leads' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/callbacks', label: 'Callbacks' },
  { to: '/calls', label: 'Call Log' },
  { to: '/settings', label: 'Settings' },
];

export function Shell() {
  const { me, logout } = useAuth();
  const { brand } = useBrand();
  const nav = useNavigate();
  if (!me) return null;

  return (
    <DialerProvider workspaceId={me.workspace.id}>
      <div className="flex h-screen overflow-hidden">
        <aside className="flex w-[210px] shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
          <div className="flex h-14 items-center gap-2 border-b border-ink-800 px-4">
            <BrandMark size={24} />
            <span className="truncate font-semibold tracking-tight">{brand.name}</span>
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2 text-sm transition-colors ${
                    isActive ? 'bg-ink-800 text-white border border-ink-700' : 'text-zinc-400 hover:text-white hover:bg-ink-850'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-ink-800 p-3">
            <p className="truncate text-xs text-zinc-300">{me.user.fullName || me.user.email}</p>
            <p className="truncate text-2xs text-muted">{me.workspace.name}</p>
            <button
              className="mt-2 text-2xs text-muted hover:text-red-400"
              onClick={async () => {
                await logout();
                nav('/login');
              }}
            >
              Sign out
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <ActiveCallBar />
          <Outlet />
        </main>

        <PhoneWidget />
        <IncomingBanner />
      </div>
    </DialerProvider>
  );
}

/**
 * Persistent call banner. It sits at the top of the content area on every page,
 * so a call that is still live can never be missed after navigating away.
 */
function ActiveCallBar() {
  const d = useDialer();
  const active = d.status === 'connecting' || d.status === 'ringing' || d.status === 'live';

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  if (!active) return null;

  const who = d.active?.label || d.active?.to || 'Call';
  const mm = String(Math.floor(d.seconds / 60)).padStart(2, '0');
  const ss = String(d.seconds % 60).padStart(2, '0');
  const label = d.status === 'live' ? 'On call' : d.status === 'ringing' ? 'Ringing' : 'Connecting';

  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-red-900/60 bg-red-950/70 px-6 py-2 backdrop-blur">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
      </span>
      <span className="text-2xs font-semibold uppercase tracking-wider text-red-200">{label}</span>
      <span className="mono max-w-[260px] truncate text-xs text-zinc-100">{who}</span>
      <span className="mono text-xs text-red-200/80">
        {mm}:{ss}
      </span>
      {d.batch && d.batch.calls.length > 1 && (
        <span className="text-2xs text-amber-300">{d.batch.calls.length} lines</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button className="btn-ghost !py-1 text-2xs" onClick={d.toggleMute}>
          {d.muted ? 'Unmute' : 'Mute'}
        </button>
        <button className="btn-danger !py-1 text-xs" onClick={d.hangup}>
          End call
        </button>
      </div>
    </div>
  );
}

/** Rings in the browser when someone calls one of the workspace numbers. */
function IncomingBanner() {
  const d = useDialer();
  if (!d.incoming) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <div className="panel flex w-full max-w-md items-center gap-3 border-accent/40 bg-ink-900 p-4 shadow-2xl">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-2xs uppercase tracking-wider text-muted">Incoming call</p>
          <p className="mono truncate text-sm">{d.incoming.from || 'Unknown number'}</p>
        </div>
        <button className="btn-ghost !py-1.5 text-xs" onClick={d.declineIncoming}>
          Decline
        </button>
        <button className="btn-primary !py-1.5 text-xs" onClick={() => d.answerIncoming()}>
          Answer
        </button>
      </div>
    </div>
  );
}

export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-ink-800 px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
