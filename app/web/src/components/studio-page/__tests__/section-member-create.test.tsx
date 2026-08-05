/**
 * @vitest-environment jsdom
 * section-member-create 单测（v0.0.169 弹层 → 主区创建页迁移）：
 *   模式切换渲染 / Fresh valid 门槛 / Derive valid 门槛 / 提交 body 组装
 *   （fresh 含 workStyle + skillConfig；derive 含 deriveFrom + overrides）/ 取消回退。
 * 参考: specs/ui/components/studio-page/member-create.md；11a §2.1
 *
 * vi.mock 绝对路径 api-client（skills 筛选器挂载调 listSkills，必须 mock 否则真 fetch）。
 * 定位策略：产品代码 data-testid 已移除，改语义定位（字段按 label/placeholder；模式/父选择按按钮文案；
 *   switch 按 role+label；submit/cancel/back 按按钮文案）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { MemberCreate } from '../section-member-create';
import { mkDetail, mkMember } from './_fixtures';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const mocks = vi.hoisted(() => ({ listSkills: vi.fn() }));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
vi.mock(apiPath, async (importOriginal) => ({
  ...(await (importOriginal as () => Promise<Record<string, unknown>>)()),
  listSkills: (...a: unknown[]) => mocks.listSkills(...a),
}));

/** 默认 catalog：2 个 app skill（skA/skB 均全局 enabled） */
function defaultCatalog() {
  mocks.listSkills.mockResolvedValue([
    { name: 'skA', description: 'Skill A', scope: 'app', skillDir: '/a', enabled: true },
    { name: 'skB', description: 'Skill B', scope: 'app', skillDir: '/b', enabled: true },
  ]);
}

// —— 语义定位辅助 —— //
const NAME_LABEL_FRESH = 'name（squad 内唯一，必填）';
const INTRO_LABEL_FRESH = 'intro 一句话介绍（花名册用）';
const WORKSTYLE_LABEL = '工作方式（仅注入个人会话）';
/** 按 label 文案定位字段（label 父容器内首个 input，无则 textarea） */
function fieldByLabel(text: string): HTMLInputElement {
  const label = screen.getByText(text, { selector: 'label' });
  const wrap = label.closest('div')!;
  return (wrap.querySelector('input') ?? wrap.querySelector('textarea')) as HTMLInputElement;
}
/** 模式切换按钮 */
const freshModeBtn = () => screen.getByRole('button', { name: 'Fresh · 新建' });
const deriveModeBtn = () => screen.getByRole('button', { name: 'Derive · 派生' });
/** skills 模式开关（ToggleSwitch label「custom skills」） */
const skillsModeSwitch = () => screen.getByRole('switch', { name: 'custom skills' });
/** 提交按钮（文案「创建」） */
const submitBtn = () => screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;

describe('MemberCreate（v0.0.169 主区创建页）', () => {
  afterEach(() => {
    cleanup();
    mocks.listSkills.mockReset();
  });

  it('默认 fresh：渲染页面/模式切换/profile 三字段 + skills switch；name+intro 未齐 → submit disabled', async () => {
    defaultCatalog();
    const { container } = render(<MemberCreate detail={mkDetail()} onBack={() => {}} onSubmit={async () => {}} />);
    expect(container.querySelector('main')).toBeTruthy();
    expect(freshModeBtn()).toBeTruthy();
    expect(deriveModeBtn()).toBeTruthy();
    expect(fieldByLabel(NAME_LABEL_FRESH)).toBeTruthy();
    expect(fieldByLabel(INTRO_LABEL_FRESH)).toBeTruthy();
    expect(fieldByLabel(WORKSTYLE_LABEL)).toBeTruthy();
    expect(skillsModeSwitch()).toBeTruthy();
    expect(submitBtn().disabled).toBe(true);
    // 等筛选器 catalog 落定（始终挂载预载），避免 act 警告
    await screen.findByText('skA');
  });

  it('fresh valid 门槛：仅填 name → disabled；name+intro 填齐 → enabled', async () => {
    defaultCatalog();
    render(<MemberCreate detail={mkDetail()} onBack={() => {}} onSubmit={async () => {}} />);
    fireEvent.change(fieldByLabel(NAME_LABEL_FRESH), { target: { value: '王五' } });
    expect(submitBtn().disabled).toBe(true);
    fireEvent.change(fieldByLabel(INTRO_LABEL_FRESH), { target: { value: '负责前端' } });
    expect(submitBtn().disabled).toBe(false);
    await screen.findByText('skA');
  });

  it('fresh 提交：body 含 trim 后 name/intro/workStyle；skills off=inherit 不传 skillConfig', async () => {
    defaultCatalog();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<MemberCreate detail={mkDetail()} onBack={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(fieldByLabel(NAME_LABEL_FRESH), { target: { value: ' 王五 ' } });
    fireEvent.change(fieldByLabel(INTRO_LABEL_FRESH), { target: { value: ' 负责前端 ' } });
    fireEvent.change(fieldByLabel(WORKSTYLE_LABEL), { target: { value: ' 小步快跑 ' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'fresh', name: '王五', intro: '负责前端', workStyle: '小步快跑',
    });
  });

  it('fresh 提交：workStyle 留空不传；skills 开 custom → skillConfig R5 全量快照', async () => {
    defaultCatalog();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<MemberCreate detail={mkDetail()} onBack={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(fieldByLabel(NAME_LABEL_FRESH), { target: { value: '王五' } });
    fireEvent.change(fieldByLabel(INTRO_LABEL_FRESH), { target: { value: '负责前端' } });
    // 开 skills custom → 等筛选器展开后关 skA
    fireEvent.click(skillsModeSwitch());
    const tglA = await screen.findByRole('switch', { name: 'skA' });
    fireEvent.click(tglA);
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'fresh', name: '王五', intro: '负责前端',
      skillConfig: { mode: 'custom', overrides: { skA: false, skB: true } },
    });
  });

  it('derive 模式：渲染父选择（排除 leader）；未选父 → disabled；选父 + 覆盖 name → body 组装', async () => {
    defaultCatalog();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<MemberCreate detail={mkDetail()} onBack={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(deriveModeBtn());
    // skills Card 不暴露（derive 继承父）
    expect(screen.queryByText('skills')).toBeNull();
    // 父选择：mate（张三）可选，leader（Rocky）排除
    expect(screen.getByRole('button', { name: '张三' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rocky' })).toBeNull();
    // v0.0.250：inheritMemory toggle 已删（dead UI），不应渲染
    expect(screen.queryByRole('switch', { name: '继承父角色长期记忆' })).toBeNull();
    // 未选父 → disabled
    expect(submitBtn().disabled).toBe(true);
    // 选父 + 覆盖 name（intro/workStyle 留空 = 继承父）
    fireEvent.click(screen.getByRole('button', { name: '张三' }));
    fireEvent.change(fieldByLabel('name'), { target: { value: ' 王五改 ' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'derive', deriveFrom: 'm2', overrides: { name: '王五改' },
    });
  });

  it('derive 提交：覆盖全留空 → 无 overrides 字段；workStyle 覆盖非空 → trim 进 overrides', async () => {
    defaultCatalog();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<MemberCreate detail={mkDetail()} onBack={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(deriveModeBtn());
    fireEvent.click(screen.getByRole('button', { name: '张三' }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'derive', deriveFrom: 'm2' });

    // workStyle 覆盖
    onSubmit.mockClear();
    fireEvent.change(fieldByLabel(WORKSTYLE_LABEL), { target: { value: ' 直接给方案 ' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'derive', deriveFrom: 'm2', overrides: { workStyle: '直接给方案' },
    });
  });

  it('derive 父列表为空（仅 leader）→ 空提示', async () => {
    defaultCatalog();
    const onlyLeader = mkDetail({ members: [mkMember({ id: 'leader1', name: 'Rocky', role: 'leader' })], memberIds: ['leader1'] });
    render(<MemberCreate detail={onlyLeader} onBack={() => {}} onSubmit={async () => {}} />);
    fireEvent.click(deriveModeBtn());
    expect(screen.getByText('暂无可派生的 mate（仅 leader），请先用 Fresh 新建。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rocky' })).toBeNull();
  });

  it('取消 / 返回 → 调 onBack（不提交）', async () => {
    defaultCatalog();
    const onBack = vi.fn();
    render(<MemberCreate detail={mkDetail()} onBack={onBack} onSubmit={async () => {}} />);
    await screen.findByText('skA');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});
