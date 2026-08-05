/**
 * section-config-layout — 三栏 config 布局（app/dev/合并设置页共用）
 * 参考: specs/ui/components/app-dev-config-page/section-config-layout.md
 *
 * 三栏：左 group 列表（testid group-item-{groupId}，自渲染以匹配 ET 锚点）+
 * 右 配置区（每 key 一张 component-key-card，testid key-card-{key}）+
 * 当前 group 底部 component-group-save-bar（testid group-save-bar-{groupId}）。
 *
 * [v0.0.47 Bug B] group 列表支持 entryKind==='system-toggle' 分割线条目
 * （testid app-settings-system-toggle），用于合并设置页「展开/收起系统配置」。
 * system-toggle 永不被选中、不路由到右栏（sentinel groupId __system_toggle__）。
 *
 * 边界：不持 key 编辑态本地副本（onKeyChange 即时上抛由 page 维护）；
 * 保存态（dirty/saving）由 page 维护并传入；group 切换由 onSelectGroup 上抛。
 *
 * group 类型分发：page 通过 renderGroupArea prop 可注入自定义配置区节点
 * （如 providers group 注入 SectionProviders），缺省时渲染 KV key-card 网格。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ComponentGroupListItem } from '../common/component-group-list-item';
import { ComponentKeyCard, type KeyInfo } from './component-key-card';
import { ComponentGroupSaveBar } from './component-group-save-bar';

/** 单个 group 信息 */
export interface GroupInfo {
  groupId: string;
  /** 该 group 的 keys（KV 形态，providers 等自定义渲染 group 可留空） */
  keys: KeyInfo[];
  /**
   * 保存粒度：
   *   - 'group'（默认）：整组延迟保存——底部 group-save-bar，编辑进 draft，点保存才生效（如 appearance / dev llm_request）。
   *   - 'item'：逐项保存——group 区自渲染（如 providers 进 item 后各自保存），无底部 group-save-bar。
   * 未来可扩展 'key'（逐 key 即时）中间粒度，暂不实现。
   */
  saveMode?: 'group' | 'item';
  /**
   * [v0.0.47 Bug B] 条目类型：
   *   - 'group'（默认）：普通 group 项，走 ComponentGroupListItem 渲染。
   *   - 'system-toggle'：分割线 + 展开/收起系统配置按钮（testid app-settings-system-toggle）。
   *     永不被选中（groupId 用 sentinel '__system_toggle__'）；仅作 sidebar 内的折叠分隔器。
   *     渲染依赖 systemExpanded + onSystemToggle（见下方两个字段）。
   */
  entryKind?: 'group' | 'system-toggle';
  /** entryKind==='system-toggle' 时：当前是否展开（按钮文案 + chev rotate + data-expanded） */
  systemExpanded?: boolean;
  /** entryKind==='system-toggle' 时：点击按钮 toggle 展开/收起 */
  onSystemToggle?: () => void;
}

/** entryKind==='system-toggle' 用的 sentinel groupId（永不被选中、不路由） */
export const SYSTEM_TOGGLE_GROUP_ID = '__system_toggle__';

interface SectionConfigLayoutProps {
  /** 全部 group */
  groups: GroupInfo[];
  /** 当前选中的 groupId */
  selectedGroup: string;
  /** 切换 group */
  onSelectGroup: (groupId: string) => void;
  /** 点当前 group 的保存按钮 → page 内部 PUT 整组 */
  onSaveGroup: (groupId: string) => void;
  /** 编辑某个 key → page 维护 dirty draft（即时上抛） */
  onKeyChange: (groupId: string, key: string, next: unknown) => void;
  /** 该 group 是否有未保存改动（按 groupId 查询） */
  dirtyOf: (groupId: string) => boolean;
  /** 该 group 是否正在保存（按 groupId 查询） */
  savingOf: (groupId: string) => boolean;
  /** 该 group 是否处于「已保存」短暂反馈窗口（按 groupId 查询；BUG-011 saved 反馈） */
  savedOf?: (groupId: string) => boolean;
  /**
   * 自定义 group 配置区渲染：返回非空节点时替代 KV key-card 网格
   * （如 providers group 注入 SectionProviders）。
   * 返回 undefined / null 时走默认 KV key-card 网格。
   */
  renderGroupArea?: (group: GroupInfo) => ReactNode | undefined;
}

/** 三栏 config 布局 */
export function SectionConfigLayout({
  groups,
  selectedGroup,
  onSelectGroup,
  onSaveGroup,
  onKeyChange,
  dirtyOf,
  savingOf,
  savedOf,
  renderGroupArea,
}: SectionConfigLayoutProps) {
  // [v0.0.62 i18n] 配置区空态 + 展开/收起文案走 app-dev-config ns
  const { t } = useTranslation('app-dev-config');
  // 容错：selectedGroup 不在 groups 内时回退首个普通 group（跳过 system-toggle sentinel，
  // [v0.0.47 Bug B] system-toggle 项永不被选中 / 不路由到右栏）
  const normalGroups = groups.filter((g) => g.entryKind !== 'system-toggle');
  const current =
    normalGroups.find((g) => g.groupId === selectedGroup) ?? normalGroups[0];
  const currentId = current?.groupId ?? '';

  return (
    <div className="flex h-full">
      {/* 左栏：group 列表（testid group-list 容器 + group-item-{groupId} 单项）。
          复用 common/component-group-list-item，通过 testIdPrefix='group-item' 保留 ET 锚点。 */}
      <aside className="w-[200px] shrink-0 border-r border-border bg-surface overflow-y-auto p-3">
        <ul className="flex flex-col gap-1.5">
          {groups.map((g) => (
            <li key={g.groupId}>
              {g.entryKind === 'system-toggle' ? (
                <SystemToggle
                  expanded={!!g.systemExpanded}
                  onToggle={g.onSystemToggle}
                />
              ) : (
                <ComponentGroupListItem
                  groupId={g.groupId}
                  active={g.groupId === currentId}
                  onSelect={() => onSelectGroup(g.groupId)}

                  labelKey={`app-dev-config:group.${g.groupId}.label`}
                />
              )}
            </li>
          ))}
        </ul>
      </aside>

      {/* 右栏：配置区 + 该 group 保存条 */}
      <section className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto py-6 px-8">
          {current ? renderArea(current, renderGroupArea, onKeyChange, t('layout.emptyGroup')) : (
            <p className="text-muted text-sm">{t('layout.emptyGroups')}</p>
          )}
        </div>
        {/* 整组保存粒度才渲染底部 save-bar；逐项保存（item）的 group（如 providers）自管保存，无底部条 */}
        {current && (current.saveMode ?? 'group') === 'group' && (
          <ComponentGroupSaveBar
            groupId={currentId}
            dirty={dirtyOf(currentId)}
            saving={savingOf(currentId)}
            saved={savedOf?.(currentId) ?? false}
            onSave={() => onSaveGroup(currentId)}
          />
        )}
      </section>
    </div>
  );
}

/** 渲染配置区：page 注入自定义节点时优先；否则渲染 KV key-card 网格 */
function renderArea(
  group: GroupInfo,
  renderGroupArea: ((g: GroupInfo) => ReactNode | undefined) | undefined,
  onKeyChange: (groupId: string, key: string, next: unknown) => void,
  emptyGroupText: string,
): ReactNode {
  const custom = renderGroupArea?.(group);
  if (custom !== undefined && custom !== null) {
    return custom;
  }
  // 默认 KV key-card 网格
  if (group.keys.length === 0) {
    return <p className="text-muted text-sm">{emptyGroupText}</p>;
  }
  return (
    <div className="flex flex-col">
      {group.keys.map((k) => (
        <ComponentKeyCard
          key={k.key}
          keyInfo={k}
          onChange={(next) => onKeyChange(group.groupId, k.key, next)}
        />
      ))}
    </div>
  );
}

/**
 * [v0.0.47 Bug B] 「展开/收起系统配置」分割线 + toggle 按钮（对齐 mockup .expand-btn）。
 * entryKind==='system-toggle' 时由 SectionConfigLayout 渲染。
 * 永不被选中（不含 onSelectGroup），仅 toggle systemExpanded。
 * 布局稳定性：分割线 + 按钮固定占位，展开/收起只切文案 + chev rotate，零布局位移。
 */
function SystemToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle?: () => void;
}) {
  // [v0.0.62 i18n] 展开/收起文案走 app-dev-config ns
  const { t } = useTranslation('app-dev-config');
  return (
    <div className="my-2">
      <div className="h-px bg-border" />
      <button
        type="button"

        data-expanded={expanded ? 'true' : 'false'}
        aria-expanded={expanded}
        aria-label={expanded ? t('layout.collapseAll') : t('layout.expandAll')}
        onClick={onToggle}
        className="mt-1.5 flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-mono text-muted hover:text-fg-2 hover:bg-bg-warm rounded transition-colors"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={
            expanded
              ? 'rotate-90 transition-transform'
              : 'transition-transform'
          }
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>{expanded ? t('layout.collapseAll') : t('layout.expandAll')}</span>
      </button>
    </div>
  );
}

export default SectionConfigLayout;
