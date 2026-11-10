import { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { api } from '../lib/api';
import { Modal } from '../components/ui';

const TARGETS: { key: string; label: string; required?: boolean }[] = [
  { key: 'business_name', label: 'Business name' },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'website', label: 'Website' },
  { key: 'email', label: 'Email' },
  { key: 'notes', label: 'Notes' },
];

const SYNONYMS: Record<string, string[]> = {
  business_name: ['businessname', 'business', 'company', 'companyname', 'name', 'title', 'account'],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'cell', 'number', 'phonenumbers'],
  address: ['address', 'street', 'streetaddress', 'addr', 'address1', 'location'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'province', 'region', 'st'],
  zip: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode'],
  website: ['website', 'url', 'site', 'web'],
  email: ['email', 'emailaddress', 'mail'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function ImportDialog({
  open,
  asUserId,
  onClose,
  onDone,
}: {
  open: boolean;
  asUserId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; duplicates: number; invalid: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState('');

  const parse = (text: string) => {
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    });
    const fields = (parsed.meta.fields || []).filter(Boolean);
    if (!fields.length) {
      setError('Could not find a header row. The first line should be column names like business_name,phone,city.');
      return;
    }
    setHeaders(fields);
    setRows(parsed.data.filter((r) => Object.values(r).some((v) => String(v || '').trim())));
    setError(null);

    const auto: Record<string, string> = {};
    for (const t of TARGETS) {
      const hit = fields.find((f) => SYNONYMS[t.key]?.includes(norm(f)));
      if (hit) auto[t.key] = hit;
    }
    if (!auto.phone) {
      const fuzzy = fields.find((f) => norm(f).includes('phone') || norm(f).includes('number'));
      if (fuzzy) auto.phone = fuzzy;
    }
    if (!auto.business_name) {
      const fuzzy = fields.find((f) => norm(f).includes('business') || norm(f).includes('name') || norm(f).includes('company'));
      if (fuzzy) auto.business_name = fuzzy;
    }
    setMapping(auto);
  };

  const onFile = (f: File) => {
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => parse(String(reader.result || ''));
    reader.readAsText(f);
  };

  const preview = useMemo(() => rows.slice(0, 5), [rows]);
  const mappedOK = Boolean(mapping.phone);

  const runImport = async () => {
    if (!mappedOK) return;
    setBusy(true);
    setError(null);
    try {
      const records = rows.map((r) => {
        const out: any = {};
        for (const t of TARGETS) {
          const col = mapping[t.key];
          if (col) out[t.key] = String(r[col] ?? '').trim();
        }
        out.metadata = r;
        return out;
      });

      let created = 0;
      let duplicates = 0;
      let invalid = 0;
      const CHUNK = 500;
      for (let i = 0; i < records.length; i += CHUNK) {
        const res = await api.post<any>(`/api/leads/import${asUserId ? `?userId=${asUserId}` : ''}`, {
          records: records.slice(i, i + CHUNK),
        });
        created += res.created;
        duplicates += res.duplicates;
        invalid += res.invalid;
      }
      setResult({ created, duplicates, invalid });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setHeaders([]);
    setRows([]);
    setMapping({});
    setFileName('');
    setResult(null);
    setError(null);
    setPasted('');
    setPasteMode(false);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import leads"
      width="max-w-3xl"
    >
      {result ? (
        <div className="space-y-3">
          <div className="rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-sm text-emerald-300">
            Import finished.
          </div>
          <ul className="space-y-1 text-sm">
            <li>
              <span className="mono text-accent">{result.created}</span> leads added
            </li>
            <li>
              <span className="mono text-zinc-400">{result.duplicates}</span> skipped as duplicates (same phone number)
            </li>
            <li>
              <span className="mono text-zinc-400">{result.invalid}</span> rows had no usable phone number
            </li>
          </ul>
          <div className="flex justify-end gap-2 pt-2">
            <button
              className="btn-ghost"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Done
            </button>
            <button className="btn-ghost" onClick={reset}>
              Import another file
            </button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="space-y-3">
          <div
            className="rounded-lg border border-dashed border-ink-600 px-4 py-10 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) onFile(f);
            }}
          >
            <p className="text-sm text-zinc-300">Drop a CSV here, or</p>
            <button className="btn-ghost mt-2" onClick={() => fileRef.current?.click()}>
              Choose file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
            <p className="mt-3 text-2xs text-muted">First row must be column names. Nothing is uploaded until you confirm.</p>
          </div>

          <div className="text-center">
            <button className="text-xs text-muted hover:text-accent" onClick={() => setPasteMode((v) => !v)}>
              or paste CSV text
            </button>
          </div>

          {pasteMode && (
            <div className="space-y-2">
              <textarea
                className="field h-40 font-mono text-xs"
                placeholder={`business_name,phone,city,state\nAce Plumbing,(512) 555-0101,Austin,TX`}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <button className="btn-ghost" onClick={() => parse(pasted)} disabled={!pasted.trim()}>
                Read pasted CSV
              </button>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              <span className="mono text-zinc-200">{rows.length.toLocaleString()}</span> rows
              {fileName ? ` from ${fileName}` : ''}
            </span>
            <button className="hover:text-accent" onClick={reset}>
              Start over
            </button>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Match your columns</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {TARGETS.map((t) => (
                <div key={t.key}>
                  <label className="label">
                    {t.label}
                    {t.required && <span className="text-accent"> *</span>}
                  </label>
                  <select
                    className={`field !py-1.5 text-xs ${t.required && !mapping[t.key] ? '!border-red-800' : ''}`}
                    value={mapping[t.key] || ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [t.key]: e.target.value }))}
                  >
                    <option value="">— none —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Preview (first 5)</h3>
            <div className="overflow-x-auto rounded border border-ink-700">
              <table className="w-full">
                <thead className="bg-ink-900">
                  <tr>
                    {TARGETS.map((t) => (
                      <th key={t.key} className="th">
                        {t.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i}>
                      {TARGETS.map((t) => (
                        <td key={t.key} className="td max-w-[180px] truncate text-xs">
                          {mapping[t.key] ? String(r[mapping[t.key]] ?? '') : <span className="text-zinc-700">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex items-center justify-between pt-1">
            <p className="text-2xs text-muted">Duplicates by phone number are skipped automatically.</p>
            <button className="btn-primary" onClick={runImport} disabled={!mappedOK || busy}>
              {busy ? 'Importing…' : `Import ${rows.length.toLocaleString()} rows`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
