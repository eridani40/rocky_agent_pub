/**
 * workspace-dir-watcher 单元测试 —— depth:0 真实 fs 行为 + close 幂等
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md §2/§3.1/§4/§7
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1/模块5 dir-watcher 行
 *
 * 覆盖：
 *   - WATCH_OPTIONS 配置常量（depth:0 + ignored 函数匹配 + ignoreInitial/persistent）
 *   - waitForChokidarReady：once(ready) resolve + 超时 resolve 不抛
 *   - mapKind：5 类文件变化事件映射 + 非文件变化事件（ready/raw）返回 null
 *   - openDirWatcher 真实 fs：depth:0 一层非递归——含「大」子目录的目录只感知子目录条目本身，
 *     绝不感知其内部文件变化；新建子目录不自动被递归纳入监听（红线①核心回归防线）
 *   - closeDirWatcher 幂等：重复 close / 并发连点 close 不抛不崩（Bun FSEvents 崩溃面兜底）
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  WATCH_OPTIONS,
  waitForChokidarReady,
  mapKind,
  openDirWatcher,
  closeDirWatcher,
  type DirWatcher,
} from '../workspace-dir-watcher';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-dirwatcher-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawEvent {
  eventName: string;
  absPath: string;
}

/**
 * 有界轮询：直到 events 出现满足 predicate 的记录，或超时（fail-soft，caller 紧随其后断言）。
 *
 * timeoutMs 默认 5000ms（v0.0.158 从 2000ms 提升）：chokidar 在 bun 全量并发下 addDir 事件
 * 会因 fs 载荷高被推迟到 2000ms 附近（memory: chokidar-watcher-await-ready-addDir 相关表征）。
 * 默认 2000ms 时相关断言呈现间歇 flaky（约 50% pass 率）；5000ms 给足事件传播窗口。
 * fail-soft 语义不变——超时静默返回，由 caller 的 expect 断言给出最终判定。
 */
async function waitForRawEvent(
  events: RawEvent[],
  predicate: (e: RawEvent) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return;
    await sleep(20);
  }
}

// ============================================================
// 1. WATCH_OPTIONS 配置常量（spec §4）
// ============================================================

describe('workspace-dir-watcher — WATCH_OPTIONS 配置常量', () => {
  it('depth:0（一层非递归——懒监听结构性开关）', () => {
    expect(WATCH_OPTIONS.depth).toBe(0);
  });

  it('ignoreInitial:true + persistent:true', () => {
    expect(WATCH_OPTIONS.ignoreInitial).toBe(true);
    expect(WATCH_OPTIONS.persistent).toBe(true);
  });

  it('ignored 函数匹配目录段（chokidar v4 无 glob；4 个排除目录名 + 前缀名不误伤）', () => {
    const ig = WATCH_OPTIONS.ignored;
    expect(ig('/ws/node_modules/pkg/index.js')).toBe(true);
    expect(ig('/ws/.git/HEAD')).toBe(true);
    expect(ig('/ws/.venv/lib/site-packages/x.py')).toBe(true);
    expect(ig('/ws/sub/__pycache__/m.pyc')).toBe(true);
    expect(ig('/ws/src/index.ts')).toBe(false);
    expect(ig('/ws/node_modules_notes.md')).toBe(false); // 仅目录段精确匹配，不误伤同前缀名（hotfix 1ef2d61c 核心保证）
  });
});

// ============================================================
// 2. waitForChokidarReady + mapKind（迁自旧 manager，逻辑不变）
// ============================================================

describe('waitForChokidarReady', () => {
  it('once(ready) 立即 resolve（不等到超时）', async () => {
    const ee = new EventEmitter();
    const t0 = Date.now();
    setTimeout(() => ee.emit('ready'), 20);
    await waitForChokidarReady(ee as unknown as { once(e: string, cb: () => void): unknown }, 5000);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('ready 不来 → 超时 resolve（不抛）', async () => {
    const ee = new EventEmitter();
    await expect(
      waitForChokidarReady(ee as unknown as { once(e: string, cb: () => void): unknown }, 80),
    ).resolves.toBeUndefined();
  });
});

describe('mapKind', () => {
  it('映射 5 类文件变化事件（透传原名）', () => {
    expect(mapKind('add')).toBe('add');
    expect(mapKind('change')).toBe('change');
    expect(mapKind('unlink')).toBe('unlink');
    expect(mapKind('addDir')).toBe('addDir');
    expect(mapKind('unlinkDir')).toBe('unlinkDir');
  });

  it('非文件变化事件（ready/raw）返回 null（忽略）', () => {
    expect(mapKind('ready')).toBeNull();
    expect(mapKind('raw')).toBeNull();
  });
});

// ============================================================
// 3. openDirWatcher 真实 fs：depth:0 一层非递归（懒监听核心回归防线）
// ============================================================

describe('openDirWatcher — depth:0 一层非递归（真实 fs）', () => {
  it('直接子项变化被捕获；「大」子目录（预置多文件）内部变化不被捕获', async () => {
    const absDir = resolve(tmpRoot, 'dirA');
    const bigSub = join(absDir, 'big');
    mkdirSync(bigSub, { recursive: true });
    // 预置若干文件模拟「.venv 型」大子目录（watch 开始前已存在）
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(bigSub, `f${i}.txt`), 'x');
    }
    const nested = join(bigSub, 'nested.txt');
    writeFileSync(nested, 'pre-existing');

    const events: RawEvent[] = [];
    const handle = await openDirWatcher({
      sessionId: 's1',
      absDir,
      onEvent: (_sid, _dir, eventName, absPath) => {
        events.push({ eventName, absPath });
      },
    });

    try {
      expect(handle.ready).toBe(true);

      // 修改「大」子目录内部预置文件 → depth:0 不应下降进 big/，不产事件
      writeFileSync(nested, 'modified');
      await sleep(300); // 给可能的误报事件充分时间冒出
      expect(events.some((e) => e.absPath === nested)).toBe(false);

      // 直接子项（absDir 顶层）变化 → 应被捕获
      const topFile = join(absDir, 'top.txt');
      writeFileSync(topFile, 'hello');
      await waitForRawEvent(events, (e) => e.absPath === topFile && e.eventName === 'add');
      expect(events.some((e) => e.absPath === topFile && e.eventName === 'add')).toBe(true);
    } finally {
      await closeDirWatcher(handle);
    }
  });

  it('运行时新建子目录不自动被递归监听（MUST NOT addDir→watcher.add，红线①）', { retry: 2, timeout: 15000 }, async () => {
    // 全量 suite 高并发 CPU 争用下 chokidar addDir emit 时序可能被拉伸，超默认 5s → vitest
    // retry:2 + timeout:15s（与 session-workspace-manager-f2 同处置），避免偶发假 fail。
    const absDir = resolve(tmpRoot, 'dirB');
    mkdirSync(absDir, { recursive: true });

    const events: RawEvent[] = [];
    const handle = await openDirWatcher({
      sessionId: 's1',
      absDir,
      onEvent: (_sid, _dir, eventName, absPath) => {
        events.push({ eventName, absPath });
      },
    });

    try {
      // 新建直接子目录 → addDir 事件应被捕获（前端文件树显示新文件夹）
      const newSub = join(absDir, 'newSub');
      mkdirSync(newSub);
      await waitForRawEvent(events, (e) => e.absPath === newSub && e.eventName === 'addDir');
      expect(events.some((e) => e.absPath === newSub && e.eventName === 'addDir')).toBe(true);

      // 在新子目录内写文件（该子目录未被显式 watch）→ 不应自动被纳入监听，无事件
      const grandchild = join(newSub, 'x.txt');
      writeFileSync(grandchild, 'y');
      await sleep(300);
      expect(events.some((e) => e.absPath === grandchild)).toBe(false);
    } finally {
      await closeDirWatcher(handle);
    }
  });
});

// ============================================================
// 4. closeDirWatcher 幂等 + 快速连点（Bun FSEvents 崩溃面兜底）
// ============================================================

describe('closeDirWatcher — 幂等 + 并发连点不崩', () => {
  it('重复 close 同一句柄不抛错（幂等）', async () => {
    const absDir = resolve(tmpRoot, 'dirC');
    mkdirSync(absDir, { recursive: true });
    const handle = await openDirWatcher({ sessionId: 's1', absDir, onEvent: () => {} });

    await expect(closeDirWatcher(handle)).resolves.toBeUndefined();
    await expect(closeDirWatcher(handle)).resolves.toBeUndefined();
    await expect(closeDirWatcher(handle)).resolves.toBeUndefined();
    expect(handle.closed).toBe(true);
  });

  it('并发连点 close 同一句柄不崩（Promise.all 快速连点）', async () => {
    const absDir = resolve(tmpRoot, 'dirD');
    mkdirSync(absDir, { recursive: true });
    const handle = await openDirWatcher({ sessionId: 's1', absDir, onEvent: () => {} });

    await expect(
      Promise.all([closeDirWatcher(handle), closeDirWatcher(handle), closeDirWatcher(handle)]),
    ).resolves.toBeDefined();
    expect(handle.closed).toBe(true);
  });

  it('快速连续 open→close→open 不同句柄同一目录序列不崩（各自独立 handle）', async () => {
    const absDir = resolve(tmpRoot, 'dirE');
    mkdirSync(absDir, { recursive: true });

    let h1: DirWatcher | undefined;
    let h2: DirWatcher | undefined;
    await expect(
      (async () => {
        h1 = await openDirWatcher({ sessionId: 's1', absDir, onEvent: () => {} });
        await closeDirWatcher(h1);
        h2 = await openDirWatcher({ sessionId: 's1', absDir, onEvent: () => {} });
        await closeDirWatcher(h2);
      })(),
    ).resolves.toBeUndefined();
    expect(h1?.closed).toBe(true);
    expect(h2?.closed).toBe(true);
  });
});
