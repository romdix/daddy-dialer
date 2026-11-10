import { useState } from 'react';

/** Exports and the do-not-call import. */
export function DataPanel() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const importDnc = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      const text = await file.text();
      // Accept a bare list, or a CSV whose first column is the number.
      const tokens = text
        .split(/[\r\n,;]+/)
        .map((t) => t.replace(/["']/g, '').trim())
        .filter((t) => t.replace(/\D/g, '').length >= 7);

      if (!tokens.length) {
        setMsg('No phone numbers found in that file.');
        return;
      }
      const res = await fetch('/api/leads/do-not-call', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numbers: tokens }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Import failed');
      setMsg(
        `${data.valid} numbers read, ${data.marked} matching leads marked Do Not Call and disqualified.`,
      );
    } catch (e: any) {
      setMsg(e?.message || 'Could not import that list');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel p-4">
      <h2 className="text-sm font-semibold">Data &amp; compliance</h2>
      <p className="mt-1 text-xs text-muted">
        Take your data out whenever you want, and make sure numbers that asked not to be called are never dialled.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a className="btn-ghost !py-1.5 text-xs" href="/api/leads/export.csv">
          Export leads (CSV)
        </a>
        <a className="btn-ghost !py-1.5 text-xs" href="/api/calls/export.csv">
          Export call log (CSV)
        </a>
        <label className="btn-ghost !py-1.5 text-xs cursor-pointer">
          {busy ? 'Importing…' : 'Import Do-Not-Call list'}
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importDnc(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {msg && <p className="mt-2 text-2xs text-accent">{msg}</p>}

      <p className="mt-2 text-2xs leading-relaxed text-muted">
        The Do-Not-Call file can be one number per line or a CSV — every number it can read is matched against your
        leads. Matches are marked <span className="mono">do_not_call</span> and disqualified, and the dialler refuses
        them on every future attempt.
      </p>
    </section>
  );
}
