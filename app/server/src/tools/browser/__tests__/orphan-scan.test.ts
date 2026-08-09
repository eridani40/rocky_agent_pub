/**
 * orphan-scan 单元测试（纯函数：marker 判定 / 目录提取 / ps 扫描 / 三层孤儿判定）
 * 参考: specs/tech/version_logs/v0.0.272/change_plan.md 裁决 1-3
 *
 * 重点覆盖「不误杀」：用户主 Chrome（9222 段 / 无 rocky marker）绝不命中；
 * 活跃实例（chromePidSet / ppid workerPidSet / ppid worker-entry）绝不判孤儿。
 */
import { describe, it, expect } from 'vitest';
import {
  isRockyChromeMarker,
  extractUserDataDir,
  scanRockyChromeProcesses,
  isOrphanChrome,
  buildOrphanCtx,
  type ChromeProcInfo,
} from '../orphan-scan';

describe('isRockyChromeMarker 白名单判定', () => {
  it('命中 rocky-browser-worker- 临时目录前缀（ET/headless worker 临时目录）', () => {
    expect(isRockyChromeMarker('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/x/rocky-browser-worker-abc')).toBe(true);
  });

  it('命中 rocky-browser-instance- 临时实例目录前缀', () => {
    expect(isRockyChromeMarker('--user-data-dir=/tmp/rocky-browser-instance-xyz --remote-debugging-port=18801')).toBe(true);
  });

  it('命中 et<digits>-prof（ET playwright user-data-dir）', () => {
    expect(isRockyChromeMarker('--user-data-dir=/tmp/et1234-prof --remote-debugging-port=9222')).toBe(true);
  });

  it('命中 CDP 18800-18899 段端口（rocky CDP 段）', () => {
    expect(isRockyChromeMarker('--remote-debugging-port=18850')).toBe(true);
  });

  it('不命中用户主 Chrome（9222 段 / 无 rocky marker）', () => {
    expect(isRockyChromeMarker('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222')).toBe(false);
  });

  it('不命中空串 / 非 string / 无 marker 的普通进程', () => {
    expect(isRockyChromeMarker('')).toBe(false);
    expect(isRockyChromeMarker('/usr/bin/ps')).toBe(false);
    // @ts-expect-error 纯函数防御：非 string 输入返 false
    expect(isRockyChromeMarker(undefined)).toBe(false);
  });

  it('端口段边界：18800 命中 / 18799 不命中 / 18900 不命中', () => {
    expect(isRockyChromeMarker('--remote-debugging-port=18800')).toBe(true);
    expect(isRockyChromeMarker('--remote-debugging-port=18799')).toBe(false);
    expect(isRockyChromeMarker('--remote-debugging-port=18900')).toBe(false);
  });
});

describe('extractUserDataDir 目录提取（rmSync 前二次验证）', () => {
  it('提取 rocky-browser-instance- 临时目录', () => {
    const dir = extractUserDataDir('--user-data-dir=/tmp/rocky-browser-instance-abc --remote-debugging-port=18801');
    expect(dir).toBe('/tmp/rocky-browser-instance-abc');
  });

  it('提取 et<digits>-prof 目录', () => {
    const dir = extractUserDataDir('--user-data-dir=/tmp/et99-prof');
    expect(dir).toBe('/tmp/et99-prof');
  });

  it('不提取 managed 持久目录（browser/p1/user-data 非 rocky marker）', () => {
    const dir = extractUserDataDir(`--user-data-dir=/data/browser/p1/user-data --remote-debugging-port=18802`);
    expect(dir).toBeNull();
  });

  it('不提取用户 Chrome 数据目录（防误删用户数据）', () => {
    const dir = extractUserDataDir('--user-data-dir=/Users/x/Library/Application Support/Google/Chrome --remote-debugging-port=9222');
    expect(dir).toBeNull();
  });

  it('无 user-data-dir → null；坏输入 → null', () => {
    expect(extractUserDataDir('--remote-debugging-port=18803')).toBeNull();
    // @ts-expect-error 纯函数防御
    expect(extractUserDataDir(undefined)).toBeNull();
  });
});

describe('scanRockyChromeProcesses ps 扫描（双段：all 全量表 + candidates marker chrome）', () => {
  // 真实形态 ps 输出：含 worker-entry node 进程（无 rocky marker）+ marker chrome + 用户 chrome
  const psOut = [
    '  PID  PPID COMMAND',
    '  100     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222',
    '  200     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/rocky-browser-instance-a --remote-debugging-port=18801',
    '  201   200 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer',
    '  777     1 node /usr/local/lib/rocky/dist/app/server/src/tools/browser/worker-entry.js',
    '  888   777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/rocky-browser-instance-b --remote-debugging-port=18802',
    '  badline-no-pid-format',
    '  400     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/et7-prof',
  ].join('\n');

  it('all = 全量进程表（含 worker-entry node 进程）；candidates = 仅 marker chrome（用户 9222/helper/worker-entry 排除）', async () => {
    const scan = await scanRockyChromeProcesses(async (_cmd, _args) => psOut);
    // all：全部合法行（含 worker-entry node 进程 777 + 用户 chrome 100 + helper 201）
    expect(scan.all.map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 200, 201, 400, 777, 888]);
    // candidates：仅 marker chrome（200 instance-a / 888 instance-b / 400 et7-prof）
    expect(scan.candidates.map((p) => p.pid).sort((a, b) => a - b)).toEqual([200, 400, 888]);
    expect(scan.candidates.find((p) => p.pid === 200)!.userDataDir).toBe('/tmp/rocky-browser-instance-a');
    expect(scan.candidates.find((p) => p.pid === 400)!.userDataDir).toBe('/tmp/et7-prof');
    expect(scan.candidates.find((p) => p.pid === 888)!.userDataDir).toBe('/tmp/rocky-browser-instance-b');
    // worker-entry node 进程不在 candidates（cmdline 无 marker）→ 不会被回收
    expect(scan.candidates.find((p) => p.pid === 777)).toBeUndefined();
  });

  it('buildOrphanCtx(all) 可反查 worker-entry cmdline（第三层保护数据源）', async () => {
    const scan = await scanRockyChromeProcesses(async (_cmd, _args) => psOut);
    const { procByPid } = buildOrphanCtx(scan.all);
    // 生产关键：888 的 ppid=777 → procByPid 能查到 worker-entry cmdline → 第三层保护生效
    expect(procByPid.get(777)).toContain('worker-entry');
    expect(procByPid.get(888)).toContain('rocky-browser-instance-b');
  });

  it('坏行容错（缺 pid/ppid 格式跳过）；空输出 → 双段空', async () => {
    const scan = await scanRockyChromeProcesses(async () => '');
    expect(scan.all).toEqual([]);
    expect(scan.candidates).toEqual([]);
    const scan2 = await scanRockyChromeProcesses(async () => '  abc  def  chrome\n');
    expect(scan2.all).toEqual([]);
    expect(scan2.candidates).toEqual([]);
  });

  it('exec 抛错 → reject（调用方 catch warn）', async () => {
    await expect(
      scanRockyChromeProcesses(async () => { throw new Error('ps 失败'); }),
    ).rejects.toThrow('ps 失败');
  });
});

describe('isOrphanChrome 三层孤儿判定（防误杀核心）', () => {
  function mkProc(pid: number, ppid: number, cmdline = ''): ChromeProcInfo {
    return { pid, ppid, cmdline, userDataDir: null };
  }
  function mkCtx(chromePidSet: number[], workerPidSet: number[], workerEntryPids: number[]) {
    // 真实形态：procByPid 基于全量进程表（含 worker-entry node 进程）
    const procs = workerEntryPids.map((p) => mkProc(p, 1, `node .../worker-entry.js (pid ${p})`));
    const { procByPid } = buildOrphanCtx(procs);
    return { chromePidSet: new Set(chromePidSet), workerPidSet: new Set(workerPidSet), procByPid };
  }

  it('① pid ∈ 活跃 chromePidSet → 活跃（不误杀）', () => {
    const ctx = mkCtx([555], [111], []);
    expect(isOrphanChrome(mkProc(555, 999), ctx)).toBe(false);
  });

  it('② ppid ∈ 活跃 workerPidSet → 活跃（旧记录 v0.0.272 前无 chromePid 兼容；不误杀）', () => {
    const ctx = mkCtx([], [111], []);
    expect(isOrphanChrome(mkProc(666, 111), ctx)).toBe(false);
  });

  it('③ ppid cmdline 含 worker-entry → 活跃（launch 中保护；不误杀）', () => {
    const ctx = mkCtx([], [], [777]);
    expect(isOrphanChrome(mkProc(888, 777), ctx)).toBe(false);
  });

  it('④ 否则 → 孤儿（ppid 不在任何集合且非 worker-entry）', () => {
    const ctx = mkCtx([], [], []);
    expect(isOrphanChrome(mkProc(999, 1), ctx)).toBe(true);
  });

  it('ppid 无 cmdline 记录（ps 截断/未知）→ 走孤儿判定（保守回收侧）', () => {
    const ctx = mkCtx([], [], []);
    expect(isOrphanChrome(mkProc(1234, 4321), ctx)).toBe(true);
  });
});
