/**
 * section-skill-market — skill 页「市场」tab 内容区容器。
 * 参考: specs/ui/components/skill-page/section-skill-market.md
 *       设计稿 reqs/[working] v0.0.167.skill_market_ui/design/skill-market.html
 *
 * 挂载先 getMarketCapabilities 做能力协商（null → noProvider 引导态）；据结果渲染搜索框 + 结果网格。
 * 受控搜索框（防抖 400ms + 回车触发 searchMarket）；结果 grid 渲染 component-market-item。
 * 持 loading/empty/error/noProvider 态 + 详情 modal open state + install handler。
 * 把已安装列表透传给卡片算同源态（deriveMarketStatus，ref 精确匹配 marketRef）。
 * 能力门控（invariant#4）：无 capabilities 不渲染搜索框；不渲染 skills.sh 未声明维度。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getMarketCapabilities,
  installMarketSkill,
  searchMarket,
  type MarketCapabilities,
  type MarketItem,
  type SkillEntry,
} from '../../lib/api-client';
import { ComponentMarketItem } from './component-market-item';
import { ComponentMarketDetailModal } from './component-market-detail-modal';
import { deriveMarketStatus, findInstalled } from './market-status';

export interface SectionSkillMarketProps {
  /** 来自 page（已安装列表，含 marketRef/installedHash） */
  installedSkills: SkillEntry[];
  /** 安装成功后回调（page 调 refresh，刷新「我的」+ 同源态） */
  onInstalled: () => void;
}

/** 虚框空态占位（复用 loading/empty/error/noProvider 视觉） */
function Placeholder({ text, tone }: { text: string; tone?: 'muted' | 'danger' }) {
  return (
    <div

      className="py-7 text-center text-[13px] font-mono rounded-lg border border-dashed"
      style={{ borderColor: 'var(--border)', color: tone === 'danger' ? 'var(--danger)' : 'var(--muted)' }}
    >
      {text}
    </div>
  );
}

export function SectionSkillMarket({ installedSkills, onInstalled }: SectionSkillMarketProps) {
  const { t } = useTranslation('skill');
  const [caps, setCaps] = useState<MarketCapabilities | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'noProvider' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const [installingRef, setInstallingRef] = useState<string | null>(null);

  // 能力门控：capabilities.stats 含 'installs' 才渲染安装量
  const showInstalls = caps?.capabilities.stats?.includes('installs') ?? false;

  // 挂载能力协商（null → noProvider）
  useEffect(() => {
    let cancelled = false;
    getMarketCapabilities()
      .then((c) => {
        if (cancelled) return;
        if (c === null) { setCapsState('noProvider'); return; }
        setCaps(c);
        setCapsState('ready');
      })
      .catch(() => { if (!cancelled) setCapsState('error'); });
    return () => { cancelled = true; };
  }, []);

  // 执行搜索（空 query → 回空闲态引导，不请求）
  const runSearch = useCallback(async (q: string) => {
    const kw = q.trim();
    if (!kw) { setItems([]); setSearchState('idle'); return; }
    setSearchState('loading');
    try {
      const { items: found } = await searchMarket({ q: kw });
      setItems(found);
      setSearchState('ready');
    } catch {
      setSearchState('error');
    }
  }, []);

  // 防抖 400ms（query 变化触发）；仅 caps ready 时生效
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (capsState !== 'ready') return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(query), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, capsState, runSearch]);

  // 安装：单卡安装中态 → installMarketSkill → onInstalled（父 refresh 兜底同源态）
  const handleInstall = useCallback(async (ref: string) => {
    setInstallingRef(ref);
    try {
      await installMarketSkill({ ref });
      onInstalled();
    } catch {
      // 失败静默（态回落 installable）；错误反馈由后续迭代补 toast
    } finally {
      setInstallingRef(null);
    }
  }, [onInstalled]);

  // 详情 modal 关闭后触发 onInstalled 已在 modal 内回调；此处仅关闭
  const detailInstalled = detailRef ? findInstalled(detailRef, installedSkills) : undefined;

  return (
    <div className="mt-2">
      {capsState === 'loading' && <Placeholder text={t('market.loading')} />}
      {capsState === 'noProvider' && <Placeholder text={t('market.noProvider')} />}
      {capsState === 'error' && <Placeholder text={t('market.error')} tone="danger" />}

      {capsState === 'ready' && (
        <>
          {/* 搜索框（能力门控：caps ready 才渲染） */}
          <div className="relative mb-4" style={{ width: '280px' }}>
            <span className="absolute left-[10px] top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--muted-2)' }}>
              <SearchIcon />
            </span>
            <input
              data-action-key="skill.market.search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(query); }}
              placeholder={t('market.searchPlaceholder')}
              className="w-full h-8 pl-[30px] pr-3 text-[13px] rounded-md outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border-2)', color: 'var(--fg)' }}
            />
          </div>

          {/* 结果区：idle/loading/error/empty/grid */}
          {searchState === 'idle' && <Placeholder text={t('market.searchHint')} />}
          {searchState === 'loading' && <Placeholder text={t('market.loading')} />}
          {searchState === 'error' && <Placeholder text={t('market.error')} tone="danger" />}
          {searchState === 'ready' && items.length === 0 && (
            <Placeholder text={t('market.empty')} />
          )}
          {searchState === 'ready' && items.length > 0 && (
            <div className="grid gap-[14px]" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              {items.map((item) => (
                <ComponentMarketItem
                  key={item.ref}
                  item={item}
                  status={
                    deriveMarketStatus(item.ref, installedSkills, {
                      installing: installingRef === item.ref,
                    }) as 'installable' | 'installing' | 'installed'
                  }
                  showInstalls={showInstalls}
                  onOpenDetail={setDetailRef}
                  onInstall={handleInstall}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* 详情 modal（按需挂载） */}
      {detailRef && (
        <ComponentMarketDetailModal
          itemRef={detailRef}
          installedSkill={detailInstalled}
          onClose={() => setDetailRef(null)}
          onInstalled={onInstalled}
        />
      )}
    </div>
  );
}

/** 放大镜图标（搜索框内嵌） */
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

export default SectionSkillMarket;
