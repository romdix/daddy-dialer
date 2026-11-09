import { Router } from 'express';
import { one, q } from '../db';
import { requireAuth, wrap } from '../middleware';
import { baseUrl } from '../baseurl';
import { config } from '../config';

export const brandRouter = Router();

export interface BrandRow {
  name: string;
  initials: string;
  accent: string;
  logo_url: string | null;
  support_email: string | null;
}

const DEFAULTS: BrandRow = {
  name: 'Power Dialer',
  initials: 'PD',
  accent: '#22C55E',
  logo_url: null,
  support_email: null,
};

function shape(r: Partial<BrandRow> | null, req?: any) {
  const b = { ...DEFAULTS, ...(r || {}) };
  return {
    name: b.name,
    initials: b.initials,
    accent: b.accent,
    logoUrl: b.logo_url || null,
    supportEmail: b.support_email || null,
    customized: Boolean((r as any)?.is_customized),
    canonicalUrl: req ? baseUrl(req) : config.publicUrl || null,
  };
}

/** Public — the login screen needs branding before anyone signs in. */
brandRouter.get(
  '/',
  wrap(async (req, res) => {
    const row = await one<BrandRow>(
      `select name, initials, accent, logo_url, support_email, is_customized from app_brand where id=1`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(shape(row, req));
  }),
);

brandRouter.put(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name ?? '').trim().slice(0, 48);
    const initials = String(b.initials ?? '').trim().slice(0, 3);
    const accent = String(b.accent ?? '').trim();
    const logoUrl = String(b.logoUrl ?? '').trim() || null;
    const supportEmail = String(b.supportEmail ?? '').trim() || null;

    if (!name) return res.status(400).json({ error: 'Give the product a name' });
    if (!/^#?[0-9a-fA-F]{6}$/.test(accent)) return res.status(400).json({ error: 'Accent colour must look like #22C55E' });

    const hex = accent.startsWith('#') ? accent : `#${accent}`;

    await q(
      `update app_brand set name=$1, initials=$2, accent=$3, logo_url=$4, support_email=$5,
              is_customized=true, updated_at=now()
        where id=1`,
      [name, initials || name.slice(0, 2).toUpperCase(), hex.toUpperCase(), logoUrl, supportEmail],
    );

    const row = await one<BrandRow>(
      `select name, initials, accent, logo_url, support_email, is_customized from app_brand where id=1`,
    );
    res.json(shape(row, req));
  }),
);
