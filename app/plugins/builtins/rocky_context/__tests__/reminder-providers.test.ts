/**
 * rocky_context plugin system_reminder provider(5) 单测
 * 参考: specs/tech/agent/context/[P0]system_reminder.md §3
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.6
 *
 * 覆盖：
 *   - env：贡献环境 reminder 含 modelId/platform/app
 *   - time：贡献含时分 + 时区的 reminder（v0.0.64 起完整时间，进程本地 = client tz）
 *   - workspace：有 workdir → 贡献；无 workdir → 空贡献
 *       [v0.0.17] workdir 接线语义：provider 读 config.workdir（= session.workspaceDir）；
 *       切换 workdir 后 provider 输出新路径；不读 cwd/环境默认值
 *   - tool_error [D1.1] no-op → 空贡献
 *   - todo [D1.1] no-op → 空贡献
 */
import { describe, it, expect } from 'vitest';
import EnvReminderProvider from '../reminder/env';
import TimeReminderProvider from '../reminder/time';
import WorkspaceReminderProvider from '../reminder/workspace';
import ToolErrorReminderProvider from '../reminder/tool_error';
import TodoReminderProvider from '../reminder/todo';

function mkCtx(overrides: Record<string, unknown> = {}): { config: Record<string, unknown> } {
  return { config: { modelId: 'test-model', ...overrides } };
}

describe('system_reminder providers', () => {
  it('env：贡献 info reminder 含 modelId', () => {
    const out = new EnvReminderProvider('env', {}).provide(mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('env');
    expect(out[0]!.content).toContain('test-model');
    expect(out[0]!.tier).toBe('info');
  });

  it('time：贡献含时分 + 时区的 reminder（v0.0.64，进程本地 = client tz）', () => {
    const out = new TimeReminderProvider('time', {}).provide(mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('time');
    expect(out[0]!.tier).toBe('info');
    // 格式：Current date and time: YYYY-MM-DD HH:MM (TZ).
    // Rocky 是 Electron 本地 app，server 进程 tz = client tz，new Date() 本地方法拿到的就是用户本地时间。
    expect(out[0]!.content).toMatch(/Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(/);
  });

  describe('workspace', () => {
    it('有 workdir → 贡献 reminder 含 Working directory 前缀 + 路径', () => {
      const out = new WorkspaceReminderProvider('workspace', {}).provide(
        mkCtx({ workdir: '/tmp/test-wd' }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe('workspace');
      expect(out[0]!.tier).toBe('info');
      // 文案前缀固定（spec §3：Working directory: <wd>）
      expect(out[0]!.content).toContain('Working directory:');
      expect(out[0]!.content).toContain('/tmp/test-wd');
    });

    it('[v0.0.17] workdir 接线：config.workdir = session.workspaceDir 来源', () => {
      // 模拟 T1 接线后 SessionConfig.workdir 即 session.workspaceDir（绝对路径）
      const workspaceDir = '/Users/test/.oobt-desktop/workspaces/01HXXX';
      const out = new WorkspaceReminderProvider('workspace', {}).provide(
        mkCtx({ workdir: workspaceDir }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.content).toContain(workspaceDir);
    });

    it('[v0.0.17] 切换 workdir 后 provider 输出新路径（零破 cache，下轮 ingest 反映）', () => {
      const provider = new WorkspaceReminderProvider('workspace', {});
      const dir1 = '/Users/test/workspaces/ws-a';
      const dir2 = '/Users/test/workspaces/ws-b';
      // 同一 provider 实例对两次 provide（模拟两次 ingest）应分别反映当时 workdir
      const out1 = provider.provide(mkCtx({ workdir: dir1 }));
      expect(out1[0]!.content).toContain(dir1);
      const out2 = provider.provide(mkCtx({ workdir: dir2 }));
      expect(out2[0]!.content).toContain(dir2);
      expect(out2[0]!.content).not.toContain(dir1);
    });

    it('[v0.0.17] 不读 cwd/环境默认值：无 workdir → 空贡献（即使有 cwd）', () => {
      // spec §3 明确来源单一为 config.workdir；cwd 不再作为 fallback
      const out = new WorkspaceReminderProvider('workspace', {}).provide(
        mkCtx({ cwd: '/some/cwd/fallback' }),
      );
      expect(out).toEqual([]);
    });

    it('无 workdir/cwd → 空贡献', () => {
      const out = new WorkspaceReminderProvider('workspace', {}).provide(mkCtx());
      expect(out).toEqual([]);
    });
  });

  it('tool_error [D1.1] no-op → 空贡献', () => {
    const out = new ToolErrorReminderProvider('tool_error', {}).provide(mkCtx());
    expect(out).toEqual([]);
  });

  it('todo v0.0.223 填壳：无 todoStore 注入 → 空贡献（向后兼容；有 store 详见 todo-reminder-provider.test）', async () => {
    const out = await new TodoReminderProvider('todo', {}).provide(mkCtx());
    expect(out).toEqual([]);
  });
});
