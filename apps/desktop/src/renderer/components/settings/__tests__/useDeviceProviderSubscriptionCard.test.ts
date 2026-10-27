// @vitest-environment jsdom
/**
 * 一个供应商连接的订阅额度卡按「哪台电脑 + 哪个供应商」读(供应商组展开看每台的额度用)：
 *   - deviceId 为 null 读本机账号，不读任何远端镜像；
 *   - 指定电脑时经 device-link 查询那台的额度，按那台的供应商 id 读，不借用本机同名账号；
 *   - 不是订阅类连接(API key 等)两边都不读。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ProviderView } from '@cindy/model-providers';
import { InvokeScheduler } from '../../../../../../../packages/device-link/src/invokeScheduler';
import { resolveInvokePriority } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  localClaude: [] as Array<[boolean, string]>,
  remoteClaude: [] as Array<[string | null, string | undefined]>,
  remoteCodex: [] as Array<[string | null, string | undefined]>,
  remoteXai: [] as Array<[string | null, string | undefined]>,
  invoke: vi.fn(),
  readLocal: vi.fn(),
  reopened: new Set<(event: { deviceId: string }) => void>(),
  presence: new Set<(snapshot: DeviceLinkPresenceSnapshot) => void>(),
  status: new Set<(snapshot: { status: 'stopped' | 'connecting' | 'online' }) => void>(),
  codexUsage: null as Record<string, unknown> | null,
}));

const snapshot = (fiveHour: number) => ({
  fiveHour: { utilization: fiveHour, resetsAt: null },
  sevenDay: { utilization: 26, resetsAt: null },
  updatedAt: 1,
});

vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  useClaudeSubscriptionUsage: (enabled: boolean, providerId: string) => {
    mocks.localClaude.push([enabled, providerId]);
    return enabled ? snapshot(10) : null;
  },
}));
vi.mock('@/hooks/useAccountUsage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/useAccountUsage')>(),
  useAccountUsage: () => null,
}));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({
  useXaiSubscriptionUsage: () => null,
  requestXaiSubscriptionRefresh: vi.fn(),
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
    mocks.remoteClaude.push([deviceId, providerId]);
    return deviceId ? snapshot(13) : null;
  },
}));
vi.mock('@/hooks/useRemoteDeviceUsage', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useRemoteDeviceUsage')>('@/hooks/useRemoteDeviceUsage');
  return {
    ...actual,
    selectRemoteCodexAccountUsage: actual.selectRemoteCodexAccountUsage,
    useRemoteCodexAccountUsage: (...args: Parameters<typeof actual.useRemoteCodexAccountUsage>) => {
      const [deviceId, providerId] = args;
      mocks.remoteCodex.push([deviceId, providerId]);
      return actual.useRemoteCodexAccountUsage(...args) ?? (deviceId ? mocks.codexUsage : null);
    },
    useRemoteXaiSubscriptionUsage: (deviceId: string | null, providerId?: string) => {
      mocks.remoteXai.push([deviceId, providerId]);
      return null;
    },
  };
});

import { useDeviceProviderSubscriptionCard } from '../useProviderSubscriptionCard';
import { resetRemoteDeviceUsageMirrorsForTest } from '@/hooks/useRemoteDeviceUsage';
import { useProviderUsageSnapshots, useProviderWeeklyQuota } from '../../new-chat/useProviderWeeklyQuota';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { useCodexRateLimits } from '@/hooks/useCodexRateLimits';
import { installHiddenAnimationGate } from '@/lib/hiddenAnimationGate';

function provider(id: string, auth: Record<string, unknown>): ProviderView {
  return { id, name: id, source: 'user', connected: true, auth } as unknown as ProviderView;
}
const claude = provider('anthropic-1a2b', { method: 'oauth', native: 'claude' });
const apiKey = provider('openrouter', { method: 'api-key' });
const codex = provider('openai', { method: 'oauth', native: 'codex' });
const invoke = mocks.invoke;
const liveQuota = (used = 42, providerId?: string) => ({
  providerId,
  account: { planType: 'pro' },
  rateLimits: { limitId: 'promo', secondary: { usedPercent: 1, windowMinutes: 10080 } },
  rateLimitsByLimitId: {
    codex: { secondary: { usedPercent: used, windowMinutes: 10080 } },
    'gpt-5.4': { limitId: 'gpt-5.4', limitName: 'GPT-5.4', secondary: { usedPercent: 7, windowMinutes: 10080 } },
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  setDataOwnerGeneration('owner-a');
  resetRemoteDeviceUsageMirrorsForTest();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  mocks.invoke.mockReset().mockResolvedValue(liveQuota());
  mocks.readLocal.mockReset();
  mocks.reopened.clear();
  mocks.presence.clear();
  mocks.status.clear();
  mocks.codexUsage = null;
  vi.stubGlobal('electronAPI', { maker: { usage: { getCodexRateLimits: mocks.readLocal } }, deviceLink: {
    invoke: mocks.invoke,
    onRemotePush: () => () => {},
    onPresenceChanged: (listener: (snapshot: DeviceLinkPresenceSnapshot) => void) => {
      mocks.presence.add(listener); return () => mocks.presence.delete(listener);
    },
    onStatusChanged: (listener: (snapshot: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
      mocks.status.add(listener); return () => mocks.status.delete(listener);
    },
    onPeerLinkReopened: (listener: (event: { deviceId: string }) => void) => {
      mocks.reopened.add(listener);
      return () => mocks.reopened.delete(listener);
    },
  } });
  mocks.localClaude.length = 0;
  mocks.remoteClaude.length = 0;
  mocks.remoteCodex.length = 0;
  mocks.remoteXai.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const remaining = (card: ReturnType<typeof useDeviceProviderSubscriptionCard>) =>
  card?.windows.map((window) => [window.key, window.window.utilization]);

describe('useDeviceProviderSubscriptionCard', () => {
  // Unit r4389193568 / §10: existing resume tests started the live card's own
  // read. First expansion alongside an ordinary consumer must share its pending
  // RPC without queuing, including a second simultaneous live card.
  it('shares an ordinary pending local read on first expansion without a trailing RPC', async () => {
    const native = { account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 91, windowMinutes: 300 } } };
    let resolve!: (value: typeof native) => void;
    mocks.readLocal.mockImplementation(() => new Promise(done => { resolve = done; }));
    const other = renderHook(() => useCodexRateLimits(true));
    const first = renderHook(() => useDeviceProviderSubscriptionCard(codex, null, { live: true }));
    const second = renderHook(() => useDeviceProviderSubscriptionCard(codex, null, { live: true }));
    expect(mocks.readLocal).toHaveBeenCalledTimes(1);
    await act(async () => resolve(native));
    expect(other.result.current.snapshot).toBe(native);
    expect(remaining(first.result.current)).toEqual([['primary', 91]]);
    expect(remaining(second.result.current)).toEqual([['primary', 91]]);
    expect(mocks.readLocal).toHaveBeenCalledTimes(1);
  });

  // A collapsed card loses its hook instance while an ordinary subscriber can
  // keep the request alive. Reopening must still queue exactly one recovery read.
  it('queues a local reread on reexpansion while an ordinary consumer keeps the old request alive', async () => {
    const native = (usedPercent: number) => ({ account: { planType: 'plus' }, rateLimits: { primary: { usedPercent, windowMinutes: 300 } } });
    let resolve!: (value: ReturnType<typeof native>) => void;
    mocks.readLocal.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(native(96));
    renderHook(() => useCodexRateLimits(true));
    const first = renderHook(() => useDeviceProviderSubscriptionCard(codex, null, { live: true }));
    first.unmount();
    const reopened = renderHook(() => useDeviceProviderSubscriptionCard(codex, null, { live: true }));
    expect(mocks.readLocal).toHaveBeenCalledTimes(1);
    await act(async () => resolve(native(91)));
    expect(mocks.readLocal).toHaveBeenCalledTimes(2);
    expect(remaining(reopened.result.current)).toEqual([['primary', 96]]);
  });

  // Unit r4388718323: a native capability denial must retain its ordinary 15m
  // backoff, but an actual reconnect probes once per shared device/account.
  // Cover both a settled denial and a pre-reconnect request rejecting late.
  it.each(['settled', 'pending', 'remount'] as const)('reprobes native quota on reconnect after a %s unsupported response', async (phase) => {
    const native = (usedPercent: number) => ({ account: { planType: 'plus' }, rateLimits: { primary: { usedPercent, windowMinutes: 300 } } });
    const oldMirror = { primary: { usedPercent: 50, windowMinutes: 300 } };
    const unsupported = new Error('[CHANNEL_NOT_ALLOWED] old computer');
    let rejectOld!: (error: Error) => void;
    let reads = 0;
    mocks.invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'maker:usage:account') return oldMirror;
      reads++;
      if (reads === 1) {
        if (phase === 'pending') return new Promise((_resolve, reject) => { rejectOld = reject; });
        throw unsupported;
      }
      if (reads === 2 && phase === 'settled') throw unsupported;
      return native(91);
    });
    let first = renderHook(() => useDeviceProviderSubscriptionCard(codex, 'mini', { live: true }));
    let second = renderHook(() => useDeviceProviderSubscriptionCard(codex, 'mini', { live: true }));
    await act(async () => {});
    expect(reads).toBe(1);
    const reopen = async (deviceId: string) => {
      const event = { deviceId };
      await act(async () => mocks.reopened.forEach(listener => listener({ ...event })));
    };
    if (phase !== 'pending') {
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(reads).toBe(1);
    }
    await reopen('other');
    expect(reads).toBe(1);
    if (phase === 'remount') {
      first.unmount(); second.unmount();
      await reopen('mini');
      expect(reads).toBe(1); // Closed cards observe no events and send nothing.
      first = renderHook(() => useDeviceProviderSubscriptionCard(codex, 'mini', { live: true }));
      second = renderHook(() => useDeviceProviderSubscriptionCard(codex, 'mini', { live: true }));
      await act(async () => {});
    } else await reopen('mini');
    if (phase === 'pending') await act(async () => rejectOld(unsupported));
    expect(reads).toBe(2);
    if (phase === 'settled') {
      expect(remaining(first.result.current)).toEqual([['primary', 50]]);
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(reads).toBe(2);
      await reopen('mini');
      expect(reads).toBe(3);
    }
    expect(remaining(first.result.current)).toEqual([['primary', 91]]);
    expect(remaining(second.result.current)).toEqual([['primary', 91]]);
    first.unmount(); second.unmount();
    const previous = reads;
    await reopen('mini');
    expect(reads).toBe(previous);
  });

  // Unit r4388718335: an already-online card's first routine presence
  // snapshot is not a reconnect. Existing recovery tests only emit peer reopen.
  // A pending mount returning 91 must survive a would-be failing duplicate read.
  it('keeps the pending first expansion read on routine initial online snapshots', async () => {
    const native = (usedPercent: number) => ({ account: { planType: 'plus' }, rateLimits: { primary: { usedPercent, windowMinutes: 300 } } });
    let finish!: (value: ReturnType<typeof native>) => void;
    let reads = 0;
    mocks.invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'maker:usage:account') return { primary: { usedPercent: 50, windowMinutes: 300 } };
      reads++;
      if (reads === 1) return new Promise(resolve => { finish = resolve; });
      throw new Error('duplicate native read failed');
    });
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(codex, 'mini', { live: true }));
    const presence = (online: boolean): DeviceLinkPresenceSnapshot => ({
      deviceId: 'mini', online, deviceName: 'Mini', platform: 'darwin', appVersion: 'test',
      remoteControlEnabled: true, lastSeenAt: 1, busy: false,
    });
    await act(async () => {
      mocks.presence.forEach(listener => listener(presence(true)));
    });
    await act(async () => finish(native(91)));
    expect(reads).toBe(1);
    expect(remaining(hook.result.current)).toEqual([['primary', 91]]);
    await act(async () => mocks.presence.forEach(listener => listener(presence(true))));
    expect(reads).toBe(1);
    mocks.invoke.mockImplementation(async (_device, channel) => channel === 'maker:usage:account'
      ? { primary: { usedPercent: 50, windowMinutes: 300 } } : (reads++, native(96)));
    // A real relay transition still recovers; its following online presence
    // belongs to the same recovery rather than another native read.
    await act(async () => mocks.status.forEach(listener => listener({ status: 'connecting' })));
    await act(async () => mocks.status.forEach(listener => listener({ status: 'online' })));
    await act(async () => mocks.presence.forEach(listener => listener(presence(true))));
    expect(reads).toBe(2);
    expect(remaining(hook.result.current)).toEqual([['primary', 96]]);
    await act(async () => mocks.presence.forEach(listener => listener(presence(false))));
    await act(async () => mocks.presence.forEach(listener => listener(presence(true))));
    expect(reads).toBe(3);
  });

  // Unit regression r4388475446 / provider-groups.md §10: document-only
  // visibility cases missed native hide/minimize with throttling disabled.
  // Through the real live hook + host gate, both local/remote cards must avoid
  // reads while initially hidden, pause polling, and reread once when restored.
  it.each(['local', 'remote'] as const)('pauses the %s live quota card while the native window is hidden', async (location) => {
    let nativeHidden!: (hidden: boolean) => void;
    window.electronAPI.onWindowHiddenChange = callback => { nativeHidden = callback; return () => {}; };
    const disposeGate = installHiddenAnimationGate();
    try {
      const native = (usedPercent: number) => ({ account: { planType: 'plus' }, rateLimits: { primary: { usedPercent, windowMinutes: 300 } } });
      mocks.readLocal.mockResolvedValue(native(73));
      mocks.invoke.mockImplementation(async (_device, channel) => channel === 'maker:usage:account' ? null : native(73));
      await act(async () => { nativeHidden(true); });
      const hook = renderHook(() => useDeviceProviderSubscriptionCard(codex, location === 'local' ? null : 'mini', { live: true }));
      await act(async () => {});
      expect(hook.result.current).toBeNull();
      expect(mocks.readLocal).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
      await act(async () => { nativeHidden(false); });
      expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
      const calls = () => location === 'local' ? mocks.readLocal.mock.calls.length : mocks.invoke.mock.calls.length;
      const beforeHiding = calls();
      await act(async () => { nativeHidden(true); });
      expect(document.visibilityState).toBe('visible');
      expect(hook.result.current).toBeNull();
      await act(async () => { vi.advanceTimersByTime(45_000); });
      expect(calls()).toBe(beforeHiding);
      mocks.readLocal.mockResolvedValue(native(84));
      mocks.invoke.mockImplementation(async (_device, channel) => channel === 'maker:usage:account' ? null : native(84));
      await act(async () => { nativeHidden(false); });
      expect(remaining(hook.result.current)).toEqual([['primary', 84]]);
      expect(calls() - beforeHiding).toBe(location === 'local' ? 1 : 2);
      hook.unmount();
      const afterUnmounting = calls();
      await act(async () => { nativeHidden(true); nativeHidden(false); vi.advanceTimersByTime(30_000); });
      expect(calls()).toBe(afterUnmounting);
    } finally { disposeGate(); }
  });

  // Unit regression r4355497194 / remote-and-mobile-adaptation.md: six expanded
  // accounts produce twelve slow periodic reads. Existing polling coverage had
  // only one account. Run the real admission scheduler at the preload boundary:
  // at most four automatic reads may start, and opening another card must work
  // immediately without waiting for any of those reads to finish.
  it('keeps periodic quota reads in background slots so opening another account is responsive', async () => {
    const scheduler = new InvokeScheduler();
    const accounts = Array.from({ length: 6 }, (_, index) =>
      provider(`openai-${index}`, { method: 'oauth', native: 'codex' }));
    const automaticIds = new Set(accounts.map(account => account.id));
    const releases: Array<() => void> = [];
    let polling = false;
    let started = 0;
    mocks.invoke.mockImplementation((deviceId, channel, args, scheduling?: { background?: boolean }) =>
      scheduler.run(deviceId, resolveInvokePriority(channel, scheduling?.background), 30_000, async () => {
        const providerId = args[channel === 'maker:usage:account' ? 1 : 0];
        if (polling && automaticIds.has(providerId)) {
          started++;
          await new Promise<void>(resolve => releases.push(resolve));
        }
        const quota = { primary: { usedPercent: 91, windowMinutes: 300 } };
        return channel === 'maker:usage:account' ? { providerId, ...quota }
          : { providerId, account: { planType: 'plus' }, rateLimits: quota };
      }));
    for (const account of accounts) {
      renderHook(() => useDeviceProviderSubscriptionCard(account, 'mini', { live: true }));
    }
    await act(async () => {});
    polling = true;
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(started).toBe(4);
    const opened = renderHook(() => useDeviceProviderSubscriptionCard(
      provider('openai-opened', { method: 'oauth', native: 'codex' }), 'mini', { live: true }));
    await act(async () => {});
    expect(remaining(opened.result.current)).toEqual([['primary', 91]]);
    polling = false;
    await act(async () => { releases.forEach(resolve => resolve()); });
  });

  // Unit regression (provider-groups.md §10): the remote card used only a stale mirror.
  // Existing cases cover account location, not native RPC results or visible-card refreshes.
  // Minimal input: mirror says 50%, native account says 73%, with no usage push/local panel.
  // Single-file command wall time: 3.96s (2026-10-22).
  it('shows native quota on opening, polls only while visible, and refreshes on return/reconnect', async () => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    const native = (usedPercent: number) => ({
      providerId: openai.id,
      account: { planType: 'plus', email: null, accountId: null },
      // A model-specific latest bucket must not replace the generic account quota.
      rateLimits: { primary: { usedPercent: 99 }, limitId: 'spark' },
      rateLimitsByLimitId: { codex: { primary: { usedPercent, windowMinutes: 300 } } },
    });
    mocks.codexUsage = { primary: { usedPercent: 50, windowMinutes: 300 } };
    let nativeReads = 0;
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? mocks.codexUsage : native(nativeReads++ === 0 ? 73 : 84));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini', { live: true }));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    expect(mocks.invoke).toHaveBeenCalledWith('mini', 'maker:usage:codex-rate-limits', ['openai-extra']);

    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(remaining(hook.result.current)).toEqual([['primary', 84]]);
    const readsBeforeHiding = mocks.invoke.mock.calls.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { vi.advanceTimersByTime(45_000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(readsBeforeHiding);

    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? mocks.codexUsage : native(91));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(remaining(hook.result.current)).toEqual([['primary', 91]]);
    const readsBeforeReconnect = mocks.invoke.mock.calls.length;
    act(() => mocks.reopened.forEach(listener => listener({ deviceId: 'other' })));
    expect(mocks.invoke).toHaveBeenCalledTimes(readsBeforeReconnect);
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? mocks.codexUsage : native(96));
    await act(async () => mocks.reopened.forEach(listener => listener({ deviceId: 'mini' })));
    expect(remaining(hook.result.current)).toEqual([['primary', 96]]);
    hook.unmount();
    const readsBeforeClosing = mocks.invoke.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(readsBeforeClosing);
    expect(mocks.reopened.size).toBe(0);
  });

  it('keeps the matching account mirror when an older computer cannot query native quota', async () => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    mocks.codexUsage = { primary: { usedPercent: 50, windowMinutes: 300 } };
    mocks.invoke.mockRejectedValue(new Error('[CHANNEL_NOT_ALLOWED] old computer'));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini'));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 50]]);
  });

  // Unit regression: PR #6752 r4355398578. Recovery coverage only kept an old
  // request pending. With no old request, the mount already starts a fresh read;
  // queuing another read can clear its successful native quota on a second error.
  // Minimal input: 73% before hiding/offline, then native 91%, with any duplicate
  // native request failing. The real card must keep 91% with one recovery read.
  it.each(['foreground', 'member-online'] as const)('keeps fresh native quota after one %s recovery read', async (resume) => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    let nativeReads = 0;
    mocks.invoke.mockImplementation(async (_deviceId, channel) => {
      const quota = { primary: { usedPercent: 50, windowMinutes: 300 } };
      if (channel === 'maker:usage:account') return { providerId: openai.id, ...quota };
      if (++nativeReads > 2) throw new Error('duplicate recovery read failed');
      return {
        providerId: openai.id,
        account: { planType: 'plus' },
        rateLimits: { primary: { usedPercent: nativeReads === 1 ? 73 : 91, windowMinutes: 300 } },
      };
    });
    const hook = renderHook(({ selected, deviceId }: { selected: ProviderView | undefined; deviceId: string | null }) =>
      useDeviceProviderSubscriptionCard(selected, deviceId, { live: true }),
    { initialProps: { selected: openai as ProviderView | undefined, deviceId: 'mini' as string | null } });
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    if (resume === 'foreground') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    } else {
      hook.rerender({ selected: undefined, deviceId: null });
      hook.rerender({ selected: openai, deviceId: 'mini' });
      await act(async () => {});
    }
    expect(remaining(hook.result.current)).toEqual([['primary', 91]]);
    expect(nativeReads).toBe(2);
    expect(mocks.invoke.mock.calls.filter(([, channel]) => channel === 'maker:usage:account')).toHaveLength(2);
  });

  // Unit regression: PR #6752 review r4344705884. Existing reconnect coverage used
  // a completed/mocked mirror. r4344881854 adds foreground/member-online recovery:
  // those paths temporarily unmount the epoch listener, so they must also queue
  // one read behind the old pending request. No timer advance is needed for 82%.
  it.each([
    { resume: 'reconnect', native: false },
    { resume: 'foreground', native: true },
    { resume: 'member-online', native: false },
    { resume: 'reopen', native: true },
  ] as const)('queues one recovery read on $resume when the old request is still pending', async ({ resume, native }) => {
    const openai = provider('openai-extra', { method: 'oauth', native: 'codex' });
    const quotaChannel = native ? 'maker:usage:codex-rate-limits' : 'maker:usage:account';
    let rejectOld!: (error: Error) => void;
    let reads = 0;
    mocks.invoke.mockImplementation((_deviceId, channel) => {
      if (channel !== quotaChannel) return native ? Promise.resolve(null)
        : Promise.reject(new Error('[CHANNEL_NOT_ALLOWED] old computer'));
      if (reads++ === 0) return new Promise((_resolve, reject) => { rejectOld = reject; });
      const quota = { primary: { usedPercent: 82, windowMinutes: 300 } };
      return Promise.resolve(native ? { providerId: openai.id, account: { planType: 'plus' }, rateLimits: quota }
        : { providerId: openai.id, ...quota });
    });
    const renderCard = () => renderHook(({ selected, deviceId }: { selected: ProviderView | undefined; deviceId: string | null }) =>
      useDeviceProviderSubscriptionCard(selected, deviceId, { live: true }),
    { initialProps: { selected: openai as ProviderView | undefined, deviceId: 'mini' as string | null } });
    let hook = renderCard();
    await act(async () => {});
    expect(remaining(hook.result.current)).toBeUndefined();
    expect(reads).toBe(1);
    if (resume === 'foreground') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
    } else if (resume === 'member-online') hook.rerender({ selected: undefined, deviceId: null });
    else if (resume === 'reopen') hook.unmount();
    if (resume !== 'reconnect') expect(mocks.reopened.size).toBe(0);
    act(() => mocks.reopened.forEach(listener => listener({ deviceId: 'mini' })));
    if (resume === 'foreground') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
    } else if (resume === 'member-online') hook.rerender({ selected: openai, deviceId: 'mini' });
    else if (resume === 'reopen') hook = renderCard();
    await act(async () => rejectOld(new Error('old link disconnected')));
    expect(remaining(hook.result.current)).toEqual([['primary', 82]]);
    expect(reads).toBe(2);
  });

  // Unit regression: PR #6752 r4344811616. A native snapshot can outlive a missed
  // account-switch clear. Existing cases start without a cached native snapshot.
  // A fresh B mirror must replace A after the native reread fails, on either
  // remount or link reopen; a later successful native read must become primary.
  it.each(['remount', 'reconnect'] as const)('discards stale native quota after a missed account clear and failed %s read', async (mode) => {
    const openai = provider('openai-switched', { method: 'oauth', native: 'codex' });
    const native = (accountId: string, usedPercent: number) => ({
      providerId: openai.id, account: { accountId, planType: 'plus' },
      rateLimits: { primary: { usedPercent, windowMinutes: 300 } },
    });
    const account = (accountId: string, usedPercent: number) => ({
      providerId: openai.id, accountId, primary: { usedPercent, windowMinutes: 300 },
    });
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? account('account-a', 50) : native('account-a', 73));
    let hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini', { live: true }));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    if (mode === 'remount') hook.unmount();
    mocks.invoke.mockImplementation(async (_deviceId, channel) => {
      if (channel === 'maker:usage:account') return account('account-b', 82);
      throw new Error('native quota temporarily unavailable');
    });
    if (mode === 'remount') hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, 'mini', { live: true }));
    else act(() => mocks.reopened.forEach(listener => listener({ deviceId: 'mini' })));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 82]]);
    mocks.invoke.mockImplementation(async (_deviceId, channel) => channel === 'maker:usage:account'
      ? account('account-b', 82) : native('account-b', 91));
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(remaining(hook.result.current)).toEqual([['primary', 91]]);
  });

  // Unit regression r4362108215 / provider-groups.md §10: remote recovery tests
  // did not cover the local native hook. Hide/resume during its first pending
  // read, then fail the queued reread: the first successful quota must remain.
  it('keeps a pending local quota result across foreground resume and queues one reread', async () => {
    const openai = provider('openai', { method: 'oauth', native: 'codex' });
    const native = { account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 73, windowMinutes: 300 } } };
    let resolveFirst!: (value: typeof native) => void;
    let rejectNext!: (error: Error) => void;
    mocks.readLocal.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectNext = reject; }));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, null, { live: true }));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.readLocal).toHaveBeenCalledTimes(1);
    await act(async () => resolveFirst(native));
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    expect(mocks.readLocal).toHaveBeenCalledTimes(2);
    await act(async () => rejectNext(new Error('quota temporarily unavailable')));
    expect(remaining(hook.result.current)).toEqual([['primary', 73]]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('refreshes the local account on the same live-card interval without querying another computer', async () => {
    const openai = provider('openai', { method: 'oauth', native: 'codex' });
    const native = (usedPercent: number) => ({
      account: { planType: 'plus' }, rateLimits: { primary: { usedPercent, windowMinutes: 300 } },
    });
    mocks.readLocal.mockResolvedValueOnce(native(55)).mockResolvedValue(native(76));
    const hook = renderHook(() => useDeviceProviderSubscriptionCard(openai, null, { live: true }));
    await act(async () => {});
    expect(remaining(hook.result.current)).toEqual([['primary', 55]]);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(remaining(hook.result.current)).toEqual([['primary', 76]]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  // Unit regression: the real card hook used a day-old snapshot because remote reads
  // never reached app-server. Existing account routing mocks did not exercise IPC.
  it('reads live remote Codex quota and timestamps the generic account window', async () => {
    let finish!: (value: ReturnType<typeof liveQuota>) => void;
    invoke.mockImplementation((_device, channel) => channel === 'maker:usage:account'
      ? Promise.resolve({ secondary: { usedPercent: 99 }, webSnapshot: { source: 'openai-web', secondary: { usedPercent: 88 } } })
      : new Promise((resolve) => { finish = resolve; }));
    const startedAt = Date.now();
    const { result } = renderHook(() => ({
      card: useDeviceProviderSubscriptionCard(codex, 'mini'),
      rail: useProviderWeeklyQuota(codex, { deviceId: 'mini' }),
      models: useProviderUsageSnapshots(codex, { deviceId: 'mini' }, { web: true }),
    }));
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'maker:usage:codex-rate-limits')).toEqual([
      ['mini', 'maker:usage:codex-rate-limits', ['openai']],
    ]);
    await act(async () => {});
    expect(result.current.models.codex?.web?.secondary?.usedPercent).toBe(88);
    expect(result.current.models.codex?.buckets).toBeNull();
    expect(result.current.card).toBeNull();
    await act(async () => { finish(liveQuota()); });
    expect(remaining(result.current.card)).toEqual([['secondary', 42]]);
    expect(result.current.card?.updatedAt).toBeGreaterThanOrEqual(startedAt);
    expect(result.current.rail?.usedPercent).toBe(42);
    expect(matchCodexBucketForModel(result.current.models.codex?.buckets, 'gpt-5.4')?.secondary?.usedPercent).toBe(7);
    expect(result.current.models.codex?.web?.secondary?.usedPercent).toBe(88);
  });

  it('shares one read per minute and stops when hidden, closed or unmounted', async () => {
    let nativeHidden!: (hidden: boolean) => void;
    window.electronAPI.onWindowHiddenChange = (callback) => {
      nativeHidden = callback;
      return () => {};
    };
    const disposeGate = installHiddenAnimationGate();
    const { result, rerender, unmount } = renderHook(({ open }) => ({
      card: useDeviceProviderSubscriptionCard(open ? codex : undefined, 'mini'),
      second: useDeviceProviderSubscriptionCard(open ? codex : undefined, 'mini'),
    }), { initialProps: { open: true } });
    await act(async () => {});
    invoke.mockResolvedValue(liveQuota(56));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(remaining(result.current.card)).toEqual([['secondary', 56]]);
    expect(result.current.card?.updatedAt).toBe(Date.now());
    await act(async () => { nativeHidden(true); });
    expect(document.visibilityState).toBe('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => { nativeHidden(false); });
    expect(invoke).toHaveBeenCalledTimes(3);
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(3);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(invoke).toHaveBeenCalledTimes(4);
    rerender({ open: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(result.current.card).toBeNull();
    await act(async () => { nativeHidden(true); });
    rerender({ open: true });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(4);
    await act(async () => { nativeHidden(false); });
    expect(invoke).toHaveBeenCalledTimes(5);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(5);
    disposeGate();
  });

  it.each(['[CHANNEL_NOT_ALLOWED]', 'network unavailable'])('falls back to the old snapshot after %s without clearing it on failure', async (error) => {
    const updatedAt = Date.now() - 86_400_000;
    invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'maker:usage:codex-rate-limits') throw new Error(error);
      return { secondary: { usedPercent: 26, windowMinutes: 10080 }, updatedAt };
    });
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(codex, 'mini'));
    await act(async () => {});
    expect(invoke).toHaveBeenLastCalledWith('mini', 'maker:usage:account', ['codex']);
    expect(remaining(result.current)).toEqual([['secondary', 26]]);
    expect(result.current?.updatedAt).toBe(updatedAt);
    invoke.mockRejectedValue(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(remaining(result.current)).toEqual([['secondary', 26]]);
    invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'maker:usage:codex-rate-limits') throw new Error(error);
      return null; // The host cleared its account after logout, not a transport failure.
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current).toBeNull();
  });

  it('rejects unscoped legacy replies for named accounts and keeps devices/accounts separate', async () => {
    const named = provider('openai-secondary', { method: 'oauth', native: 'codex' });
    invoke.mockImplementation(async (device, channel, [id]) => channel === 'maker:usage:account'
      ? { secondary: { usedPercent: 99, windowMinutes: 10080 } }
      : liveQuota(device === 'mini' ? 42 : 61, id === named.id ? undefined : id));
    const { result } = renderHook(() => ({
      first: useDeviceProviderSubscriptionCard(codex, 'mini'),
      other: useDeviceProviderSubscriptionCard(codex, 'other'),
      named: useDeviceProviderSubscriptionCard(named, 'mini'),
    }));
    await act(async () => {});
    expect(remaining(result.current.first)).toEqual([['secondary', 42]]);
    expect(remaining(result.current.other)).toEqual([['secondary', 61]]);
    expect(result.current.named).toBeNull();
    expect(invoke).toHaveBeenCalledWith('mini', 'maker:usage:codex-rate-limits', [named.id]);
    invoke.mockResolvedValue(liveQuota(18, named.id));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(remaining(result.current.named)).toEqual([['secondary', 18]]);
    expect(remaining(result.current.first)).toEqual([['secondary', 42]]);
  });

  it('drops old-owner results and never queries sharing devices', async () => {
    let finish!: (value: ReturnType<typeof liveQuota>) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ device }) => useDeviceProviderSubscriptionCard(codex, device), {
      initialProps: { device: 'mini' },
    });
    const oldFinish = finish;
    setDataOwnerGeneration('owner-b');
    rerender({ device: 'mini' });
    await act(async () => { oldFinish(liveQuota(90)); });
    expect(result.current).toBeNull();
    await act(async () => { finish(liveQuota(15)); });
    expect(remaining(result.current)).toEqual([['secondary', 15]]);
    rerender({ device: 'share:example' });
    const count = invoke.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(invoke).toHaveBeenCalledTimes(count);
    expect(result.current).toBeNull();
  });
  it('reads this computer’s account when no device is given', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(claude, null));
    expect(remaining(result.current)).toEqual([['five-hour', 10], ['seven-day', 26]]);
    expect(mocks.localClaude.at(-1)).toEqual([true, 'anthropic-1a2b']);
    expect(mocks.remoteClaude.every(([deviceId]) => deviceId === null)).toBe(true);
  });

  it('reads the other computer’s account by its own provider id, never this computer’s', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(claude, 'mini'));
    expect(remaining(result.current)).toEqual([['five-hour', 13], ['seven-day', 26]]);
    expect(mocks.remoteClaude.at(-1)).toEqual(['mini', 'anthropic-1a2b']);
    expect(mocks.localClaude.every(([enabled]) => !enabled)).toBe(true);
    expect(mocks.remoteCodex.every(([deviceId]) => deviceId === null)).toBe(true);
    expect(mocks.remoteXai.every(([deviceId]) => deviceId === null)).toBe(true);
  });

  it('reads nothing for a connection without a subscription quota', () => {
    const { result } = renderHook(() => useDeviceProviderSubscriptionCard(apiKey, 'mini'));
    expect(result.current).toBeNull();
    expect(mocks.remoteClaude.every(([deviceId]) => deviceId === null)).toBe(true);
    expect(mocks.localClaude.every(([enabled]) => !enabled)).toBe(true);
  });
});
