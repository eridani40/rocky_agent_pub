/**
 * @vitest-environment jsdom
 * section-member-panel 单测（[v0.0.113] ②③ 重构；[v0.0.169] 任务区删）：
 *   2 section（profile + skills，无任务区/无记忆/无 model）+ skills inherit/custom 开关 + 简化筛选器叠加态 +
 *   保存 R5（custom 全量补齐）/ R6（off 清空 overrides）+ 悬浮保存「改了才显」+ 返回。
 * 参考: specs/ui/components/studio-page/member-panel.md；2-member-skills-mechanism.md R1-R6；11a §2.2
 *
 * vi.mock 绝对路径 api-client（筛选器挂载调 listSkills，必须 mock 否则真 fetch）。
 * 定位策略：产品代码 data-testid 已移除，改语义定位（input 按 label/placeholder；switch 按 role+label；
 *   section 按 Card 标题；save/back 按按钮文案）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { MemberPanel } from '../section-member-panel';
import { mkMember } from './_fixtures';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const mocks = vi.hoisted(() => ({ listSkills: vi.fn() }));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
vi.mock(apiPath, async (importOriginal) => ({
  ...(await (importOriginal as () => Promise<Record<string, unknown>>)()),
  listSkills: (...a: unknown[]) => mocks.listSkills(...a),
}));

/** 默认 catalog：2 个 app skill（skA/skB 均全局 enabled）+ 1 个 workspace（应被排除） */
function defaultCatalog() {
  mocks.listSkills.mockResolvedValue([
    { name: 'skA', description: 'Skill A', scope: 'app', skillDir: '/a', enabled: true },
    { name: 'skB', description: 'Skill B', scope: 'app', skillDir: '/b', enabled: true },
    { name: 'wk', description: 'Workspace', scope: 'workspace', skillDir: '/w', enabled: true },
  ]);
}

// —— 语义定位辅助 —— //
const INTRO_PLACEHOLDER = '一句话说明该成员的职责，如：负责前端页面与交互';
/** 按 label 文案定位输入框（label 的父容器内首个 input） */
function inputByLabel(text: string): HTMLInputElement {
  return screen.getByText(text).closest('div')!.querySelector('input') as HTMLInputElement;
}
/** intro 输入框（按 placeholder） */
const introInput = () => screen.getByPlaceholderText(INTRO_PLACEHOLDER) as HTMLInputElement;
/** skills 模式开关（ToggleSwitch role=switch，label「custom skills」） */
const skillsModeSwitch = () => screen.getByRole('switch', { name: 'custom skills' });
/** 某 skill 行的可见性开关（ToggleSwitch label = skill name） */
const skillToggle = (name: string) => screen.getByRole('switch', { name });
/** [v0.0.317] SaveBar 保存按钮（常驻；dirty 时文案「● 保存」，非 dirty「保存」） */
const saveBtn = () => screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement;
/** [v0.0.317] dirty 态判定：SaveBar 常驻无「缺席」概念，断言 dirty 指示文案（● 前缀 = dirty） */
const isDirty = () => screen.getByRole('button', { name: /保存/ }).textContent?.includes('●') === true;

describe('MemberPanel [v0.0.113] skills 重构', () => {
  afterEach(() => {
    cleanup();
    mocks.listSkills.mockReset();
  });

  it('2 section（[v0.0.169] 任务区删）：profile + skills；旧字段/section 移除', async () => {
    defaultCatalog();
    const { container } = render(<MemberPanel member={mkMember()} onBack={() => {}} onSave={async () => {}} />);
    expect(container.querySelector('main')).toBeTruthy();
    expect(inputByLabel('name')).toBeTruthy();
    // [v0.0.114] intro 一句话介绍输入框实跑
    expect(introInput()).toBeTruthy();
    // systemPrompt 输入框已删除（phantom 字段清理）
    expect(screen.queryByText(/systemPrompt/i)).toBeNull();
    // ② skills section 存在且标题为「skills」（非旧「技能与模型」）
    const skillsTitle = screen.getByText('skills');
    const skillsCard = skillsTitle.closest('.rounded-lg') as HTMLElement;
    expect(skillsCard.textContent?.toLowerCase()).toContain('skills');
    expect(skillsCard.textContent).not.toContain('技能与模型');
    expect(skillsModeSwitch()).toBeTruthy();
    // ③ 记忆 / 心跳 section 移除
    expect(screen.queryByText('记忆管理')).toBeNull();
    expect(screen.queryByText('心跳配置')).toBeNull();
    // 等筛选器异步 catalog 落定，避免 act 警告
    await screen.findByText('skA');
  });

  it('默认 off=inherit（aria-checked=false）；开 switch → on=custom + 筛选器列出非 workspace skill', async () => {
    defaultCatalog();
    render(<MemberPanel member={mkMember()} onBack={() => {}} onSave={async () => {}} />);
    const sw = skillsModeSwitch();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // 开 switch → custom
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    // 筛选器展开列出 skA/skB（排除 workspace wk）
    expect(await screen.findByText('skA')).toBeTruthy();
    expect(screen.getByText('skB')).toBeTruthy();
    expect(screen.queryByText('wk')).toBeNull();
    // 叠加显示态 = 全局 enabled=true（overrides 空）
    expect(skillToggle('skA').getAttribute('aria-checked')).toBe('true');
  });

  it('R5：custom + 关 skA + 保存 → skillConfig={mode:custom, overrides 全量补齐(skA=false,skB=true)}', async () => {
    defaultCatalog();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MemberPanel member={mkMember({ id: 'm9' })} onBack={() => {}} onSave={onSave} />);
    fireEvent.click(skillsModeSwitch()); // → custom
    const tglA = await screen.findByRole('switch', { name: 'skA' });
    fireEvent.click(tglA); // 关 skA
    expect(tglA.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith('m9', {
      skillConfig: { mode: 'custom', overrides: { skA: false, skB: true } },
    });
    // 保存后基线重置 → 悬浮保存消失（settle 掉 setState 避免 act 警告）
    await waitFor(() => expect(isDirty()).toBe(false));
  });

  it('R6：初始 custom(overrides skA:false) → 关 switch → 保存 → skillConfig={mode:inherit, overrides:{}}', async () => {
    defaultCatalog();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <MemberPanel
        member={mkMember({ id: 'm7', skillConfig: { mode: 'custom', overrides: { skA: false } } })}
        onBack={() => {}}
        onSave={onSave}
      />,
    );
    const sw = skillsModeSwitch();
    expect(sw.getAttribute('aria-checked')).toBe('true'); // 初始 custom
    fireEvent.click(sw); // → inherit
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith('m7', { skillConfig: { mode: 'inherit', overrides: {} } });
    await waitFor(() => expect(isDirty()).toBe(false));
  });

  it('悬浮保存「改了才显」：初始无 save，改 name 后出现；保存后消失', async () => {
    defaultCatalog();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MemberPanel member={mkMember({ id: 'm1' })} onBack={() => {}} onSave={onSave} />);
    expect(isDirty()).toBe(false);
    fireEvent.change(inputByLabel('name'), { target: { value: '张三改' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('m1', { name: '张三改' }));
    await waitFor(() => expect(isDirty()).toBe(false));
  });

  // [v0.0.114] intro 可编辑：预填初始 intro，改后仅 intro 进 patch
  it('intro 输入框预填初始值；改 intro → onSave(仅 intro patch)', async () => {
    defaultCatalog();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MemberPanel member={mkMember({ id: 'm7', intro: '原始介绍' })} onBack={() => {}} onSave={onSave} />);
    // 等 skill 筛选器 catalog 落定（避免 act 警告；记忆 section 已在 v0.0.113 删除）
    await screen.findByText('skA');
    // 预填初始 intro
    const input = introInput();
    expect(input.value).toBe('原始介绍');
    // 初始无 dirty → 无 save
    expect(isDirty()).toBe(false);
    // 改 intro → save 出现
    fireEvent.change(input, { target: { value: '负责后端接口' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith('m7', { intro: '负责后端接口' });
  });

  it('member 无 intro（旧队优雅降级）→ 输入框空串，可填后保存', async () => {
    defaultCatalog();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MemberPanel member={mkMember({ id: 'm8', intro: undefined })} onBack={() => {}} onSave={onSave} />);
    await screen.findByText('skA');
    const input = introInput();
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '补填介绍' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith('m8', { intro: '补填介绍' });
  });

  it('点返回调 onBack', async () => {
    defaultCatalog();
    const onBack = vi.fn();
    render(<MemberPanel member={mkMember()} onBack={onBack} onSave={async () => {}} />);
    await screen.findByText('skA'); // 等 catalog 落定
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(onBack).toHaveBeenCalled();
  });
});
