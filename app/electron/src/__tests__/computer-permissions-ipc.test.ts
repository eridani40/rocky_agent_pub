/**
 * computer-permissions-ipc 单测 — 原生权限/截图纯计算函数（v0.0.105 spike）
 * 参考: app/electron/src/computer-permissions-ipc.ts
 *
 * 只测纯计算函数（注入 fake 依赖，无需 Electron runtime）：
 *   - 非 macOS 优雅降级（不调 electron API、不崩）
 *   - macOS 分支返回形状 + 状态归一化 + 异常兜底
 * register/self-check 走真 electron require，不进 UT（Electron 主进程运行时才有）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  computeGetPermissions,
  computeRequestAccessibility,
  computeOpenScreenRecordingSettings,
  computeTestScreenshot,
  runComputerSelfCheck,
  type SystemPreferencesLike,
  type DesktopCapturerLike,
  type NativeImageLike,
  type ShellLike,
} from '../computer-permissions-ipc';

/** 造 systemPreferences fake */
function fakeSys(over: Partial<{ ax: boolean; screen: string }> = {}): SystemPreferencesLike {
  return {
    isTrustedAccessibilityClient: vi.fn(() => over.ax ?? false),
    getMediaAccessStatus: vi.fn(() => over.screen ?? 'not-determined'),
  };
}

/** 造 NativeImage fake */
function fakeImage(over: Partial<{ empty: boolean; url: string; w: number; h: number }> = {}): NativeImageLike {
  return {
    isEmpty: () => over.empty ?? false,
    toDataURL: () => over.url ?? 'data:image/png;base64,AAAA',
    getSize: () => ({ width: over.w ?? 640, height: over.h ?? 400 }),
  };
}

describe('computeGetPermissions', () => {
  it('非 macOS：supported=false + 都不可用（不调 electron API）', () => {
    const sys = fakeSys();
    const r = computeGetPermissions('linux', sys);
    expect(r).toEqual({ platform: 'linux', supported: false, accessibility: false, screenRecording: 'unknown' });
    expect(sys.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(sys.getMediaAccessStatus).not.toHaveBeenCalled();
  });

  it('macOS：透传 accessibility + 归一化 screenRecording（isTrusted 用 false 只查不弹）', () => {
    const sys = fakeSys({ ax: true, screen: 'granted' });
    const r = computeGetPermissions('darwin', sys);
    expect(r).toEqual({ platform: 'darwin', supported: true, accessibility: true, screenRecording: 'granted' });
    expect(sys.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(sys.getMediaAccessStatus).toHaveBeenCalledWith('screen');
  });

  it('macOS：未知 getMediaAccessStatus 值 → screenRecording=unknown', () => {
    const r = computeGetPermissions('darwin', fakeSys({ ax: false, screen: 'weird-value' }));
    expect(r.screenRecording).toBe('unknown');
    expect(r.accessibility).toBe(false);
  });

  it('macOS：denied / restricted / not-determined 原样保留', () => {
    for (const s of ['denied', 'restricted', 'not-determined'] as const) {
      expect(computeGetPermissions('darwin', fakeSys({ screen: s })).screenRecording).toBe(s);
    }
  });
});

describe('computeRequestAccessibility', () => {
  it('非 macOS：返回 false（不调 electron API）', () => {
    const sys = fakeSys({ ax: true });
    expect(computeRequestAccessibility('win32', sys)).toBe(false);
    expect(sys.isTrustedAccessibilityClient).not.toHaveBeenCalled();
  });

  it('macOS：调 isTrustedAccessibilityClient(true) 弹引导，返回当前信任态', () => {
    const sys = fakeSys({ ax: true });
    expect(computeRequestAccessibility('darwin', sys)).toBe(true);
    expect(sys.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
  });
});

describe('computeOpenScreenRecordingSettings', () => {
  it('非 macOS：{ok:false, reason:not-macos}（不调 shell）', async () => {
    const shell: ShellLike = { openExternal: vi.fn(async () => undefined) };
    expect(await computeOpenScreenRecordingSettings('linux', shell)).toEqual({ ok: false, reason: 'not-macos' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('macOS：深链系统设置屏幕录制页 → {ok:true}', async () => {
    const shell: ShellLike = { openExternal: vi.fn(async () => undefined) };
    const r = await computeOpenScreenRecordingSettings('darwin', shell);
    expect(r).toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  it('macOS：openExternal 抛错 → {ok:false, reason}', async () => {
    const shell: ShellLike = { openExternal: vi.fn(async () => { throw new Error('boom'); }) };
    const r = await computeOpenScreenRecordingSettings('darwin', shell);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('boom');
  });
});

describe('computeTestScreenshot', () => {
  it('非 macOS：{ok:false, reason:not-macos}', async () => {
    const cap: DesktopCapturerLike = { getSources: vi.fn(async () => []) };
    expect(await computeTestScreenshot('win32', cap)).toEqual({ ok: false, reason: 'not-macos' });
    expect(cap.getSources).not.toHaveBeenCalled();
  });

  it('macOS：无 source → {ok:false}（通常缺屏幕录制权限或需重启）', async () => {
    const cap: DesktopCapturerLike = { getSources: vi.fn(async () => []) };
    const r = await computeTestScreenshot('darwin', cap);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no-screen-source');
    expect(cap.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 640, height: 400 } });
  });

  it('macOS：thumbnail 空 → {ok:false}（缺权限/需重启生效）', async () => {
    const cap: DesktopCapturerLike = {
      getSources: vi.fn(async () => [{ name: 'Screen 1', thumbnail: fakeImage({ empty: true }) }]),
    };
    const r = await computeTestScreenshot('darwin', cap);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('empty-thumbnail');
  });

  it('macOS：正常 → {ok:true, dataUrl, width, height}', async () => {
    const cap: DesktopCapturerLike = {
      getSources: vi.fn(async () => [
        { name: 'Screen 1', thumbnail: fakeImage({ url: 'data:image/png;base64,ZZ', w: 640, h: 400 }) },
      ]),
    };
    const r = await computeTestScreenshot('darwin', cap);
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/png;base64,ZZ', width: 640, height: 400 });
  });

  it('macOS：getSources 抛错 → {ok:false, reason}（不抛出）', async () => {
    const cap: DesktopCapturerLike = { getSources: vi.fn(async () => { throw new Error('no perm'); }) };
    const r = await computeTestScreenshot('darwin', cap);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no perm');
  });
});

describe('runComputerSelfCheck（启动自检守护）', () => {
  it('绝不触发 desktopCapturer.getSources（守护：启动不触发屏幕录制权限请求），只走非侵入查询', () => {
    const getSources = vi.fn(async () => []);
    const sys = fakeSys({ ax: false, screen: 'not-determined' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 注入 fake 原生（免 electron runtime）；desktopCapturer 仅供本守护断言观测。
    runComputerSelfCheck({ systemPreferences: sys, desktopCapturer: { getSources } });

    // 核心守护（平台无关）：自检绝不调 getSources（getSources 首次会触发屏幕录制系统权限请求）。
    expect(getSources).not.toHaveBeenCalled();
    // 非侵入（平台无关）：辅助功能查询绝不用 prompt=true（true 会弹系统授权引导窗）。
    expect(sys.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
    // darwin 下自检走 isTrustedAccessibilityClient(false)（只查不弹）+ getMediaAccessStatus('screen')。
    if (process.platform === 'darwin') {
      expect(sys.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
      expect(sys.getMediaAccessStatus).toHaveBeenCalledWith('screen');
    }

    logSpy.mockRestore();
  });
});
