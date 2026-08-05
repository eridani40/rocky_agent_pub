/**
 * component-usage-panel —— topbar 右侧 token 用量组件 + CompactBtn + ClearBtn（§1/§3/§4）
 * 参考: specs/ui/components/chat-page/component-usage-panel.md（权威视觉契约 + testid 总表 §5）
 *       reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html §143-258（设计稿 CSS，视觉权威源）
 *
 * 6 子组件（§1）：UsageRing / UsageTrigger / UsageExpandBtn / UsagePanel / CompactBtn / ClearBtn。
 * UsageRing 拆到 component-usage-ring.tsx（primitive，§4.2 SVG 圆环）；本文件含其余 5 子组件 +
 * 顶层 ComponentUsagePanel（组合 usage trigger + expand + panel + tooltip）。
 *
 * 三态交互（§3）：
 *   - 收起（默认）：圆环 28×28 + 「已用/总」k 格式 + chevron；hover trigger 显 tooltip
 *   - 展开（.open）：浮层 280px，大圆环 52×52 + 4 分段进度条 + 图例 + 累积消耗表格
 *   - CompactBtn：summaryTask.status=running → disabled+spinner；idle/done/failed 可点
 *   - ClearBtn：hover danger 色；点击弹 clear-confirm-modal（独立组件）
 *
 * 数据契约（§2）：usage = SessionUsageView（含 ContextWindowUsage 7 字段 + 三分区 + 4 cacheRate）。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionUsageView, SummaryTaskStatus } from './types';
import { ComponentUsageRing, usageRingColor } from './component-usage-ring';
import { ChevronIcon, CompressIcon, TrashIcon } from './icons';
import { formatTraffic } from '../../lib/format-traffic';

/** k 格式化：n>=1000 → 「{k}k」，否则原值字符串（§4.3） */
function fmtK(n: number): string {
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
}

/** toLocaleString 兜底（SSR / 旧环境） */
function fmtNum(n: number): string {
  try {
    return n.toLocaleString();
  } catch {
    return String(n);
  }
}

/** 累积消耗表格一行（§4.7） */
interface CumRow {
  /** testid 后缀：current/forked/sub/total（§5） */
  key: 'current' | 'forked' | 'sub' | 'total';
  /** i18n key 后缀：会话 / 整理 / 子Agent / 合计（chat.usage.row.<key>） */
  labelKey: string;
  input: number;
  output: number;
  cacheRate: number;
  /** 是否合计行（border-top + 加粗） */
  isTotal?: boolean;
}

interface UsagePanelProps {
  usage: SessionUsageView;
}

/**
 * 顶层 usage-panel 组件（收起 trigger + expand btn + 展开浮层 + tooltip）。
 * 挂于 chat-page topbar 右侧（§4.4）；CompactBtn / ClearBtn 由父 topbar 横排（§1 末段）。
 */
export function ComponentUsagePanel({ usage }: UsagePanelProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // usage 面板文案走 chat ns
  const { t } = useTranslation('chat');

  // 点 panel 外部关闭（§3.2）；点 panel 内部 stopPropagation 不关
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const ctx = usage.contextWindowUsage;
  // 兜底：无 contextWindowUsage 时全 0（避免 UI 崩；真 LLM 进会话 GET /usage 即有值）
  const total = ctx?.tokenLimit ?? 0;
  const used = ctx?.totalTokens ?? 0;
  // UI usage 不展示 estimatedOutput：reserve 分段砍，free = limit - total
  //   用户视角 = 已用 / window（estimated output 是 assemble budget 用的常量，不进 UI 占用展示）。
  const parts = {
    system: ctx?.systemTokens ?? 0,
    messages: ctx?.messageTokens ?? 0,
    tools: ctx?.toolTokens ?? 0,
  };
  const free = Math.max(0, total - used);
  const pct = Math.min(1, total > 0 ? used / total : 0);
  const ringColor = usageRingColor(pct);

  // 累积消耗表格行（§4.7）：会话始终展示；整理/子Agent total_tokens=0 隐藏；末尾必有合计
  const rows: CumRow[] = [
    { key: 'current', labelKey: 'usage.row.current', input: usage.current.input_total_tokens ?? 0, output: usage.current.output_total_tokens ?? 0, cacheRate: usage.currentCacheRate },
  ];
  const forkedIn = usage.forked.input_total_tokens ?? 0;
  const forkedOut = usage.forked.output_total_tokens ?? 0;
  if (forkedIn + forkedOut > 0) {
    rows.push({ key: 'forked', labelKey: 'usage.row.forked', input: forkedIn, output: forkedOut, cacheRate: usage.forkedCacheRate });
  }
  const subIn = usage.sub.input_total_tokens ?? 0;
  const subOut = usage.sub.output_total_tokens ?? 0;
  if (subIn + subOut > 0) {
    rows.push({ key: 'sub', labelKey: 'usage.row.sub', input: subIn, output: subOut, cacheRate: usage.subCacheRate });
  }
  rows.push({ key: 'total', labelKey: 'usage.row.total', input: usage.total.input_total_tokens ?? 0, output: usage.total.output_total_tokens ?? 0, cacheRate: usage.totalCacheRate, isTotal: true });

  return (
    <div
      ref={containerRef}
      className={'relative flex items-center gap-0.5 ' + (open ? 'open' : '')}
    >
      {/* 收起态 trigger：圆环 + 「已用/总」k 格式 + hover tooltip（§3.1：group 驱动 group-hover） */}
      <div className="group flex items-center gap-1.5 px-1.5 py-1 rounded-lg relative hover:bg-bg-warm transition-colors">
        <ComponentUsageRing used={used} total={total} />
        <span className="text-[11px] text-fg-2 font-medium font-mono whitespace-nowrap">
          {fmtK(used)}<span className="text-muted mx-px">/</span>{fmtK(total)}
        </span>
        {/* hover tooltip（仅收起态显示；opacity 由 group-hover 驱动，无内联覆盖） */}
        {!open && (
          <div

            className="absolute top-full right-0 mt-2 bg-surface border border-border rounded-[10px] shadow-[0_8px_24px_rgba(40,30,20,0.12)] px-3 py-2.5 min-w-[184px] z-[var(--z-popover)] opacity-0 pointer-events-none -translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-opacity"
          >
            <div className="text-[9px] font-semibold text-muted-2 uppercase tracking-wider mb-1.5">{t('usage.cumulative')}</div>
            <div className="flex justify-between gap-4 text-[11px] py-0.5">
              <span className="text-muted">{t('usage.row.total')}</span>
              <span className="text-fg-2 font-mono">{fmtNum(usage.total.total_tokens ?? 0)}</span>
            </div>
          </div>
        )}
      </div>
      {/* expand 按钮（chevron，.open 时 rotate 180°） */}
      <button
        type="button"
        data-action-key="chat.usage.toggle"
        onClick={() => setOpen((o) => !o)}
        title={open ? t('usage.toggle.collapse') : t('usage.toggle.expand')}
        aria-label={open ? t('usage.toggle.collapse') : t('usage.toggle.expand')}
        className="w-[22px] h-[30px] rounded-lg flex items-center justify-center text-muted hover:bg-bg-warm hover:text-fg-2 transition-colors"
      >
        <ChevronIcon size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>

      {/* 展开浮层（panel） */}
      {open && (
        <div

          onClick={(e) => e.stopPropagation()}
          className="absolute top-full right-0 mt-1.5 bg-surface border border-border rounded-xl shadow-[0_12px_32px_rgba(40,30,20,0.16)] p-3.5 w-[300px] z-[var(--z-popover)]"
        >
          {/* head */}
          <div className="mb-3">
            <div className="text-[13px] font-bold text-fg">{t('usage.title')}</div>
            <div className="text-[10px] text-muted mt-0.5 font-mono">{fmtNum(total)} context</div>
          </div>
          {/* 大圆环 + 数字 */}
          <div className="flex items-center gap-3 mb-2">
            <ComponentUsageRing used={used} total={total} size={52} stroke={6} />
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold font-mono">
                {fmtNum(used)} <span className="text-muted font-normal">/ {fmtNum(total)}</span>
              </div>
              <div className="text-[11px] mt-0.5 font-medium" style={{ color: ringColor }}>
                {t('usage.occupancy', { pct: Math.round(pct * 100), free: fmtNum(free) })}
              </div>
            </div>
          </div>
          {/* 3 分段进度条（reserve 分段砍，UI 不展示 estimated output） */}
          <div className="flex h-2 bg-bg-warm rounded-full overflow-hidden gap-px mb-2.5">
            <div className="h-full transition-[width] duration-300" style={{ width: `${total > 0 ? parts.system / total * 100 : 0}%`, background: 'var(--color-accent)' }} />
            <div className="h-full transition-[width] duration-300" style={{ width: `${total > 0 ? parts.messages / total * 100 : 0}%`, background: 'var(--color-sage)' }} />
            <div className="h-full transition-[width] duration-300" style={{ width: `${total > 0 ? parts.tools / total * 100 : 0}%`, background: 'var(--color-gold)' }} />
          </div>
          {/* 3 图例（reserve 砍） */}
          <div className="grid grid-cols-2 gap-y-[5px] gap-x-3.5 mb-3.5">
            <CtxLeg color="var(--color-accent)" label={t('usage.leg.system')} value={parts.system} />
            <CtxLeg color="var(--color-sage)" label={t('usage.leg.messages')} value={parts.messages} />
            <CtxLeg color="var(--color-gold)" label={t('usage.leg.tools')} value={parts.tools} />
          </div>
          {/* 累积消耗 section label */}
          <div className="text-[10px] font-semibold text-muted-2 uppercase tracking-wider mb-2">{t('usage.cumulative')}</div>
          {/* 累积消耗表格（§4.7）。
              列宽：auto 标签列 + minmax(0,1fr) 值列（可缩）+ min-w-0/overflow-hidden 收敛，配 w-[300px] 面板留余量。
              值列 tabular-nums 等宽数字防 K→M 切换抖动；whitespace-nowrap 防折行。 */}
          <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-x-1 gap-y-px text-[11px] min-w-0 overflow-hidden">
            <div className="cum-th text-left py-1.5 pr-1.5 whitespace-nowrap">{t('usage.col.source')}</div>
            <div className="cum-th py-1.5 px-1.5 tabular-nums">{t('usage.col.input')}</div>
            <div className="cum-th py-1.5 px-1.5 tabular-nums">{t('usage.col.cache')}</div>
            <div className="cum-th py-1.5 px-1.5 tabular-nums">{t('usage.col.output')}</div>
            <div className="cum-th py-1.5 px-1.5 tabular-nums">{t('usage.col.total')}</div>
            {rows.map((r) => (
              <CumCells key={r.key} row={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 图例行（§4.6 图例） */
function CtxLeg({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
      <span className="text-muted-2">{label}</span>
      <span className="ml-auto text-fg-2 font-medium font-mono">{fmtNum(value)}</span>
    </div>
  );
}

/** 累积消耗表格单行 5 单元格（§4.7）；派生值（合计/cls/cz）由 row 在内部计算 */
function CumCells({ row }: { row: CumRow }) {
  // 行 label 走 chat.usage.row.<key> 查表
  const { t } = useTranslation('chat');
  const ct = row.input + row.output;
  const cz = row.cacheRate > 0;
  const cls = row.isTotal ? 'border-t border-border font-bold text-fg pt-1.5' : '';
  const cacheCls = cz ? 'text-accent' : 'text-muted';
  // 数据单元格统一 Tailwind 类：mono / 右对齐 / 不换行 / 内边距。
  // tabular-nums：等宽数字列防 K→M 切换时数字位宽变化挤邻列抖动。
  const tdBase = 'cum-td font-mono text-right whitespace-nowrap tabular-nums px-1.5 py-[5px]';
  const fgCls = 'text-fg-2';
  return (
    <>
      <div className={'cum-td-label text-left font-medium whitespace-nowrap ' + cls} style={!row.isTotal ? { color: 'var(--color-fg)' } : undefined}>
        {t(row.labelKey)}
      </div>
      {/* 累积消耗区 input/output/total 三列用 formatTraffic（K/M/B/T 短串防 280px 紧凑面板折行） */}
      <div className={`${tdBase} ${fgCls} ${cls}`}>{formatTraffic(row.input)}</div>
      <div className={`${tdBase} ${cacheCls} ${cls}`}>{cz ? Math.round(row.cacheRate * 100) : 0}%</div>
      <div className={`${tdBase} ${fgCls} ${cls}`}>{formatTraffic(row.output)}</div>
      <div className={`${tdBase} ${fgCls} ${cls}`}>{formatTraffic(ct)}</div>
    </>
  );
}

/** CompactBtn 子组件（§3.3，状态绑定 summaryTask 四态） */
interface CompactBtnProps {
  summaryTask: SummaryTaskStatus | null;
  /**
   * session.state ∈ {running, interrupting}（兼容 caller 透传，不影响 disabled）。
   * 保留入参以维持 caller 调用签名稳定（section-chat-session 仍透传 sessionRunning），
   * 但组件内部忽略——任何 session.state 都能 compact。
   */
  sessionBusy: boolean;
  onClick: () => void;
}

export function CompactBtn({ summaryTask, sessionBusy: _sessionBusy, onClick }: CompactBtnProps) {
  const running = summaryTask?.status === 'running';
  // disabled 只看 summaryTask.running——任何 session.state 都可点 compact。
  // _sessionBusy 入参保留为 caller 兼容，不影响 disabled 计算。
  const disabled = running;
  // compact title 走 chat ns
  const { t } = useTranslation('chat');
  return (
    <button
      type="button"
      data-action-key="chat.session.compact"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={t('usage.compact')}
      className="w-[30px] h-[30px] rounded-lg flex items-center justify-center text-muted hover:bg-bg-warm hover:text-fg-2 transition-colors bg-transparent border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {running ? (
        <span className="inline-block w-[9px] h-[9px] border-[1.5px] border-[var(--color-border-strong)] border-t-[var(--color-accent)] rounded-full animate-spin" />
      ) : (
        <CompressIcon size={15} />
      )}
    </button>
  );
}

/** ClearBtn 子组件（§3.4，hover danger 色，点击弹确认 modal 由 caller 管理） */
interface ClearBtnProps {
  onClick: () => void;
}

export function ClearBtn({ onClick }: ClearBtnProps) {
  // clear title 走 chat ns
  const { t } = useTranslation('chat');
  return (
    <button
      type="button"
      data-action-key="chat.session.clear"
      onClick={onClick}
      title={t('usage.clear')}
      className="w-[30px] h-[30px] rounded-lg flex items-center justify-center text-muted hover:bg-[var(--danger-bg)] hover:text-[var(--danger)] transition-colors bg-transparent border-none cursor-pointer"
    >
      <TrashIcon size={15} />
    </button>
  );
}

export default ComponentUsagePanel;
