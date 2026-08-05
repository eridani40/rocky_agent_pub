/**
 * SideRunReminderHandler — side-run reminder 骨架 + 条件段渲染（读 content/side_run_reminder/*.md）。
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]forked_reminder.md §2-§6
 *
 * 两态 actualToolsDescription 判断 + runKind tail 选择的**业务分支决策**留在调用方
 * （side-run-reminder-injector.ts 的 buildReminderText），本类只负责「按 key 取 md 段 + 拼接」，
 * 不做判断逻辑本身——保持不变量 §6（reminder 拓扑/cache 前缀零改动）之外的关注点分离。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** SideRunReminderHandler：骨架 = content/side_run_reminder/skeleton.md + {{mode_key}}/{{actual_tools_description}} */
export class SideRunReminderHandler extends PromptHandler {
  protected readonly contentFile = 'side_run_reminder/skeleton.md';

  /**
   * 拼骨架 + （按需）追加 mode_tail 段。
   * ctx.vars：
   *   - mode_key：注入骨架第二行 runKind=xxx
   *   - actual_tools_description：注入骨架 ACTUALLY EXECUTE 行
   *   - mode_tail_key：'summary' / 'consolidate' 时追加对应 mode_tail_*.md（'\n\n' 连接后 trim）；
   *     其余值（含空串）不追加——runKind 的「选哪个」判断留给调用方，本方法只认 key 取文件。
   */
  build(ctx: PromptHandlerContext): PromptHandlerResult {
    const skeleton = this.fillTemplate(this.readContent().trimEnd(), {
      mode_key: ctx.vars?.mode_key ?? '',
      actual_tools_description: ctx.vars?.actual_tools_description ?? '',
    });
    const tailKey = ctx.vars?.mode_tail_key;
    if (tailKey === 'summary' || tailKey === 'consolidate') {
      const tail = this.readContent(`side_run_reminder/mode_tail_${tailKey}.md`);
      return { content: `${skeleton}\n\n${tail}`.trim() };
    }
    return { content: skeleton };
  }

  /** 零工具态文案（content/side_run_reminder/tools_none.md），供 buildReminderText 两态选择用 */
  readToolsNone(): string {
    return this.readContent('side_run_reminder/tools_none.md').trim();
  }
}

export default SideRunReminderHandler;
