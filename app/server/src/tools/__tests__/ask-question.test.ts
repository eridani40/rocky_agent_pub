/**
 * [v0.0.101 T3] ask-question 工具 UT（白盒，模块 G 首消费者）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 G
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §9 §12 §13
 *
 * 覆盖：
 *   - definition.name = 'ask-question'；inputSchema 含 questions + prompt
 *   - interaction 恒返 { subType:'need_feedback', handleType:'direct_result', data:FeedbackData }
 *   - interaction 校验：questions 非空数组 / id 唯一 / type ∈ single|multi / options 非空 + key 唯一
 *   - interaction 校验失败抛错（engine fail-open 降级）
 *   - prompt 可选；缺省 FeedbackData 无 prompt 字段
 *   - run 占位 stub：永不达，返 isError 提示
 */
import { describe, it, expect } from 'vitest';
import { askQuestionTool } from '../ask-question';
import type { ToolCtx, ToolInput } from '../types';

function makeCtx(): ToolCtx {
  return { config: { tools: [] }, workdir: '/tmp' };
}

describe('ask-question tool（v0.0.101 模块 G 首消费者）', () => {
  it('definition.name = ask-question；description 含澄清语义', () => {
    expect(askQuestionTool.definition.name).toBe('ask-question');
    expect(askQuestionTool.definition.description).toMatch(/clarif|question|user/i);
  });

  it('inputSchema required = [questions]；含 prompt 可选字段', () => {
    const schema = askQuestionTool.definition.inputSchema;
    expect(schema.required).toEqual(['questions']);
    expect(schema.properties).toHaveProperty('questions');
    expect(schema.properties).toHaveProperty('prompt');
  });

  it('interaction 恒返 need_feedback / direct_result（含完整 FeedbackData）', () => {
    const input: ToolInput = {
      questions: [
        {
          id: 'q1',
          title: '请选择',
          type: 'single',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          allowOther: true,
        },
      ],
      prompt: '请回答',
    };
    const r = askQuestionTool.interaction!(input, makeCtx());
    expect(r).not.toBeNull();
    expect(r!.subType).toBe('need_feedback');
    expect(r!.handleType).toBe('direct_result');
    expect(r!.data).toMatchObject({
      prompt: '请回答',
      questions: [
        expect.objectContaining({
          id: 'q1',
          type: 'single',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          allowOther: true,
        }),
      ],
    });
  });

  it('prompt 缺省 → FeedbackData 不含 prompt 字段', () => {
    const r = askQuestionTool.interaction!(
      {
        questions: [
          {
            id: 'q1',
            title: 't',
            type: 'multi',
            options: [{ key: 'k', label: 'L' }],
            allowOther: false,
          },
        ],
      },
      makeCtx(),
    );
    expect(r!.data).not.toHaveProperty('prompt');
    expect(r!.data).toHaveProperty('questions');
  });

  it('interaction 多 question 都透传（id 唯一性校验通过）', () => {
    const r = askQuestionTool.interaction!(
      {
        questions: [
          { id: 'q1', title: 't1', type: 'single', options: [{ key: 'a', label: 'A' }] },
          { id: 'q2', title: 't2', type: 'multi', options: [{ key: 'x', label: 'X' }] },
        ],
      },
      makeCtx(),
    );
    // narrow data to FeedbackData（data 是 FeedbackData | ApprovalData 联合，按 subType 缩窄）
    const data = r!.data as { questions: { id: string }[] };
    expect(data.questions).toHaveLength(2);
    expect(data.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('interaction 校验失败：questions 空数组 → 抛错', () => {
    expect(() => askQuestionTool.interaction!({ questions: [] }, makeCtx())).toThrow(/non-empty/);
  });

  it('interaction 校验失败：question.id 缺失 → 抛错', () => {
    expect(() =>
      askQuestionTool.interaction!(
        { questions: [{ title: 't', type: 'single', options: [{ key: 'a', label: 'A' }] }] },
        makeCtx(),
      ),
    ).toThrow(/questions\[0\]\.id/);
  });

  it('interaction 校验失败：type 非法值 → 抛错', () => {
    expect(() =>
      askQuestionTool.interaction!(
        { questions: [{ id: 'q1', title: 't', type: 'invalid', options: [{ key: 'a', label: 'A' }] }] },
        makeCtx(),
      ),
    ).toThrow(/type/);
  });

  it('interaction 校验失败：options 空 → 抛错', () => {
    expect(() =>
      askQuestionTool.interaction!(
        { questions: [{ id: 'q1', title: 't', type: 'single', options: [] }] },
        makeCtx(),
      ),
    ).toThrow(/options/);
  });

  it('interaction 校验失败：option.key 重复 → 抛错', () => {
    expect(() =>
      askQuestionTool.interaction!(
        {
          questions: [
            {
              id: 'q1',
              title: 't',
              type: 'single',
              options: [
                { key: 'a', label: 'A' },
                { key: 'a', label: 'A2' },
              ],
            },
          ],
        },
        makeCtx(),
      ),
    ).toThrow(/duplicate/);
  });

  it('interaction 校验失败：question.id 跨 question 重复 → 抛错', () => {
    expect(() =>
      askQuestionTool.interaction!(
        {
          questions: [
            { id: 'q1', title: 't1', type: 'single', options: [{ key: 'a', label: 'A' }] },
            { id: 'q1', title: 't2', type: 'single', options: [{ key: 'a', label: 'A' }] },
          ],
        },
        makeCtx(),
      ),
    ).toThrow(/duplicate question id/);
  });

  it('allowOther 缺省 false', () => {
    const r = askQuestionTool.interaction!(
      {
        questions: [
          { id: 'q1', title: 't', type: 'single', options: [{ key: 'a', label: 'A' }] },
        ],
      },
      makeCtx(),
    );
    const data = r!.data as { questions: { allowOther: boolean }[] };
    expect(data.questions[0]!.allowOther).toBe(false);
  });

  it('run 占位 stub：返 isError 提示「永不达」', async () => {
    const result = await askQuestionTool.run({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/internal error|interaction should have suspended/i),
    });
  });
});
