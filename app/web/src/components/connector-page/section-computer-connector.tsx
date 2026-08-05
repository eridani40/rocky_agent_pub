/**
 * section-computer-connector — 电脑连接器卡片（v0.0.105 架构验证 spike）
 * 参考: specs/ui/components/connector-page/section-computer-connector.md
 *       UI 协议: specs/ui/overall/05-connectors.md §4
 *
 * 架构 pivot：权限主体 = Rocky Electron 本体。经 window.rockyComputer（preload contextBridge）
 * → 主进程原生能力（desktopCapturer / systemPreferences），共享 Rocky TCC 身份。**不走后端 HTTP**。
 *
 * 自管 IPC 态（区别于 section-browser-connector 受控）：挂载拉权限 + window focus 重拉
 * （从系统设置授权回来自动刷新）+ 手动重检 + 测试截图渲染缩略图（证明真截到）。
 * window.rockyComputer 不存在 = 非 Electron 环境 → 降级「仅桌面 App 可用」。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ComputerPermissions, ComputerScreenshotResult } from '../../types/rocky-computer';

/** 卡片头部（name + desc），降级/正常态共用 */
function CardHeader({ t }: { t: TFunction }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[13.5px] font-semibold text-fg">
        {t('computer.name')}
      </div>
      <div

        className="mt-[3px] text-[12px] text-muted-2 leading-[1.5]"
      >
        {t('computer.desc')}
      </div>
    </div>
  );
}

interface PermRowProps {
  label: string;
  granted: boolean;
  /** granted 时的补充说明（如屏幕录制原始状态），可选 */
  detail?: string;
  /** 未授权时的操作按钮 */
  action: React.ReactNode;
  t: TFunction;
}

/** 单条权限行：名称 + ✓/✗ 状态 + （未授权时）操作按钮 */
function PermRow({ label, granted, detail, action, t }: PermRowProps) {
  return (
    <div

      className="flex items-center gap-3 py-2 border-b border-border last:border-b-0"
    >
      <span className="flex-1 text-[12.5px] text-fg">{label}</span>
      <span

        className={
          'text-[12px] font-mono ' + (granted ? 'text-sage' : 'text-danger')
        }
      >
        {granted ? `✓ ${t('computer.granted')}` : `✗ ${t('computer.denied')}`}
        {granted && detail ? ` (${detail})` : ''}
      </span>
      {action}
    </div>
  );
}

/** 次级操作按钮样式（复用 browser retry button 基调，避免造新 token） */
const BTN_CLS =
  'inline-flex items-center gap-1 px-3 py-1 rounded-md text-[12px] font-semibold ' +
  'border border-border text-fg-2 hover:bg-surface-3 transition-colors shrink-0 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * 渲染电脑连接器卡片。api = window.rockyComputer（非 Electron 为 undefined → 降级）。
 */
export function SectionComputerConnector() {
  const { t } = useTranslation('connector');
  const api = typeof window !== 'undefined' ? window.rockyComputer : undefined;

  const [perms, setPerms] = useState<ComputerPermissions | null>(null);
  const [shot, setShot] = useState<ComputerScreenshotResult | null>(null);
  const [busy, setBusy] = useState(false);

  /** 重拉权限态（IPC 失败静默保持旧态，不制造假态） */
  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setPerms(await api.getPermissions());
    } catch {
      // 静默：IPC 失败保持旧态
    }
  }, [api]);

  // 挂载拉一次 + window focus 重拉（用户从系统设置授权完回到 Rocky 自动刷新）
  useEffect(() => {
    if (!api) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [api, refresh]);

  // 非 Electron 环境降级
  if (!api) {
    return (
      <section>
        <div

          className="flex flex-col gap-3 px-4 py-3 rounded-[10px] bg-surface-2 border border-border"
        >
          <div className="flex items-start gap-3">
            <CardHeader t={t} />
          </div>
          <div

            className="px-3 py-2 rounded-md bg-surface-3 text-[12px] text-muted leading-[1.5]"
          >
            {t('computer.unavailable')}
          </div>
        </div>
      </section>
    );
  }

  const handleRequestAccessibility = async () => {
    setBusy(true);
    try {
      await api.requestAccessibility();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleOpenScreenRecording = async () => {
    try {
      await api.openScreenRecordingSettings();
    } catch {
      // 静默：openExternal 失败不阻塞（用户可手动去系统设置）
    }
  };

  const handleTestScreenshot = async () => {
    setBusy(true);
    try {
      setShot(await api.testScreenshot());
    } catch (e) {
      setShot({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const accessibilityGranted = perms?.accessibility === true;
  const screenGranted = perms?.screenRecording === 'granted';

  return (
    <section>
      <div

        className="flex flex-col gap-3 px-4 py-3 rounded-[10px] bg-surface-2 border border-border"
      >
        {/* name + desc + 重新检测 */}
        <div className="flex items-start gap-3">
          <CardHeader t={t} />
          <button
            type="button"
            data-action-key="connector.computer.refresh"
            onClick={() => void refresh()}
            disabled={busy}
            className={BTN_CLS}
          >
            {t('computer.refresh')}
          </button>
        </div>

        {/* 权限面板：两行 accessibility + screen-recording */}
        <div

          className="flex flex-col px-3 rounded-md bg-surface-3"
        >
          <PermRow

            label={t('computer.accessibility')}
            granted={accessibilityGranted}
            t={t}
            action={
              !accessibilityGranted && (
                <button
                  type="button"
                  data-action-key="connector.computer.request-accessibility"
                  onClick={() => void handleRequestAccessibility()}
                  disabled={busy}
                  className={BTN_CLS}
                >
                  {t('computer.requestAccessibility')}
                </button>
              )
            }
          />
          <PermRow

            label={t('computer.screenRecording')}
            granted={screenGranted}
            detail={perms?.screenRecording}
            t={t}
            action={
              !screenGranted && (
                <button
                  type="button"
                  data-action-key="connector.computer.open-screen-recording"
                  onClick={() => void handleOpenScreenRecording()}
                  className={BTN_CLS}
                >
                  {t('computer.openScreenRecording')}
                </button>
              )
            }
          />
        </div>

        {/* 测试截图：证明 Rocky 作为权限主体真截到图 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-action-key="connector.computer.test-screenshot"
            onClick={() => void handleTestScreenshot()}
            disabled={busy}
            className={
              'inline-flex items-center gap-1 px-3 py-1 rounded-md text-[12px] font-semibold ' +
              'border border-accent text-accent hover:bg-accent hover:text-white transition-colors ' +
              'shrink-0 disabled:opacity-60 disabled:cursor-not-allowed'
            }
          >
            {t('computer.testScreenshot')}
          </button>
          <span className="text-[11px] text-muted-2 font-mono">{t('computer.testScreenshotHint')}</span>
        </div>

        {/* 截图结果：成功渲染缩略图（append 在底部，不位移上方元素） */}
        {shot?.ok && shot.dataUrl && (
          <img

            src={shot.dataUrl}
            alt={t('computer.screenshotOk')}
            className="rounded-md border border-border max-w-full self-start"
            style={{ maxWidth: '320px' }}
          />
        )}
        {shot && !shot.ok && (
          <div

            className="px-3 py-2 rounded-md bg-danger-light text-[12px] font-mono text-danger leading-[1.5]"
          >
            {t('computer.screenshotFail')}: {shot.reason}
          </div>
        )}
      </div>
    </section>
  );
}

export default SectionComputerConnector;
