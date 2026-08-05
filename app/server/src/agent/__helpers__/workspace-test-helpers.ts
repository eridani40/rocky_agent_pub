/**
 * Workspace watch 测试辅助 —— bounded poll 模式消除 chokidar 固定 sleep 断言的 flakiness。
 * 参考: specs/tech/version_logs/v0.0.85.ui_opt/change_plan.md F2 段（UT flaky 修复）
 *       tests/api/lib/poll.sh bounded poll 同款思路
 *
 * 背景：固定 `await sleep(N); expect(events ...)` 模式在并行/CPU 争用下 flaky——
 *   chokidar emit + 100ms debounce + addDir listener 的总时序被拉伸，N 不够时事件未到，
 *   N 过大则浪费时间。bounded poll 直到满足谓词或超时（fail-soft：超时不抛错，
 *   caller 紧随其后用 expect(...) 做最终断言，错误信息更具诊断价值）。
 *
 * 仅测试用：vitest include 仅匹配 *.test.ts，本文件不会被视为测试用例。
 */
import type { ReplayableEventBus } from '../event-bus';

/**
 * 单个 session_workspace_file_changed 事件的 payload 形状。
 * 与 session-workspace-manager.ts flushPending emit 对齐（collectEvents 把 r.value.data push 进数组）。
 */
export interface WorkspaceFileEvent {
  id: string;
  type: 'session_workspace_file_changed';
  sessionId: string;
  createdAt: string;
  data: { path: string; kind: string; isDir: boolean };
}

/** collectEvents 返回的 collector 形状（events 数组 + sub.cancel） */
export interface EventCollector {
  events: unknown[];
  sub: { cancel: () => void };
}

/**
 * 订阅 statusBus 收集所有 event（验 payload）。
 * 与 baseline session-workspace-manager.test.ts 内联的同名 helper 行为对齐——
 * 提取共享以缩短 F2 test 文件（≤300 行）。
 */
export function collectEvents(sid: string, statusBus: ReplayableEventBus): EventCollector {
  const events: unknown[] = [];
  const iter = statusBus.subscribe(`session_id:${sid}`)[Symbol.asyncIterator]();
  const stopSignal = { stopped: false };
  const consume = async () => {
    while (!stopSignal.stopped) {
      const r = await iter.next();
      if (r.done) break;
      events.push((r.value as { data: unknown }).data);
    }
  };
  void consume();
  return {
    events,
    sub: {
      cancel: () => {
        stopSignal.stopped = true;
        void iter.return?.();
      },
    },
  };
}

/**
 * waitForFileEvent —— 有界轮询 col.events 直到出现满足 predicate 的事件或超时。
 * 替代 `await sleep(N); expect(events...)` flaky 模式。
 *
 * 超时不抛错（fail-soft）：caller 紧随其后用 expect(...) 做最终断言，错误信息更有诊断价值
 *   （能打印当前 events 数组而非无信息的超时 stack）。
 *
 * @param col         collectEvents 返回的 collector（须含 events 数组）
 * @param predicate   满足条件的 event 谓词（接 WorkspaceFileEvent）
 * @param timeoutMs   总等待上限（默认 2000ms —— 远大于 100ms debounce + chokidar emit 正常耗时）
 * @param intervalMs  轮询间隔（默认 20ms）
 */
export async function waitForFileEvent(
  col: { events: unknown[] },
  predicate: (e: WorkspaceFileEvent) => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (col.events as WorkspaceFileEvent[]).find(predicate);
    if (found) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  // 超时不抛错：caller 紧随其后用 expect(...) 做最终断言
}
