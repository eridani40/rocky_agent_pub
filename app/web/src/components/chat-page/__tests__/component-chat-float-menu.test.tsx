// @vitest-environment jsdom
/**
 * component-chat-float-menu 单测
 * 参考: specs/ui/components/chat-page/component-chat-float-menu.md §2/§3
 *
 * 覆盖：
 *   - badge：memory badge = entries.length；cron badge = enabled jobs 数；todo badge = 未完成主 item 数
 *   - badge=0 → 不渲染（不占位，非文本 '0'）
 *   - hideCron=true → cron 菜单项不挂载 + useCronCrud 以 {enabled:false} 调用（零网络 gate）
 *   - hideCron=false（缺省）→ cron 菜单项挂载 + useCronCrud 以 {enabled:true} 调用
 *   - 点菜单项 → 对应弹层挂载（打开态）
 *   - [v0.0.205.t2_cons] skills 第 3 菜单项：纵排 3 图标（memory/cron/skills 顺序）+ 无 badge +
 *     useSkillsCatalog 恒挂载 + 点击挂 ComponentSkillsModal；hideCron 不影响 skills 项
 *   - [v0.0.223] todo 第 4 菜单项（skills 下方）：useTodoCrud 恒挂载 + badge=pendingCount +
 *     点击挂 ComponentTodoModal；hideCron 不影响 todo 项
 *
 * mock 策略：vi.hoisted + __dirname 派生绝对路径 mock use-memory-crud / use-cron-crud /
 * use-skills-catalog / use-todo-crud + mock 四个弹层组件（component-memory-modal /
 * component-cron-modal / component-skills-modal / component-todo-modal）。
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const memoryCrudMocks = vi.hoisted(() => ({ useMemoryCrud: vi.fn() }));
const cronCrudMocks = vi.hoisted(() => ({ useCronCrud: vi.fn() }));
const skillsCatalogMocks = vi.hoisted(() => ({ useSkillsCatalog: vi.fn() }));
const todoCrudMocks = vi.hoisted(() => ({ useTodoCrud: vi.fn() }));
const memoryModalMocks = vi.hoisted(() => ({ ComponentMemoryModal: vi.fn() }));
const cronModalMocks = vi.hoisted(() => ({ ComponentCronModal: vi.fn() }));
const skillsModalMocks = vi.hoisted(() => ({ ComponentSkillsModal: vi.fn() }));
const todoModalMocks = vi.hoisted(() => ({ ComponentTodoModal: vi.fn() }));

const memoryCrudPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../use-memory-crud'));
const cronCrudPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../use-cron-crud'));
const skillsCatalogPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../use-skills-catalog'));
const todoCrudPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../use-todo-crud'));
const memoryModalPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../component-memory-modal'));
const cronModalPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../component-cron-modal'));
const skillsModalPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../component-skills-modal'));
const todoModalPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../component-todo-modal'));

vi.mock(memoryCrudPath, () => memoryCrudMocks);
vi.mock(cronCrudPath, () => cronCrudMocks);
vi.mock(skillsCatalogPath, () => skillsCatalogMocks);
vi.mock(todoCrudPath, () => todoCrudMocks);
vi.mock(memoryModalPath, () => memoryModalMocks);
vi.mock(cronModalPath, () => cronModalMocks);
vi.mock(skillsModalPath, () => skillsModalMocks);
vi.mock(todoModalPath, () => todoModalMocks);

beforeAll(async () => {
  await initI18n('zh-CN');
});

import { ComponentChatFloatMenu } from '../component-chat-float-menu';

function mkMemoryCrud(entryCount: number) {
  return {
    entries: Array.from({ length: entryCount }, (_, i) => ({ name: `e${i}` })),
    loading: false,
    error: null,
    editor: { open: false },
    setEditor: vi.fn(),
    refetch: vi.fn(),
    handleSave: vi.fn(),
    handleArchive: vi.fn(),
  };
}

function mkCronCrud(jobs: { id: string; enabled: boolean }[]) {
  return {
    jobs,
    loading: false,
    error: null,
    busyId: null,
    refetch: vi.fn(),
    handleToggle: vi.fn(),
    handleDelete: vi.fn(),
  };
}

function mkSkillsCatalog() {
  return {
    groups: { session: [], group: [], global: [] },
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
}

function mkTodoCrud(pendingCount: number) {
  return {
    items: [],
    loading: false,
    error: null,
    busyId: null,
    pendingCount,
    refetch: vi.fn(),
    handleDelete: vi.fn(),
  };
}

beforeEach(() => {
  memoryCrudMocks.useMemoryCrud.mockReset().mockReturnValue(mkMemoryCrud(0));
  cronCrudMocks.useCronCrud.mockReset().mockReturnValue(mkCronCrud([]));
  skillsCatalogMocks.useSkillsCatalog.mockReset().mockReturnValue(mkSkillsCatalog());
  todoCrudMocks.useTodoCrud.mockReset().mockReturnValue(mkTodoCrud(0));
  memoryModalMocks.ComponentMemoryModal.mockReset().mockImplementation(() => (
    <div>MEMORY_MODAL_STUB</div>
  ));
  cronModalMocks.ComponentCronModal.mockReset().mockImplementation(() => (
    <div>CRON_MODAL_STUB</div>
  ));
  skillsModalMocks.ComponentSkillsModal.mockReset().mockImplementation(() => (
    <div>SKILLS_MODAL_STUB</div>
  ));
  todoModalMocks.ComponentTodoModal.mockReset().mockImplementation(() => (
    <div>TODO_MODAL_STUB</div>
  ));
});
afterEach(() => cleanup());

/** 菜单项按钮内的 badge span（absolute 定位角标）；无 badge 返 null */
function getBadge(btnName: string): HTMLElement | null {
  const btn = screen.getByRole('button', { name: btnName });
  return btn.querySelector('span.absolute');
}

describe('ComponentChatFloatMenu — memory badge', () => {
  it('badge = entries.length（非 0）', () => {
    memoryCrudMocks.useMemoryCrud.mockReturnValue(mkMemoryCrud(3));
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(getBadge('长期记忆')!.textContent).toBe('3');
  });

  it('entries.length=0 → badge 不渲染（不占位）', () => {
    memoryCrudMocks.useMemoryCrud.mockReturnValue(mkMemoryCrud(0));
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(getBadge('长期记忆')).toBeNull();
  });
});

describe('ComponentChatFloatMenu — cron badge', () => {
  it('badge = enabled jobs 数（非总数）', () => {
    cronCrudMocks.useCronCrud.mockReturnValue(
      mkCronCrud([
        { id: 'j1', enabled: true },
        { id: 'j2', enabled: true },
        { id: 'j3', enabled: false },
      ]),
    );
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(getBadge('定时任务')!.textContent).toBe('2');
  });

  it('全部 disabled（enabled 数=0）→ badge 不渲染', () => {
    cronCrudMocks.useCronCrud.mockReturnValue(
      mkCronCrud([{ id: 'j1', enabled: false }]),
    );
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(getBadge('定时任务')).toBeNull();
  });

  it('jobs 为空 → badge 不渲染', () => {
    cronCrudMocks.useCronCrud.mockReturnValue(mkCronCrud([]));
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(getBadge('定时任务')).toBeNull();
  });
});

describe('ComponentChatFloatMenu — hideCron gate', () => {
  it('hideCron=true → cron 菜单项不挂载', () => {
    render(<ComponentChatFloatMenu sessionId="s1" hideCron />);
    expect(screen.queryByRole('button', { name: '定时任务' })).toBeNull();
    expect(screen.getByRole('button', { name: '长期记忆' })).toBeTruthy();
  });

  it('hideCron=true → useCronCrud 以 {enabled:false} 调用（零网络 gate）', () => {
    render(<ComponentChatFloatMenu sessionId="s1" hideCron />);
    expect(cronCrudMocks.useCronCrud).toHaveBeenCalledWith('s1', { enabled: false });
  });

  it('hideCron=false（缺省）→ cron 菜单项挂载 + useCronCrud 以 {enabled:true} 调用', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(screen.getByRole('button', { name: '定时任务' })).toBeTruthy();
    expect(cronCrudMocks.useCronCrud).toHaveBeenCalledWith('s1', { enabled: true });
  });
});

describe('ComponentChatFloatMenu — 点菜单项开弹层', () => {
  it('点 memory 项 → ComponentMemoryModal 挂载', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(screen.queryByText('MEMORY_MODAL_STUB')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '长期记忆' }));
    expect(screen.getByText('MEMORY_MODAL_STUB')).toBeTruthy();
  });

  it('点 cron 项 → ComponentCronModal 挂载', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: '定时任务' }));
    expect(screen.getByText('CRON_MODAL_STUB')).toBeTruthy();
  });
});

describe('ComponentChatFloatMenu — skills 第 3 菜单项（v0.0.205.t2_cons）', () => {
  it('纵排 4 图标按 memory/cron/skills/todo 顺序挂载（v0.0.223 加第 4 项 todo）', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    const names = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['长期记忆', '定时任务', '技能', '待办']);
  });

  it('skills 项无 badge（无计数需求）', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    const btn = screen.getByRole('button', { name: '技能' });
    expect(btn.querySelector('span.absolute')).toBeNull();
  });

  it('useSkillsCatalog 以 sessionId 恒挂载调用（不随弹层开关）', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(skillsCatalogMocks.useSkillsCatalog).toHaveBeenCalledWith('s1');
  });

  it('点 skills 项 → ComponentSkillsModal 挂载（catalog prop 下传同一实例）', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(screen.queryByText('SKILLS_MODAL_STUB')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '技能' }));
    expect(screen.getByText('SKILLS_MODAL_STUB')).toBeTruthy();
    const props = skillsModalMocks.ComponentSkillsModal.mock.calls[0]![0] as { catalog: unknown };
    expect(props.catalog).toBe(skillsCatalogMocks.useSkillsCatalog.mock.results[0]!.value);
  });

  it('hideCron=true → cron 项不挂载但 skills 项仍挂载', () => {
    render(<ComponentChatFloatMenu sessionId="s1" hideCron />);
    expect(screen.queryByRole('button', { name: '定时任务' })).toBeNull();
    expect(screen.getByRole('button', { name: '技能' })).toBeTruthy();
  });
});

describe('ComponentChatFloatMenu — todo 第 4 菜单项（v0.0.223）', () => {
  it('todo 项位于 skills 下方（顺序断言见 4 图标顺序用例）+ useTodoCrud 以 sessionId 恒挂载', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(screen.getByRole('button', { name: '待办' })).toBeTruthy();
    expect(todoCrudMocks.useTodoCrud).toHaveBeenCalledWith('s1');
  });

  it('todo badge = pendingCount（未完成主 item 数，非 0）', () => {
    todoCrudMocks.useTodoCrud.mockReturnValue(mkTodoCrud(4));
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(getBadge('待办')!.textContent).toBe('4');
  });

  it('pendingCount=0 → badge 不渲染（不占位）', () => {
    todoCrudMocks.useTodoCrud.mockReturnValue(mkTodoCrud(0));
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(getBadge('待办')).toBeNull();
  });

  it('点 todo 项 → ComponentTodoModal 挂载（crud prop 下传同一实例）', () => {
    render(<ComponentChatFloatMenu sessionId="s1" />);
    expect(screen.queryByText('TODO_MODAL_STUB')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '待办' }));
    expect(screen.getByText('TODO_MODAL_STUB')).toBeTruthy();
    const props = todoModalMocks.ComponentTodoModal.mock.calls[0]![0] as { crud: unknown };
    expect(props.crud).toBe(todoCrudMocks.useTodoCrud.mock.results[0]!.value);
  });

  it('hideCron=true → cron 项不挂载但 todo 项仍挂载', () => {
    render(<ComponentChatFloatMenu sessionId="s1" hideCron />);
    expect(screen.queryByRole('button', { name: '定时任务' })).toBeNull();
    expect(screen.getByRole('button', { name: '待办' })).toBeTruthy();
  });
});
