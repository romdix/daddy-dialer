import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DialerProvider } from '../lib/dialer';
import { BrandMark, useBrand } from '../lib/brand';
import { PhoneWidget } from './PhoneWidget';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/leads', label: 'Leads' },
  { to: '/sessions', label: 'Sessions' },
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
      <div className="flex min-h-screen">
        <aside className="w-[210px] shrink-0 border-r border-ink-800 bg-ink-900/60">
          <div className="flex items-center gap-2 px-4 h-14 border-b border-ink-800">
            <BrandMark size={24} />
            <span className="truncate font-semibold tracking-tight">{brand.name}</span>
          </div>

          <nav className="p-2 space-y-0.5">
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

          <div className="absolute bottom-0 w-[210px] border-t border-ink-800 p-3">
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

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>

        <PhoneWidget />
      </div>
    </DialerProvider>
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
