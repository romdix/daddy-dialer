import { one, q } from './db';
import { primaryWorkspaceId } from './workspace';
import { pullFromGhl } from './ghlpull';

const TICK_MS = 10 * 60 * 1000;

function ny(d: Date) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(d),
  );
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  return { hour, day };
}

async function tick() {
  try {
    const ws = await primaryWorkspaceId();
    const s = await one<any>(
      `select ghl_sync_enabled, ghl_sync_hour, ghl_sync_amount, ghl_last_sync_at
         from settings where workspace_id=$1`,
      [ws],
    );
    if (!s?.ghl_sync_enabled) return;

    const now = new Date();
    const { hour, day } = ny(now);
    if (hour !== Number(s.ghl_sync_hour)) return;
    // One top-up per New York day, however many times this timer fires.
    if (s.ghl_last_sync_at && ny(new Date(s.ghl_last_sync_at)).day === day) return;

    const r = await pullFromGhl(ws, { amount: s.ghl_sync_amount || 100, label: 'Nightly top-up' });
    await q(`update settings set ghl_last_sync_at=now() where workspace_id=$1`, [ws]);
    console.log(
      `[sync] nightly top-up: ${r.created} new, ${r.duplicates} already had, ${r.skippedTagged} tagged before, ${r.skippedRecent} called recently, ${r.skippedDnc} do-not-call`,
    );
  } catch (e: any) {
    console.error('[sync] nightly top-up failed:', e?.message);
  }
}

export function startGhlSync() {
  setTimeout(tick, 60 * 1000);
  setInterval(tick, TICK_MS);
  console.log('[sync] nightly top-up scheduler started (disabled until switched on)');
}
