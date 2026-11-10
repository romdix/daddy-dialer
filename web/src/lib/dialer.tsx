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
  inbound?: boolean;
}

interface DialerValue {
  status: DialStatus;
  active: StartedCall | null;
  lastEnded: (StartedCall & { durationSec: number; cause: string }) | null;
  muted: boolean;
  seconds: number;
  error: string | null;
  clearError: () => void;
  start: (o: { to: string; leadId?: string | null; sessionId?: string | null; label?: string; mode?: 'pstn' | 'conference'; callerId?: string }) => Promise<string>;
  /** Ring several leads at once; the first to answer wins. */
  startBatch: (o: {
    leads: { id: string; phone: string; businessName?: string }[];
    sessionId?: string | null;
    callerId?: string;
    lines?: number;
  }) => Promise<{ batchId: string; calls: any[] }>;
  batch: { id: string; calls: any[]; winnerId: string | null } | null;
  hangup: () => void;
  toggleMute: () => void;
  sendDigit: (d: string) => void;
  inputDevices: { deviceId: string; label: string }[];
  inputDevice: string;
  refreshInputs: () => Promise<void>;
  selectInputDevice: (deviceId: string) => Promise<void>;
  setEndedHandler: (fn: ((c: StartedCall & { durationSec: number }) => void) | null) => void;
  /** Inbound call ringing the browser right now. */
  incoming: { from: string; callLogId: string } | null;
  answerIncoming: () => Promise<void>;
  declineIncoming: () => void;
  /** Preferred caller ID ('' = rotate automatically). */
  callerId: string;
  setCallerId: (v: string) => void;
  /** The number the current/last call was placed from. */
  activeFrom: string;
}

const Ctx = createContext<DialerValue>(null as any);

/**
 * Local ringback for the agent while the lead's phone rings. This is only a
 * comfort cue — "connected" is decided by the server, and the tone is stopped
 * the moment it reports the lead actually joined the room.
 */
class Ringback {
  private ctx: AudioContext | null = null;
  private nodes: OscillatorNode[] = [];
  start() {
    try {
      if (this.ctx) return;
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.035;
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
  const timer = useRef<any>(null);
  const pollRef = useRef<any>(null);
  const pollFailures = useRef(0);
  const startingRef = useRef(false);
  const ringback = useRef<Ringback>(new Ringback());
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
  const [incoming, setIncoming] = useState<{ from: string; callLogId: string } | null>(null);
  const [callerId, setCallerIdState] = useState<string>(() => localStorage.getItem('dd.callerId') || '');
  const [activeFrom, setActiveFrom] = useState<string>('');
  const [batch, setBatch] = useState<{ id: string; calls: any[]; winnerId: string | null } | null>(null);
  const incomingRef = useRef<any>(null);
  const batchRef = useRef<string | null>(null);
  const batchWinnerRef = useRef<string | null>(null);

  const setCallerId = useCallback((v: string) => {
    setCallerIdState(v);
    localStorage.setItem('dd.callerId', v);
  }, []);

  /**
   * One Device for the whole session. Created on page load so inbound calls can
   * ring even if the agent never dials, and reused for outbound.
   */
  const ensureDevice = useCallback(async (token: string) => {
    if (deviceRef.current) {
      try {
        await deviceRef.current.updateToken(token);
      } catch {
        /* next call retries */
      }
      return deviceRef.current;
    }

    const device = new Device(token, { logLevel: 'error' as any, closeProtection: true });
    device.on('error', (e: any) => setError(e?.message || 'Calling device error'));
    device.on('tokenWillExpire', async () => {
      try {
        const fresh = await api.get<{ token: string }>('/api/voice/token');
        await device.updateToken(fresh.token);
      } catch {
        /* next call fetches a new one anyway */
      }
    });

    // Someone is calling one of our numbers.
    device.on('incoming', (call: any) => {
      incomingRef.current = call;
      const from = call.parameters?.From || 'Unknown number';
      const callLogId = call.customParameters?.get?.('callLogId') || '';
      setIncoming({ from, callLogId });
      call.on('cancel', () => {
        incomingRef.current = null;
        setIncoming(null);
      });
      call.on('disconnect', () => {
        incomingRef.current = null;
        setIncoming(null);
        qc.invalidateQueries({ queryKey: ['calls'] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
      });
    });

    deviceRef.current = device;
    if (inputDevice) {
      try {
        await device.audio?.setInputDevice(inputDevice);
      } catch {
        /* device not ready; retried after registration */
      }
    }
    return device;
  }, [inputDevice, qc]);

  // Register on load so inbound calls work without placing an outbound first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await api.get<{ token: string }>('/api/voice/token');
        if (!cancelled) await ensureDevice(t.token);
      } catch {
        /* voice not configured yet — nothing to do */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ringback follows real state: plays only while we wait for the lead, and dies
  // the instant the server says they joined.
  useEffect(() => {
    if (status === 'ringing') ringback.current.start();
    else ringback.current.stop();
  }, [status]);

  // Ring pattern while an inbound call waits to be answered.
  useEffect(() => {
    if (!incoming) return;
    let ctx: AudioContext | null = null;
    let stopped = false;
    let timer: any = null;
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const beep = () => {
        if (stopped || !ctx) return;
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = 440;
          gain.gain.value = 0.05;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          setTimeout(() => {
            try {
              osc.stop();
            } catch {
              /* already stopped */
            }
          }, 700);
        } catch {
          /* ignore */
        }
      };
      beep();
      timer = setInterval(beep, 2600);
    } catch {
      /* no audio available */
    }
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      try {
        ctx?.close();
      } catch {
        /* ignore */
      }
    };
  }, [incoming]);

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
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    pollFailures.current = 0;
  };

  const finish = useCallback(
    (cause: string, callLogId?: string) => {
      cleanupTimer();
      startingRef.current = false;
      liveRef.current = false;
      batchRef.current = null;
      batchWinnerRef.current = null;
      setBatch(null);
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

  /** Watches the server's view of the call: room joined, lead answered, ended. */
  const beginPolling = useCallback(
    (callLogId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollFailures.current = 0;

      const tick = async () => {
        try {
          const st = await api.get<any>(`/api/voice/state?callLogId=${encodeURIComponent(callLogId)}`);
          pollFailures.current = 0;

          if (st.connected) {
            setStatus('live');
            if (!timer.current) {
              secondsRef.current = st.elapsedSec || 0;
              setSeconds(secondsRef.current);
              timer.current = setInterval(() => {
                secondsRef.current += 1;
                setSeconds(secondsRef.current);
              }, 1000);
            }
          }

          const terminal = ['completed', 'no_answer', 'busy', 'failed', 'canceled', 'blocked'];
          if (st.ended || terminal.includes(st.status)) {
            if (st.status === 'no_answer') setError('No answer');
            else if (st.status === 'busy') setError('Line was busy');
            else if (st.status === 'failed') setError(st.error || 'The call failed');
            else if (st.status === 'canceled') setError('Call canceled');
            else if (st.status === 'blocked') setError(st.error || 'Calling blocked');
            try {
              callRef.current?.disconnect();
            } catch {
              /* ignore */
            }
            finish(st.status || 'completed', callLogId);
          }
        } catch {
          pollFailures.current += 1;
          // ~30s without a state answer means the call is gone; stop polling.
          if (pollFailures.current > 15) cleanupTimer();
        }
      };

      tick();
      pollRef.current = setInterval(tick, 2000);
    },
    [finish],
  );

  const start = useCallback(
    async (o: { to: string; leadId?: string | null; sessionId?: string | null; label?: string; mode?: 'pstn' | 'conference'; callerId?: string }) => {
      setError(null);
      // Guards against a double click: callRef only becomes set once connect()
      // resolves, so without this two fast clicks could dial twice.
      if (callRef.current || startingRef.current) throw new Error('A call is already in progress');
      startingRef.current = true;

      const started = await api
        .post<{ callLogId: string; token: string; identity: string; provider: string; fromNumber: string }>(
          '/api/voice/start',
          { to: o.to, leadId: o.leadId, sessionId: o.sessionId, mode: o.mode || 'conference', callerId: o.callerId || callerId || undefined },
        )
        .catch((e: any) => {
          startingRef.current = false;
          setStatus('idle');
          throw e;
        });

      setActiveFrom(started.fromNumber || '');

      const info: StartedCall = { callLogId: started.callLogId, to: o.to, label: o.label, leadId: o.leadId, sessionId: o.sessionId };
      activeRef.current = info;
      liveRef.current = false;
      secondsRef.current = 0;
      setActive(info);
      setSeconds(0);
      setStatus('connecting');

      const device = await ensureDevice(started.token);

      const call = await device
        .connect({
          params: { callLogId: started.callLogId, workspaceId },
        })
        .catch((e: any) => {
          startingRef.current = false;
          setStatus('idle');
          setActive(null);
          activeRef.current = null;
          throw e;
        });
      callRef.current = call;
      startingRef.current = false;

      // In conference mode the agent joins the room immediately, so 'accept' means
      // our own media path is live. The lead is dialled by the server separately
      // and joins the same room when they pick up. No tone is generated locally —
      // the UI reflects what the server actually observes.
      call.on('accept', () => {
        liveRef.current = true;
        setStatus('ringing');
        beginPolling(started.callLogId);
      });
      call.on('disconnect', () => finish('completed', started.callLogId));
      call.on('cancel', () => finish('canceled', started.callLogId));
      call.on('reject', () => finish('rejected', started.callLogId));
      call.on('error', (e: any) => {
        setError(e?.message || 'Call failed');
        finish('failed', started.callLogId);
      });

      return started.callLogId;
    },
    [beginPolling, callerId, ensureDevice, finish, inputDevice, workspaceId],
  );

  /** Ring several leads at once — whoever answers first takes the room. */
  const startBatch = useCallback(
    async (o: {
      leads: { id: string; phone: string; businessName?: string }[];
      sessionId?: string | null;
      callerId?: string;
      lines?: number;
    }) => {
      setError(null);
      if (callRef.current || startingRef.current) throw new Error('A call is already in progress');
      if (!o.leads.length) throw new Error('Nothing to dial');
      startingRef.current = true;

      let res: any;
      try {
        res = await api.post<any>('/api/voice/batch', {
          leadIds: o.leads.map((l) => l.id),
          sessionId: o.sessionId || undefined,
          callerId: o.callerId || callerId || undefined,
          lines: o.lines || o.leads.length,
        });
      } catch (e) {
        startingRef.current = false;
        throw e;
      }

      const first = res.calls[0];
      const info: StartedCall = {
        callLogId: first.callLogId,
        to: first.to,
        label: `${res.calls.length} lines`,
        leadId: first.leadId,
        sessionId: o.sessionId || null,
      };
      activeRef.current = info;
      setActive(info);
      setActiveFrom(first.from || '');
      secondsRef.current = 0;
      setSeconds(0);
      setStatus('connecting');
      batchRef.current = res.batchId;
      batchWinnerRef.current = null;
      setBatch({ id: res.batchId, calls: res.calls, winnerId: null });

      let device;
      try {
        device = await ensureDevice(res.token);
      } catch (e) {
        startingRef.current = false;
        throw e;
      }

      const call = await device.connect({ params: { batchId: res.batchId, workspaceId } });
      callRef.current = call;
      startingRef.current = false;

      call.on('accept', () => {
        liveRef.current = true;
        setStatus('ringing');
      });
      call.on('disconnect', () => finish('completed', batchWinnerRef.current || first.callLogId));
      call.on('cancel', () => finish('canceled', first.callLogId));
      call.on('error', (e: any) => {
        setError(e?.message || 'Call failed');
        finish('failed', first.callLogId);
      });

      const tick = async () => {
        try {
          const st = await api.get<any>(`/api/voice/batch/${res.batchId}`);
          setBatch({ id: res.batchId, calls: st.calls || [], winnerId: st.winnerId || null });

          if (st.winnerId && batchWinnerRef.current !== st.winnerId) {
            batchWinnerRef.current = st.winnerId;
            const w = (st.calls || []).find((c: any) => c.id === st.winnerId);
            const winner: StartedCall = {
              ...(activeRef.current as StartedCall),
              callLogId: st.winnerId,
              leadId: w?.lead_id || null,
              label: w?.business_name || '',
            };
            activeRef.current = winner;
            setActive(winner);
            setStatus('live');
            if (!timer.current) {
              secondsRef.current = st.elapsedSec || 0;
              setSeconds(secondsRef.current);
              timer.current = setInterval(() => {
                secondsRef.current += 1;
                setSeconds(secondsRef.current);
              }, 1000);
            }
          }

          if (!st.active) {
            cleanupTimer();
            try {
              callRef.current?.disconnect();
            } catch {
              /* ignore */
            }
            finish(st.winnerId ? 'completed' : 'no_answer', st.winnerId || first.callLogId);
          }
        } catch {
          /* transient */
        }
      };

      tick();
      pollRef.current = setInterval(tick, 1500);
      return { batchId: res.batchId, calls: res.calls };
    },
    [callerId, ensureDevice, finish, workspaceId],
  );

  const hangup = useCallback(() => {
    const bid = batchRef.current;
    const callLogId = activeRef.current?.callLogId;
    if (bid) {
      api.post(`/api/voice/batch/${bid}/end`, {}).catch(() => {});
    } else if (callLogId) {
      // Also ends the lead's leg: a phone that is still ringing is not in the
      // conference yet, so disconnecting here alone leaves it ringing.
      api.post('/api/voice/end', { callLogId }).catch(() => {});
    }
    try {
      callRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    finish('hangup', batchWinnerRef.current || undefined);
  }, [finish]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    callRef.current?.mute(next);
    setMuted(next);
  }, [muted]);

  const sendDigit = useCallback((d: string) => {
    const a = activeRef.current;
    const native = () => {
      try {
        callRef.current?.sendDigits(d);
      } catch {
        /* ignore */
      }
    };

    // Outbound calls live in a conference, which swallows DTMF. Ask the server to
    // play the tone on the lead's own leg so the IVR actually hears it.
    if (a?.callLogId && !a.inbound) {
      api
        .post<any>('/api/voice/dtmf', { callLogId: a.callLogId, digits: d })
        .then((r) => {
          if (r?.native) native();
        })
        .catch(native);
      return;
    }
    native();
  }, []);

  const setEndedHandler = useCallback((fn: any) => {
    endedHandler.current = fn;
  }, []);

  /** Pick up an inbound call that is ringing in the browser. */
  const answerIncoming = useCallback(async () => {
    const c = incomingRef.current;
    if (!c) return;
    const callLogId = c.customParameters?.get?.('callLogId') || incoming?.callLogId || '';
    try {
      await c.accept();
    } catch (e: any) {
      setError(e?.message || 'Could not answer the call');
      return;
    }
    incomingRef.current = null;
    setIncoming(null);

    const info: StartedCall = { callLogId, to: c.parameters?.From || 'inbound', label: 'Inbound call', inbound: true };
    activeRef.current = info;
    setActive(info);
    liveRef.current = true;
    secondsRef.current = 0;
    setSeconds(0);
    setStatus('live');
    cleanupTimer();
    timer.current = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
    }, 1000);
    c.on('disconnect', () => finish('completed', callLogId));
  }, [finish, incoming]);

  const declineIncoming = useCallback(() => {
    try {
      incomingRef.current?.reject();
    } catch {
      /* ignore */
    }
    incomingRef.current = null;
    setIncoming(null);
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
      startBatch,
      batch,
      hangup,
      toggleMute,
      sendDigit,
      inputDevices,
      inputDevice,
      refreshInputs,
      selectInputDevice,
      setEndedHandler,
      incoming,
      answerIncoming,
      declineIncoming,
      callerId,
      setCallerId,
      activeFrom,
    }),
    [status, active, lastEnded, muted, seconds, error, start, startBatch, batch, hangup, toggleMute, sendDigit, inputDevices, inputDevice, refreshInputs, selectInputDevice, setEndedHandler, incoming, answerIncoming, declineIncoming, callerId, setCallerId, activeFrom],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDialer() {
  return useContext(Ctx);
}
