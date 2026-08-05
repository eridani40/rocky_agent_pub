/**
 * @vitest-environment jsdom
 * component-member-skill-filter 单测（[v0.0.113] O-3 简化筛选器）：
 *   拉 catalog 排除 workspace + 叠加显示态（R4）+ toggle 上抛 + 搜索过滤 + onCatalog 上抛。
 * 参考: specs/ui/components/studio-page/component-member-skill-filter.md；2-member-skills-mechanism.md R4
 *
 * vi.mock 绝对路径 api-client（挂载调 listSkills）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ComponentMemberSkillFilter } from '../component-member-skill-filter';

const mocks = vi.hoisted(() => ({ listSkills: vi.fn() }));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
vi.mock(apiPath, async (importOriginal) => ({
  ...(await (importOriginal as () => Promise<Record<string, unknown>>)()),
  listSkills: (...a: unknown[]) => mocks.listSkills(...a),
}));

function catalog() {
  mocks.listSkills.mockResolvedValue([
    { name: 'alpha', description: 'A skill', scope: 'app', skillDir: '/a', enabled: true },
    { name: 'beta', description: 'B skill', scope: 'app', skillDir: '/b', enabled: false },
    { name: 'wsonly', description: 'ws', scope: 'workspace', skillDir: '/w', enabled: true },
  ]);
}

describe('ComponentMemberSkillFilter', () => {
  afterEach(() => {
    cleanup();
    mocks.listSkills.mockReset();
  });

  it('排除 workspace scope；builtin/app 行渲染 + onCatalog 上抛已过滤 catalog', async () => {
    catalog();
    const onCatalog = vi.fn();
    render(<ComponentMemberSkillFilter open overrides={{}} onToggle={() => {}} onCatalog={onCatalog} />);
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.queryByText('wsonly')).toBeNull();
    await waitFor(() => expect(onCatalog).toHaveBeenCalled());
    const emitted = onCatalog.mock.calls[0]![0];
    expect(emitted.map((e: { name: string }) => e.name)).toEqual(['alpha', 'beta']);
  });

  it('叠加显示态（R4）：overrides 有键用键值，无键跟全局 enabled', async () => {
    catalog();
    // alpha 全局 enabled=true，override 关 → 显示 false；beta 全局 enabled=false，无 override → 显示 false
    render(<ComponentMemberSkillFilter open overrides={{ alpha: false }} onToggle={() => {}} />);
    await screen.findByText('alpha');
    expect(screen.getByRole('switch', { name: 'alpha' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'beta' }).getAttribute('aria-checked')).toBe('false');
  });

  it('toggle 上抛 onToggle(name, 翻转值)', async () => {
    catalog();
    const onToggle = vi.fn();
    render(<ComponentMemberSkillFilter open overrides={{}} onToggle={onToggle} />);
    const tgl = await screen.findByRole('switch', { name: 'alpha' });
    fireEvent.click(tgl); // alpha 显示 true（全局 enabled）→ 翻转为 false
    expect(onToggle).toHaveBeenCalledWith('alpha', false);
  });

  it('搜索按 name 子串过滤（大小写不敏感）', async () => {
    catalog();
    render(<ComponentMemberSkillFilter open overrides={{}} onToggle={() => {}} />);
    await screen.findByText('alpha');
    fireEvent.change(screen.getByPlaceholderText('搜索 skill'), { target: { value: 'BET' } });
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.queryByText('alpha')).toBeNull();
  });
});
