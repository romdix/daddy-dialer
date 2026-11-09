import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Device, Call } from '@twilio/voice-sdk';
import { api } from './api';

export type DialStatus = 'idle' | 'connecting' | 'ringing' | 'live' | 'ended';

export interface StartedCall {
  callLogId: string;
  to: string;
  label?: string;
  leadId?: string | null;
  sessionId?: string | null;
}

interface DialerValue {
  status: DialStatus;
  active: StartedCall | null;
  lastEnded: (StartedCall & { durationSec: number; cause: string }) | null;
  muted: boolean;
  seconds: number;
  error: string | null;
  clearError: () => void;
  start: (o: { to: string; leadId?: string | null; sessionId?: string | null; label?: string; mode?: 'pstn' | 'conference' }) => Promise<string>;
  hangup: () => void;
  toggleMute: () => void;
  sendDigit: (d: string) => void;
  inputDevices: { deviceId: string; label: string }[];
  inputDevice: string;
  refreshInputs: () => Promise<void>;
  selectInputDevice: (deviceId: string) => Promise<void>;
  setEndedHandler: (fn: ((c: StartedCall & { durationSec: number }) => void) | null) => void;
}

const Ctx = createContext<DialerValue>(null as any);

const RINGBACK_KEY = 'dd.ringback';

/** 440 + 480 Hz ringback, generated locally while we wait for an answer. */
class Ringback {
  private ctx: AudioContext | null = null;
  private nodes: OscillatorNode[] = [];
  start() {
    try {
      if (this.ctx) return;
      const Ctx2 = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx2) return;
      this.ctx = new Ctx2();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.05;
      gain.connect(this.ctx.destination);
      for (const freq of [440, 480]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start();
        this.nodes.push(osc);
      }
    } catch {
      /* audio is a nicety, never fatal */
    }
  }
  stop() {
    try {
      this.nodes.forEach((n) => n.stop());
      this.nodes = [];
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }
}

export function DialerProvider({ children, workspaceId }: { children: React.ReactNode; workspaceId: string }) {
  const qc = useQueryClient();
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const ringback = useRef<Ringback>(new Ringback());
  const timer = useRef<any>(null);
  const endedHandler = useRef<((c: StartedCall & { durationSec: number }) => void) | null>(null);
  const secondsRef = useRef(0);
  const liveRef = useRef(false);
  const activeRef = useRef<StartedCall | null>(null);

  const [status, setStatus] = useState<DialStatus>('idle');
  const [active, setActive] = useState<StartedCall | null>(null);
  const [lastEnded, setLastEnded] = useState<(StartedCall & { durationSec: number; cause: string }) | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inputDevices, setInputDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [inputDevice, setInputDevice] = useState<string>(() => localStorage.getItem('dd.inputDevice') || '');

  const refreshInputs = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
      setInputDevices(mics);
      if (!inputDevice && mics[0]) setInputDevice(mics[0].deviceId);
    } catch {
      /* permission not granted yet */
    }
  }, [inputDevice]);

  useEffect(() => {
    refreshInputs();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshInputs);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshInputs);
  }, [refreshInputs]);

  const selectInputDevice = useCallback(async (deviceId: string) => {
    setInputDevice(deviceId);
    localStorage.setItem('dd.inputDevice', deviceId);
    try {
      await deviceRef.current?.audio?.setInputDevice(deviceId);
    } catch (e: any) {
      setError(e?.message || 'Could not switch microphone');
    }
  }, []);

  const cleanupTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const finish = useCallback(
    (cause: string, callLogId?: string) => {
      cleanupTimer();
      ringback.current.stop();
      liveRef.current = false;
      const info = { ...(activeRef.current || { callLogId: callLogId || '', to: '' }) } as StartedCall;
      const dur = secondsRef.current;
      setStatus('ended');
      setActive(null);
      activeRef.current = null;
      setMuted(false);
      callRef.current = null;

      if (info.callLogId) {
        const ended = { ...info, durationSec: dur, cause };
        setLastEnded(ended);
        endedHandler.current?.({ ...info, durationSec: dur });
        // Refresh anything that lists calls so the new row shows up immediately.
        qc.invalidateQueries({ queryKey: ['calls'] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
        qc.invalidateQueries({ queryKey: ['callbacks'] });
        if (info.sessionId) qc.invalidateQueries({ queryKey: ['session', info.sessionId] });
      }
      setTimeout(() => setStatus((s) => (s === 'ended' ? 'idle' : s)), 1200);
    },
    [],
  );

  const start = useCallback(
    async (o: { to: string; leadId?: string | null; sessionId?: string | null; label?: string; mode?: 'pstn' | 'conference' }) => {
      setError(null);
      if (callRef.current) throw new Error('A call is already in progress');

      const started = await api.post<{ callLogId: string; token: string; identity: string; provider: string; fromNumber: string }>(
        '/api/voice/start',
        { to: o.to, leadId: o.leadId, sessionId: o.sessionId, mode: o.mode || 'pstn' },
      );

      const info: StartedCall = { callLogId: started.callLogId, to: o.to, label: o.label, leadId: o.leadId, sessionId: o.sessionId };
      activeRef.current = info;
      liveRef.current = false;
      secondsRef.current = 0;
      setActive(info);
      setSeconds(0);
      setStatus('connecting');

      if (!deviceRef.current) {
        const device = new Device(started.token, { logLevel: 'error' as any, closeProtection: true });
        device.on('error', (e: any) => {
          setError(e?.message || 'Calling device error');
          setStatus('idle');
        });
        device.on('tokenWillExpire', async () => {
          try {
            const fresh = await api.get<{ token: string }>('/api/voice/token');
            await device.updateToken(fresh.token);
          } catch {
            /* next call fetches a new one anyway */
          }
        });
        deviceRef.current = device;
        if (inputDevice) {
          try {
            await device.audio?.setInputDevice(inputDevice);
          } catch {
            /* device not ready; retried after registration */
          }
        }
      } else {
        await deviceRef.current.updateToken(started.token);
      }

      ringback.current.start();

      const call = await deviceRef.current.connect({
        params: { callLogId: started.callLogId, workspaceId, dialTo: o.to, mode: o.mode || 'pstn' },
      });
      callRef.current = call;

      call.on('ringing', () => setStatus('ringing'));
      call.on('accept', () => {
        ringback.current.stop();
        liveRef.current = true;
        setStatus('live');
        cleanupTimer();
        timer.current = setInterval(() => {
          secondsRef.current += 1;
          setSeconds(secondsRef.current);
        }, 1000);
      });
      call.on('disconnect', () => finish('completed', started.callLogId));
      call.on('cancel', () => finish('canceled', started.callLogId));
      call.on('reject', () => finish('rejected', started.callLogId));
      call.on('error', (e: any) => {
        setError(e?.message || 'Call failed');
        finish('failed', started.callLogId);
      });

      // Nothing answered within the ring window -> hang up so we do not bill ring time.
      const ringLimit = 45_000;
      setTimeout(() => {
        if (callRef.current && !liveRef.current) {
          try {
            callRef.current.disconnect();
          } catch {
            /* ignore */
          }
        }
      }, ringLimit);

      return started.callLogId;
    },
    [finish, inputDevice, workspaceId],
  );

  const hangup = useCallback(() => {
    try {
      callRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    finish('hangup');
  }, [finish]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    callRef.current?.mute(next);
    setMuted(next);
  }, [muted]);

  const sendDigit = useCallback((d: string) => {
    callRef.current?.sendDigits(d);
  }, []);

  const setEndedHandler = useCallback((fn: any) => {
    endedHandler.current = fn;
  }, []);

  const value = useMemo<DialerValue>(
    () => ({
      status,
      active,
      lastEnded,
      muted,
      seconds,
      error,
      clearError: () => setError(null),
      start,
      hangup,
      toggleMute,
      sendDigit,
      inputDevices,
      inputDevice,
      refreshInputs,
      selectInputDevice,
      setEndedHandler,
    }),
    [status, active, lastEnded, muted, seconds, error, start, hangup, toggleMute, sendDigit, inputDevices, inputDevice, refreshInputs, selectInputDevice, setEndedHandler],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDialer() {
  return useContext(Ctx);
}
