/**
 * PlaywrightDriver —— BrowserDriver 实现（mode ① headless / ② managed-profile）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §2 §3
 *
 * ①② 共用 Playwright CDP 路线，差别仅在 userDataDir 是否持久命名 + headless 开关。
 * connect(opts)：
 *   - 解析 userDataDir：mode ② 用 profileName → <dataDir>/browser/<name>/user-data；
 *     mode ① 用临时目录（一次性）
 *   - 分配 CDP 端口：per-profile 段内分配（18800-18899 首个空闲，
 *     同实例缓存 profileName→port 稳定映射），避免僵尸 chrome 占端口
 *   - launchChromeAndConnect → PlaywrightSession
 *
 * mode ③ attach 由 ChromeMcpDriver 实现，本文件不涉及。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { BrowserDriver, BrowserSession, BrowserConnectOptions } from './types';
import { resolveUserDataDir, DEFAULT_PROFILE_NAME } from './profile';
import { launchChromeAndConnect } from './chrome-launcher';
import { PlaywrightSession } from './playwright-session';
import { allocateCdpPort, netPortBusy, type PortBusyFn } from './cdp-port';

/**
 * PlaywrightDriver 工厂参数。
 * dataDir 来自 app config（含环境后缀），用于解析 profile 目录。
 * 默认 CDP 端口（无 config 时用），connectors 任务会从 profile config 读真实端口。
 */
export interface PlaywrightDriverOptions {
  /** app dataDir（config 注入） */
  dataDir: string;
  /**
   * 端口占用探测函数（BUG-001：per-profile 端口段分配）。
   * 默认 netPortBusy（127.0.0.1 TCP 探测）；测试可注入 mock。
   */
  portBusy?: PortBusyFn;
}

/**
 * PlaywrightDriver（mode ① + ② 共用实例）。
 * mode 由 connect opts 的 profileName/headless 推断：
 *   - profileName 给定 → ② managed-profile（持久 userDataDir）
 *   - 否则 → ① headless（一次性 userDataDir）
 *
 * BUG-001 修复：CDP 端口用段内 per-profile 分配（18800-18899 首个空闲），
 * 同一 driver 实例内缓存 profileName→port 映射（同进程内稳定，避免反复 launch 时端口漂移），
 * 多 driver 实例/僵尸残留靠端口探测避让。不再用固定 18800（僵尸 chrome 占端口根因）。
 */
export class PlaywrightDriver implements BrowserDriver {
  readonly mode = 'headless' as const; // 实际 mode 在 connect 时按 opts 推断
  private readonly dataDir: string;
  private readonly portBusy: PortBusyFn;
  /** 同实例内 profileName→port 缓存（稳定映射，避免同进程内同 profile 反复换端口） */
  private readonly portCache = new Map<string, number>();
  /** 同实例内已分配端口集合（allocateCdpPort usedPorts 入参） */
  private readonly usedPorts = new Set<number>();

  constructor(opts: PlaywrightDriverOptions) {
    this.dataDir = opts.dataDir;
    this.portBusy = opts.portBusy ?? netPortBusy;
  }

  async connect(opts: BrowserConnectOptions): Promise<BrowserSession> {
    const persistent = !!opts.profileName;
    const profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;

    // userDataDir：② 持久 <dataDir>/browser/<name>/user-data；① 临时目录
    const userDataDir = persistent
      ? resolveUserDataDir(this.dataDir, profileName)
      : mkdtempSync(join(tmpdir(), 'rocky-browser-'));

    // CDP 端口：per-profile 段内分配（BUG-001：不再固定 18800）
    const cdpPort = await this.resolveCdpPort(profileName);

    const { browser, kill } = await launchChromeAndConnect({
      executablePath: opts.executablePath,
      userDataDir,
      cdpPort,
      headless: persistent ? opts.headless : opts.headless ?? true,
      persistent,
    });

    return new PlaywrightSession(browser, kill);
  }

  /**
   * 解析 profile 的 CDP 端口：缓存命中且仍空闲 → 复用；否则 allocateCdpPort 分配。
   * 同实例内同 profile 稳定（缓存），跨实例/僵尸残留靠 netPortBusy 探测避让。
   */
  private async resolveCdpPort(profileName: string): Promise<number> {
    const cached = this.portCache.get(profileName);
    if (cached !== undefined) {
      // 缓存端口若仍被占（可能是上次 launch 的 chrome 还活着或僵尸）→ 重新分配
      try {
        const busy = await this.portBusy(cached);
        if (!busy) return cached;
      } catch {
        /* 探测异常 → 重新分配 */
      }
    }
    const port = await allocateCdpPort(this.usedPorts, this.portBusy);
    this.portCache.set(profileName, port);
    this.usedPorts.add(port);
    return port;
  }
}
