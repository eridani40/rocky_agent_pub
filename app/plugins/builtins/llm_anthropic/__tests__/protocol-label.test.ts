/**
 * [v0.0.53] LlmProtocol.label + AnthropicMessagesProtocol 单测
 * 参考: specs/tech/version_logs/v0.0.53/change_log.md §1.3（protocol += readonly label）
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2
 *
 * v0.0.191：随 impl 迁入 plugin（原 app/server/src/llm/__tests__/protocol-label.test.ts）。
 *
 * 校验点：
 *   - LlmProtocol interface 含 readonly label（编译期：缺 label 实现报错——已由 TS 保证）
 *   - AnthropicMessagesProtocol 实例 .label === 'Anthropic Messages 风格'
 *   - label 是 readonly（实例赋值报错——TS 保证；运行期不主动测）
 *   - 与 id ('anthropic_messages') 正交：id 是 wire 标识，label 是 UI 展示文本
 */
import { describe, it, expect } from 'vitest';
import AnthropicMessagesProtocol from '../protocol';

describe('[v0.0.53] AnthropicMessagesProtocol.label', () => {
  it('实例 .label === "Anthropic Messages 风格"（中文 UI 展示文本）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages');
    expect(p.label).toBe('Anthropic Messages 风格');
  });

  it('label 与 implId 正交：implId 是 wire 标识，label 是 UI 展示文本', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages');
    expect(p.implId).toBe('anthropic_messages'); // wire/持久化标识（拉丁字面量）
    expect(p.label).toBe('Anthropic Messages 风格'); // UI 展示文本（中文）
    expect(p.label).not.toBe(p.implId); // 两者不冲突、互不等价
  });

  it('protocol 实例同时持有 path / contentType / label 三 readonly 常量', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages');
    expect(p.path).toBe('/v1/messages');
    expect(p.contentType).toBe('application/json');
    expect(p.label).toBe('Anthropic Messages 风格');
  });

  it('多实例 label 一致（无状态常量，每次构造同值）', () => {
    const a = new AnthropicMessagesProtocol('anthropic_messages');
    const b = new AnthropicMessagesProtocol('anthropic_messages', { foo: 1 });
    expect(a.label).toBe(b.label);
  });
});
