/**
 * ask-question 工具（首个悬挂型 tool，HITL 蓝图首消费者）
 * 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §9 §12 §13
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 G
 *
 * 设计：
 *   - inputSchema 接收 questions[]（结构化提问项）+ prompt（可选引导文案）
 *   - interaction(input, ctx) 恒返 { subType:'need_feedback', handleType:'direct_result', data: FeedbackData }
 *     → 引擎不调 run，构造 pending ToolResultBlock + PendingToolCall 落盘悬挂队列
 *   - 无 run：悬挂型 tool 永不真跑（pre-process 回填时按 direct_result 序列化 payload 编辑占位 block）
 *   - 无 onReply：direct_result handleType 不需要（答案 payload 即 result）
 *
 * 流程（端到端，跨模块）：
 *   LLM call ask-question → engine.interaction 返非 null → 占位 result + PendingToolCall 落盘 →
 *   emit require_human_input(队首) → loop exit stopReason=tool_pending → session.state=suspended →
 *   前端 mount 提问卡 → 用户提交 → POST /messages tool_reply → pre-process handleToolReply →
 *   direct_result 分支：序列化 FeedbackAnswer → 编辑占位 block（status pending→success）→
 *   resolvePendingToolCall 删一条 → 续 LLM
 *
 * inputSchema 字段对齐 §12（questions[].id/title/type/options/allowOther + prompt）。
 */
import type { Tool, ToolCtx, ToolInput, ToolInteraction } from './types';

/**
 * ask-question 输入形状（运行时窄化用，对应 inputSchema）。
 * 字段对齐 req 3-ask-question-tool §12。
 */
interface AskQuestionInput {
  questions?: unknown;
  prompt?: unknown;
}

/**
 * 单个 question 的窄化形状（inputSchema.questions 元素）。
 * 校验在 interaction 内做（inputSchema 校验只查 primitive 类型，业务闭合性在 interaction 补）。
 */
interface QuestionInput {
  id?: unknown;
  title?: unknown;
  type?: unknown;
  options?: unknown;
  allowOther?: unknown;
}

/**
 * ask-question 工具（单例导出，registry defaultTools 引用）。
 *
 * 与普通 tool 的关键差异：
 *   - 恒悬挂：interaction 永远返非 null（无「不悬挂」分支）
 *   - 无 run：定义占位 run（永不达，引擎仅当 interaction 返 null 才调；类型必填故保留 stub）
 *     返 isError 提示实现 bug（interaction 返 null 但 run 又被调到 = engine 逻辑错误）
 */
export const askQuestionTool: Tool = {
  definition: {
    name: 'ask-question',
    description:
      'Ask the user structured questions (single/multi-choice + optional free-text). ' +
      'Use when you need clarification to proceed: presents a question card, suspends the run, ' +
      'and resumes after the user submits answers. Do not use for yes/no—use single-choice instead. ' +
      'Answers replace the placeholder tool_result (direct_result handleType).',
    intro: 'Ask the user structured clarification questions.',
    inputSchema: {
      type: 'object',
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          description:
            'Question list (each renders as a tab in the question card). ' +
            'Order matters—user answers sequentially.',
          items: {
            type: 'object',
            required: ['id', 'title', 'type', 'options'],
            properties: {
              id: { type: 'string', description: 'Question id (stable key; used in answer selections)' },
              title: { type: 'string', description: 'Question title shown at top of tab' },
              type: {
                type: 'string',
                description: "'single' = radio (one answer), 'multi' = checkbox (multiple answers)",
              },
              options: {
                type: 'array',
                description: 'Candidate options',
                items: {
                  type: 'object',
                  required: ['key', 'label'],
                  properties: {
                    key: { type: 'string', description: 'Option value identifier' },
                    label: { type: 'string', description: 'Option display text' },
                  },
                },
              },
              allowOther: {
                type: 'boolean',
                default: false,
                description: 'If true, show an "Other" free-text input; answer value format: "其他：<text>"',
              },
            },
          },
        },
        prompt: {
          type: 'string',
          description: 'Optional guiding prompt shown at the top of the question card',
        },
      },
    },
  },

  /**
   * 恒悬挂：把 input 校验 + 转成 FeedbackData，返悬挂描述。
   * 校验失败抛错（被 engine maybeInteraction catch → fail-open 降级走 run stub 报错路径）；
   * 正常情况下 LLM 按 schema 产出，校验应通过。
   */
  interaction(input: ToolInput, _ctx: ToolCtx): ToolInteraction | null {
    const typed = input as AskQuestionInput;
    const data = parseFeedbackData(typed);
    return {
      subType: 'need_feedback',
      handleType: 'direct_result',
      data,
    };
  },

  /**
   * 占位 run（永不达）。
   * 引擎仅当 interaction 返 null 才调 run；ask-question interaction 恒返非 null → 此方法永不执行。
   * 若被调到 = engine 逻辑 bug（interaction 路径未走），返 isError 提示。
   */
  async run(): Promise<{ content: [{ type: 'text'; text: string }]; isError: boolean }> {
    return {
      content: [
        {
          type: 'text',
          text: '[ask-question] internal error: interaction should have suspended this call (engine bug)',
        },
      ],
      isError: true,
    };
  },
};

/**
 * 把 input 校验 + 规整成 FeedbackData（interaction 内部用）。
 *
 * 校验规则（inputSchema 之外的闭合性补强）：
 *   - questions 必须是非空数组
 *   - 每个 question.id 唯一非空字符串
 *   - type 必须是 'single' | 'multi'（其他值拒）
 *   - options 必须是非空数组，每个 option.key 唯一非空字符串
 *   - allowOther 缺省 false
 *
 * 校验失败抛错（engine fail-open 降级走 run stub），正常 LLM 产出应通过。
 */
function parseFeedbackData(input: AskQuestionInput): import('./types').FeedbackData {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error('ask-question: questions must be a non-empty array');
  }
  const prompt = typeof input.prompt === 'string' && input.prompt.length > 0 ? input.prompt : undefined;
  // 显式声明 Question[] 类型（type 字段需 narrow 成 'single'|'multi' 字面量，TS 推断为 string）
  const questions: import('./types').Question[] = rawQuestions.map((q, i) => {
    const item = (q ?? {}) as QuestionInput;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) throw new Error(`ask-question: questions[${i}].id must be a non-empty string`);
    const title = typeof item.title === 'string' ? item.title : '';
    const qType: 'single' | 'multi' | null =
      item.type === 'single' || item.type === 'multi' ? item.type : null;
    if (!qType) throw new Error(`ask-question: questions[${i}].type must be 'single' or 'multi'`);
    const rawOptions = item.options;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
      throw new Error(`ask-question: questions[${i}].options must be a non-empty array`);
    }
    const seenKeys = new Set<string>();
    const options = rawOptions.map((o, j) => {
      const opt = (o ?? {}) as { key?: unknown; label?: unknown };
      const key = typeof opt.key === 'string' ? opt.key.trim() : '';
      if (!key) throw new Error(`ask-question: questions[${i}].options[${j}].key must be a non-empty string`);
      if (seenKeys.has(key)) {
        throw new Error(`ask-question: questions[${i}].options[${j}].key duplicate: ${key}`);
      }
      seenKeys.add(key);
      const label = typeof opt.label === 'string' ? opt.label : '';
      return { key, label };
    });
    const allowOther = item.allowOther === true;
    return { id, title, type: qType, options, allowOther };
  });
  // question.id 唯一性校验（跨 question）
  const seenIds = new Set<string>();
  for (const q of questions) {
    if (seenIds.has(q.id)) throw new Error(`ask-question: duplicate question id: ${q.id}`);
    seenIds.add(q.id);
  }
  return prompt ? { prompt, questions } : { questions };
}
