/**
 * component-chat-float-menu —— 聊天区右上悬浮菜单（v0.0.131 新建）
 * 参考: specs/ui/components/chat-page/component-chat-float-menu.md
 *
 * 竖向工具条：长期记忆 / 定时任务 / skills / 待办 四个菜单项（memory/cron/todo 带 badge；
 * skills 无计数需求不挂 badge；顺序 1=memory/cron/skills 自上而下，v0.0.223 第 4 项 todo
 * 位于 skills 下方）。恒挂载 useMemoryCrud + useCronCrud + useSkillsCatalog + useTodoCrud
 * （chat 挂载即拉，badge 才有意义），badge 与弹层列表同一 hook 实例（弹层开关不重 GET；
 * skills 弹层每次打开由弹层侧 refetch，PRD UC-S7）。
 * hideCron=true（squad 群聊无主 cron）→ cron 菜单项不挂载 + cron hook enabled=false（零网络）。
 *
 * 点菜单项 → openModal state 挂对应弹层（component-memory-modal / component-cron-modal /
 * component-skills-modal / component-todo-modal），memory/cron 弹层内部自持二级视图
 * （list/editor），skills 弹层为 3 tab 只读，todo 弹层为双层树只读（v0.0.223）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrainIcon, ClockIcon, StarIcon, TodoIcon } from './icons';
import { useMemoryCrud } from './use-memory-crud';
import { useCronCrud } from './use-cron-crud';
import { useSkillsCatalog } from './use-skills-catalog';
import { useTodoCrud } from './use-todo-crud';
import { ComponentMemoryModal } from './component-memory-modal';
import { ComponentCronModal } from './component-cron-modal';
import { ComponentSkillsModal } from './component-skills-modal';
import { ComponentTodoModal } from './component-todo-modal';

export interface ChatFloatMenuProps {
  /** 当前 session id（memory/cron/skills/todo 均 session 级） */
  sessionId: string;
  /** 隐藏「定时任务」项（squad 群聊 cron 无主）；缺省 false */
  hideCron?: boolean;
}

/** badge：绝对定位右上角角标，count<=0 不渲染（不占位，不推动图标） */
function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span

      className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-surface"
    >
      {count}
    </span>
  );
}

export function ComponentChatFloatMenu({ sessionId, hideCron = false }: ChatFloatMenuProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState<'memory' | 'cron' | 'skills' | 'todo' | null>(null);

  // 数据所有权单一源：恒挂载，弹层开关不重 GET，badge 与弹层列表同一实例（component-chat-float-menu.md §2）
  const memory = useMemoryCrud('session', sessionId);
  const cron = useCronCrud(sessionId, { enabled: !hideCron });
  const skills = useSkillsCatalog(sessionId);
  const todo = useTodoCrud(sessionId);

  const memoryCount = memory.entries.length;
  const cronCount = cron.jobs.filter((j) => j.enabled).length;
  // todo badge = 未完成主 item 数（status ∉ {done, skipped}；PRD §2.6 拍板「未完成」）
  const todoCount = todo.pendingCount;

  return (
    <>
      <div

        // pointer-events-auto：footprint = 整个 menu 框（_layering.md §3B：仅 footprint auto）。
        //   overlay 插槽父 div 已改 pointer-events-none，菜单本体需显式 auto 才能接 click。
        className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm pointer-events-auto"
      >
        <button
          type="button"
          data-action-key="chat.memory.open"
          onClick={() => setOpen('memory')}
          aria-label={t('floatMenu.memory')}
          title={t('floatMenu.memory')}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg-warm hover:text-fg"
        >
          <BrainIcon size={16} />
          <Badge count={memoryCount} />
        </button>
        {!hideCron && (
          <button
            type="button"
            data-action-key="chat.cron.open"
            onClick={() => setOpen('cron')}
            aria-label={t('floatMenu.cron')}
            title={t('floatMenu.cron')}
            className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg-warm hover:text-fg"
          >
            <ClockIcon size={16} />
            <Badge count={cronCount} />
          </button>
        )}
        {/* skills 第 3 菜单项（定时任务下方，PRD 定案 1 顺序）；无 badge（无计数需求） */}
        <button
          type="button"
          data-action-key="chat.skill.open"
          onClick={() => setOpen('skills')}
          aria-label={t('floatMenu.skills')}
          title={t('floatMenu.skills')}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg-warm hover:text-fg"
        >
          <StarIcon size={16} />
        </button>
        {/* todo 第 4 菜单项（v0.0.223，skills 下方）；badge=未完成主 item 数 */}
        <button
          type="button"
          data-action-key="chat.todo.open"
          onClick={() => setOpen('todo')}
          aria-label={t('floatMenu.todo')}
          title={t('floatMenu.todo')}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg-warm hover:text-fg"
        >
          <TodoIcon size={16} />
          <Badge count={todoCount} />
        </button>
      </div>

      {open === 'memory' && (
        <ComponentMemoryModal crud={memory} onClose={() => setOpen(null)} />
      )}
      {open === 'cron' && !hideCron && (
        <ComponentCronModal sessionId={sessionId} crud={cron} onClose={() => setOpen(null)} />
      )}
      {open === 'skills' && (
        <ComponentSkillsModal catalog={skills} onClose={() => setOpen(null)} />
      )}
      {open === 'todo' && (
        <ComponentTodoModal crud={todo} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

export default ComponentChatFloatMenu;
