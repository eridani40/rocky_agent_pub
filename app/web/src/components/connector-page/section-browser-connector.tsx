/**
 * section-browser-connector — 浏览器连接器卡片
 * 参考: specs/ui/components/connector-page/section-browser-connector.md
 *       UI 协议: specs/ui/overall/05-connectors.md §2/§3
 *       双状态机: specs/tech/config/[P1]connectors.md §3
 *
 * 受控组件：state 由父级（page-connector）订阅后端 ConnectorManager 推回，
 * 本 section 只渲染双状态 + 派发 enable/disable（不直接 attach chrome）。
 * UI 态由 state.switch + state.connection 组合派生（见 §3 状态机映射表）。
 *
 * v0.0.46：switch 与 connection 完全解耦——toggle on 只表达「用户已启用」，
 * 不再触发 connect（connect 由 LLM 首次 attach 时 lazy 触发）。
 * 因此 disconnected 需要根据 switch 分「未启用」/「已启用（未连接）」两文案。
 */
import type { ConnectorState } from '../../lib/api-client';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

interface SectionBrowserConnectorProps {
  /** 连接器实时状态（switch + connection + errorDetail? + lastConnectedAt?） */
  state: ConnectorState;
  /** 派发 enable/disable → ConnectorManager（经 HTTP facade） */
  onToggle: (enable: boolean) => void;
}

/** 展示层三元素：文案 + 色点 class + 文本颜色 class */
type StatusView = { text: string; dot: string; textCls: string };

/**
 * 由 switch + connection 组合派生 status 展示（v0.0.46 分层文案）。
 * - switch=off：一律显「未启用」（不区分 connection error/disconnected）
 * - switch=on：按 connection 显示（disconnected 显「已启用（未连接）」）
 *
 * [v0.0.62 i18n] 文案查 connector.browser.connection.<code> 表（T6 type code 范式）；
 * switch=off 是 UI 层 overlay（非 connection code），查 connector.browser.switchOff。
 *
 * @param t connector ns 的 t 函数（绑定了 'connector' ns，故 key 用 'browser.<leaf>'）
 */
function deriveStatus(state: ConnectorState, t: TFunction): StatusView {
  if (state.switch !== 'on') {
    return { text: t('browser.switchOff'), dot: 'bg-border-strong', textCls: 'text-muted' };
  }
  switch (state.connection) {
    case 'disconnected':
      return { text: t('browser.connection.disconnected'), dot: 'bg-border-strong', textCls: 'text-muted' };
    case 'connecting':
      return { text: t('browser.connection.connecting'), dot: 'bg-gold', textCls: 'text-gold' };
    case 'connected':
      return { text: t('browser.connection.connected'), dot: 'bg-sage', textCls: 'text-sage' };
    case 'error':
      return { text: t('browser.connection.error'), dot: 'bg-danger', textCls: 'text-danger' };
  }
}

/** chrome remote debugging 开启步骤（引导，05-connectors.md §2 guide-step-1..4）。
 *  [v0.0.62 i18n] 文案走 connector ns t() 查表（testid 仅 UI 锚点不变）。 */
const GUIDE_STEP_KEYS = ['step1', 'step2', 'step3', 'step4'] as const;
const GUIDE_STEP_TESTIDS: Record<(typeof GUIDE_STEP_KEYS)[number], string> = {
  step1: 'browser-connector-guide-step-1',
  step2: 'browser-connector-guide-step-2',
  step3: 'browser-connector-guide-step-3',
  step4: 'browser-connector-guide-step-4',
};

/**
 * 渲染浏览器连接器卡片（v0.0.46 lazy connect 语义）。
 * - toggle 视觉态：connecting 禁用防抖（避免重复触发）；其他态可点。
 * - 点 toggle on → onToggle(true)：后端 enable 只写 intent + 立即回推
 *   `{switch:'on', connection:'disconnected'}`，UI 立即显 on + 「已启用（未连接）」；
 *   **不再进入 connecting 局部态**（等 LLM 首次 attach 时才 lazy connect）。
 * - 点 toggle off（当前 on）→ onToggle(false)：若已连接后端 driver.disconnect + 收敛到 off。
 * - error 态显 errorDetail + 重试 button（=再 onToggle(true)）。
 */
export function SectionBrowserConnector({ state, onToggle }: SectionBrowserConnectorProps) {
  const isOn = state.switch === 'on';
  // connecting 中禁用 toggle 防抖（避免重复派发 enable）
  const isConnecting = state.connection === 'connecting';
  // [v0.0.62 i18n] 连接器文案走 connector ns
  const { t } = useTranslation('connector');
  // v0.0.46：文案由 switch + connection 组合派生（switch=off→未启用；on+disconnected→已启用未连接）
  const status = deriveStatus(state, t);

  return (
    <section>
      <div

        className="flex flex-col gap-3 px-4 py-3 rounded-[10px] bg-surface-2 border border-border"
      >
        {/* name + desc + toggle 行 */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div

              className="text-[13.5px] font-semibold text-fg"
            >
              {t('browser.name')}
            </div>
            <div

              className="mt-[3px] text-[12px] text-muted-2 leading-[1.5]"
            >
              {t('browser.desc')}
            </div>
          </div>
          {/* toggle + connecting 内联反馈（v0.0.29 BUG-004：点击即时反馈，放在按钮旁 top row） */}
          <div className="flex items-center gap-2 shrink-0">
            <ToggleSwitch
              value={isOn}
              // connecting 中禁用防抖：阻止重复点击（pointer-events-none + 透传 onChange 由 button 处理）
              onChange={(next) => {
                if (isConnecting) return;
                onToggle(next);
              }}
              label={t('browser.switchLabel')}
              actionKey="connector.browser.toggle"
            />
            {isConnecting && (
              <span

                aria-hidden
                className="inline-flex items-center gap-1 text-[11px] font-mono text-gold whitespace-nowrap"
              >
                {/* 小 spinner：用 gold 圆点 + animate-pulse（复用现有 token，避免引入新动画） */}
                <span
                  className="inline-block w-[6px] h-[6px] rounded-full bg-gold animate-pulse"
                />
                {t('browser.connectingInline')}
              </span>
            )}
          </div>
        </div>

        {/* status 行：色点 + 文本（+ connecting 时 spinner） */}
        <div className="flex items-center gap-2">
          <span

            aria-hidden
            className={
              'inline-block w-[7px] h-[7px] rounded-full ' + status.dot +
              (isConnecting ? ' animate-pulse' : '')
            }
          />
          <span

            className={'text-[12px] font-mono ' + status.textCls}
          >
            {status.text}
          </span>
          {state.connection === 'connected' && state.lastConnectedAt && (
            <span className="text-[11px] font-mono text-muted-2">
              · {formatTime(state.lastConnectedAt)}
            </span>
          )}
        </div>

        {/* error 态：原因 + 重试 button（重试 = 再 onToggle(true)）
            switch=off 时 status 已收敛为「未启用」，error 区块也随之收起（防御式，
            后端 disable 已清 connection，此处仅兜底 stale state）。 */}
        {isOn && state.connection === 'error' && (
          <div

            className="flex items-center gap-2 px-3 py-2 rounded-md bg-danger-light"
          >
            <span className="flex-1 text-[12px] font-mono text-danger leading-[1.5]">
              {state.errorDetail || t('browser.errorDefault')}
            </span>
            <button
              type="button"
              data-action-key="connector.browser.retry"
              onClick={() => onToggle(true)}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-[12px] font-semibold border border-danger text-danger hover:bg-danger hover:text-white transition-colors shrink-0"
            >
              {t('browser.retry')}
            </button>
          </div>
        )}

        {/* guide 副标题（v0.0.46）：解释 lazy connect 语义 —— 开关只启用功能，
            实际连接由 agent 首次使用 browser attach 时触发。 */}
        <div

          className="mt-1 text-[12px] text-muted-2 leading-[1.6]"
        >
          {t('browser.guideSubtitle')}
        </div>
        {/* guide：chrome remote debugging 开启步骤 */}
        <ol

          className="flex flex-col gap-1 pl-1 text-[12px] text-muted-2 font-mono leading-[1.6]"
        >
          {GUIDE_STEP_KEYS.map((key, i) => (
            <li key={key} className="flex gap-2">
              <span className="shrink-0 text-muted">{i + 1}.</span>
              <span>{t(`browser.guide.${key}`)}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** 格式化时间戳（仅 connected 态展示） */
function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

export default SectionBrowserConnector;
