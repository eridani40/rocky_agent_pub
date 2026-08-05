/**
 * component-ext-impl-router — 按 EP type 路由到 radio/checkbox/ordered（v0.0.26 sub-component）
 * 参考: specs/ui/components/plugin-config-page/section-ext-point-area.md
 *
 * 从 section-ext-point-area.tsx 拆出（避免主文件超 300 行 + 消除三 type 分支重复 impls.map）。
 * 三 type 共享：disabled 透传（未激活 EP 灰显）、onConfig 闭包（按 implId 查 configSchema 打开 modal）、
 *   onToggle/onExclusiveSelect/onReorder 上抛。差异仅在 type→组件 + impls 映射字段。
 *
 * [v0.0.71 D7] 字段源从 schemaConfig → configSchema（D7 删 schemaConfig 后单一 schema 源）。
 * [v0.0.71 D4] 齿轮按钮恢复：inner component 删 `!disabled` 守卫，按钮在 disabled 时也渲染。
 *
 * [v0.0.179] enabled/selected/order 字段语义改由后端 inventory 按 scope 配置 membership 派生
 *   （前端读派生值，不在前端重算）。router 实现零改动：radio/checkbox/ordered 渲染仍按 type
 *   读对应字段（radio 读 selected / checkbox+ordered 读 enabled+order），与派生规则解耦。
 */
import type { PluginExtImpl } from '../../lib/api-client';
import { ComponentExtImplRadio } from './component-ext-impl-radio';
import { ComponentExtImplCheckbox } from './component-ext-impl-checkbox';
import { ComponentExtImplOrdered } from './component-ext-impl-ordered';

export interface ComponentExtImplRouterProps {
  /** EP id */
  pointId: string;
  /** EP type（exclusive/list/ordered） */
  type: 'exclusive' | 'list' | 'ordered';
  /** 该 EP 下所有 impl（router 内部按 type 映射字段 + ordered 排序） */
  impls: PluginExtImpl[];
  /** [v0.0.26] 未激活 EP 强制 disabled（灰显，继承 default 视图只读） */
  disabled: boolean;
  /** exclusive 单选（父级互斥） */
  onExclusiveSelect: (implId: string) => void;
  /** list/ordered 单项翻转 enabled */
  onToggle: (implId: string, next: boolean) => void;
  /** ordered 拖拽：父级按 from/to 重排 order */
  onReorder: (from: number, to: number) => void;
  /** 点齿轮配置入口（父级挂载 component-schema-config-modal） */
  onConfig: (implId: string) => void;
}

/**
 * 按 type 路由到对应 component-ext-impl-*。三 type 共享 disabled 透传 + onConfig 闭包。
 * 消除 section-ext-point-area 中三分支重复的 impls.map + disabled 透传模板。
 */
export function ComponentExtImplRouter({
  pointId,
  type,
  impls,
  disabled,
  onExclusiveSelect,
  onToggle,
  onReorder,
  onConfig,
}: ComponentExtImplRouterProps) {
  if (type === 'exclusive') {
    return (
      <ComponentExtImplRadio
        pointId={pointId}
        disabled={disabled}
        impls={impls.map((i) => ({
          implId: i.implId,
          pluginId: i.pluginId,
          // [v0.0.55] 改用 inventory 派生的 selected 字段（修「两红框一 dot」bug）：
          //   旧版按 i.enabled 瞎猜，但 enabled 与 selected 解耦（exclusive EP 多个 enabled=true
          //   时只有 effective order 最小者 selected）。fallback false 兼容旧后端不返 selected。
          selected: !!i.selected,
          // [v0.0.71 D7] 字段源从 schemaConfig → configSchema（齿轮按钮显示条件）
          hasSchemaConfig: !!i.configSchema,
          description: i.description ?? '',
        }))}
        onSelect={onExclusiveSelect}
        onConfig={onConfig}
      />
    );
  }
  if (type === 'list') {
    return (
      <ComponentExtImplCheckbox
        pointId={pointId}
        disabled={disabled}
        impls={impls.map((i) => ({
          implId: i.implId,
          pluginId: i.pluginId,
          enabled: i.enabled,
          hasSchemaConfig: !!i.configSchema,
          description: i.description ?? '',
        }))}
        onToggle={onToggle}
        onConfig={onConfig}
      />
    );
  }
  // ordered
  return (
    <ComponentExtImplOrdered
      pointId={pointId}
      disabled={disabled}
      impls={impls
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((i, idx) => ({
          implId: i.implId,
          pluginId: i.pluginId,
          enabled: i.enabled,
          // order 取 inventory effective order（已是 1..n），缺省回退 idx+1
          order: i.order ?? idx + 1,
          hasSchemaConfig: !!i.configSchema,
          description: i.description ?? '',
        }))}
      onReorder={onReorder}
      onToggle={onToggle}
      onConfig={onConfig}
    />
  );
}

export default ComponentExtImplRouter;
