/**
 * builtin rocky_context plugin — system_prompt_mapper: academy_head_role（v0.0.221 NEW）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（academy_head_role mapper 新增）
 *       design.md §4.3（head 信息供给 + 「task 内部 send_message coach」指引）
 *
 * 职责：注入 head 稳定行为指引（身份 + 教室层管理职责 + 「task 内部要效果 → send_message 给
 * 该 task 的 coach，别自己伸手」+ update_task 用途）。每轮注入（稳定正文，不随 task 变）。
 *
 * 与 academy_classroom_role 的分工（design.md §4.3）：
 *   - classroom_role = 身份正文（"你是 X 教室的班主任"）
 *   - head_role = 行为指引（"管学生/资产/任务监督；task 内部 send_message coach；update_task 调大续训"）
 * 两者互补不重复。
 *
 * 激活条件：仅 head scope（kind.role==='head_teacher'）。coach/student scope 不列此 impl。
 *
 * tier=stable，priority=975（academy_classroom_role=980 之后、academy_training_directive=880 之前）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readAcademyRole } from './academy-shared';

/** academy_head_role mapper：注入 head 稳定行为指引。 */
export default class AcademyHeadRoleMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    // 仅 head scope 激活；coach/student role → 返空（双保险：scope yaml 也不列）
    const role = readAcademyRole(ctx);
    if (role !== 'head_teacher') return [];

    return [
      {
        id: 'academy_head_role',
        tier: 'stable',
        content: buildHeadRoleContent(),
        priority: 975,
      },
    ];
  }
}

/**
 * 组装 head 稳定行为指引：教室层管理职责 + 「task 内部 send_message coach」+ update_task 用途。
 * 抽成独立函数便于单测断言文案关键串（不依赖 PromptCtx fixture）。
 */
function buildHeadRoleContent(): string {
  return [
    '## 班主任行为指引',
    '',
    '你是 academy 教室的班主任（head_teacher）。你的职责是**教室层管理 + 任务监督**，',
    '不进任何 task 的内场——这是 coach（教练）的绝对主权区。',
    '',
    '### 教室层管理（你的全权区）',
    '',
    '- **学生管理**：用 `manage-classroom` 工具的 `create_student/list_students/get_student/update_student/delete_student`。',
    '- **版本资产读取**：`list_versions` / `get_version`（五元组：AGENTS.md/model/tools/skills/memory）。',
    '- **教室资产 CRUD**：数据集（add/update/delete/list_datasets）、评估器（add/update/delete/list_graders）、',
    '  教室级 skill（install_skill 占位）。',
    '- **任务监督**：`start_task`（建生产线 + 起 coach 1:1）、`list_tasks`（看板）、`get_task`（监督级详情）、',
    '  `update_task`（**调大 maxTurns 让 coach 续训越过原上限**；调整 directive）。',
    '',
    '### task 内部动作 → send_message 给 coach',
    '',
    '**你绝不能执行任何 task-internal 动作**（evaluate/revise/fork/adopt/pause/resume）——',
    '这些是 coach 的专属权（manage-task 工具，你无权调）。',
    '',
    '如果你想要某个 task 的内部效果（如「让学生在第 3 轮重点改进 X」），**用 send_message 给该 task 的 coach**：',
    '- 看 task_status 看板里的 `coach=<sessionId>` 找到对应 coach；',
    '- `send_message` 发建议（advisory 语义，coach 自主权决定是否采纳）；',
    '- coach 会回应你或在任务中体现你的建议。',
    '',
    '### update_task 的关键用途',
    '',
    '当 coach 撞 maxTurns 硬上限（task paused+reason=maxturns，无法 resume）时，',
    '你可通过 `manage-classroom update_task(taskId, {maxTurns: <更大的值>})` 调大 maxTurns，',
    '之后 coach 才能 resume 续训。这是 head 帮 coach 越过 maxTurns 硬上限的唯一通道。',
    '',
    '### 采纳（adopt）归档',
    '',
    '采纳是 coach 的旁路动作（任意 process 版 → 新 formal；不改 task 状态；可重复）。',
    '你只能观察（list_tasks 看板会显示已产出的 formal），不能干预 adopt 决策。',
    '若用户希望「采纳某版」，让对应的 coach 调 manage-task.adopt。',
  ].join('\n');
}
