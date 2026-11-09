import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface Brand {
  name: string;
  initials: string;
  accent: string;
  logoUrl: string | null;
  supportEmail: string | null;
  customized?: boolean;
  canonicalUrl?: string | null;
}

const DEFAULT_BRAND: Brand = {
  name: 'Power Dialer',
  initials: 'PD',
  accent: '#22C55E',
  logoUrl: null,
  supportEmail: null,
};

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const raw = (hex || '').replace('#', '');
  const h = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.padEnd(6, '0');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

/** Text colour that stays readable on top of the accent. */
export function onAccent(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return l > 0.62 ? '#0B0C0F' : '#FFFFFF';
}

function tint(rgb: RGB, factor: number): RGB {
  return [Math.round(rgb[0] * factor), Math.round(rgb[1] * factor), Math.round(rgb[2] * factor)];
}

function applyBrand(b: Brand) {
  const rgb = hexToRgb(b.accent);
  const root = document.documentElement;
  root.style.setProperty('--accent', rgb.join(' '));
  root.style.setProperty('--accent-dim', tint(rgb, 0.86).join(' '));
  root.style.setProperty('--on-accent', onAccent(b.accent));
  document.title = b.name;

  const text = (b.initials || b.name.slice(0, 2)).toUpperCase().slice(0, 3);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${b.accent}"/>` +
    `<text x="32" y="43" font-family="Inter,Arial,sans-serif" font-size="25" font-weight="700" ` +
    `text-anchor="middle" fill="${onAccent(b.accent)}">${text}</text></svg>`;

  let link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface BrandValue {
  brand: Brand;
  refresh: () => Promise<void>;
  save: (b: Partial<Brand>) => Promise<Brand>;
}

const Ctx = createContext<BrandValue>(null as any);

export function BrandProvider({ children }: { children: React.ReactNode }) {
  const [brand, setBrand] = useState<Brand>(DEFAULT_BRAND);

  useEffect(() => {
    applyBrand(brand);
  }, [brand]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/brand', { credentials: 'same-origin' });
      if (res.ok) {
        const data = (await res.json()) as Brand;
        setBrand({ ...DEFAULT_BRAND, ...data });
      }
    } catch {
      /* keep defaults */
    }
  }, []);

  const save = useCallback(async (patch: Partial<Brand>) => {
    const res = await fetch('/api/brand', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Could not save branding');
    setBrand({ ...DEFAULT_BRAND, ...data });
    return data as Brand;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(() => ({ brand, refresh, save }), [brand, refresh, save]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBrand() {
  return useContext(Ctx);
}

export function BrandMark({ size = 24, className = '' }: { size?: number; className?: string }) {
  const { brand } = useBrand();
  const style = { width: size, height: size } as React.CSSProperties;

  if (brand.logoUrl) {
    return <img src={brand.logoUrl} alt={brand.name} style={style} className={`rounded object-cover ${className}`} />;
  }
  return (
    <div
      style={{ ...style, background: brand.accent, color: onAccent(brand.accent) }}
      className={`rounded flex items-center justify-center ${className}`}
    >
      <span className="font-bold" style={{ fontSize: Math.max(9, size * 0.38) }}>
        {(brand.initials || brand.name.slice(0, 2)).toUpperCase()}
      </span>
    </div>
  );
}
