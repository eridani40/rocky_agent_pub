/**
 * @vitest-environment jsdom
 * page-studio 单测（挂载拉 squad 列表 + 自动选中进面板 + 新建 squad wizard + 建队调 createSquad）
 * 参考: specs/ui/overall/06-studio.md §2/§6
 *
 * vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效；
 * 用 __dirname 派生 portable 路径，避免 worktree 硬编码）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { mkDetail, mkMember, mkSummary } from './_fixtures';
import { initI18n } from '../../../i18n';

// [v0.0.62 i18n] 启动 i18next instance：squad/member-chat 内 ChatComposer 用 useTranslation('common')
// Polyfill jsdom 缺失的布局方法（ProseMirror coordsAtPos → singleRect 在 Text 节点上调 getClientRects）
// 不补则 focus('end') 触发 scrollToSelection 抛 uncaught exception（测试仍过但报错 → 全量 run 计为 failed）
beforeAll(async () => {
  const fakeRects = () =>
    [{ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }] as never;
  const fakeRect = () =>
    ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => {} }) as never;
  const TextProto = Text.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  if (typeof TextProto.getClientRects !== 'function') TextProto.getClientRects = fakeRects;
  if (typeof TextProto.getBoundingClientRect !== 'function') TextProto.getBoundingClientRect = fakeRect;
  const RangeProto = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  if (typeof RangeProto.getClientRects !== 'function') RangeProto.getClientRects = fakeRects;
  if (typeof RangeProto.getBoundingClientRect !== 'function') RangeProto.getBoundingClientRect = fakeRect;
  await initI18n('zh-CN');
});

// 绝对路径 mock squad-api（含 sidebar 用的 getSquad + page 用的全部端点）
// [v0.0.165 T5] 补 deleteSquad / getBudgetUsage（use-squad-mutations / use-seats-data 依赖）
// [v0.0.245] 补 fetchTokenStats（component-token-widget → useSquadTokenStats 挂载即拉，缺 export 抛 Uncaught）
const mocks = vi.hoisted(() => ({
  listSquads: vi.fn(),
  getSquad: vi.fn(),
  createSquad: vi.fn(),
  hireMember: vi.fn(),
  benchMember: vi.fn(),
  deployMember: vi.fn(),
  deleteSquad: vi.fn(),
  patchMember: vi.fn(),
  patchSquad: vi.fn(),
  listStudioSessions: vi.fn(),
  getBudgetUsage: vi.fn(),
  fetchTokenStats: vi.fn(),
  listSquadTemplates: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/squad-api'));
vi.mock(apiPath, () => mocks);

// chat-api mock（v0.0.33.2 Studio chat 真聊接通后，page-studio 渲染 chat 页调 getMessages 等；
// [v0.0.85 F4] onOpenChat → markReadAndClear → markSessionRead 必须mock，否则点击 chat 节点抛 TypeError）
// [v0.0.165 T5] 补 listSessions（use-seats-data 依赖，SeatsPanel 挂载即拉）
// [v0.0.216] 补 postClear/cancelEnqueue/getSessionChrome/updateSession（SectionChatSession 统一装配层依赖）
const chatMocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  postMessage: vi.fn(),
  getSummary: vi.fn(),
  postCompact: vi.fn(),
  postClear: vi.fn(),
  cancelEnqueue: vi.fn(),
  getSessionChrome: vi.fn(),
  updateSession: vi.fn(),
  markSessionRead: vi.fn(),
  listSessions: vi.fn(),
  // [v0.0.139] SectionWorkspacePanel 挂载即 watch 根（use-workspace-watch.ts），
  // chat 页渲染时会连带挂载工作区面板，缺此二 mock 会抛「No export defined」
  watchWorkspaceDir: vi.fn(),
  unwatchWorkspaceDir: vi.fn(),
}));
const chatApiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/chat-api'));
vi.mock(chatApiPath, () => chatMocks);

// [v0.0.169] api-client mock：member-create 创建页挂载 ComponentMemberSkillFilter → listSkills
// （防 jsdom 下真 fetch；其余 export 保留原样）
const apiClientPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
vi.mock(apiClientPath, async (importOriginal) => ({
  ...(await (importOriginal as () => Promise<Record<string, unknown>>)()),
  listSkills: vi.fn().mockResolvedValue([]),
}));

// [v0.0.216] mock useChatChrome（统一 chrome hook；router + SectionChatSession 共用，隔离 GET /session/:id/chrome）。
//   根据 sessionId 区分群聊（sess-group）vs 单聊（sess-leader/sess-m2）。
//   mkDetail: squadChatSessionId='sess-group', leader='sess-leader', mate='sess-m2'.
const useChromePath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../chat-page/use-chat-chrome'),
);
vi.mock(useChromePath, () => {
  const capsAllOpen = {
    runState: true, hitl: true, enqueue: true, effortPicker: true, approvalPicker: true,
    usage: true, compact: true, clear: true, minimap: true, floatMenu: true, cron: true,
    groupRender: false,
  };
  const members = [
    { id: 'leader1', name: 'Rocky', role: 'leader' },
    { id: 'm2', name: '张三', role: 'mate' },
  ];
  return {
    useChatChrome: (sessionId: string) => {
      const isGroup = sessionId === 'sess-group';
      const role = sessionId === 'sess-leader' ? 'leader' : 'mate';
      const base = {
        sessionId,
        readOnly: false,
        title: isGroup ? 'Alpha 小队' : role === 'leader' ? 'Rocky' : '张三',
        titled: true,
        sessionModel: null,
        defaultModel: null,
        effort: null,
        approvalMode: null,
        members,
      };
      return {
        chrome: isGroup
          ? {
              ...base, kind: 'studio_group', tag: 'Alpha 小队 · 群聊', memberId: null,
              capabilities: {
                ...capsAllOpen,
                runState: false, enqueue: false, effortPicker: false, approvalPicker: false, cron: false,
                groupRender: true,
              },
            }
          : {
              ...base, kind: 'studio_member', tag: `Alpha 小队 · ${role}`,
              memberId: role === 'leader' ? 'leader1' : 'm2',
              capabilities: capsAllOpen,
            },
        loading: false,
        error: null,
        setEffort: vi.fn(),
        setApprovalMode: vi.fn(),
        setModel: vi.fn(),
      };
    },
  };
});

// mock panorama-api + sse-singleton：业务全景「更多」tab 引导按钮（onAtLeader handler 测试）。
//   SeatsPanel 第二栏 PanoramaRoute 挂载即拉 schema；schema 到位后渲「更多」tab → PanoramaIdle 按钮。
//   sse-singleton mock 必须返 Promise-returning unsubscribe（use-lifecycle unsubscribeAll 调 .catch 在其上）。
const panoramaMocks = vi.hoisted(() => ({
  getPanoramaSchema: vi.fn(),
  subscribe: vi.fn(),
}));
const panoramaApiPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/panorama-api'),
);
vi.mock(panoramaApiPath, () => ({
  getPanoramaSchema: panoramaMocks.getPanoramaSchema,
  listPanoramaEntities: vi.fn().mockResolvedValue([]),
  listPanoramaEvents: vi.fn().mockResolvedValue([]),
}));
const sseSingletonPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/sse-singleton'),
);
vi.mock(sseSingletonPath, () => ({
  // unsubscribe 必须返 Promise（use-lifecycle unsubscribeAll: h.unsubscribe().catch(...)）
  getSseClient: () => ({
    subscribe: panoramaMocks.subscribe,
  }),
}));

/** 构造 mock subscribe 返回值（unsubscribe 返 resolved Promise 满足 use-lifecycle 契约） */
function makeSubHandle() {
  return {
    subId: 'x',
    topic: 'panorama',
    group: 'g',
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };
}

// task-only DSL：后端 ensureSystemEntities 后的首访问 squad 真实返回（views 首项 = task_kanban）
const TASK_ONLY_DSL = `
meta:
  version: '1.0'
entities:
  task:
    system: true
    label: 任务
    id_field: id
    fields:
      id: { type: string, required: true, label: ID }
      title: { type: string, required: true, max: 200, label: 标题 }
      status: { type: enum, values: [todo, in_progress, done], required: true, label: 状态 }
views:
  - id: task_kanban
    label: 任务
    entity: task
    component: kanban
    group_by: status
    columns: [todo, in_progress, done]
    card: { title: '{title}', badges: [status] }
`;

import { PageStudio } from '../page-studio';

// —— 语义定位辅助（产品代码 data-testid 已移除，全改 role/text/aria-label） —— //
/** 左 sidebar 根容器（<aside>） */
const sidebarOf = (container: HTMLElement) => container.querySelector('aside') as HTMLElement;
/** 侧栏新建 squad 按钮（aria-label「新建 squad」；限定 sidebar 内，避开空态同名按钮） */
const newSquadBtn = () =>
  within(screen.getByRole('complementary')).getByRole('button', { name: '新建 squad' });
/** SeatsPanel 落地信号：首页 tab「自动工作」唯一存在于 SeatsPanel header */
const seatsPanelSignal = () => screen.findByRole('button', { name: '自动工作' });
/** SeatsPanel 缺席（切到 member-create/chat 后首页 tab 消失） */
const seatsPanelAbsent = () => screen.queryByRole('button', { name: '自动工作' });
/** mate（张三）坐席行（v0.0.288：MemberRosterList 的 PanelRowView，data-testid=squad-status-row-{id}） */
function mateEnterBtn(): HTMLElement {
  return screen.getByTestId('squad-status-row-m2');
}
/** 单聊页加载完成信号：topbar tag（chrome mock 给 mate 固定 tag） */
const mateChatSignal = () => screen.findByText('Alpha 小队 · mate');
/** 单聊顶栏角色头像容器（member 名 span 的父 div） */
const roleAvatar = () => screen.getByText('张三').parentElement as HTMLElement;

describe('PageStudio', () => {
  beforeEach(() => {
    // [v0.0.139] mock 配置须先于 cleanup()：cleanup() 会 flush 上一个 test 遗留渲染树的
    // unmount 副作用（SectionWorkspacePanel 卸载 → unwatchWorkspaceDir），若先 cleanup 再配置，
    // 该调用会打在刚被 afterEach mockReset() 清空实现的裸 vi.fn() 上（返回 undefined，
    // .catch is not a function 崩溃）。
    mocks.listSquads.mockResolvedValue([mkSummary()]);
    mocks.listSquadTemplates.mockResolvedValue([]);
    mocks.getSquad.mockResolvedValue(mkDetail());
    mocks.createSquad.mockResolvedValue(mkDetail({ id: 's2', name: 'Gamma 小队' }));
    chatMocks.getMessages.mockResolvedValue({ items: [], hasMore: false });
    chatMocks.postMessage.mockResolvedValue({ runId: 'r1' });
    chatMocks.getSummary.mockResolvedValue({ summary: null });
    chatMocks.postCompact.mockResolvedValue({ ok: true });
    // [v0.0.85 F4] markSessionRead 默认成功（fire-and-forget POST /read）
    chatMocks.markSessionRead.mockResolvedValue({ session: { unread: false } });
    // [v0.0.139] watch/unwatch 默认成功（fire-and-forget，SectionWorkspacePanel 挂载即调）
    chatMocks.watchWorkspaceDir.mockResolvedValue({ ok: true });
    chatMocks.unwatchWorkspaceDir.mockResolvedValue({ ok: true });
    // [v0.0.165 T5] listSessions（use-seats-data 一次拉全量）+ getBudgetUsage（未配 budget）
    chatMocks.listSessions.mockResolvedValue([]);
    mocks.getBudgetUsage.mockResolvedValue({
      squadId: 's1', limit: -1, window: 'daily', consumed: 0, remaining: -1,
      windowStart: '', windowEnd: '', perSession: [], timezone: 'UTC',
    });
    // [v0.0.245] fetchTokenStats：TokenWidget 挂载即拉 team/近60天空序列（空态不触发下游错；
    //   deriveWidgetData 对 series ?? [] 容错，today=null/daily7=[]/cumulative=0）
    mocks.fetchTokenStats.mockResolvedValue({
      squadId: 's1', granularity: 'day', scope: 'team',
      from: '', to: '', timezone: 'UTC', series: [],
    });
    // panorama：schema 返 task-only DSL + SSE subscribe 默认成功（PanoramaRoute 挂载即拉）
    panoramaMocks.getPanoramaSchema.mockResolvedValue(TASK_ONLY_DSL);
    panoramaMocks.subscribe.mockResolvedValue(makeSubHandle());
    cleanup();
  });
  afterEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    for (const fn of Object.values(chatMocks)) fn.mockReset();
    // [v0.0.139] watch/unwatch 在 reset 后仍需默认可用实现：@testing-library/react 的全局
    // auto-cleanup（import 时自注册的 afterEach(cleanup)）晚于本文件 afterEach 触发，会在
    // mockReset() 之后才 unmount 遗留渲染树 → 调用刚被清空实现的裸 vi.fn()（undefined.catch 崩溃）。
    chatMocks.watchWorkspaceDir.mockResolvedValue({ ok: true });
    chatMocks.unwatchWorkspaceDir.mockResolvedValue({ ok: true });
    // panorama subscribe 同理：auto-cleanup 触发的 unmount 会调 unsubscribe，
    //   reset 后需默认可用实现避免 .catch(undefined) 崩溃
    panoramaMocks.subscribe.mockResolvedValue(makeSubHandle());
    // [bugfix 2026-08-15] 清 pin 状态：置顶用例写入 localStorage，防跨用例污染默认选中断言
    localStorage.removeItem('studio.squadPins');
  });

  it('挂载 → sidebar 渲染 squad 列表 + 新建按钮；自动选中第一个 → 落坐席面板（v0.0.165 T5 IA D7）', async () => {
    const { container } = render(<PageStudio />);
    expect(sidebarOf(container)).toBeTruthy();
    expect(newSquadBtn()).toBeTruthy();
    // 列表项（异步加载）
    expect(await screen.findByRole('button', { name: /Alpha 小队/ })).toBeTruthy();
    // [v0.0.165 T5] 自动选中第一个 → 坐席面板（selectSquad 默认落 'seats'，不再是 SquadPanel/studio-main）
    expect(await seatsPanelSignal()).toBeTruthy();
  });

  it('挂载默认选中=sidebar 视觉第一行（置顶优先，非 API 首位；bugfix 2026-08-15）', async () => {
    // API 序 [Beta(updatedAt 最新), Alpha]；Alpha 置顶 → sortSquads 视觉第一行=Alpha
    mocks.listSquads.mockResolvedValue([
      mkSummary({ id: 's2', name: 'Beta 小队', updatedAt: '2026-07-01T00:00:00.000Z' }),
      mkSummary(), // s1 Alpha（updatedAt 较旧，但被 pin）
    ]);
    localStorage.setItem('studio.squadPins', JSON.stringify(['s1']));
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Beta 小队/ });
    // 默认选中应取排序后第一个（置顶 s1），而非 API 原始序 list[0]（s2）
    await waitFor(() => expect(mocks.getSquad).toHaveBeenCalledWith('s1'));
    expect(mocks.getSquad).not.toHaveBeenCalledWith('s2');
  });

  it('点新建按钮 → 打开 new-squad wizard', async () => {
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    fireEvent.click(newSquadBtn());
    expect(screen.getByText('新建 squad')).toBeTruthy();
  });

  it('wizard 填字段提交 → 调 createSquad（POST /squad）', async () => {
    // v0.0.36：wizard 的 modelDefault 换成 ModelPicker，经 useProviders → fetch /provider 拉模型
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'pA', label: 'Provider A', models: [{ modelId: 'a-1', label: 'A-1' }] }] }),
    }) as unknown as typeof fetch;
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    fireEvent.click(newSquadBtn());
    fireEvent.change(screen.getByPlaceholderText('如：Gamma 小队'), { target: { value: 'Gamma 小队' } });
    // modelDefault 必填 → 经 ModelPicker 下拉选模型（leader.systemPrompt 输入框已删）
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    fireEvent.click(await screen.findByText('Provider A / A-1'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(mocks.createSquad).toHaveBeenCalledTimes(1));
    expect(mocks.createSquad.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ name: 'Gamma 小队', modelDefault: 'a-1', leader: { name: 'Rocky' } }),
    );
  });

  it('v0.0.168：侧栏无展开树 —— 点 squad 行落首页 seats；无 squad-tree-* 节点', async () => {
    const { container } = render(<PageStudio />);
    const row = await screen.findByRole('button', { name: /Alpha 小队/ });
    fireEvent.click(row);
    // 落 seats 首页（无展开树，chat 入口迁首页）
    expect(await seatsPanelSignal()).toBeTruthy();
    // 树节点族 grep 归零：侧栏内仅「新建按钮 + squad 行 + pin 按钮」三个 button，无任何展开树子节点
    // [v0.0.305] pin 按钮 hover 显隐（visibility 占位），getAllByRole 能查到
    expect(within(sidebarOf(container)).getAllByRole('button')).toHaveLength(3);
  });

  it('首页坐席卡「进入对话」→ 真聊页（chat 入口收敛到首页）', async () => {
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    // 等坐席面板渲染完（use-seats-data 拉 listSessions 后坐席行才出现），点 mate（张三）行「进入对话」
    await screen.findByText('张三');
    fireEvent.click(mateEnterBtn());
    // 单聊页加载完成（topbar tag）+ 角色头像（保留为纯身份展示）
    expect(await mateChatSignal()).toBeTruthy();
    const avatar = roleAvatar();
    expect(avatar).toBeTruthy();
    // v0.0.168：单聊头像 = div（不可点，无 onClick 上抛 member panel）
    expect(avatar.tagName).toBe('DIV');
    // 点头像不进 member 面板（唯一入口 = 坐席卡菜单编辑）
    fireEvent.click(avatar);
    expect(screen.queryByText('姓名 / 介绍')).toBeNull();
    // 且仍在 chat 页
    expect(screen.getByText('Alpha 小队 · mate')).toBeTruthy();
  });

  it('v0.0.169：seat-add-card → 主区 member-create 创建页（非 hire 弹层）；返回回 seats', async () => {
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    // 等坐席网格渲染完，点「+ 新增成员」按钮
    const addCard = await screen.findByRole('button', { name: '新增成员' });
    fireEvent.click(addCard);
    // 主区切 member-create 创建页；无 hire 弹层（dialog 缺席）
    expect(await screen.findByText('新建成员')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fresh · 新建' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(seatsPanelAbsent()).toBeNull();
    // 返回 → 回首页 seats
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(await seatsPanelSignal()).toBeTruthy();
    expect(screen.queryByText('新建成员')).toBeNull();
  });

  it('[v0.0.276] chat 返回 seats → reloadDetail 重拉 detail（getSquad 次数 +1）', async () => {
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    await screen.findByText('张三');
    const before = mocks.getSquad.mock.calls.length;
    fireEvent.click(mateEnterBtn());
    expect(await mateChatSignal()).toBeTruthy();
    // chat-topbar 返回键（common:action.back「返回」）→ 回 seats
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(await seatsPanelSignal()).toBeTruthy();
    // handleChatBack 触发 reloadDetail → getSquad 至少 +1（宽松口径防 R4 mutation 双拉误报）
    expect(mocks.getSquad.mock.calls.length).toBeGreaterThanOrEqual(before + 1);
  });

  it('[v0.0.276] member-create 返回 seats → reloadDetail 重拉 detail（getSquad 次数 +1）', async () => {
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    const addCard = await screen.findByRole('button', { name: '新增成员' });
    const before = mocks.getSquad.mock.calls.length;
    fireEvent.click(addCard);
    expect(await screen.findByText('新建成员')).toBeTruthy();
    // member-create 返回 → 回 seats（fallbackToSeats 触发 reloadDetail）
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(await seatsPanelSignal()).toBeTruthy();
    expect(mocks.getSquad.mock.calls.length).toBeGreaterThanOrEqual(before + 1);
  });

  it('业务全景「更多」tab「找 leader 搭看板」→ 切 leader 单聊 + composer 预填模板文本（非群聊/非 mention）', async () => {
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    await seatsPanelSignal();
    // 点「更多」固定 tab（v0.0.288 全景在 SeatsBody 右列，无 panorama-section 包裹；直接 screen 定位）
    // schema 拉回后 panorama tabs 才渲染，用 findByRole 等待
    const moreTab = await screen.findByRole('button', { name: '更多' });
    fireEvent.click(moreTab);
    const idleBtn = await screen.findByRole('button', { name: '找 leader 搭看板' });
    fireEvent.click(idleBtn);
    // 主区切 leader 单聊：topbar tag 是「Alpha 小队 · leader」（chrome mock by sessionId='sess-leader'）
    //   非群聊（群聊 tag =「Alpha 小队 · 群聊」，对应 squadChatSessionId='sess-group'）
    expect(await screen.findByText('Alpha 小队 · leader')).toBeTruthy();
    expect(screen.queryByText('Alpha 小队 · 群聊')).toBeNull();
    // composer 预填了模板文本（mount-time queueMicrotask 注入；轮询 5s 上限）
    const editor = await waitForPanoramaPrefill(document.body, '帮我搭建一个看板，展示…');
    expect(editor).not.toBeNull();
    // 不渲染任何 mention pill（纯文本分支）
    expect(document.body.querySelectorAll('[data-mention-icon]').length).toBe(0);
  });

  it('squad 无 leader 场景点「找 leader 搭看板」→ toast noLeaderAvailable，不切 chat', async () => {
    // 重写 detail：去掉 leader member（仅 mate）
    mocks.getSquad.mockResolvedValue(
      mkDetail({
        members: [mkMember({ id: 'm2', name: '张三', role: 'mate', sessionId: 'sess-m2' })],
        leaderId: '',
      }),
    );
    render(<PageStudio />);
    await screen.findByRole('button', { name: /Alpha 小队/ });
    await seatsPanelSignal();
    // v0.0.288 全景在 SeatsBody 右列，无 panorama-section 包裹；直接 screen 定位
    const moreTab = await screen.findByRole('button', { name: '更多' });
    fireEvent.click(moreTab);
    const idleBtn = await screen.findByRole('button', { name: '找 leader 搭看板' });
    fireEvent.click(idleBtn);
    // toast noLeaderAvailable（zh-CN 文案）出现
    expect(await screen.findByText('当前 squad 暂无 leader，无法跳转对话')).toBeTruthy();
    // 未切 chat：群聊/单聊 tag 均缺席（仍在 PanoramaIdle 引导页）
    expect(screen.queryByText('Alpha 小队 · leader')).toBeNull();
    expect(screen.queryByText('Alpha 小队 · 群聊')).toBeNull();
  });
});

/**
 * 等待 composer 预填文本出现（onAtLeader → leader 单聊 + prefill string）。
 * useChatChrome 已 mock 为同步返 chrome（loading=false）→ SectionChatSession 立即挂 ChatComposer；
 * prefill 经 mount-time queueMicrotask → injectInitialContent → insertContent 注成 text node。
 */
async function waitForPanoramaPrefill(scope: ParentNode, expected: string): Promise<HTMLElement | null> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const editor = scope.querySelector<HTMLElement>('.ProseMirror');
    if (editor && (editor.textContent ?? '').includes(expected)) return editor;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
