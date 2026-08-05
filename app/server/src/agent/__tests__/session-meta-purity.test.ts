/**
 * session_meta 纯粹性硬不变量 UT（v0.0.27）
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_channel.md §10.4（producer=session 层，状态机+agent-loop 纯粹）
 *   - specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md §5（硬约束）
 *   - task.json Task 4 acceptanceCriteria 第 4 条
 *
 * 验证：状态机 + agent-loop **不调 broadcaster、不 import session_meta / SessionMetaBroadcaster**。
 * （broadcaster 是状态机之上的 session 层组件，状态机/agent-loop 保持纯粹不感知 session_meta。）
 *
 * 实现方式：读源码文件文本，grep 断言无相关 import / 调用。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** src 根目录（app/server/src）。__dirname = .../app/server/src/agent/__tests__ */
const SRC_ROOT = join(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf-8');
}

describe('session_meta 纯粹性硬不变量', () => {
  it('session-state-machine.ts 不 import SessionMetaBroadcaster / session_meta', () => {
    const src = readSrc('agent/session-state-machine.ts');
    expect(src).not.toMatch(/SessionMetaBroadcaster/);
    expect(src).not.toMatch(/session-meta-broadcaster/);
    expect(src).not.toMatch(/SESSION_META_TOPIC/);
    // 状态机不调 broadcaster.broadcast
    expect(src).not.toMatch(/\.broadcast\s*\(/);
  });

  it('run-react-loop.ts 不 import SessionMetaBroadcaster / session_meta（v0.0.40 T6a：agent-loop.ts 退役，迁此）', () => {
    // v0.0.40 T6a 起 AgentLoop 类退役，主对话骨架迁入 run-react-loop.ts（+ build-deps.ts）
    // v0.0.49：ContextPort 退役，骨架直调 contextEngine，仍保持 session_meta 纯粹
    const src = readSrc('agent/run-react-loop.ts');
    expect(src).not.toMatch(/SessionMetaBroadcaster/);
    expect(src).not.toMatch(/session-meta-broadcaster/);
    expect(src).not.toMatch(/SESSION_META_TOPIC/);
    expect(src).not.toMatch(/\.broadcast\s*\(/);
  });

  it('loop-stage-context.ts 不 import SessionMetaBroadcaster / session_meta（v0.0.49：ContextPort 退役，context 交互迁此）', () => {
    // v0.0.49：context-port.ts 删除，contextEngine 交互胶水迁入 loop-stage-context.ts
    const src = readSrc('agent/loop-stage-context.ts');
    expect(src).not.toMatch(/SessionMetaBroadcaster/);
    expect(src).not.toMatch(/session-meta-broadcaster/);
    expect(src).not.toMatch(/SESSION_META_TOPIC/);
    expect(src).not.toMatch(/\.broadcast\s*\(/);
  });

  it('build-run-deps.ts 不 import SessionMetaBroadcaster / session_meta（v0.0.204 T3：build-deps.ts 合并为 build-run-deps.ts）', () => {
    const src = readSrc('agent/build-run-deps.ts');
    expect(src).not.toMatch(/SessionMetaBroadcaster/);
    expect(src).not.toMatch(/session-meta-broadcaster/);
    expect(src).not.toMatch(/SESSION_META_TOPIC/);
    expect(src).not.toMatch(/\.broadcast\s*\(/);
  });

  it('session-meta-broadcaster.ts 是 session 层组件（不 import agent-loop / state-machine）', () => {
    // broadcaster 不反向依赖状态机 / agent-loop（避免循环 + 归属层纯粹）
    const src = readSrc('agent/session-meta-broadcaster.ts');
    expect(src).not.toMatch(/from\s+['"].*agent-loop['"]/);
    expect(src).not.toMatch(/from\s+['"].*session-state-machine['"]/);
  });

  it('session-unread-runtime.ts 才持有 broadcaster 引用（session 层 fan-out 归属）', () => {
    // 反向确认 broadcaster 只被 session 层组件注入（runtime / wrap），不被状态机/agent-loop 引用
    const runtimeSrc = readSrc('agent/session-unread-runtime.ts');
    expect(runtimeSrc).toMatch(/SessionMetaBroadcaster/); // runtime 注入 + 产生路径直调
  });
});

describe('session_meta topic 注册契约（bootstrap + sse 白名单）', () => {
  it('bootstrap 装配链注册 session_meta topic + 构造 SessionMetaBroadcaster + 注入 wrap（v0.0.156 起装配拆到 bootstrap-bus-phase/bootstrap-store-phase）', () => {
    const busSrc = readSrc('bootstrap-bus-phase.ts');
    const storeSrc = readSrc('bootstrap-store-phase.ts');
    expect(busSrc).toMatch(/SESSION_META_TOPIC/);
    expect(busSrc).toMatch(/registerTopic\(SESSION_META_TOPIC/);
    expect(busSrc).toMatch(/replayable:\s*false/); // session_meta non-replayable（spec §10.3）
    expect(storeSrc).toMatch(/new SessionMetaBroadcaster/);
    expect(storeSrc).toMatch(/metaBroadcaster:\s*sessionMetaBroadcaster/); // runtime + wrap 都注入
  });

  it('handlers/sse.ts ALLOWED_TOPICS 含 session_meta（SSE 白名单放行）', () => {
    const src = readSrc('handlers/sse.ts');
    expect(src).toMatch(/'session_meta'/);
    expect(src).toMatch(/ALLOWED_TOPICS/);
  });
});
