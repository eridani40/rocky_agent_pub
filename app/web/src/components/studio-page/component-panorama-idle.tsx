/**
 * component-panorama-idle —— 全景「更多」tab 引导卡（提醒用户可以让 leader 搭看板）
 * 参考: specs/ui/components/studio-page/component-panorama-idle.md v1.0
 *
 * v0.0.243 恢复：v0.0.240 删了 idle 组件（panorama 内嵌首页第二栏 + 删「更多」tab）。
 *   本版本恢复「更多」tab + 此 idle 引导（用户原话：永远在最右，提醒用户可以用这个功能）。
 *
 * 核心产品决策：业务全景由 leader 搭建，用户不写 DSL——「更多」tab 的引导指向「说话」
 * 不是「配置」。点击按钮 → 切 leader 单聊 + composer 预填搭看板模板文本（onAtLeader 回调）。
 * 边界：纯展示 + onAtLeader 回调；跳转 + 预填逻辑在 page-studio。
 */
import { useTranslation } from 'react-i18next';
import { IconBox } from '../common/component-icon-box';
import { Icon } from './studio-icons';
import { BTN_PRIMARY } from './studio-styles';

export interface PanoramaIdleProps {
  squadId: string;
  /** 跳 leader 单聊 + 预填搭看板模板文本（page-studio 组装 ChatNode + prefill string） */
  onAtLeader: () => void;
}

/** 空态 icon（全景 = 四象限网格 glyph） */
const PanoramaGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={16} height={16} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

/** 引导卡：居中白卡（标题 + 文案 + 「找 leader 搭看板」按钮） */
export function PanoramaIdle({ onAtLeader }: PanoramaIdleProps) {
  const { t } = useTranslation('studio');
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center">
        <IconBox hue="violet" size={32} icon={PanoramaGlyph} />
        <div>
          <div className="text-[15px] font-semibold text-fg">
            {t('panorama.idle.title')}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">{t('panorama.idle.subtitle')}</div>
        </div>
        <div className="text-[12.5px] leading-relaxed text-fg-2">
          {t('panorama.idle.desc')}
        </div>
        <button type="button" onClick={onAtLeader} className={BTN_PRIMARY} data-action-key="studio.panorama.ask-leader">
          <Icon name="chat" size={13} />
          {t('panorama.idle.atLeaderBtn')}
        </button>
      </div>
    </div>
  );
}

export default PanoramaIdle;
