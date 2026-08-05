/**
 * ToolExecutionEngine 策略门 UT（v0.0.122）
 * 参考: specs/tech/agent/tools/[P0]tool_permission.md §4（引擎集成）
 *       specs/tech/version_logs/v0.0.122/change_plan.md 模块 B
 *
 * 校验点：
 *   - deny → errorResult 不悬挂（INV-P4）
 *   - ask 未批准 → pending（subType/handleType/data 四字段齐，INV-P5）
 *   - ask 已批准 → fall through，直接 run
 *   - checkPermission 抛错 → fail-open → allow，继续 run（§3）
 *   - 未实现 checkPermission 的工具行为完全不变（INV-P2）
 */
import { describe, it, expect, vi } from 'vitest';
import { ToolExecutionEngine, safeCheckPermission, buildApprovalInteraction } from '../engine';
import { ApprovalManager } from '../approval-manager';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import type { ToolCallBlock } from '../../message/types';

/** 构造最小合法 ToolCallBlock */
function makeCall(name: string, args: Record<string, unknown> = {}): ToolCallBlock {
  return { type: 'tool_call', id: `call-${name}`, name, arguments: args };
}

/** 构造 session 最小配置（含 tools） */
function makeConfig(tools: Tool[]): { tools: Tool[]; sessionId: string; workdir: string } {
  return { tools, sessionId: 'session-test', workdir: '/tmp' };
}

/** 构造一个立即成功的普通 tool */
function makeSimpleTool(name: string, result: string = '执行成功'): Tool {
  return {
    definition: { name, description: '测试工具', inputSchema: { type: 'object' } },
    run: async (): Promise<ToolRunResult> => ({
      content: [{ type: 'text', text: result }],
      isError: false,
    }),
  };
}

describe('策略门 — deny 分支（INV-P4 不悬挂）', () => {
  it('deny → errorResult isError=true，不产 pending，不调 run', async () => {
    const runSpy = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '不应被调用' }], isError: false });
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'deny', reason: '禁止访问 ~/.ssh 敏感目录' }),
      run: runSpy,
    };
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(makeConfig([tool]), [makeCall('bash', { command: 'ls ~/.ssh' })]);

    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect((results[0]!.content[0]! as { type: string; text: string }).text).toContain('禁止访问 ~/.ssh');
    expect(pending).toHaveLength(0); // 不悬挂
    expect(runSpy).not.toHaveBeenCalled(); // run 未被调
  });

  it('deny 时不进 pending 队列（isError 结果直接进 transcript）', async () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'deny', reason: '测试拒绝' }),
      run: async () => ({ content: [], isError: false }),
    };
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const { pending } = await engine.execute(makeConfig([tool]), [makeCall('bash')]);
    expect(pending).toHaveLength(0);
  });
});

describe('策略门 — ask 未批准分支（INV-P5 复用 buildPendingResult）', () => {
  it('ask 未批准 → 产 pending，subType=need_approval，handleType=approval', async () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: 'rm 通配删除，需用户批准', approvalKey: 'bash:rm-wildcard' }),
      run: async () => ({ content: [{ type: 'text', text: '执行了' }], isError: false }),
    };
    const mgr = new ApprovalManager(); // 全新实例，未记忆任何 key
    const engine = new ToolExecutionEngine(mgr);
    const call = makeCall('bash', { command: 'rm -rf *' });
    const { results, pending } = await engine.execute(makeConfig([tool]), [call], undefined, { runId: 'run-001' });

    expect(results).toHaveLength(1);
    expect(pending).toHaveLength(1);

    // 占位 block：status=pending，subState=need_approval
    expect(results[0]!.status).toBe('pending');
    expect(results[0]!.subState).toBe('need_approval');
    expect(results[0]!.isError).toBe(false); // pending 非错误

    // PendingToolCall 字段齐全
    const pc = pending[0]!;
    expect(pc.subState).toBe('need_approval');
    expect(pc.handleType).toBe('approval');
    expect(pc.toolCallId).toBe(call.id);
    expect(pc.toolName).toBe('bash');
  });

  it('ask 未批准的 pending.data 含 ApprovalData 四字段（toolName/arguments/reason/approvalKey）', async () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'bash:rm-wildcard' }),
      run: async () => ({ content: [], isError: false }),
    };
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const args = { command: 'rm -rf *' };
    const { pending } = await engine.execute(makeConfig([tool]), [makeCall('bash', args)]);

    const data = pending[0]!.data as { toolName: string; arguments: unknown; reason?: string; approvalKey?: string };
    expect(data.toolName).toBe('bash');
    expect(data.arguments).toEqual(args);
    expect(data.reason).toBe('需批准');
    expect(data.approvalKey).toBe('bash:rm-wildcard');
  });
});

describe('策略门 — ask 已批准分支（fall through）', () => {
  it('ask 已批准（isApproved=true）→ 直接调 run，不产 pending', async () => {
    const runSpy = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '执行成功' }], isError: false });
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'bash:rm-wildcard' }),
      run: runSpy,
    };
    const mgr = new ApprovalManager();
    // 预先记忆（v0.0.148 recordAlways async）
    await mgr.recordAlways('session-test', 'bash:rm-wildcard');

    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(makeConfig([tool]), [makeCall('bash', { command: 'rm *' })]);

    expect(pending).toHaveLength(0); // 不悬挂
    expect(results[0]!.isError).toBe(false);
    expect(runSpy).toHaveBeenCalled(); // run 被调
  });
});

describe('策略门 — checkPermission 抛错 fail-open（§3）', () => {
  it('checkPermission 抛错 → 视作 allow → 继续 run（fail-open，不阻断）', async () => {
    const runSpy = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '正常执行' }], isError: false });
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => { throw new Error('权限检查服务异常'); },
      run: runSpy,
    };
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(makeConfig([tool]), [makeCall('bash')]);

    expect(pending).toHaveLength(0);
    expect(results[0]!.isError).toBe(false);
    expect(runSpy).toHaveBeenCalled(); // fail-open → run 被调
  });
});

describe('策略门 — INV-P2 向后兼容（未实现 checkPermission 的工具行为不变）', () => {
  it('普通 tool（无 checkPermission）→ 直接调 run，行为与 v0.0.122 前完全一致', async () => {
    const tool = makeSimpleTool('read_file', '文件内容');
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(makeConfig([tool]), [makeCall('read_file')]);

    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    expect((results[0]!.content[0]! as { type: string; text: string }).text).toBe('文件内容');
    expect(pending).toHaveLength(0);
  });

  it('多工具 mix：有 checkPermission 的 deny + 无 checkPermission 的普通 → 各自独立', async () => {
    const denyTool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'deny', reason: '策略拒绝' }),
      run: async () => ({ content: [], isError: false }),
    };
    const normalTool = makeSimpleTool('read_file', '读取结果');
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(
      makeConfig([denyTool, normalTool]),
      [makeCall('bash'), makeCall('read_file')],
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(true);  // bash deny
    expect(results[1]!.isError).toBe(false); // read_file 正常
    expect(pending).toHaveLength(0);
  });
});

describe('safeCheckPermission — 独立 helper UT', () => {
  const ctx: ToolCtx = {
    config: { tools: [], sessionId: 'test', workdir: '/tmp' },
    workdir: '/tmp',
  };

  it('正常返回 deny', () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测', inputSchema: {} },
      checkPermission: () => ({ behavior: 'deny', reason: '策略拒绝' }),
      run: async () => ({ content: [], isError: false }),
    };
    const result = safeCheckPermission(tool, {}, ctx);
    expect(result.behavior).toBe('deny');
  });

  it('正常返回 ask', () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测', inputSchema: {} },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'bash:rm-wildcard' }),
      run: async () => ({ content: [], isError: false }),
    };
    const result = safeCheckPermission(tool, {}, ctx);
    expect(result.behavior).toBe('ask');
  });

  it('抛错 → fail-open → {behavior:"allow"}', () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测', inputSchema: {} },
      checkPermission: () => { throw new Error('崩了'); },
      run: async () => ({ content: [], isError: false }),
    };
    const result = safeCheckPermission(tool, {}, ctx);
    expect(result.behavior).toBe('allow');
  });
});

describe('buildApprovalInteraction — 独立 helper UT', () => {
  it('产出 ToolInteraction{subType:need_approval, handleType:approval, data:ApprovalData}', () => {
    const call = { name: 'bash', arguments: { command: 'rm *' } };
    const decision = { reason: '需批准', approvalKey: 'bash:rm-wildcard' };
    const interaction = buildApprovalInteraction(call, decision);

    expect(interaction.subType).toBe('need_approval');
    expect(interaction.handleType).toBe('approval');

    const data = interaction.data as { toolName: string; arguments: unknown; reason?: string; approvalKey?: string };
    expect(data.toolName).toBe('bash');
    expect(data.arguments).toEqual({ command: 'rm *' });
    expect(data.reason).toBe('需批准');
    expect(data.approvalKey).toBe('bash:rm-wildcard');
  });

  it('ApprovalData.arguments 透传原始 call.arguments（不丢失字段）', () => {
    const call = { name: 'bash', arguments: { command: 'cmd', cwd: '/tmp', timeout: 5000 } };
    const interaction = buildApprovalInteraction(call, { reason: 'r', approvalKey: 'k' });
    const data = interaction.data as { arguments: unknown };
    expect(data.arguments).toEqual({ command: 'cmd', cwd: '/tmp', timeout: 5000 });
  });
});

/**
 * [v0.0.148 链路 D] engine 绿灯短路（approvalMode=greenlight）
 * 参考: specs/tech/version_logs/v0.0.148/change_plan.md 链路 D
 *
 * 校验点：
 *   - greenlight + ask → fall through（不悬挂，直接调 run）
 *   - greenlight + deny → 仍 deny（绿灯不绕策略层）
 *   - normal + ask 未批准 → 现状（悬挂审批卡）
 *   - 绿灯可逆（切回 normal 恢复审批）
 */
describe('策略门 — [v0.0.148] 绿灯短路（approvalMode=greenlight）', () => {
  /** 构造含 approvalMode 的 config（扩展 makeConfig） */
  function makeConfigWithApproval(
    tools: Tool[],
    approvalMode: 'normal' | 'greenlight' | undefined,
  ): { tools: Tool[]; sessionId: string; workdir: string; approvalMode?: 'normal' | 'greenlight' } {
    const base: { tools: Tool[]; sessionId: string; workdir: string; approvalMode?: 'normal' | 'greenlight' } = {
      tools,
      sessionId: 'session-test',
      workdir: '/tmp',
    };
    if (approvalMode !== undefined) base.approvalMode = approvalMode;
    return base;
  }

  it('greenlight + ask → fall through，直接调 run（不产 pending）', async () => {
    const runSpy = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '绿灯放行' }], isError: false });
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: 'rm 通配删除，需用户批准', approvalKey: 'bash:rm-wildcard' }),
      run: runSpy,
    };
    const mgr = new ApprovalManager(); // 未记忆任何 key
    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(
      makeConfigWithApproval([tool], 'greenlight'),
      [makeCall('bash', { command: 'rm -rf *' })],
    );

    expect(pending).toHaveLength(0); // 绿灯短路，不悬挂
    expect(results[0]!.isError).toBe(false);
    expect(runSpy).toHaveBeenCalled(); // run 被调（fall through）
  });

  it('greenlight + deny → 仍 deny（绿灯不绕策略层 deny）', async () => {
    const runSpy = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '不应被调用' }], isError: false });
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'deny', reason: '禁止访问 ~/.ssh' }),
      run: runSpy,
    };
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(
      makeConfigWithApproval([tool], 'greenlight'),
      [makeCall('bash', { command: 'cat ~/.ssh/id_rsa' })],
    );

    // deny 路径在 ask 之前，绿灯不绕过
    expect(results[0]!.isError).toBe(true);
    expect((results[0]!.content[0]! as { text: string }).text).toContain('禁止访问 ~/.ssh');
    expect(pending).toHaveLength(0);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('normal + ask 未批准 → 现状（悬挂审批卡，不短路）', async () => {
    const runSpy = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '不应被调用' }], isError: false });
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'bash:rm-wildcard' }),
      run: runSpy,
    };
    const mgr = new ApprovalManager(); // 未记忆
    const engine = new ToolExecutionEngine(mgr);
    const { results, pending } = await engine.execute(
      makeConfigWithApproval([tool], 'normal'),
      [makeCall('bash', { command: 'rm *' })],
    );

    expect(pending).toHaveLength(1); // normal 模式悬挂
    expect(results[0]!.status).toBe('pending');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('approvalMode undefined → 走 normal 分支（向后兼容，悬挂审批）', async () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'bash:rm-wildcard' }),
      run: async () => ({ content: [], isError: false }),
    };
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);
    const { pending } = await engine.execute(
      makeConfigWithApproval([tool], undefined),
      [makeCall('bash')],
    );
    expect(pending).toHaveLength(1); // undefined = normal = 悬挂
  });

  it('绿灯可逆：切回 normal 恢复审批（同一 engine，两 config）', async () => {
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'bash:rm-wildcard' }),
      run: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    };
    const mgr = new ApprovalManager();
    const engine = new ToolExecutionEngine(mgr);

    // greenlight → 不悬挂
    const r1 = await engine.execute(makeConfigWithApproval([tool], 'greenlight'), [makeCall('bash')]);
    expect(r1.pending).toHaveLength(0);

    // 切回 normal → 悬挂
    const r2 = await engine.execute(makeConfigWithApproval([tool], 'normal'), [makeCall('bash')]);
    expect(r2.pending).toHaveLength(1);
  });

  it('绿灯 + ask + isApproved 也放行（绿灯与 always 正交，双路径都不悬挂）', async () => {
    const runSpy = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });
    const tool: Tool = {
      definition: { name: 'bash', description: '测试', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'bash:rm-wildcard' }),
      run: runSpy,
    };
    const mgr = new ApprovalManager();
    await mgr.recordAlways('session-test', 'bash:rm-wildcard'); // also approved
    const engine = new ToolExecutionEngine(mgr);
    const { pending } = await engine.execute(
      makeConfigWithApproval([tool], 'greenlight'),
      [makeCall('bash')],
    );
    expect(pending).toHaveLength(0);
    expect(runSpy).toHaveBeenCalled();
  });
});
