// @vitest-environment node
/**
 * session-slice-reducer 单测（v0.0.13 S4）
 * 参考: specs/tech/agent/session/[P0]session_event.md §2-§3（SessionStatus 五态 + 触发时机）
 *       specs/tech/app/frontend/[P0]sse_channel.md §9（chat 页 session_panel 订阅）
 *       specs/ui/components/chat-page/_overview.md §5-6（running 状态来源）/ §4.11b（abort-btn）
 *
 * 覆盖 applySessionStatusUpdate 纯函数：
 *   - state=running / currentRunId 非空 → sessionRunning=true
 *   - state=interrupting → sessionRunning=true（abort 收尾中，含中间态 [D4.2]）
 *   - state=interrupted → sessionRunning=false
 *   - state=idle → sessionRunning=false
 *   - state=error → sessionRunning=false
 *   - data.running 字段权威优先；缺失时按 state 推导
 *   - sessionStatus 快照正确
 */
import { describe, it, expect } from 'vitest';
import {
  applySessionStatusUpdate,
  type SessionEvent,
} from '../session-slice-reducer';

/** session_status_update 帧类型（从 SessionEvent union 提取，[v0.0.16] union 扩展后 mkEvt 需 narrow） */
type SessionStatusUpdateEvent = Extract<SessionEvent, { type: 'session_status_update' }>;
/** SessionStatus.state 枚举（从 SessionStatus 提取） */
type SessionStateKind = SessionStatusUpdateEvent['data']['state'];

/** 构造 session_status_update 帧 helper（narrow 到 session_status_update 分支） */
function mkEvt(
  state: SessionStateKind,
  running: boolean,
  currentRunId: string | null,
): SessionStatusUpdateEvent {
  return {
    type: 'session_status_update',
    sessionId: 'sess-1',
    createdAt: '2026-06-22T00:00:00.000Z',
    data: { state, running, currentRunId },
  };
}

describe('applySessionStatusUpdate (v0.0.13 S4)', () => {
  it('state=running + currentRunId 非空 → sessionRunning=true（run 进行中，abort-btn 可见）', () => {
    const out = applySessionStatusUpdate(mkEvt('running', true, 'run-abc'), false);
    expect(out.sessionRunning).toBe(true);
    expect(out.sessionStatus.state).toBe('running');
    expect(out.sessionStatus.currentRunId).toBe('run-abc');
  });

  it('state=interrupting → sessionRunning=true（abort 收尾中间态，[D4.2] 关键差异点）', () => {
    // 这是 session_panel 比 agent_loop 更权威的核心场景：
    // abort 已触发但 run_stop 未到 → agent_loop 派生会把 sessionRunning 抖动到 false，
    // session_panel 状态机 emit 保持 true，UI 中断按钮仍可见（disabled）
    const out = applySessionStatusUpdate(mkEvt('interrupting', true, null), false);
    expect(out.sessionRunning).toBe(true);
    expect(out.sessionStatus.state).toBe('interrupting');
    expect(out.sessionStatus.currentRunId).toBe(null);
  });

  it('state=interrupted → sessionRunning=false（中断收尾完成，abort-btn 消失）', () => {
    const out = applySessionStatusUpdate(mkEvt('interrupted', false, null), true);
    expect(out.sessionRunning).toBe(false);
    expect(out.sessionStatus.state).toBe('interrupted');
  });

  it('state=idle → sessionRunning=false（正常结束）', () => {
    const out = applySessionStatusUpdate(mkEvt('idle', false, null), true);
    expect(out.sessionRunning).toBe(false);
  });

  it('state=error → sessionRunning=false（异常终态）', () => {
    const out = applySessionStatusUpdate(mkEvt('error', false, null), true);
    expect(out.sessionRunning).toBe(false);
  });

  it('data.running 字段权威：即使 state=running，data.running=false → sessionRunning=false', () => {
    // 边界：状态机权威 data.running 优先于 state 推导
    const out = applySessionStatusUpdate(mkEvt('running', false, 'run-x'), true);
    expect(out.sessionRunning).toBe(false);
  });

  it('data.running 缺失（undefined）时按 state 推导兜底', () => {
    // 边界：后端某次漏字段，前端不应崩 —— 按 state 推导
    const evt: SessionStatusUpdateEvent = {
      type: 'session_status_update',
      sessionId: 'sess-1',
      createdAt: '2026-06-22T00:00:00.000Z',
      data: { state: 'running', running: undefined as unknown as boolean, currentRunId: 'r' },
    };
    const out = applySessionStatusUpdate(evt, false);
    expect(out.sessionRunning).toBe(true);

    const evt2: SessionStatusUpdateEvent = {
      type: 'session_status_update',
      sessionId: 'sess-1',
      createdAt: '2026-06-22T00:00:00.000Z',
      data: { state: 'interrupting', running: undefined as unknown as boolean, currentRunId: null },
    };
    expect(applySessionStatusUpdate(evt2, false).sessionRunning).toBe(true);

    const evt3: SessionStatusUpdateEvent = {
      type: 'session_status_update',
      sessionId: 'sess-1',
      createdAt: '2026-06-22T00:00:00.000Z',
      data: { state: 'idle', running: undefined as unknown as boolean, currentRunId: null },
    };
    expect(applySessionStatusUpdate(evt3, true).sessionRunning).toBe(false);
  });

  it('整个 data 缺失 → 安全兜底 sessionRunning=false（不崩）', () => {
    const evt = {
      type: 'session_status_update',
      sessionId: 'sess-1',
      createdAt: '2026-06-22T00:00:00.000Z',
      data: undefined as unknown as SessionStatusUpdateEvent['data'],
    } as SessionStatusUpdateEvent;
    const out = applySessionStatusUpdate(evt, true);
    expect(out.sessionRunning).toBe(false);
    expect(out.sessionStatus.state).toBe('idle');
  });

  it('中断完整序列：running → interrupting → interrupted（验证状态机推进正确）', () => {
    // 用户点 chat-abort 后的真实事件序列（design 板块 5.2）
    // step1: POST /messages → markRunning emit
    const s1 = applySessionStatusUpdate(mkEvt('running', true, 'run-1'), false);
    expect(s1.sessionRunning).toBe(true);

    // step2: POST /abort → markInterrupting emit（中间态，[D4.2] 关键）
    const s2 = applySessionStatusUpdate(mkEvt('interrupting', true, null), s1.sessionRunning);
    expect(s2.sessionRunning).toBe(true); // 中断按钮仍可见（disabled）

    // step3: abort 4 步收尾完成 → markInterrupted emit
    const s3 = applySessionStatusUpdate(mkEvt('interrupted', false, null), s2.sessionRunning);
    expect(s3.sessionRunning).toBe(false); // 中断按钮消失
  });

  it('正常完成序列：idle → running → idle', () => {
    const s1 = applySessionStatusUpdate(mkEvt('idle', false, null), false);
    expect(s1.sessionRunning).toBe(false);

    const s2 = applySessionStatusUpdate(mkEvt('running', true, 'run-1'), s1.sessionRunning);
    expect(s2.sessionRunning).toBe(true);

    const s3 = applySessionStatusUpdate(mkEvt('idle', false, null), s2.sessionRunning);
    expect(s3.sessionRunning).toBe(false);
  });

  it('sessionStatus 快照保留 currentRunId（便于扩展 run-level UI 联动）', () => {
    const out = applySessionStatusUpdate(mkEvt('running', true, 'run-xyz'), false);
    expect(out.sessionStatus.currentRunId).toBe('run-xyz');
    expect(out.sessionStatus.running).toBe(true);
  });
});

/**
 * [v0.0.39 P2] 原 chat-slice store 集成测试（sessionRunning 权威源切换 / setSessionRunning / resetRunState）
 * 已迁至 `app/web/src/components/chat-page/__tests__/use-session-run-state.test.tsx`——run 态从 store 迁至
 * 共享引擎 useSessionRunState，这些行为现在由引擎持有（agent_loop run_start 不覆盖 sessionRunning、
 * session_status_update 权威源、切 session reset、GET /session 恢复初值）。纯 reducer 测试见上方。
 */
