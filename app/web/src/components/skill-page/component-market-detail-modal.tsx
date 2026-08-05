/**
 * component-market-detail-modal — 市场 skill 详情弹窗（区别于本地 component-skill-preview-modal）。
 * 参考: specs/ui/components/skill-page/component-market-detail-modal.md
 *       设计稿 reqs/[working] v0.0.167.skill_market_ui/design/skill-market-detail.html
 *
 * 挂载调 getMarketDetail(itemRef) 取 readme + files + hash。
 * 展示：头(icon-box + name + ref + repository + 已安装 badge) + readme + 文件清单 + 底部状态区。
 * 惰性可更新：本 modal 是唯一做 hash 比对的地方——已安装项点「检查更新」比对
 * detail.hash 与 installedSkill.installedHash（invariant#6）；更新 = installMarketSkill(ref,{overwrite:true})。
 * 能力门控裁剪：不渲染设计稿 version/许可/stars 的 stat 条（skills.sh 未声明）。
 *
 * 注：prop 名用 `itemRef` 而非 spec 的 `ref`——`ref` 是 React 保留属性名，作普通 prop 会被拦截。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconBox } from '../common/component-icon-box';
import { getMarketDetail, installMarketSkill, type MarketDetail, type SkillEntry } from '../../lib/api-client';

export interface ComponentMarketDetailModalProps {
  /** 市场 item.ref（打开时传入） */
  itemRef: string;
  /** 若该 ref 已安装（父按 marketRef 匹配后传入；含 installedHash） */
  installedSkill?: SkillEntry;
  onClose: () => void;
  /** 安装/更新成功回调（父 refresh） */
  onInstalled: () => void;
}

export function ComponentMarketDetailModal({
  itemRef,
  installedSkill,
  onClose,
  onInstalled,
}: ComponentMarketDetailModalProps) {
  const { t } = useTranslation('skill');
  const { t: tc } = useTranslation('common');
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [installing, setInstalling] = useState(false);
  // null = 未检查 / 未安装；true/false = 已比对结果
  const [updatable, setUpdatable] = useState<boolean | null>(null);
  const isInstalled = installedSkill !== undefined;

  // 挂载取详情
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    getMarketDetail(itemRef)
      .then((d) => { if (!cancelled) { setDetail(d); setState('ready'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [itemRef]);

  // 检查更新：惰性比对 detail.hash vs 已安装 installedHash
  const handleCheckUpdate = useCallback(() => {
    if (!detail || !installedSkill) return;
    // 缺锚点保守视为已是最新（不误判可更新，对齐 deriveMarketStatus）：
    // detail.hash 缺失（provider 未返）或 installedHash 缺失（legacy 无锚点）→ false。
    setUpdatable(
      detail.hash !== undefined &&
      installedSkill.installedHash !== undefined &&
      detail.hash !== installedSkill.installedHash,
    );
  }, [detail, installedSkill]);

  // 安装（未安装项）
  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      await installMarketSkill({ ref: itemRef });
      onInstalled();
    } finally {
      setInstalling(false);
    }
  }, [itemRef, onInstalled]);

  // 更新（同源覆盖重装）
  const handleUpdate = useCallback(async () => {
    setInstalling(true);
    try {
      await installMarketSkill({ ref: itemRef, overwrite: true });
      onInstalled();
      setUpdatable(false); // 更新后转「已是最新」
    } finally {
      setInstalling(false);
    }
  }, [itemRef, onInstalled]);

  const repoUrl = detail?.repository?.url;

  return (
    <div

      onClick={onClose}
      className="fixed inset-0 flex items-center justify-center z-[200]"
      style={{ background: 'rgba(24,24,27,0.32)' }}
    >
      <div

        onClick={(e) => e.stopPropagation()}
        className="flex flex-col overflow-hidden rounded-2xl"
        style={{ width: '720px', maxHeight: '760px', background: 'var(--surface)', boxShadow: 'var(--shadow-lg)' }}
      >
        {/* head */}
        <div className="px-6 pt-5 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-start gap-4">
            <IconBox hueBy={itemRef} size={34} icon={<SkillStarIcon />} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[18px] font-bold" style={{ color: 'var(--fg)' }}>
                  {detail?.name ?? itemRef}
                </span>
                {isInstalled && (
                  <span

                    className="inline-flex items-center gap-1 px-2 py-[2px] rounded-full text-[11px] font-medium"
                    style={{ background: 'var(--success-bg)', color: 'var(--success)' }}
                  >
                    <span className="w-[6px] h-[6px] rounded-full" style={{ background: 'currentColor' }} />
                    {t('market.status.installed')}
                  </span>
                )}
                {updatable === true && (
                  <span

                    className="inline-flex items-center gap-1 px-2 py-[2px] rounded-full text-[11px] font-medium"
                    style={{ background: 'var(--info-bg)', color: 'var(--info)' }}
                  >
                    <span className="w-[6px] h-[6px] rounded-full" style={{ background: 'currentColor' }} />
                    {t('market.status.updatable')}
                  </span>
                )}
              </div>
              <div className="text-[13px] mt-[2px] truncate" style={{ color: 'var(--muted)' }}>
                <span className="font-mono text-[12px]">{itemRef}</span>
                {repoUrl && (
                  <>
                    {' · '}
                    <a href={repoUrl} target="_blank" rel="noreferrer" className="font-mono text-[12px] underline" style={{ color: 'var(--muted)' }}>
                      {t('market.detail.viewSource')}
                    </a>
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              data-action-key="skill.market.close-detail"
              onClick={onClose}
              aria-label={tc('modal.close')}
              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-[var(--surface-2)]"
              style={{ color: 'var(--muted)' }}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* body：readme + 文件清单 */}
        <div className="px-6 py-[18px] overflow-y-auto flex-1">
          {state === 'loading' && (
            <div className="py-6 text-center text-[13px] font-mono" style={{ color: 'var(--muted)' }}>
              {t('market.detail.loading')}
            </div>
          )}
          {state === 'error' && (
            <div className="py-6 text-center text-[13px] font-mono" style={{ color: 'var(--danger)' }}>
              {t('market.detail.error')}
            </div>
          )}
          {state === 'ready' && detail && (
            <>
              {detail.readme && (
                <pre

                  className="text-[13px] leading-[1.7] whitespace-pre-wrap break-words font-sans m-0"
                  style={{ color: 'var(--fg-2)' }}
                >
                  {detail.readme}
                </pre>
              )}
              {detail.files && detail.files.length > 0 && (
                <div className="mt-4">
                  <div className="text-[14px] font-semibold mb-1" style={{ color: 'var(--fg)' }}>
                    {t('market.detail.files')}
                  </div>
                  {detail.files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 py-[5px] font-mono text-[12px]" style={{ color: 'var(--fg-3)' }}>
                      <FileMiniIcon />
                      {f.path}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* foot：状态区（互斥态） */}
        <div
          className="px-6 py-[14px] flex items-center justify-end gap-[10px]"
          style={{ borderTop: '1px solid var(--border)', background: 'var(--chrome)' }}
        >
          {!isInstalled && (
            <button
              type="button"
              data-action-key="skill.market.install"
              disabled={installing || state !== 'ready'}
              onClick={handleInstall}
              className="inline-flex items-center gap-1 px-4 py-[6px] rounded-md text-[13px] font-semibold border-none cursor-pointer transition-opacity hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)' }}
            >
              {installing ? t('market.btn.installing') : t('market.btn.install')}
            </button>
          )}
          {isInstalled && updatable === null && (
            <button
              type="button"
              data-action-key="skill.market.check-update"
              disabled={state !== 'ready'}
              onClick={handleCheckUpdate}
              className="inline-flex items-center gap-1 px-4 py-[6px] rounded-md text-[13px] font-semibold cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--btn-secondary-bg)', color: 'var(--btn-secondary-fg)', border: '1px solid var(--btn-secondary-border)' }}
            >
              {t('market.btn.checkUpdate')}
            </button>
          )}
          {isInstalled && updatable === true && (
            <button
              type="button"
              data-action-key="skill.market.update"
              disabled={installing}
              onClick={handleUpdate}
              className="inline-flex items-center gap-1 px-4 py-[6px] rounded-md text-[13px] font-semibold border-none cursor-pointer transition-opacity hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)' }}
            >
              {installing ? t('market.btn.installing') : t('market.btn.update')}
            </button>
          )}
          {isInstalled && updatable === false && (
            <span className="text-[13px] font-mono" style={{ color: 'var(--muted)' }}>
              {t('market.status.upToDate')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 四角星 skill icon */
function SkillStarIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
function FileMiniIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: 'var(--muted-2)' }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export default ComponentMarketDetailModal;
