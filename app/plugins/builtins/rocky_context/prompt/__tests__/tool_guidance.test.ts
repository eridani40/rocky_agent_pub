/**
 * tool_guidance mapper 单测 — intro 字段优先 + fallback description（v0.0.146）
 * 参考: specs/tech/version_logs/v0.0.146.tool_desc/change_plan.md
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.4
 *
 * 覆盖：
 *   ① 有 intro → system prompt Tool Guidance 用 intro（不含完整 description 细节）
 *   ② 无 intro → fallback 用 description（向后兼容，外部 plugin 不丢信息）
 *   ③ 空 tools 列表 → mapper 不贡献片段
 *   ④ intro + description 同时有 → 只展示 intro（system prompt 不重复完整 description）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __clearPromptCacheForTests } from '../../../../../server/src/prompts/prompt-handler';
import ToolGuidanceMapper from '../tool_guidance';
import type { PromptCtx } from '../../types';

/** 构造 PromptCtx（duck-typed config） */
function makeCtx(partial: Record<string, unknown>): PromptCtx {
  return { config: partial } as unknown as PromptCtx;
}

describe('ToolGuidanceMapper（intro 优先 + fallback description）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('① 有 intro → system prompt 用 intro（不含 description 的细节）', () => {
    const ctx = makeCtx({
      tools: [
        {
          definition: {
            name: 'read',
            intro: 'Read a text file.',
            description:
              'Read a text file. Output is cat -n style (line number + tab + content). Supports offset/limit.',
          },
        },
      ],
    });
    const fragments = new ToolGuidanceMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    const content = fragments[0]!.content;
    expect(content).toContain('- `read` — Read a text file.');
    // intro 优先：完整 description 的细节（cat -n / offset/limit）不应出现在 system prompt
    expect(content).not.toContain('cat -n');
    expect(content).not.toContain('offset/limit');
  });

  it('② 无 intro → fallback 用 description（向后兼容）', () => {
    const ctx = makeCtx({
      tools: [
        {
          definition: {
            name: 'custom_tool',
            description: 'Does something custom and specific.',
          },
        },
      ],
    });
    const fragments = new ToolGuidanceMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain(
      '- `custom_tool` — Does something custom and specific.',
    );
  });

  it('③ 空 tools 列表 → mapper 不贡献片段', () => {
    expect(new ToolGuidanceMapper('test').map(makeCtx({ tools: [] }))).toEqual([]);
  });

  it('③ 无 tools 字段 → mapper 不贡献片段', () => {
    expect(new ToolGuidanceMapper('test').map(makeCtx({}))).toEqual([]);
  });

  it('④ intro + description 同时有 → 只展示 intro，不重复完整 description', () => {
    const ctx = makeCtx({
      tools: [
        {
          definition: {
            name: 'bash',
            intro: 'Execute a shell command.',
            description:
              'Execute a shell command. Persistent cwd per session. Timeout default 120s, max 600s.',
          },
        },
        {
          // 无 intro 的 tool 仍用 description（混合场景）
          definition: {
            name: 'external_plugin_tool',
            description: 'External plugin full description.',
          },
        },
      ],
    });
    const fragments = new ToolGuidanceMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    const content = fragments[0]!.content;
    // bash 用 intro
    expect(content).toContain('- `bash` — Execute a shell command.');
    expect(content).not.toContain('Persistent cwd');
    // 无 intro 的 tool 用 description（fallback 不破坏外部 plugin）
    expect(content).toContain(
      '- `external_plugin_tool` — External plugin full description.',
    );
  });

  it('⑤ fragment metadata（id/tier/priority）保持', () => {
    const ctx = makeCtx({
      tools: [{ definition: { name: 'read', intro: 'Read a text file.' } }],
    });
    const fragments = new ToolGuidanceMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe('tool_guidance');
    expect(f.tier).toBe('stable');
    expect(f.priority).toBe(600);
    expect(f.content).toContain('# Tool Guidance');
  });

  it('⑥ intro 与 description 都缺 → 仍输出 name（无 — 后缀）', () => {
    const ctx = makeCtx({
      tools: [{ definition: { name: 'bare_tool' } }],
    });
    const fragments = new ToolGuidanceMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain('- `bare_tool`');
    expect(fragments[0]!.content).not.toContain('- `bare_tool` —');
  });
});
