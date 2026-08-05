/**
 * @vitest-environment jsdom
 * ComponentSkillItem 单测（[v0.0.55] 双开关：enabled + evolvable）
 * 参考: specs/ui/components/skill-page/component-skill-item.md
 *       specs/api/overall/06a-skill-governance.md v2.0（evolvable 契约）
 *
 * 覆盖 [v0.0.55] 双 toggle：
 *  - 渲染 enabled toggle + evolvable toggle（role=switch，aria-label 区分）
 *  - 点 evolvable toggle → 触发 onToggleEvolvable 回调（父 page 调 PATCH /skill/:name/governance）
 *  - evolvable 状态从 skill.evolvable 正确渲染（undefined → false 兜底）
 *  - 点 enabled toggle 仍触发 onToggle（不破坏原有）
 *
 * 本组件 UT 不 mock api-client（受控组件，回调透传），由父 page-skill 实际发 fetch；
 * fetch 路径在 page-skill 集成测试中验证（本文件聚焦 component 层契约）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentSkillItem } from '../skill-page/component-skill-item';
import type { SkillEntry } from '../../lib/api-client';
import { initI18n } from '../../i18n';

// toggle aria-label 走 i18n（skill ns）
beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 构造测试用 SkillEntry */
function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: 'code-review',
    description: '审查 diff 找正确性 bug + 简化清理',
    scope: 'app',
    skillDir: '/tmp/skills/code-review',
    enabled: true,
    evolvable: false,
    ...overrides,
  };
}

/** enabled toggle（aria-label = 「{name} 启用 / 禁用」） */
function getEnabledToggle() {
  return screen.getByRole('switch', { name: 'code-review 启用 / 禁用' });
}

/** evolvable toggle（aria-label = 「{name} 自进化 开 / 关」） */
function getEvolvableToggle() {
  return screen.getByRole('switch', { name: 'code-review 自进化 开 / 关' });
}

describe('ComponentSkillItem（[v0.0.55] 双开关：enabled + evolvable）', () => {
  it('渲染卡根 + 两 toggle（enabled toggle 与 evolvable toggle 都存在）', () => {
    render(
      <ComponentSkillItem
        skill={makeSkill()}
        onToggle={() => {}}
        onToggleEvolvable={() => {}}
        onPreview={() => {}}
        onDelete={() => {}}
      />,
    );
    // 卡根渲染 name
    expect(screen.getByText('code-review')).toBeTruthy();
    // enabled toggle（原有）
    expect(getEnabledToggle()).toBeTruthy();
    // [v0.0.55] evolvable toggle（新增）
    expect(getEvolvableToggle()).toBeTruthy();
  });

  it('evolvable=true 时 evolvable toggle 的 aria-checked=true（状态从 skill data 正确渲染）', () => {
    render(
      <ComponentSkillItem
        skill={makeSkill({ evolvable: true })}
        onToggle={() => {}}
        onToggleEvolvable={() => {}}
        onPreview={() => {}}
        onDelete={() => {}}
      />,
    );
    const evolvableSwitch = getEvolvableToggle();
    expect(evolvableSwitch.getAttribute('aria-checked')).toBe('true');
    // data-enabled 同步（primitive-toggle-switch 内部设定）
    expect(evolvableSwitch.getAttribute('data-enabled')).toBe('true');
  });

  it('evolvable=false 时 evolvable toggle 的 aria-checked=false', () => {
    render(
      <ComponentSkillItem
        skill={makeSkill({ evolvable: false })}
        onToggle={() => {}}
        onToggleEvolvable={() => {}}
        onPreview={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(getEvolvableToggle().getAttribute('aria-checked')).toBe('false');
  });

  it('evolvable 字段缺失时兜底为 false（与 server frontmatter 默认一致）', () => {
    render(
      <ComponentSkillItem
        skill={makeSkill({ evolvable: undefined })}
        onToggle={() => {}}
        onToggleEvolvable={() => {}}
        onPreview={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(getEvolvableToggle().getAttribute('aria-checked')).toBe('false');
  });

  it('点 evolvable toggle → 触发 onToggleEvolvable 回调（参数 = skill.name）', () => {
    const onToggleEvolvable = vi.fn();
    render(
      <ComponentSkillItem
        skill={makeSkill({ evolvable: false })}
        onToggle={() => {}}
        onToggleEvolvable={onToggleEvolvable}
        onPreview={() => {}}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(getEvolvableToggle());
    expect(onToggleEvolvable).toHaveBeenCalledTimes(1);
    expect(onToggleEvolvable).toHaveBeenCalledWith('code-review');
  });

  it('点 enabled toggle → 触发 onToggle 回调（原有行为不破坏）', () => {
    const onToggle = vi.fn();
    render(
      <ComponentSkillItem
        skill={makeSkill()}
        onToggle={onToggle}
        onToggleEvolvable={() => {}}
        onPreview={() => {}}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(getEnabledToggle());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('code-review');
  });

  it('两 toggle 互相独立：点 enabled 不触发 evolvable，反之亦然', () => {
    const onToggle = vi.fn();
    const onToggleEvolvable = vi.fn();
    render(
      <ComponentSkillItem
        skill={makeSkill()}
        onToggle={onToggle}
        onToggleEvolvable={onToggleEvolvable}
        onPreview={() => {}}
        onDelete={() => {}}
      />,
    );
    // 点 enabled toggle 只触发 onToggle
    fireEvent.click(getEnabledToggle());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggleEvolvable).not.toHaveBeenCalled();
    // 点 evolvable toggle 只触发 onToggleEvolvable
    fireEvent.click(getEvolvableToggle());
    expect(onToggleEvolvable).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1); // 仍只 1 次，未被 evolvable click 再触发
  });
});

/**
 * 集成层验证：page-skill 的 handleToggleEvolvable 调 patchSkillEvolvable 发 PATCH governance。
 * 此处单独验证 fetch 调用契约（mock global fetch，断言 URL + body），
 * 不渲染整个 PageSkill（避免 listSkills/install 等额外 fetch 噪音）。
 */
describe('page-skill handleToggleEvolvable → PATCH /skill/:name/governance 集成契约', () => {
  it('patchSkillEvolvable 发 PATCH governance：URL=/skill/<name>/governance + body 含 {scope, evolvable}', async () => {
    // 模拟 200 OK 响应（SkillEntry）
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ skill: makeSkill({ evolvable: true }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    // 动态 import 避免在文件顶部拉入整个 api-client 模块依赖
    const { patchSkillEvolvable } = await import('../../lib/api-client');
    await patchSkillEvolvable('code-review', true, { scope: 'app' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // URL 形态：含 /skill/code-review/governance（base 前缀由 resolveApiBase 处理）
    expect(url).toContain('/skill/code-review/governance');
    // method = PATCH
    expect(init.method).toBe('PATCH');
    // body 含 scope + evolvable（不传 workspace）
    const body = JSON.parse(init.body as string);
    expect(body.scope).toBe('app');
    expect(body.evolvable).toBe(true);
    expect(body.workspace).toBeUndefined();
    // 不得包含 evolvable 之外的治理元字段（如 mutableLocked，v0.0.55 已删维度）
    expect(body.mutableLocked).toBeUndefined();
    expect(body.mutable).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('patchSkillEvolvable scope=workspace 时 body 含 workspace', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ skill: makeSkill({ scope: 'workspace', evolvable: false }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { patchSkillEvolvable } = await import('../../lib/api-client');
    await patchSkillEvolvable('my-ws-skill', false, {
      scope: 'workspace',
      workspace: '/abs/path/to/ws',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.scope).toBe('workspace');
    expect(body.workspace).toBe('/abs/path/to/ws');
    expect(body.evolvable).toBe(false);

    vi.unstubAllGlobals();
  });
});
