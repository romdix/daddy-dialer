const KEYS = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
];

export function DialPad({
  onKey,
  compact = false,
  disabled = false,
}: {
  onKey: (d: string) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`grid grid-cols-3 ${compact ? 'gap-1.5' : 'gap-2'}`}>
      {KEYS.map(([k, sub]) => (
        <button
          key={k}
          type="button"
          disabled={disabled}
          onClick={() => onKey(k)}
          className={`flex flex-col items-center justify-center rounded-md border border-ink-700 bg-ink-900
                      text-zinc-100 hover:border-accent/60 hover:bg-ink-800 active:scale-95 transition
                      disabled:opacity-40 ${compact ? 'h-10' : 'h-12'}`}
        >
          <span className={`mono ${compact ? 'text-sm' : 'text-base'} leading-none`}>{k}</span>
          {sub && <span className="text-[8px] tracking-wider text-muted mt-0.5">{sub}</span>}
        </button>
      ))}
    </div>
  );
}
