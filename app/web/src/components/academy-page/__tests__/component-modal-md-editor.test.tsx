/**
 * @vitest-environment jsdom
 * component-modal-md-editor 单测 —— md 查看/编辑弹层
 * 参考: specs/ui/components/academy-page/component-modal-md-editor.md
 *       specs/ui/components/_conventions.md §13（L3 modal 不变式：Portal + pointer-events-auto）
 *
 * 覆盖：
 * - 防回归（核心）：Portal 根 div className 必须含 pointer-events-auto。
 *   overlay-root 容器是 pointer-events:none 且该属性可继承——漏写则整棵子树不接事件、
 *   所有按钮 click 全穿透（仅 ESC 可关）。jsdom 不做 hit-testing，click 断言抓不到此类 bug，
 *   必须直接断 className。
 * - view/edit 切换行为：默认 view 渲染 markdown；切 edit 出 textarea + 保存按钮；切回 view 收起。
 * - readOnly 隐藏切换段与保存；关闭按钮回调 onClose。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentModalMdEditor } from '../../common/component-modal-md-editor';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 默认 props（各 case 按需覆盖） */
function renderModal(overrides: Partial<Parameters<typeof ComponentModalMdEditor>[0]> = {}) {
  const onClose = vi.fn();
  const props = {
    open: true,
    fileName: 'AGENTS.md',
    subtitle: '小红书文案 · v2.0 · system prompt',
    initialValue: '# 标题\n\n正文一段',
    versionLabel: 'v2.0',
    onClose,
    ...overrides,
  };
  render(<ComponentModalMdEditor {...props} />);
  return { onClose };
}

/** Portal 根 div（挂在 overlay-root 下，不在 render container 内） */
function overlayRootDiv(): HTMLElement {
  const el = document.querySelector('#overlay-root > div') as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe('ComponentModalMdEditor — L3 modal 不变式（防回归）', () => {
  it('Portal 根 div className 含 pointer-events-auto（缺失 → 全弹层按钮不可点）', () => {
    renderModal();
    const root = overlayRootDiv();
    expect(root.className).toContain('pointer-events-auto');
    // 同时确认它就是 z-modal 遮罩层本体（避免误断到别的节点）
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('z-[var(--z-modal)]');
  });

  it('overlay-root 容器自身仍是 pointer-events:none（不做结构性加固，保持 invariant 显式）', () => {
    renderModal();
    const container = document.getElementById('overlay-root')!;
    expect(container.style.pointerEvents).toBe('none');
  });
});

describe('ComponentModalMdEditor — view/edit 切换', () => {
  it('open=false → 不渲染', () => {
    renderModal({ open: false });
    expect(document.querySelector('#overlay-root > div')).toBeNull();
  });

  it('默认 view 模式：渲染 markdown、无 textarea、无保存按钮', () => {
    renderModal();
    expect(screen.getByRole('button', { name: '👁 查看' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('点「✏️ 编辑」→ 切 edit：textarea 带原文 + 保存按钮出现', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    expect(screen.getByRole('button', { name: '✏️ 编辑' }).getAttribute('aria-pressed')).toBe('true');
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe('# 标题\n\n正文一段');
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('edit → 点「👁 查看」切回：textarea 收起、保存按钮消失', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '👁 查看' }));
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('edit 改文本后保存 → onSave 收到草稿，成功后回到 view 模式', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    renderModal({ onSave });
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '改后正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith('改后正文');
    // 等待 onSave promise resolve 后的 setMode('view')
    await screen.findByRole('button', { name: '✏️ 编辑' });
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('readOnly → 无 view/edit 切换段、无保存按钮', () => {
    renderModal({ readOnly: true });
    expect(screen.queryByRole('button', { name: '✏️ 编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '👁 查看' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });
});

describe('ComponentModalMdEditor — 关闭路径', () => {
  it('点 head ✕ → onClose', () => {
    const { onClose } = renderModal();
    // head ✕ 与 foot「关闭」可访问名同为「关闭」，按 textContent 区分
    const headClose = screen.getAllByRole('button', { name: '关闭' }).find((b) => b.textContent === '✕')!;
    fireEvent.click(headClose);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点 foot「关闭」→ onClose', () => {
    const { onClose } = renderModal();
    const footClose = screen.getAllByRole('button', { name: '关闭' }).find((b) => b.textContent === '关闭')!;
    fireEvent.click(footClose);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点遮罩不关闭（防误丢输入）；点 dialog 内部同样不关', () => {
    const { onClose } = renderModal();
    fireEvent.click(overlayRootDiv());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ESC → onClose', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * v0.0.241 多格式扩展（format Props + view 分流 + 格式按钮 + hint 状态机）
 * 参考: specs/prd/version_logs/v0.0.241.md §2-3 + 8 UC
 *
 * 注意：Bun vs V8 差异（context findings coder T1）：Bun JSON.parse 错误 message 无 position，
 * 故 validateJson 在 Bun UT 下 line/col=undefined（走 validateFail 非 validateFailLine）。
 * 测试断言只验「错误 hint 显示」（msg 非空），不断言具体行号。
 */
describe('ComponentModalMdEditor — v0.0.241 format 分流', () => {
  it("format 缺省 → 'md' → view 走 PrimitiveMarkdownView（academy 回归保护）", () => {
    // 不传 format → 缺省 'md' → markdown 渲染（h1）+ 不渲染 <pre>
    renderModal();
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy();
    expect(document.querySelector('pre')).toBeNull();
  });

  it("format='json' → view 走 <pre> 朴素预览（不渲染 markdown）", () => {
    renderModal({ format: 'json', initialValue: '{\n  "k": "v"\n}' });
    const pre = document.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toBe('{\n  "k": "v"\n}');
    // md 渲染会生成 h1/h2 等；structured 走 pre 不应渲染 heading
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it("format='json' edit 模式 → 显示「格式化」「校验」按钮（structured 类，无 invisible）", () => {
    renderModal({ format: 'json', initialValue: '{}' });
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    const fmtBtn = screen.getByRole('button', { name: '格式化' });
    const valBtn = screen.getByRole('button', { name: '校验' });
    expect(fmtBtn).toBeTruthy();
    expect(valBtn).toBeTruthy();
    // structured → 按钮可见（className 不含 invisible）
    expect(fmtBtn.className).not.toContain('invisible');
    expect(valBtn.className).not.toContain('invisible');
  });

  it("format='txt' edit 模式 → 格式按钮存在但 invisible 占位（UC-241-PLAIN 布局稳定）", () => {
    renderModal({ format: 'txt', initialValue: 'hello' });
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    // 按钮存在（保布局占位，禁 display:none + 条件渲染致位移）但 invisible
    const fmtBtn = screen.getByRole('button', { name: '格式化' });
    const valBtn = screen.getByRole('button', { name: '校验' });
    expect(fmtBtn.className).toContain('invisible');
    expect(valBtn.className).toContain('invisible');
  });

  it('view 模式不渲染格式按钮（UC-241-VIEW-RO 只读）', () => {
    // structured + view 模式：格式按钮完全不渲染
    renderModal({ format: 'json', initialValue: '{}' });
    expect(screen.queryByRole('button', { name: '格式化' })).toBeNull();
    expect(screen.queryByRole('button', { name: '校验' })).toBeNull();
  });

  it('handleFormat 失败不动 draft + 显 formatFail 文案（UC-241-JSON-FULL 关键不变量）', () => {
    // 喂坏 JSON：格式化应失败 → textarea 内容保留 + hint 显「格式错误，无法格式化」
    renderModal({ format: 'json', initialValue: '{bad json' });
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    const before = (document.querySelector('textarea') as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole('button', { name: '格式化' }));
    // 关键不变量：解析失败不可格式化，防洗空坏内容（PRD §3.1）
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(before);
    expect(screen.getByText('格式错误，无法格式化')).toBeTruthy();
  });

  it('校验失败仍可保存（UC-241-SAVE-INVALID：last-write-wins 不阻塞）', () => {
    const onSave = vi.fn(() => Promise.resolve());
    renderModal({ format: 'json', initialValue: '{bad json', onSave });
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '校验' }));
    // 校验失败后保存仍被调用（不阻塞，原文本传入）
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith('{bad json');
  });

  it('handleFormat 成功替换 draft + 显「✓ 格式正确」（pretty 反馈）', () => {
    // 紧凑 JSON → 2 空格缩进 pretty（V8/Bun JSON.stringify 行为一致）
    renderModal({ format: 'json', initialValue: '{"a":1,"b":2}' });
    fireEvent.click(screen.getByRole('button', { name: '✏️ 编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '格式化' }));
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(screen.getByText('✓ 格式正确')).toBeTruthy();
  });
});
