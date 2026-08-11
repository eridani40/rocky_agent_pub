# component-skill-source-filter

> 层级: component
> 文件: app/web/src/components/skill-page/component-skill-source-filter.tsx

## 职责
「我的」列表上方的来源筛选条。4 个选项「全部 / 内置 / 市场 / Rocky」单选，切换后由父 `page-skill` 调纯函数 `filterSkillsBySource` 重算可见列表。受控组件，自身不持有状态。
边界：只管 4 个选项的视觉 + 转发 onChange；不做筛选计算（筛选由纯函数 + 父 useMemo 完成）；不在 market tab 渲染。

## Props / 导出
```ts
// 来源筛选类型（与 PRD §2.2 来源映射表一一对应）
export type SkillSourceFilter = 'all' | 'builtin' | 'market' | 'rocky';

// 纯函数：按 filter 过滤 skills 数组（无副作用，不改原数组）
export function filterSkillsBySource(
  skills: SkillEntry[],
  filter: SkillSourceFilter,
): SkillEntry[];

interface SourceFilterProps {
  active: SkillSourceFilter;
  onChange: (filter: SkillSourceFilter) => void;
}
```

## 状态 / 交互（含可见文案——E2E 定位契约）
- 4 个选项 tab **风格**（视觉与 `component-skill-tabs` 同色系：激活 accent 文字 + 底 2px accent 下划线），语义用 `role="radiogroup"` + `role="radio"`（单选筛选，区别于 tabs 的导航语义——避免与 nav tab 在 a11y tree/name 查询上冲突）
- 容器 aria-label：`sourceFilter.ariaLabel`（中「来源筛选」/ 英「Source filter」）
- 选项文案（i18n key skill ns `sourceFilter.*`）：
  - 全部：`sourceFilter.all`（中「全部」/ 英「All」）
  - 内置：`sourceFilter.builtin`（中「内置」/ 英「Built-in」）
  - 市场：`sourceFilter.market`（中「市场」/ 英「Market」）
  - Rocky：`sourceFilter.rocky`（中「Rocky」/ 英「Rocky」）
- Rocky 选项 hover/focus 显示 tooltip：`sourceFilter.rockyTooltip`（中「来自于 Rocky 的自我迭代和进化」/ 英「From Rocky's self-iteration and evolution」）；复用 `common/primitive-tooltip`
- 点任一选项 → `onChange(filter)`；激活态视觉 = accent 文字 + 底 2px accent 下划线

## 来源映射（PRD §2.2 对齐）
| filter | 判定条件 | 说明 |
|--------|---------|------|
| `'all'` | 无 filter | 返回原数组（passthrough） |
| `'builtin'` | `scope === 'builtin'` | 随 app 发版的内置 skill |
| `'market'` | `Boolean(marketRef)` | 由市场 tab 安装 |
| `'rocky'` | `productionMethod === 'consolidation'` | Rocky 自我迭代/进化产物 |

边界：`productionMethod` undefined 不归 rocky；4 类按精确单一条件，不做交集。

## 复用关系
- 被组合：`page-skill`（仅 manage tab 内、drop-zone / 弹层 下方、列表上方渲染）
- 组合：`common/primitive-tooltip`（Rocky hover 文案）

## 视觉基线
无独立设计稿；按 `component-skill-tabs` 同色系延伸（全 token / 双主题无特判）：
- **layout**：flex 横排 gap-1，紧凑高度不抢占列表视觉权重；`mb-[14px]`（无栏底线，区别于 tabs 栏——筛选条非主导航，视觉权重轻）
- **font**：12px/600；激活 accent，非激活 muted-2（紧凑字号，不与 tabs 13px 抢主导）
- **option padding**：`px-[10px] py-[5px]`（紧凑）
- **border**：每选项底 2px 下划线（激活 `border-accent` / 非激活 `border-transparent`），`-mb-px` 压栏底线
- **color**：激活 `text-accent`；非激活 `text-muted-2`；hover → `text-fg-2`
- **a11y**：`role="radiogroup"` + 选项 `role="radio"`（单选筛选语义，区别于 tabs 的导航语义——避免与 nav tab 在 a11y tree/name 查询上冲突）；容器 aria-label = `sourceFilter.ariaLabel`

## 消费方
- `app/web/src/components/skill-page/page-skill.tsx`
