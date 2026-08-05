/**
 * @vitest-environment jsdom
 * page-skill 单测：渲染骨架（header/tab/dropzone/list 空态）+ 导航入口路由
 * 参考: specs/ui/components/skill-page/page-skill.md
 *
 * mock api-client（listSkills 返回空 → 空态），验证：
 * - header title/desc
 * - tab 栏渲染「我的」/「市场」双 tab
 * - drop-zone 渲染（拖拽落点 + 两按钮）
 * - 空态「还没有已安装的 Skill」
 * - list 出 skill 时渲染单卡（name/badge/toggle/preview/delete）
 *
 * 注意：bun --bun runtime 下 vitest 的 vi.mock 对相对路径在 jsdom 环境不生效，必须用绝对路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { PageSkill } from '../page-skill';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：skill delete/preview modal 用 useTranslation('common')
beforeAll(async () => {
  await initI18n('zh-CN');
});

// bun --bun 下 vi.mock 需绝对路径（hoisted 计算避免引用未初始化）
const apiPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/api-client'),
);
const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  installSkill: vi.fn(),
  patchSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(),
  getSkillTree: vi.fn(),
  getSkillFile: vi.fn(),
  // [v0.0.167] SectionSkillMarket（market tab）从同一 api-client 模块导入这三个
  getMarketCapabilities: vi.fn(),
  searchMarket: vi.fn(),
  installMarketSkill: vi.fn(),
}));

vi.mock(apiPath, () => ({
  listSkills: (...args: unknown[]) => mocks.listSkills(...args),
  installSkill: (...args: unknown[]) => mocks.installSkill(...args),
  patchSkillEnabled: (...args: unknown[]) => mocks.patchSkillEnabled(...args),
  deleteSkill: (...args: unknown[]) => mocks.deleteSkill(...args),
  getSkillTree: (...args: unknown[]) => mocks.getSkillTree(...args),
  getSkillFile: (...args: unknown[]) => mocks.getSkillFile(...args),
  getMarketCapabilities: (...args: unknown[]) => mocks.getMarketCapabilities(...args),
  searchMarket: (...args: unknown[]) => mocks.searchMarket(...args),
  installMarketSkill: (...args: unknown[]) => mocks.installMarketSkill(...args),
}));

describe('PageSkill', () => {
  beforeEach(() => {
    mocks.listSkills.mockClear();
    mocks.installSkill.mockClear();
    mocks.patchSkillEnabled.mockClear();
    mocks.deleteSkill.mockClear();
    mocks.getSkillTree.mockClear();
    mocks.getSkillFile.mockClear();
    mocks.getMarketCapabilities.mockClear();
    mocks.searchMarket.mockClear();
    mocks.installMarketSkill.mockClear();
    mocks.listSkills.mockResolvedValue([]);
    mocks.getSkillTree.mockResolvedValue([]);
    mocks.getSkillFile.mockResolvedValue({ content: '', binary: false, truncated: false });
    // 默认无 provider（503→null）：market tab 挂载即渲染 noProvider 引导态，不发搜索
    mocks.getMarketCapabilities.mockResolvedValue(null);
  });
  afterEach(() => cleanup());

  it('渲染 header title/desc + tab（drop-zone 默认收起，弹层化）', async () => {
    render(<PageSkill />);
    expect(screen.getByText('Skill 管理').textContent).toBe('Skill 管理');
    expect(screen.getByText(/skill · 安装/).textContent).toContain('skill');
    expect(screen.getByRole('tab', { name: '我的' }).textContent).toBe('我的');
    expect(screen.getByRole('tab', { name: '市场' }).textContent).toBe('市场');
    // drop-zone 默认收起（弹层化），「+」按钮在 tab 栏最右
    expect(screen.queryByText('拖拽 Skill 到此处安装')).toBeNull();
    expect(screen.getByRole('button', { name: '安装 Skill' })).toBeTruthy();
    // 点「+」→ drop-zone 弹层展开
    fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }));
    expect(screen.getByText('拖拽 Skill 到此处安装').textContent).toBe('拖拽 Skill 到此处安装');
    expect(screen.getByText('选择文件')).toBeTruthy();
    expect(screen.getByText('选择文件夹')).toBeTruthy();
    await waitFor(() => expect(mocks.listSkills).toHaveBeenCalled());
  });

  it('空列表 → 渲染空态「还没有已安装的 Skill」', async () => {
    render(<PageSkill />);
    await waitFor(() => {
      expect(screen.getByText('还没有已安装的 Skill').textContent).toBe('还没有已安装的 Skill');
    });
  });

  it('有 skill → 渲染单卡（name/badge/toggle/preview/delete）', async () => {
    mocks.listSkills.mockResolvedValue([
      {
        name: 'my-skill',
        description: 'desc here',
        scope: 'app',
        skillDir: '/tmp/skills/my-skill',
        enabled: true,
      },
    ]);
    render(<PageSkill />);
    await waitFor(() => {
      expect(screen.getByText('my-skill')).toBeTruthy();
      expect(screen.getByText('已启用')).toBeTruthy();
      expect(screen.getByRole('switch', { name: 'my-skill 启用 / 禁用' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '预览' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '删除 my-skill' })).toBeTruthy();
    });
  });

  it('禁用态 skill → badge 显示「已禁用」', async () => {
    mocks.listSkills.mockResolvedValue([
      { name: 'off-skill', description: '', scope: 'app', skillDir: '/x', enabled: false },
    ]);
    render(<PageSkill />);
    await waitFor(() => {
      expect(screen.getByText('已禁用').textContent).toBe('已禁用');
    });
  });

  it('点 toggle → 调 patchSkillEnabled（翻转后的值）', async () => {
    mocks.listSkills.mockResolvedValue([
      { name: 's1', description: '', scope: 'app', skillDir: '/x', enabled: true },
    ]);
    mocks.patchSkillEnabled.mockResolvedValue({
      name: 's1', description: '', scope: 'app', skillDir: '/x', enabled: false,
    });
    render(<PageSkill />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 's1 启用 / 禁用' })).toBeTruthy());
    fireEvent.click(screen.getByRole('switch', { name: 's1 启用 / 禁用' }));
    await waitFor(() => {
      expect(mocks.patchSkillEnabled).toHaveBeenCalledWith('s1', false, { scope: 'app' });
    });
  });

  it('点删除 → 打开 delete modal（标题 + 取消 + 确认）', async () => {
    mocks.listSkills.mockResolvedValue([
      { name: 'del-me', description: '', scope: 'app', skillDir: '/x', enabled: true },
    ]);
    render(<PageSkill />);
    await waitFor(() => expect(screen.getByRole('button', { name: '删除 del-me' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '删除 del-me' }));
    await waitFor(() => {
      expect(screen.getByText('删除 Skill').textContent).toBe('删除 Skill');
      expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();
    });
  });

  it('delete modal 点确认 → 调 deleteSkill', async () => {
    mocks.listSkills.mockResolvedValue([
      { name: 'del-me', description: '', scope: 'app', skillDir: '/x', enabled: true },
    ]);
    mocks.deleteSkill.mockResolvedValue(undefined);
    render(<PageSkill />);
    await waitFor(() => expect(screen.getByRole('button', { name: '删除 del-me' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '删除 del-me' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(mocks.deleteSkill).toHaveBeenCalledWith('del-me');
    });
  });

  // [v0.0.167 U7] tab 切换：manage（拖拽+列表）↔ market（SectionSkillMarket）分支正确切换
  // drop-zone 改弹层：默认收起，需先点「+」展开
  it('切到「市场」tab → 渲染市场内容区 + 隐藏 drop-zone；切回「我的」→ 恢复 drop-zone（弹层收起态）', async () => {
    render(<PageSkill />);
    // 默认 manage：弹层收起态、市场区不在
    await waitFor(() => expect(screen.getByRole('button', { name: '安装 Skill' })).toBeTruthy());
    expect(screen.queryByText('市场未配置生效来源')).toBeNull();

    // 切到市场：市场区挂载（能力协商 null → noProvider 引导态）
    fireEvent.click(screen.getByRole('tab', { name: '市场' }));
    await waitFor(() => expect(screen.getByText('市场未配置生效来源')).toBeTruthy());
    expect(mocks.getMarketCapabilities).toHaveBeenCalled();

    // 切回我的：弹层仍收起、市场区卸载
    fireEvent.click(screen.getByRole('tab', { name: '我的' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '安装 Skill' })).toBeTruthy());
    expect(screen.queryByText('市场未配置生效来源')).toBeNull();
  });

  // 安装成功 → 弹层自动收起（installExpanded=false）
  it('安装成功 → 弹层自动收起', async () => {
    mocks.listSkills.mockResolvedValue([]);
    mocks.installSkill.mockResolvedValue(undefined);
    render(<PageSkill />);
    await waitFor(() => expect(screen.getByRole('button', { name: '安装 Skill' })).toBeTruthy());

    // 点「+」展开弹层
    fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }));
    await waitFor(() => expect(screen.getByText('拖拽 Skill 到此处安装')).toBeTruthy());
    expect(screen.getByRole('button', { name: '关闭安装区' })).toBeTruthy();

    // 触发安装：drop-zone 内的 file input（按 accept 属性定位）onChange
    const fileInput = document.querySelector('input[type=file][accept]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 's.md')] },
    });

    // installSkill 被调 + 弹层自动收起
    await waitFor(() => expect(mocks.installSkill).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText('拖拽 Skill 到此处安装')).toBeNull();
      expect(screen.queryByRole('button', { name: '关闭安装区' })).toBeNull();
    });
  });

  // 安装失败 → 弹层保留展开（让用户看到 error）
  it('安装失败 → 弹层保留展开 + 显示 error（不收起）', async () => {
    mocks.listSkills.mockResolvedValue([]);
    mocks.installSkill.mockRejectedValue(new Error('boom'));
    render(<PageSkill />);
    await waitFor(() => expect(screen.getByRole('button', { name: '安装 Skill' })).toBeTruthy());

    // 点「+」展开弹层
    fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }));
    await waitFor(() => expect(screen.getByText('拖拽 Skill 到此处安装')).toBeTruthy());

    // 触发安装
    const fileInput = document.querySelector('input[type=file][accept]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 's.md')] },
    });

    // installSkill 被调 + 弹层保留展开（看到 error）
    await waitFor(() => expect(mocks.installSkill).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText('拖拽 Skill 到此处安装')).toBeTruthy();
      expect(screen.getByText('boom')).toBeTruthy();
    });
  });
});
