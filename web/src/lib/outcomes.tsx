import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { OUTCOMES as STATIC_KEYS, OUTCOME_LABEL, outcomeColor } from './format';

/** Colour tokens the admin can pick from for a tag. */
export const TAG_COLORS = ['green', 'emerald', 'sky', 'violet', 'amber', 'red', 'rose', 'zinc'] as const;

const PALETTE: Record<string, string> = {
  green: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300',
  emerald: 'border-emerald-700/60 bg-emerald-900/40 text-emerald-200',
  sky: 'border-sky-800/60 bg-sky-950/40 text-sky-300',
  violet: 'border-violet-800/60 bg-violet-950/40 text-violet-300',
  amber: 'border-amber-800/60 bg-amber-950/30 text-amber-300',
  red: 'border-red-900/60 bg-red-950/40 text-red-300',
  rose: 'border-rose-900/60 bg-rose-950/40 text-rose-300',
  zinc: 'border-ink-600 bg-ink-800 text-zinc-300',
};

export interface Tag {
  id: string;
  key: string;
  label: string;
  color: string;
  kind: string;
  sort: number;
}

const FALLBACK: Tag[] = STATIC_KEYS.map((k, i) => ({
  id: k,
  key: k,
  label: OUTCOME_LABEL[k],
  color: 'zinc',
  kind: 'custom',
  sort: i,
}));

/** Tags come from the database; the built-in list is only a fallback. */
export function useTags() {
  const { data } = useQuery<{ rows: Tag[] }>({
    queryKey: ['tags'],
    queryFn: () => api.get('/api/outcomes'),
    staleTime: 5 * 60_000,
  });

  const rows = data?.rows ?? FALLBACK;
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return {
    rows,
    label: (k?: string | null) => {
      if (!k) return '—';
      return byKey.get(k)?.label || OUTCOME_LABEL[k] || k;
    },
    color: (k?: string | null) => {
      const tag = k ? byKey.get(k) : null;
      if (tag) return PALETTE[tag.color] || PALETTE.zinc;
      return outcomeColor(k);
    },
  };
}

export function OutcomeBadge({ outcome, className = '' }: { outcome?: string | null; className?: string }) {
  const { label, color } = useTags();
  if (!outcome) return <span className="text-zinc-700">—</span>;
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-2xs ${color(outcome)} ${className}`}>
      {label(outcome)}
    </span>
  );
}
