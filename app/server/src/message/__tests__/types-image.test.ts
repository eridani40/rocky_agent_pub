/**
 * [v0.0.105 T1] message/types ImageBlock 类型闭合性 UT（白盒）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan.md 模块 A
 *       specs/tech/agent/message/[P0]agent_message_interface.md §3/§4.2
 *
 * 校验点：
 *   - ImageBlock 加入 ContentBlock 联合（第 7 类）
 *   - ImageSource 判别联合闭合（url | base64）
 *   - mediaType 顶层 + source.kind（spec 形，非 anthropic wire 嵌套形）
 *   - ImageBlock 可嵌 ToolResultBlock.content（computer use get_app_state 路径）
 *   - 旧 ContentBlock[]（无 image）向后兼容
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ImageBlock,
  ImageSource,
  ContentBlock,
  ToolResultBlock,
} from '../types';

describe('ImageBlock 类型（v0.0.105 T1）', () => {
  it('ImageSource 判别联合闭合：kind = url | base64', () => {
    expectTypeOf<ImageSource['kind']>().toEqualTypeOf<'url' | 'base64'>();
    const url: ImageSource = { kind: 'url', url: 'https://a/b.png' };
    const b64: ImageSource = { kind: 'base64', data: 'iVBOR' };
    expect(url.kind).toBe('url');
    expect(b64.kind).toBe('base64');
  });

  it('ImageBlock 是 spec 形：source.kind 判别联合 + mediaType 顶层（非 wire 嵌套形）', () => {
    const img: ImageBlock = {
      type: 'image',
      source: { kind: 'base64', data: 'iVBOR' },
      mediaType: 'image/png',
    };
    expect(img.type).toBe('image');
    expect(img.mediaType).toBe('image/png');
    // 判别联合窄化：base64 分支拿 data，无 wire 层 media_type/kind 混入 source
    if (img.source.kind === 'base64') {
      expect(img.source.data).toBe('iVBOR');
    }
    // spec 形不含 anthropic wire 字段（source.type / source.media_type）
    expect((img.source as Record<string, unknown>)['media_type']).toBeUndefined();
    expect((img.source as Record<string, unknown>)['type']).toBeUndefined();
  });

  it('ImageBlock 属于 ContentBlock 联合（第 7 类，类型可赋值）', () => {
    const block: ContentBlock = {
      type: 'image',
      source: { kind: 'url', url: 'https://a/b.png' },
      mediaType: 'image/jpeg',
    };
    expect(block.type).toBe('image');
    // discriminant 窄化确认 image 分支在联合内
    expectTypeOf(block).toMatchTypeOf<ContentBlock>();
  });

  it('ImageBlock 可嵌 ToolResultBlock.content（computer use get_app_state：image + text 双 block）', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      toolCallId: '01CALL',
      isError: false,
      content: [
        { type: 'image', source: { kind: 'base64', data: 'PNGDATA' }, mediaType: 'image/png' },
        { type: 'text', text: 'ax tree' },
      ],
    };
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.type).toBe('image');
    expect(result.content[1]!.type).toBe('text');
  });

  it('旧 ContentBlock[]（无 image）向后兼容', () => {
    const legacy: ContentBlock[] = [
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: '01', name: 'bash', arguments: { cmd: 'ls' } },
    ];
    expect(legacy.some((b) => b.type === 'image')).toBe(false);
  });
});
