import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';

export interface Me {
  user: { id: string; email: string; fullName: string | null };
  workspace: { id: string; name: string };
  provider: 'twilio' | 'telnyx';
  twilio: { accountSid: string | null; authToken: string | null; number: string | null; twimlApp: string | null };
  telnyx: { apiKey: string | null; number: string | null; connectionId: string | null };
  recordingEnabled: boolean;
  ringTimeoutSec: number;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  setMe: (m: Me | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const data = await api.get<Me>('/api/auth/me');
      setMe(data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const logout = async () => {
    await api.post('/api/auth/logout');
    setMe(null);
  };

  const value = useMemo(() => ({ me, loading, setMe, refresh, logout }), [me, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
