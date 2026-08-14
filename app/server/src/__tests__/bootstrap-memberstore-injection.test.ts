/**
 * bootstrap — AgentManagerImpl memberStore 装配集成测试（[v0.0.340 决策 1] 回归防线）
 * 参考: app/server/src/bootstrap-agent-phase.ts（new AgentManagerImpl 装配 memberStore）
 *       app/server/src/agent/agent-manager.ts（:129 this.memberStore = opts.memberStore；
 *       :379-381 childrenOps 条件注入 memberStore → managerDeliverTo lookup）
 *       app/server/src/agent/inbox-enrich.ts（deriveAgentRefName lookup?.memberStore 反查 sender 实时名）
 *
 * 为何是集成而非单测（C-1 教训，与 bootstrap-todostore-injection.test.ts 同款）：
 *   code-review 发现 bootstrap 装配 AgentManagerImpl 未传 memberStore → inbox sender 名反查
 *   生产不生效（in 信封 sender 名仍读 session.title 快照）。UT 手工构造 AgentManagerImpl 时
 *   自带 memberStore → 全绿没暴露断线。故补此集成测试：用真实 bootstrap 链路断言装配产物
 *   的 memberStore 非 undefined —— 锁死「bootstrap→AgentManagerImpl」装配链。
 *
 * 文件系统隔离：mkdtempSync + afterEach rmSync。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { bootstrapBuiltinPlugins } from '../bootstrap';

describe('bootstrap — [v0.0.340 决策 1] AgentManagerImpl memberStore 装配（inbox sender 名反查）', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-bootstrap-member-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('bootstrap 装配的 agentManager.memberStore 非 undefined（生产 inbox 反查生效）', async () => {
    // C-1 教训同款：装配级遗漏 UT 手工构造全绿暴露不了，必须真实 bootstrap 链路断言。
    const bs = await bootstrapBuiltinPlugins(dataDir);
    // 白盒断言（private 字段，UT 惯例 as unknown as；同 bootstrap.test.ts scopeConfigs 模式）
    const memberStore = (bs.agentManager as unknown as { memberStore?: unknown }).memberStore;
    expect(memberStore).toBeDefined();
    // 鸭子类型：MemberStore 契约方法齐全（getMember 是反查主入口）
    expect(typeof (memberStore as { getMember?: unknown }).getMember).toBe('function');
    expect(typeof (memberStore as { putMember?: unknown }).putMember).toBe('function');
    expect(typeof (memberStore as { listMembers?: unknown }).listMembers).toBe('function');
  });
});
