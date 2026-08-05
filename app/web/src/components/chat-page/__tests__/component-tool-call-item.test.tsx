/**
 * @vitest-environment jsdom
 * component-tool-call-item input arguments value JSON pretty 单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.9（禁整体 JSON 代码框——
 *       pretty 后仍渲在 value cell 内 mono + whitespace-pre-wrap 多行）
 *
 * 覆盖 input arguments value 的四种形态：
 *   1. object 值 → JSON.stringify(v, null, 2) 多行 pretty（含换行 + 缩进）
 *   2. string 值内容是 JSON → formatToolOutputText pretty 多行
 *   3. 纯文本 string → 原样返回不被破坏
 *   4. 空 arguments → 显示 paramsEmpty i18n 占位
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentToolCallItem } from '../component-tool-call-item';
import type { ViewElement } from '../types';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

/** 构造 tool-call-item 视图元素（无 result = running 态，body 仅渲参数区） */
function argsCall(
  toolCallId: string,
  arguments_: Record<string, unknown>,
): Extract<ViewElement, { kind: 'tool-call-item' }> {
  return {
    kind: 'tool-call-item',
    key: `k-${toolCallId}`,
    messageId: 'm1',
    toolCallId,
    name: 'run_bash',
    arguments: arguments_,
  };
}

describe('ComponentToolCallItem input arguments value JSON pretty', () => {
  it('object 值 → 多行 pretty（含换行 + 缩进），非单行紧凑', () => {
    const { container } = render(
      <ComponentToolCallItem
        call={argsCall('o1', { target: { a: 1, b: { c: 2 } } })}
      />,
    );
    // 点击 head 行展开 body
    fireEvent.click(screen.getByText('run_bash'));

    const args = container.querySelector('span.whitespace-pre-wrap')!;
    // 紧凑形态不应出现（断言反向：不含单行紧凑串）
    expect(args.textContent).not.toContain('{"a":1,"b":{"c":2}}');
    // pretty 形态：含换行 + 两空格缩进
    expect(args.textContent).toContain('"a": 1');
    expect(args.textContent).toContain('"c": 2');
    // object 整体 pretty 后必含换行
    expect(args.textContent).toContain('\n');
  });

  it('string 值内容是 JSON → formatToolOutputText pretty 多行', () => {
    const { container } = render(
      <ComponentToolCallItem
        call={argsCall('s1', { body: '{"x":1,"y":[2,3]}' })}
      />,
    );
    fireEvent.click(screen.getByText('run_bash'));

    const args = container.querySelector('span.whitespace-pre-wrap')!;
    // 原始紧凑串不应整体保留
    expect(args.textContent).not.toContain('{"x":1,"y":[2,3]}');
    // pretty 后含换行 + 缩进
    expect(args.textContent).toContain('"x": 1');
    expect(args.textContent).toContain('\n');
  });

  it('纯文本 string（非 JSON）→ 原样显示，不被破坏', () => {
    const { container } = render(<ComponentToolCallItem call={argsCall('t1', { command: 'ls -la' })} />);
    fireEvent.click(screen.getByText('run_bash'));

    const args = container.querySelector('span.whitespace-pre-wrap')!;
    // 纯文本原样保留，无双引号包裹/转义
    expect(args.textContent).toContain('ls -la');
    expect(args.textContent).not.toContain('"ls -la"');
  });

  it('空 arguments → 显示 paramsEmpty 占位', () => {
    render(<ComponentToolCallItem call={argsCall('e1', {})} />);
    fireEvent.click(screen.getByText('run_bash'));

    // i18n key paramsEmpty 渲染（zh-CN: 「无参数」）
    expect(screen.getByText('无参数')).toBeTruthy();
  });
});
