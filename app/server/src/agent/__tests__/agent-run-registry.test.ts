/**
 * agent-run-registry 单元测试 — createAgentRunShell / makeErrorRun / cleanupRun
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §4 三 map
 *
 * 核心覆盖（Bun crash 修复回归）：
 *   - makeErrorRun 不产生 unhandled rejection（原 __reject 后无人 catch 致 Bun 进程 crash）
 *   - shell.state='error' 仍是权威 error 信号
 *   - caller 后续 await shell.promise 仍 throw（语义保留，挂 noop catch 不影响 await 行为）
 *
 * 隔离：纯函数测试，不读写文件系统。
 */
import { describe, it, expect } from 'vitest';
import {
  makeErrorRun,
  createAgentRunShell,
  cleanupRun,
  loopKey,
  runMapKey,
  RUN_KIND_MAIN,
} from '../agent-run-registry';
import type { AgentRun } from '../agent-interface';
import { ModelNotConfiguredError } from '../../services/model-resolver';

/**
 * 等待足够 microtask 让 unhandled rejection 有机会触发 process.on('unhandledRejection')。
 * setImmediate 跨过所有 microtask，连调两次保证不同 tick 的 rejection 都被捕获。
 */
async function waitForUnhandledRejectionWindow(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe('makeErrorRun — Bun crash 修复回归', () => {
  it('state=error + runId ULID + 不产生 unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', handler);

    try {
      const shell = makeErrorRun('sid_test', RUN_KIND_MAIN, 'boom');

      // error 信号权威源
      expect(shell.state).toBe('error');
      expect(shell.sessionId).toBe('sid_test');
      expect(shell.runKind).toBe(RUN_KIND_MAIN);

      // runId 是 ULID（26 字符）
      expect(shell.runId).toMatch(/^[0-9A-Z]{26}$/);

      // 等 microtask 窗口，确认没有任何 unhandled rejection 触发
      await waitForUnhandledRejectionWindow();

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('await shell.promise 仍 throw（rejection 语义保留给 caller）', async () => {
    const shell = makeErrorRun('sid_test', RUN_KIND_MAIN, 'config resolve failed');

    // caller 可 await promise 拿 error（state==='error' 时通常走 500，但 await 语义仍保留）
    await expect(shell.promise).rejects.toThrow('config resolve failed');
  });

  it('caller 二次 .catch 与内部 noop catch 不冲突（多次 handler 各自触发）', async () => {
    const shell = makeErrorRun('sid_test', RUN_KIND_MAIN, 'duplicated catch');

    let callerCaught = false;
    let caughtMsg = '';
    try {
      await shell.promise;
    } catch (e) {
      callerCaught = true;
      caughtMsg = e instanceof Error ? e.message : String(e);
    }

    // caller 仍能 catch 到错误（挂 noop catch 不影响 promise 最终态/await throw 语义）
    expect(callerCaught).toBe(true);
    expect(caughtMsg).toBe('duplicated catch');
  });
});

describe('makeErrorRun — 原 Error 透传（P1 修复）', () => {
  it('Error 对象入参：shell.error 原样保留 + instanceof 可识别', () => {
    // v0.0.158：ModelNotConfiguredError 构造签名去 task 参数（chat/compact 同链），
    //   detail 从 {sessionType, task} 收窄为 {sessionType}。
    const err = new ModelNotConfiguredError('playground');
    const shell = makeErrorRun('sid_ghost', RUN_KIND_MAIN, err);

    // 透传原 Error，caller handler 据 instanceof 决定 HTTP 状态码
    expect(shell.state).toBe('error');
    expect(shell.error).toBe(err);
    expect(shell.error).toBeInstanceOf(ModelNotConfiguredError);
    if (shell.error instanceof ModelNotConfiguredError) {
      expect(shell.error.code).toBe('MODEL_NOT_CONFIGURED');
      expect(shell.error.detail).toEqual({ sessionType: 'playground' });
    }
  });

  it('字符串入参：兼容旧调用点（自动包 Error）', () => {
    const shell = makeErrorRun('sid_x', RUN_KIND_MAIN, 'session not found: sid_x');

    expect(shell.state).toBe('error');
    expect(shell.error).toBeInstanceOf(Error);
    expect((shell.error as Error).message).toBe('session not found: sid_x');
    // 非结构化错误 → caller handler 走 500 兜底
    expect(shell.error).not.toBeInstanceOf(ModelNotConfiguredError);
  });

  it('Error 透传后仍不产生 unhandled rejection（护栏保留）', async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', handler);

    try {
      const err = new ModelNotConfiguredError('playground', 'summary');
      makeErrorRun('sid_y', RUN_KIND_MAIN, err);

      for (let i = 0; i < 3; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('await promise throw 的错误 === 原 Error 对象（语义保留）', async () => {
    const err = new ModelNotConfiguredError('studio', 'chat');
    const shell = makeErrorRun('sid_z', RUN_KIND_MAIN, err);

    await expect(shell.promise).rejects.toBe(err);
  });
});

describe('createAgentRunShell — 基础构造', () => {
  it('构造 running 态 shell，promise 初始 pending', () => {
    const shell = createAgentRunShell('sid_a', RUN_KIND_MAIN, '01KWP8VBDKNQRS8NDPQYV15PFK');

    expect(shell.sessionId).toBe('sid_a');
    expect(shell.runKind).toBe(RUN_KIND_MAIN);
    expect(shell.runId).toBe('01KWP8VBDKNQRS8NDPQYV15PFK');
    expect(shell.state).toBe('running');
    expect(shell.result).toBeUndefined();
    expect(shell.groupKey).toBe('session_id:sid_a_amt:main');
    expect(shell.promise).toBeInstanceOf(Promise);
  });

  it('groupKey 形如 session_id:<sid>_amt:<runKind>', () => {
    const forked = createAgentRunShell('sid_b', 'summary', 'run_x');
    expect(forked.groupKey).toBe('session_id:sid_b_amt:summary');
  });
});

describe('cleanupRun — 三 map 条目清理', () => {
  it('删除 agentRuns + abortControllers 对应条目', () => {
    const agentRuns = new Map<string, AgentRun>();
    const abortControllers = new Map<string, { runId: string; aborted: boolean }>();

    const rk = runMapKey('sid_c', RUN_KIND_MAIN);
    agentRuns.set(rk, createAgentRunShell('sid_c', RUN_KIND_MAIN, 'r1'));
    abortControllers.set(rk, { runId: 'r1', aborted: false });

    expect(agentRuns.has(rk)).toBe(true);
    expect(abortControllers.has(rk)).toBe(true);

    cleanupRun(agentRuns, abortControllers, rk);

    expect(agentRuns.has(rk)).toBe(false);
    expect(abortControllers.has(rk)).toBe(false);
  });

  it('runKey 不存在时 cleanup 幂等 no-op', () => {
    const agentRuns = new Map<string, AgentRun>();
    const abortControllers = new Map<string, { runId: string; aborted: boolean }>();

    expect(() =>
      cleanupRun(agentRuns, abortControllers, runMapKey('missing', RUN_KIND_MAIN)),
    ).not.toThrow();
  });
});

describe('key helpers', () => {
  it('loopKey = ${sid}_main', () => {
    expect(loopKey('sid_d')).toBe('sid_d_main');
  });

  it('runMapKey = ${sid}_${runKind}', () => {
    expect(runMapKey('sid_e', 'main')).toBe('sid_e_main');
    expect(runMapKey('sid_e', 'summary')).toBe('sid_e_summary');
  });

  it('RUN_KIND_MAIN 常量', () => {
    expect(RUN_KIND_MAIN).toBe('main');
  });
});
