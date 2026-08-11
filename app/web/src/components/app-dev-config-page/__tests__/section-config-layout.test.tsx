/**
 * @vitest-environment jsdom
 * section-config-layout 单测：三栏渲染 + group 切换 + 配置区默认/自定义分发 + 脏态/保存条
 * 参考: specs/ui/components/app-dev-config-page/section-config-layout.md
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SectionConfigLayout, type GroupInfo } from '../section-config-layout';
import type { KeyInfo } from '../component-key-card';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：group-save-bar 用 useTranslation('common')，group label 走 app-dev-config ns
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('SectionConfigLayout', () => {
  afterEach(() => cleanup());

  const groups: GroupInfo[] = [
    {
      groupId: 'appearance',
      keys: [
        { key: 'theme', type: 'enum' as const, value: 'dark', options: ['dark', 'light'] },
      ] as KeyInfo[],
    },
    {
      groupId: 'llm_request',
      keys: [
        { key: 'stall_timeout_s', type: 'number' as const, value: 30 },
        { key: 'max_retry_times', type: 'number' as const, value: 3 },
      ] as KeyInfo[],
    },
  ];

  it('渲染 group 列表项 + 配置区', () => {
    render(
      <SectionConfigLayout
        groups={groups}
        selectedGroup="llm_request"
        onSelectGroup={() => {}}
        onSaveGroup={() => {}}
        onKeyChange={() => {}}
        dirtyOf={() => false}
        savingOf={() => false}
      />,
    );
    expect(screen.getByRole('button', { name: '外观' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'LLM 请求' })).toBeTruthy();
    // 配置区渲染当前 group 的 key label
    expect(screen.getByText('stall_timeout_s')).toBeTruthy();
  });

  it('选中项 data-active=true，其他 false；点其他项触发 onSelectGroup', () => {
    const onSelect = vi.fn();
    render(
      <SectionConfigLayout
        groups={groups}
        selectedGroup="appearance"
        onSelectGroup={onSelect}
        onSaveGroup={() => {}}
        onKeyChange={() => {}}
        dirtyOf={() => false}
        savingOf={() => false}
      />,
    );
    expect(screen.getByRole('button', { name: '外观' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'LLM 请求' }).getAttribute('data-active')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'LLM 请求' }));
    expect(onSelect).toHaveBeenCalledWith('llm_request');
  });

  it('默认渲染 KV key-card 网格：当前 group 的每 key 一张卡', () => {
    render(
      <SectionConfigLayout
        groups={groups}
        selectedGroup="llm_request"
        onSelectGroup={() => {}}
        onSaveGroup={() => {}}
        onKeyChange={() => {}}
        dirtyOf={() => false}
        savingOf={() => false}
      />,
    );
    expect(screen.getByText('stall_timeout_s')).toBeTruthy();
    expect(screen.getByText('max_retry_times')).toBeTruthy();
    // 非当前 group 的 key 不渲染
    expect(screen.queryByText('theme')).toBeNull();
  });

  it('编辑 key 触发 onKeyChange(groupId, key, next)', () => {
    const onKeyChange = vi.fn();
    render(
      <SectionConfigLayout
        groups={groups}
        selectedGroup="llm_request"
        onSelectGroup={() => {}}
        onSaveGroup={() => {}}
        onKeyChange={onKeyChange}
        dirtyOf={() => false}
        savingOf={() => false}
      />,
    );
    // 两个 number input（stall_timeout_s=30, max_retry_times=3），按值定位第一个
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    const stallInput = inputs.find((i) => i.value === '30')!;
    fireEvent.change(stallInput, { target: { value: '45' } });
    expect(onKeyChange).toHaveBeenCalledWith('llm_request', 'stall_timeout_s', 45);
  });

  it('[v0.0.317] GroupSaveBar 已废弃 → group 底部不渲染保存条', () => {
    const onSave = vi.fn();
    render(
      <SectionConfigLayout
        groups={groups}
        selectedGroup="llm_request"
        onSelectGroup={() => {}}
        onSaveGroup={onSave}
        onKeyChange={() => {}}
        dirtyOf={(g) => g === 'llm_request'}
        savingOf={() => false}
      />,
    );
    // group 底部不再有保存条（saveMode='group' 的 save bar 已废弃，统一走 tab 级 SaveBar）
    expect(screen.queryByRole('button', { name: '● 保存' })).toBeNull();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('[v0.0.317] GroupSaveBar 已废弃 → saving 状态不影响渲染（无保存条）', () => {
    render(
      <SectionConfigLayout
        groups={groups}
        selectedGroup="llm_request"
        onSelectGroup={() => {}}
        onSaveGroup={() => {}}
        onKeyChange={() => {}}
        dirtyOf={() => true}
        savingOf={(g) => g === 'llm_request'}
      />,
    );
    // group 底部不再有保存条（含 saving 态）
    expect(screen.queryByRole('button', { name: '保存中…' })).toBeNull();
  });

  it('renderGroupArea 注入自定义节点（替代默认 KV 网格）', () => {
    render(
      <SectionConfigLayout
        groups={[{ groupId: 'providers', keys: [] }]}
        selectedGroup="providers"
        onSelectGroup={() => {}}
        onSaveGroup={() => {}}
        onKeyChange={() => {}}
        dirtyOf={() => false}
        savingOf={() => false}
        renderGroupArea={(g) =>
          g.groupId === 'providers' ? <div>providers</div> : undefined
        }
      />,
    );
    expect(screen.getByText('providers')).toBeTruthy();
  });
});
