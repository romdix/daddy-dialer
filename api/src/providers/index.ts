import type { ProviderId, ProviderSettings } from './types';
import { twilioProvider } from './twilio';
import { telnyxProvider } from './telnyx';

export const providers = {
  twilio: twilioProvider,
  telnyx: telnyxProvider,
} as const;

export function getProvider(id: ProviderId | string) {
  const p = providers[id as ProviderId];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export function ensureConfigured(s: ProviderSettings) {
  const p = getProvider(s.provider);
  if (!p.isConfigured(s)) {
    throw Object.assign(new Error(`${p.label} is not configured yet. Open Settings and add your credentials.`), {
      status: 400,
    });
  }
  return p;
}

export * from './types';
