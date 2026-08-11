/**
 * section-studio-sidebar —— Studio 左 sidebar（squad 列表 + 新建按钮；无展开树）
 * 参考: specs/ui/components/studio-page/studio-sidebar.md v1.6（v0.0.168 手风琴展开树彻底删除）
 *       specs/ui/overall/06-studio.md §2 v0.0.168 修订（sidebar 只留 squad 行 + 新建）
 *       specs/tech/version_logs/v0.0.305.squad-list-ui-upgrade/change_plan.md D 组
 *       specs/prd/version_logs/v0.0.305.squad-list-ui-upgrade/prd.md §3/§5
 *
 * [v0.0.305] SquadRow 视觉升级（B 方案）：
 *   32×32 彩色字母头像（hashHueIndex 8 色）+ 两行布局（名字 15px semibold / X 在线 · Y 工作中 11px muted）
 *   + Y>0 橙色脉冲点 + pin 按钮 hover 显隐（visibility:hidden 占位）+ 排序（置顶组最前 + lastActiveAt desc）
 *   + localStorage studio.squadPins 持久化
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SquadSummary } from './squad-types';
import type { SquadAggregate } from './use-squad-meta';
import { hashHueIndex, HUE_PALETTE } from '../../lib/hue-hash';
import { Icon } from './studio-icons';

// ── localStorage pin 读写 ──

const PIN_KEY = 'studio.squadPins';

/** 读 pin 列表（JSON string[]；损坏 → [] 不 crash） */
function readPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 写 pin 列表 */
function writePins(pins: string[]): void {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {
    // localStorage 满/禁用 → 静默失败
  }
}

/** toggle pin：已 pin → 移除；未 pin → 插入头部。导出供 UT 直测。 */
export function togglePinInList(pins: string[], squadId: string): string[] {
  const idx = pins.indexOf(squadId);
  if (idx >= 0) {
    return pins.filter((id) => id !== squadId);
  }
  return [squadId, ...pins];
}

// ── 排序纯函数 ──

/** 排序键：lastActiveAt ?? updatedAt（旧后端降级） */
function sortKey(squad: SquadSummary, agg?: SquadAggregate): string {
  return agg?.lastActiveAt ?? squad.lastActiveAt ?? squad.updatedAt;
}

/**
 * 排序：置顶组最前（组内 lastActiveAt desc）+ 非置顶组 lastActiveAt desc。
 * 未知 squadId（pin 列表有但 squads 没有）渲染时忽略。
 * 导出供 UT 直测。
 */
export function sortSquads(
  squads: SquadSummary[],
  pins: string[],
  getAgg?: (id: string) => SquadAggregate | undefined,
): SquadSummary[] {
  const pinSet = new Set(pins);
  const pinned: SquadSummary[] = [];
  const unpinned: SquadSummary[] = [];
  for (const s of squads) {
    if (pinSet.has(s.id)) pinned.push(s);
    else unpinned.push(s);
  }
  const byActiveDesc = (a: SquadSummary, b: SquadSummary) =>
    sortKey(b, getAgg?.(b.id)).localeCompare(sortKey(a, getAgg?.(a.id)));
  pinned.sort(byActiveDesc);
  unpinned.sort(byActiveDesc);
  return [...pinned, ...unpinned];
}

// ── 组件 ──

interface StudioSidebarProps {
  squads: SquadSummary[];
  selectedSquadId: string | null;
  onSelectSquad: (id: string) => void;
  onNewSquad: () => void;
  /** [v0.0.305] squad 聚合数据（统一数据源；optional 旧消费方兼容） */
  getAgg?: (squadId: string) => SquadAggregate | undefined;
}

/** Studio 左 sidebar */
export function StudioSidebar({
  squads,
  selectedSquadId,
  onSelectSquad,
  onNewSquad,
  getAgg,
}: StudioSidebarProps) {
  const { t } = useTranslation('studio');
  const [pins, setPins] = useState<string[]>(readPins);

  const sorted = useMemo(() => sortSquads(squads, pins, getAgg), [squads, pins, getAgg]);

  const handleTogglePin = useCallback((squadId: string) => {
    setPins((prev) => {
      const next = togglePinInList(prev, squadId);
      writePins(next);
      return next;
    });
  }, []);

  return (
    <aside
      className="flex w-56 shrink-0 flex-col border-r border-border bg-surface"
    >
      {/* 头部：标题 + 新建按钮 */}
      <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-4">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-2">{t('sidebar.title')}</div>
        <button
          type="button"
          data-action-key="studio.squad.create"
          aria-label={t('sidebar.newSquadAria')}
          title={t('sidebar.newSquadAria')}
          onClick={onNewSquad}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-surface hover:text-accent"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {/* 列表：squad 行（B 方案视觉升级） */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sorted.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted">{t('sidebar.empty')}</div>
        ) : (
          sorted.map((s) => (
            <SquadRow
              key={s.id}
              squad={s}
              agg={getAgg?.(s.id)}
              selected={selectedSquadId === s.id}
              pinned={pins.includes(s.id)}
              onSelect={() => onSelectSquad(s.id)}
              onTogglePin={() => handleTogglePin(s.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

/**
 * 单个 squad 行（B 方案：32×32 彩色字母头像 + 两行布局 + pin 按钮）。
 * 视觉基线（PRD §3.1）：
 *   - 容器：px-2.5 py-2 rounded-lg + 选中 bg-accent-surface / hover bg-bg-warm
 *   - 头像：32×32（h-8 w-8）rounded-lg，首字符 + hashHueIndex 8 色
 *   - 第一行：团队名 15px font-semibold truncate；选中 text-accent
 *   - 第二行：X 在线 · Y 工作中 11px text-muted（i18n 模板变量）
 *   - Y>0 时「工作中」前加橙色脉冲圆点（animate-pulse + aria-hidden）
 *   - pin 按钮：hover 显隐，visibility:hidden 占位（不位移）
 */
function SquadRow({
  squad,
  agg,
  selected,
  pinned,
  onSelect,
  onTogglePin,
}: {
  squad: SquadSummary;
  agg?: SquadAggregate;
  selected: boolean;
  pinned: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
}) {
  const { t } = useTranslation('studio');
  const [hovered, setHovered] = useState(false);

  // 头像：首字符 + hashHueIndex 8 色
  const initial = (squad.name.trim().charAt(0) || '#').toUpperCase();
  const hueName = HUE_PALETTE[hashHueIndex(squad.id)] ?? 'rose';

  // 聚合数据（SSE 值优先，SquadSummary 3 字段兜底，旧后端 undefined 降级）
  const onlineCount = agg?.onlineCount ?? squad.onlineCount;
  const inProgressCount = agg?.inProgressCount ?? squad.inProgressCount;
  const hasStatus = onlineCount !== undefined && inProgressCount !== undefined;

  return (
    <div
      data-action-key="studio.squad.select"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={
        'group mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors ' +
        (selected ? 'bg-accent-surface' : 'hover:bg-bg-warm')
      }
    >
      {/* 19px 彩色字母头像（对齐 member-roster-list 三元素） */}
      <span
        className="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded font-bold font-sans text-[10px] text-white"
        style={{ background: `var(--hue-${hueName})` }}
        aria-hidden
      >
        {initial}
      </span>

      {/* 两行布局 */}
      <div className="min-w-0 flex-1">
        {/* 第一行：团队名 */}
        <div className={'truncate text-[12.5px] font-medium leading-tight ' + (selected ? 'text-accent' : 'text-fg')}>
          {squad.name}
        </div>
        {/* 第二行：X 在线 · Y 工作中（有聚合数据才渲染） */}
        {hasStatus && (
          <div className="mt-0.5 flex items-center gap-1 text-[11px] leading-tight text-muted">
            <span>{t('sidebar.status', { online: onlineCount, working: inProgressCount })}</span>
            {/* Y>0 橙色脉冲圆点（仅视觉装饰，aria-hidden） */}
            {(inProgressCount ?? 0) > 0 && (
              <span
                className="ml-0.5 inline-block h-[7px] w-[7px] animate-pulse rounded-full"
                style={{ background: 'var(--hue-orange)' }}
                aria-hidden
              />
            )}
          </div>
        )}
      </div>

      {/* pin 按钮（hover 显隐，visibility:hidden 占位不位移） */}
      <button
        type="button"
        aria-label={pinned ? t('sidebar.unpin') : t('sidebar.pin')}
        title={pinned ? t('sidebar.unpin') : t('sidebar.pin')}
        onClick={(e) => {
          e.stopPropagation(); // 不触发 onSelectSquad
          onTogglePin();
        }}
        className={
          'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity ' +
          (pinned
            ? 'text-accent'
            : 'text-muted hover:text-fg') +
          (hovered || pinned ? ' opacity-100' : ' opacity-0')
        }
        style={{ visibility: 'visible' }} // 恒占位（visibility 不控 display）
      >
        <Icon name={pinned ? 'pin-filled' : 'pin'} size={12} />
      </button>
    </div>
  );
}

export default StudioSidebar;
