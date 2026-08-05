/**
 * ToolExecutionEngine 统一拒绝 helper UT（v0.0.48 Task 2）
 * 参考: specs/tech/agent/tools/[P0]tool_execution_engine.md §3.1（统一拒绝错误 code）
 *       specs/tech/agent/tools/[P0]tool_policy.md §1.5（统一拒绝 code 原则）
 *
 * 覆盖：
 *   - 未注册工具 → `[tool_not_allowed]` + reason=`not registered`（旧 unknown_tool code 退役）
 *   - 白名单外 → `[tool_not_allowed]` + reason=`not in whitelist`
 *   - allowedTools=undefined（全集模式）→ 不在白名单外路径触发（仅未注册路径可能触发）
 *   - allowedTools=[]（forked 零工具）→ 任何 toolCall 都被白名单外路径拦
 *   - 同一批混合：白名单外 + 未注册 + 通过 → 三类 result 顺序与 toolCalls 一致
 *   - isError=true + content[0].text 含 `[tool_not_allowed]` 前缀（机读 + 人读兼容）
 *
 * 白盒：直接调 engine.execute(config, toolCalls, allowedTools?) 验拒绝路径产出。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutionEngine } from '../engine';
import { defaultTools } from '../registry';
import type { ToolCallBlock, ToolResultBlock } from '../../message/types';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-engine-reject-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 取 ToolResultBlock 的首个 text block 文本（拒绝文案在 content[0].text） */
function textOf(r: ToolResultBlock | undefined): string {
  if (!r || !r.content || r.content.length === 0) return '';
  const first = r.content[0];
  return first && typeof first === 'object' && first.type === 'text' ? first.text : '';
}

describe('ToolExecutionEngine 统一拒绝 helper（v0.0.48 §3.1）', () => {
  it('未注册工具 → `[tool_not_allowed]` + reason="not registered"（旧 unknown_tool 退役）', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'foo_not_registered', arguments: {} },
    ];
    const { results, pending } = await engine.execute(config, calls); expect(pending).toEqual([]);
    expect(results[0]!.isError).toBe(true);
    expect(textOf(results[0])).toMatch(/^\[tool_not_allowed\]/);
    expect(textOf(results[0])).toMatch(/not registered/i);
    expect(textOf(results[0])).toContain('foo_not_registered');
  });

  it('白名单外工具 → `[tool_not_allowed]` + reason="not in whitelist"', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    // read 工具存在 + 注册，但不在 allowedTools 白名单
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'read', arguments: { filePath: join(tmpRoot, 'x') } },
    ];
    const { results, pending } = await engine.execute(config, calls, ['bash']);  // 仅 bash 允许
    expect(pending).toEqual([]);
    expect(results[0]!.isError).toBe(true);
    expect(textOf(results[0])).toMatch(/^\[tool_not_allowed\]/);
    expect(textOf(results[0])).toMatch(/not in whitelist/i);
    expect(textOf(results[0])).toContain('read');
  });

  it('allowedTools=undefined（全集模式）→ 仅未注册路径触发拒绝', async () => {
    const engine = new ToolExecutionEngine();
    const p = join(tmpRoot, 'a.txt');
    writeFileSync(p, 'hi');
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    // 全集模式：read 在 registry，不会被白名单外路径拦
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'read', arguments: { filePath: p } },
      { type: 'tool_call', id: 'c2', name: 'foo_unknown', arguments: {} },
    ];
    const { results, pending } = await engine.execute(config, calls); expect(pending).toEqual([]);
    expect(results[0]!.isError).toBe(false);  // read 成功
    expect(results[1]!.isError).toBe(true);   // 未注册
    expect(textOf(results[1])).toMatch(/not registered/i);
  });

  it('allowedTools=[]（forked 零工具）→ 所有 toolCall 都被白名单外路径拦', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'c1', name: 'read', arguments: {} },
      { type: 'tool_call', id: 'c2', name: 'bash', arguments: { command: 'echo', description: 'd' } },
    ];
    const { results, pending } = await engine.execute(config, calls, []);
    expect(pending).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(true);
    expect(results[1]!.isError).toBe(true);
    expect(textOf(results[0])).toMatch(/not in whitelist/i);
    expect(textOf(results[1])).toMatch(/not in whitelist/i);
  });

  it('同一批混合：白名单外 + 未注册 + 通过 → 三类 result 顺序与 toolCalls 一致', async () => {
    // 注：Layer C（白名单）在 for 循环前置，Layer B（resolve）仅 Layer C 通过才触发。
    //   所以「未注册工具 + 该工具不在 whitelist」→ 被 Layer C 先拦（reason=not in whitelist）。
    //   要独立触发 Layer B「未注册」reason，必须 allowedTools 包含该名（或全集模式 undefined）。
    const engine = new ToolExecutionEngine();
    const p = join(tmpRoot, 'mix.txt');
    writeFileSync(p, 'content');
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const calls: ToolCallBlock[] = [
      // ① 白名单外（read 存在但不在 whitelist）
      { type: 'tool_call', id: 'c-wl', name: 'read', arguments: { filePath: p } },
      // ② 通过（bash 在 whitelist + 注册）
      { type: 'tool_call', id: 'c-ok', name: 'bash', arguments: { command: 'echo ok', description: 'd' } },
    ];
    const { results, pending } = await engine.execute(config, calls, ['bash', 'foo_unknown']);
    expect(pending).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]!.toolCallId).toBe('c-wl');
    expect(results[1]!.toolCallId).toBe('c-ok');
    expect(results[0]!.isError).toBe(true);
    expect(textOf(results[0])).toMatch(/not in whitelist/i);
    expect(results[1]!.isError).toBe(false);
  });

  it('两条拒绝路径产出同 code 前缀（`[tool_not_allowed]`，文案机读兼容）', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: defaultTools(tmpRoot), workdir: tmpRoot };
    const wlR = await engine.execute(config, [
      { type: 'tool_call', id: 'a', name: 'read', arguments: {} },
    ], []);
    const unkR = await engine.execute(config, [
      { type: 'tool_call', id: 'b', name: 'foo_unknown', arguments: {} },
    ]);
    const wlText = textOf(wlR.results[0]);
    const unkText = textOf(unkR.results[0]);
    // 同前缀（机读 grep 工具一致）
    expect(wlText.startsWith('[tool_not_allowed]')).toBe(true);
    expect(unkText.startsWith('[tool_not_allowed]')).toBe(true);
    // 仅 reason 短语不同
    expect(wlText).toMatch(/not in whitelist/);
    expect(unkText).toMatch(/not registered/);
  });
});
