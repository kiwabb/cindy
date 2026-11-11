// @vitest-environment jsdom

/**
 * 更新就绪后完整 banner 的自动弹出时机:有任务在跑(与「立即重启」二次确认同一条
 * 探针)就不占侧栏,只留最小化入口;全部停下后再弹出。用户点 X 关掉的不自动恢复。
 *
 * 本文件覆盖这条自动路径。点入口之后「拦不拦重启」仍由 updateBannerRelaunchEntry 负责。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateBanner } from '@/components/sidebar/UpdateBanner';
import {
  UPDATE_BANNER_BUSY_POLL_MS,
} from '@/hooks/useDeferUpdateBannerWhileBusy';
import {
  deferUpdateBannerBecauseBusy,
  dismissUpdateBanner,
  getUpdateBannerDismissState,
  markUpdateBannerAutoShown,
  resetUpdateBannerDismissStoreForTests,
  restoreUpdateBanner,
} from '@/hooks/useUpdateBannerDismiss';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'en', effectiveLocale: 'en', setLocale: vi.fn() }),
}));

const updateStatus = vi.hoisted(() => ({
  current: { status: 'ready', version: '1.2.3', errorCode: null } as {
    status: string;
    version?: string;
    errorCode: string | null;
    downloadUrl?: string;
  },
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => updateStatus.current,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

const { anyActivityBlockingRelaunch, relaunchToUpdate, openExternal } = vi.hoisted(() => ({
  anyActivityBlockingRelaunch: vi.fn<() => Promise<boolean>>(),
  relaunchToUpdate: vi.fn(),
  openExternal: vi.fn(),
}));

const EXPANDED = 'update.banner.ariaExpanded';
const COLLAPSED = 'update.banner.ariaCollapsed';

function deferredProbe(): (busy: boolean) => void {
  let settle!: (busy: boolean) => void;
  anyActivityBlockingRelaunch.mockImplementation(
    () => new Promise<boolean>((resolve) => { settle = resolve; }),
  );
  return (busy: boolean) => settle(busy);
}

beforeEach(() => {
  resetUpdateBannerDismissStoreForTests();
  anyActivityBlockingRelaunch.mockReset();
  relaunchToUpdate.mockReset();
  openExternal.mockReset();
  updateStatus.current = { status: 'ready', version: '1.2.3', errorCode: null };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      anyActivityBlockingRelaunch,
      relaunchToUpdate,
      openExternal,
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('update banner dismiss store', () => {
  it('does not let a busy defer overwrite a user dismiss', () => {
    dismissUpdateBanner('ready', '1.0.0');
    deferUpdateBannerBecauseBusy('ready', '1.0.0');
    expect(getUpdateBannerDismissState().reason).toBe('user');
    expect(getUpdateBannerDismissState().dismissed).toBe(true);
  });

  it('does not let idle auto-show restore a user dismiss', () => {
    dismissUpdateBanner('ready', '1.0.0');
    markUpdateBannerAutoShown('1.0.0');
    expect(getUpdateBannerDismissState().dismissed).toBe(true);
    expect(getUpdateBannerDismissState().reason).toBe('user');
  });

  it('is a no-op when the same busy snapshot is recorded twice', () => {
    deferUpdateBannerBecauseBusy('ready', '1.0.0');
    const first = getUpdateBannerDismissState();
    deferUpdateBannerBecauseBusy('ready', '1.0.0');
    expect(getUpdateBannerDismissState()).toBe(first);
  });

  it('does not let a busy defer hide a banner the user reopened', () => {
    deferUpdateBannerBecauseBusy('ready', '1.0.0');
    restoreUpdateBanner();
    expect(getUpdateBannerDismissState().pinnedByUser).toBe(true);
    deferUpdateBannerBecauseBusy('ready', '1.0.0');
    expect(getUpdateBannerDismissState().dismissed).toBe(false);
    expect(getUpdateBannerDismissState().pinnedByUser).toBe(true);
  });

  it('does not keep a user pin when a newer update becomes ready', () => {
    deferUpdateBannerBecauseBusy('ready', '1.0.0');
    restoreUpdateBanner();
    expect(getUpdateBannerDismissState().pinnedByUser).toBe(true);

    deferUpdateBannerBecauseBusy('ready', '2.0.0');
    expect(getUpdateBannerDismissState().reason).toBe('busy');
    expect(getUpdateBannerDismissState().dismissedVersion).toBe('2.0.0');
    expect(getUpdateBannerDismissState().pinnedByUser).toBe(false);
  });
});

describe('UpdateBanner busy defer', () => {
  it('keeps the expanded banner hidden while the first probe is in flight', async () => {
    const settle = deferredProbe();
    render(<UpdateBanner isCollapsed={false} />);

    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1));
    expect(anyActivityBlockingRelaunch).toHaveBeenCalledWith({ silent: true });

    settle(false);
    expect(await screen.findByRole('button', { name: EXPANDED })).toBeTruthy();
    expect(getUpdateBannerDismissState().dismissed).toBe(false);
  });

  it('shows the expanded banner when main reports nothing running', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(false);
    render(<UpdateBanner isCollapsed={false} />);

    expect(await screen.findByRole('button', { name: EXPANDED })).toBeTruthy();
    expect(getUpdateBannerDismissState().reason).toBeNull();
  });

  it('hides the expanded banner when main reports live activity', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed={false} />);

    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });

  it('keeps the collapsed flame as the minimized reminder while busy', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed />);

    expect(await screen.findByRole('button', { name: COLLAPSED })).toBeTruthy();
    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));
    expect(screen.getByRole('button', { name: COLLAPSED })).toBeTruthy();
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
  });

  it('falls back to hiding the expanded banner when the busy probe throws', async () => {
    anyActivityBlockingRelaunch.mockImplementation(() => {
      throw new Error('electron bridge is not registered');
    });
    render(<UpdateBanner isCollapsed={false} />);

    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
  });

  it('falls back to hiding the expanded banner when the busy probe rejects', async () => {
    anyActivityBlockingRelaunch.mockRejectedValue(new Error('ipc channel closed'));
    render(<UpdateBanner isCollapsed={false} />);

    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
  });

  it('does not auto-restore a banner the user dismissed once the probe goes idle', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(false);
    render(<UpdateBanner isCollapsed={false} />);
    expect(await screen.findByRole('button', { name: EXPANDED })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
    expect(getUpdateBannerDismissState().reason).toBe('user');

    anyActivityBlockingRelaunch.mockResolvedValue(false);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
    expect(getUpdateBannerDismissState().reason).toBe('user');
  });

  it('does not hide the banner again after the user reopens it while still busy', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);
    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();

    act(() => {
      restoreUpdateBanner();
    });
    rerender(<UpdateBanner isCollapsed={false} />);
    expect(await screen.findByRole('button', { name: EXPANDED })).toBeTruthy();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: EXPANDED })).toBeTruthy();
    expect(getUpdateBannerDismissState().dismissed).toBe(false);
  });

  it('pops the expanded banner once a later poll sees idle', async () => {
    vi.useFakeTimers();
    let busy = true;
    anyActivityBlockingRelaunch.mockImplementation(() => Promise.resolve(busy));
    render(<UpdateBanner isCollapsed={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getUpdateBannerDismissState().reason).toBe('busy');
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();

    busy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_BANNER_BUSY_POLL_MS);
    });
    expect(screen.getByRole('button', { name: EXPANDED })).toBeTruthy();
    expect(getUpdateBannerDismissState().dismissed).toBe(false);
  });

  it('hides the expanded banner again if a later poll sees activity', async () => {
    vi.useFakeTimers();
    let busy = false;
    anyActivityBlockingRelaunch.mockImplementation(() => Promise.resolve(busy));
    render(<UpdateBanner isCollapsed={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: EXPANDED })).toBeTruthy();

    busy = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_BANNER_BUSY_POLL_MS);
    });
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
    expect(getUpdateBannerDismissState().reason).toBe('busy');
    expect(getUpdateBannerDismissState().pinnedByUser).toBe(false);
  });

  it('pops the expanded banner again after a later busy defer goes idle', async () => {
    vi.useFakeTimers();
    let busy = false;
    anyActivityBlockingRelaunch.mockImplementation(() => Promise.resolve(busy));
    render(<UpdateBanner isCollapsed={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: EXPANDED })).toBeTruthy();

    busy = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_BANNER_BUSY_POLL_MS);
    });
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();

    busy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_BANNER_BUSY_POLL_MS);
    });
    expect(screen.getByRole('button', { name: EXPANDED })).toBeTruthy();
    expect(getUpdateBannerDismissState().dismissed).toBe(false);
  });

  it('probes a newer update after the previous one was user-pinned', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);
    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));

    act(() => {
      restoreUpdateBanner();
    });
    rerender(<UpdateBanner isCollapsed={false} />);
    expect(await screen.findByRole('button', { name: EXPANDED })).toBeTruthy();
    expect(getUpdateBannerDismissState().pinnedByUser).toBe(true);

    anyActivityBlockingRelaunch.mockResolvedValue(false);
    updateStatus.current = { status: 'ready', version: '2.0.0', errorCode: null };
    rerender(<UpdateBanner isCollapsed={false} />);

    expect(await screen.findByRole('button', { name: EXPANDED })).toBeTruthy();
    await waitFor(() => {
      expect(getUpdateBannerDismissState().pinnedByUser).toBe(false);
      expect(getUpdateBannerDismissState().decidedVersion).toBe('2.0.0');
    });
  });

  it('hides a newer update when it arrives busy after a previous pin', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);
    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));

    act(() => {
      restoreUpdateBanner();
    });
    rerender(<UpdateBanner isCollapsed={false} />);
    expect(await screen.findByRole('button', { name: EXPANDED })).toBeTruthy();

    updateStatus.current = { status: 'ready', version: '2.0.0', errorCode: null };
    rerender(<UpdateBanner isCollapsed={false} />);

    await waitFor(() => expect(getUpdateBannerDismissState().reason).toBe('busy'));
    expect(screen.queryByRole('button', { name: EXPANDED })).toBeNull();
    expect(getUpdateBannerDismissState().pinnedByUser).toBe(false);
    expect(getUpdateBannerDismissState().dismissedVersion).toBe('2.0.0');
  });
});

describe('update banner for a release that needs a manual install', () => {
  const URL_R1 = 'https://github.com/kiwabb/cindy/releases/tag/personal-windows-x64-r1';
  const manual = (version: string, downloadUrl = URL_R1) => ({
    status: 'manual', version, errorCode: null, downloadUrl,
  });

  it('opens the release page, never probes or restarts, and stays dismissed across polls of the same version', async () => {
    updateStatus.current = manual('personal-r1');
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);
    expect(screen.getByText('update.banner.manualTitle')).toBeTruthy();
    expect(screen.getByText('personal-r1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'update.banner.manualAria' }));
    expect(openExternal).toHaveBeenCalledWith(URL_R1);
    expect(anyActivityBlockingRelaunch).not.toHaveBeenCalled();
    expect(relaunchToUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    expect(screen.queryByText('update.banner.manualTitle')).toBeNull();

    // The 30-minute poll: manual -> checking -> manual with the same version.
    updateStatus.current = { status: 'checking', version: 'personal-r1', errorCode: null };
    rerender(<UpdateBanner isCollapsed={false} />);
    updateStatus.current = manual('personal-r1');
    rerender(<UpdateBanner isCollapsed={false} />);
    expect(screen.queryByText('update.banner.manualTitle')).toBeNull();

    // A newer release shows again, and the collapsed form opens the same page.
    const URL_R2 = URL_R1.replace('-r1', '-r2');
    updateStatus.current = manual('personal-r2', URL_R2);
    rerender(<UpdateBanner isCollapsed />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'update.banner.manualAria' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'update.banner.manualAria' }));
    expect(openExternal).toHaveBeenLastCalledWith(URL_R2);
  });
});
