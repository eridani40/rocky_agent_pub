/**
 * section-ext-point-area — 扩展点 tab 主区域（2 栏）
 * 参考: specs/ui/components/plugin-config-page/section-ext-point-area.md
 *       设计稿视觉基线: reqs/v0.0.5/easy-opc-config-center-v4.html .ext-group / .impl-row（§9）
 *
 * 职责：左栏 group 列表（复用 common/section-group-list）+ 右栏按选中 group 渲染该 group
 * 下扩展点及其实现，按 impl.type 路由 radio/checkbox/ordered。impl 有 configSchema 时挂 modal。
 * 边界：group 列表复用 common；ext impl 操作结果上抛父级 page（page 负责乐观更新 + PUT）。
 *
 * 视觉基线（对齐设计稿 .ext-group）：每个扩展点 = 可折叠分组，header 含
 * 标题(14/600) + type-tag 徽章(exclusive=橙/list=绿/ordered=金) + "N impls" count + 折叠 chevron。
 *
 * [v0.0.71 D3] 嵌套数据消费：groups[].points[].impls[]（不再跨 point 平铺到 extImpls[]）。
 *
 * [v0.0.67] 配置只读化（v0.0.71 D4 部分回退）：
 *   - EP 的 impl 列表强制 disabled（radio/checkbox/ordered 灰显）
 *   - 非 default scope 未激活 EP：不渲染 impl 列表，改显「未激活（继承 default）」提示
 *   - 删除激活/取消激活按钮（scope 配置代码声明，运行时不可改）
 *   - [v0.0.71 D4] 配置齿轮按钮恢复显示（disabled 时也渲染），modal readOnly 化（无保存按钮）
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginGroup, PluginExtImpl, JsonSchema } from '../../lib/api-client';
import { SectionGroupList } from '../common/section-group-list';
import { ComponentExtImplRouter } from './component-ext-impl-router';
import { ComponentSchemaConfigModal } from './component-schema-config-modal';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';

export interface SectionExtPointAreaProps {
  /** inventory groups[]（v0.0.71 D3 嵌套：groups[].points[].impls[]） */
  groups: PluginGroup[];
  /** plugin 级 setEnabled 回调（v0.0.67 noop，保留签名避免 props 接线改动） */
  onImplToggle: (implId: string, next: boolean) => void;
  /** exclusive 单选（v0.0.67 noop，保留签名） */
  onExclusiveSelect: (implId: string) => void;
  /** ordered 拖拽（v0.0.67 noop，保留签名） */
  onReorder: (pointId: string, from: number, to: number) => void;
  /** setImplConfig 稀疏 delta 保存（v0.0.67 noop，保留签名） */
  onSaveImplConfig: (implId: string, values: Record<string, unknown>) => void;
  /** [v0.0.26] 当前 scope（default 时全 EP 激活基线） */
  currentScopeId?: string;
  /** [v0.0.26] 该 scope 已激活的 pointId 集合（default 时 = 全部 pointId） */
  activatedPoints?: Set<string>;
}

/** type-tag 徽章配色（对齐设计稿 .type-tag.{exclusive,list,ordered}） */
const TAG_CLASS: Record<string, string> = {
  exclusive: 'bg-accent-light text-accent',
  list: 'bg-sage-bg text-sage',
  ordered: 'bg-gold-bg text-gold',
};

/**
 * 扩展点节点（v0.0.71 D3：直接来自 inventory 嵌套 points[]，不再客户端聚合）。
 * type 字段：从该 point 任一 impl 的 type 取（同 point 一致）；缺省 'list' 兼容旧数据。
 */
interface ExtPointNode {
  pointId: string;
  type: 'exclusive' | 'list' | 'ordered';
  impls: PluginExtImpl[];
  /** EP 级描述（取同 point 任一 impl 的 pointDescription；同 point 一致），无则空串 */
  pointDescription: string;
  /** 该 EP 在当前 scope 的激活态（来自嵌套 points[].activated） */
  pointActivated: boolean;
}

/**
 * 取 group 的扩展点节点（v0.0.71 D3：直接消费嵌套 points[]，不再按 pointId 聚合 extImpls[]）。
 * 兜底 group.points 缺失时返 []（旧数据兼容；新 inventory 必返 points[]）。
 */
function readExtPoints(group: PluginGroup): ExtPointNode[] {
  return (group.points ?? []).map((p) => {
    const type = p.impls.find((i) => i.type)?.type ?? 'list';
    const pointDescription = p.impls.find((i) => i.pointDescription)?.pointDescription ?? '';
    return {
      pointId: p.pointId,
      type,
      impls: p.impls,
      pointDescription,
      pointActivated: p.activated,
    };
  });
}

/**
 * 扩展点 tab 主区域。selectedGroupId 默认首个 group；
 * 每个 ext point 可折叠（collapsedPoints）；schema modal 同屏仅一个。
 * [v0.0.67] 全部 EP 强制 disabled（只读）；非 default 未激活 EP 不渲染 impl 列表。
 * [v0.0.71 D4] 齿轮按钮恢复（disabled 下也渲染）；modal 改 readOnly（无保存按钮）。
 */
export function SectionExtPointArea({
  groups,
  onImplToggle,
  onExclusiveSelect,
  onReorder,
  onSaveImplConfig,
  currentScopeId = 'default',
  activatedPoints,
}: SectionExtPointAreaProps) {
  // [v0.0.62 i18n] EP 区文案走 plugin-config ns
  const { t } = useTranslation('plugin-config');
  const [selectedGroupId, setSelectedGroupId] = useState<string>(
    groups[0]?.groupId ?? '',
  );
  /** 各扩展点折叠态（pointId → collapsed）—— 对齐设计稿 .ext-group.collapsed */
  const [collapsedPoints, setCollapsedPoints] = useState<Record<string, boolean>>({});
  /** [v0.0.71 D7] modal 触发态：存 implId + configSchema + config（readOnly） */
  const [modalImpl, setModalImpl] = useState<{
    implId: string;
    configSchema: JsonSchema;
    config: Record<string, unknown>;
  } | null>(null);

  const currentGroup = useMemo(
    () => groups.find((g) => g.groupId === selectedGroupId) ?? groups[0],
    [groups, selectedGroupId],
  );

  const extPoints = useMemo(
    () => (currentGroup ? readExtPoints(currentGroup) : []),
    [currentGroup],
  );

  /**
   * 抽公共 onConfig：按 implId 查 configSchema 并打开 modal。
   * [v0.0.71 D4] readOnly 入口：齿轮按钮在 disabled 下也渲染（router 仍传 disabled=true），
   *   但 onConfig 闭包不被 disabled 短路（齿轮按钮自身 stopPropagation）。
   * [v0.0.71 D7] 触发条件从 schemaConfig → configSchema（D7 删 schemaConfig 后单一 schema 源）。
   */
  const openImplConfig = (impls: PluginExtImpl[], implId: string) => {
    const impl = impls.find((i) => i.implId === implId);
    if (impl?.configSchema) {
      setModalImpl({
        implId,
        configSchema: impl.configSchema,
        config: impl.config ?? {},
      });
    }
  };

  const modalImplData = useMemo(() => {
    if (!modalImpl) return null;
    for (const g of groups) {
      for (const p of g.points ?? []) {
        for (const i of p.impls) {
          if (i.implId === modalImpl.implId) {
            return i;
          }
        }
      }
    }
    return null;
  }, [groups, modalImpl]);

  const toggleCollapse = (pointId: string) =>
    setCollapsedPoints((prev) => ({ ...prev, [pointId]: !prev[pointId] }));

  return (
    <div className="flex flex-1 min-h-0">
      <SectionGroupList
        groups={groups.map((g) => ({
          groupId: g.groupId,
          // [v0.0.99] locale key 用 snake_id（groupId 的 `-` 转 `_`），与 groups.json
          //   `__MSG_group.<snake_id>.label__` 占位符约定一致（GroupMetaLoader 文档同款约定），
          //   三方（声明/查询/实现）统一下划线。missing key 走报错不 fallback。
          labelKey: `plugin-config:group.${g.groupId.replace(/-/g, '_')}.label`,
        }))}
        selected={selectedGroupId}
        onSelect={setSelectedGroupId}
      />
      <div className="flex-1 overflow-y-auto p-4 flex flex-col">
        {extPoints.length === 0 && (
          <p className="text-muted text-sm">{t('empty.extPoint')}</p>
        )}
        {extPoints.map((ep) => {
          const collapsed = collapsedPoints[ep.pointId] ?? false;
          // 该 EP 在当前 scope 是否激活：
          //   default scope → 永远激活（基线）
          //   非 default → activatedPoints 集合判断（缺省视为激活，兼容旧调用）
          const isDefaultScope = currentScopeId === 'default';
          const epActivated = isDefaultScope
            ? true
            : (activatedPoints ? activatedPoints.has(ep.pointId) : ep.pointActivated);
          return (
            <div key={ep.pointId} className="mb-5">
              {/* 可折叠分组头：标题 + type-tag 徽章 + impls count + chevron —— 设计稿 .ext-group-header */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                data-action-key="plugin.ext-point.toggle-collapse"
                onClick={() => toggleCollapse(ep.pointId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleCollapse(ep.pointId);
                  }
                }}
                className="flex items-center gap-2 py-2.5 cursor-pointer border-b border-border mb-3"
              >
                <span className="text-sm font-semibold text-fg">{ep.pointId}</span>
                <span
                  className={
                    'text-[9px] font-bold font-mono uppercase tracking-wide px-1.5 py-0.5 rounded ' +
                    (TAG_CLASS[ep.type] ?? TAG_CLASS.list)
                  }
                >
                  {ep.type}
                </span>
                <span className="text-[10px] text-muted font-mono bg-bg-warm px-1.5 py-0.5 rounded">
                  {ep.impls.length} impls
                </span>
                {/* [v0.0.67] 激活/取消激活按钮已删（scope 配置代码声明，运行时不可改） */}
                <span
                  aria-hidden
                  className="text-muted transition-transform ml-auto"
                  style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
                >
                  <ChevronIcon />
                </span>
              </div>
              {/* EP header 副文本：pointDescription（同 point 一致），无则不渲染。
                  pointDescription 是 EP 声明的 __MSG_<key>__ 占位符（builtin）或字面文案（第三方/未改造），
                  统一走 resolveI18nField 查 plugin-config ns。 */}
              {resolveI18nField(ep.pointDescription, t) && (
                <p

                  className="text-[11px] text-muted mb-3"
                >
                  {resolveI18nField(ep.pointDescription, t)}
                </p>
              )}
              {!collapsed && epActivated && (
                /* [v0.0.67] 配置只读化：激活 EP 的 impl 列表强制 disabled（灰显）。
                   [v0.0.71 D4] 齿轮按钮恢复（router 内 disabled 透传到外层灰显，齿轮 stopPropagation 仍可点） */
                <ComponentExtImplRouter
                  pointId={ep.pointId}
                  type={ep.type}
                  disabled
                  impls={ep.impls}
                  onExclusiveSelect={onExclusiveSelect}
                  onToggle={onImplToggle}
                  onReorder={(from, to) => onReorder(ep.pointId, from, to)}
                  onConfig={(implId) => openImplConfig(ep.impls, implId)}
                />
              )}
              {!collapsed && !epActivated && (
                /* [v0.0.67] 非 default scope 未激活 EP：不渲染 impl 列表，仅显「未激活」提示（req.md §2.2） */
                <p

                  className="text-[11px] text-muted italic"
                >
                  {t('page.epInactiveHint')}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {modalImpl && modalImplData && (
        <ComponentSchemaConfigModal
          implId={modalImpl.implId}
          configSchema={modalImpl.configSchema}
          value={modalImpl.config}
          open={!!modalImpl}
          onClose={() => setModalImpl(null)}
          /* [v0.0.71 D4] 整页只读化：modal 强制 readOnly（无保存按钮 + 字段 disabled） */
          readOnly
          onSave={(v) => onSaveImplConfig(modalImpl.implId, v)}
        />
      )}
    </div>
  );
}

/** 折叠箭头（chevron-down，collapsed 时父级旋转 -90deg）—— 设计稿 .ext-chevron */
function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export default SectionExtPointArea;
