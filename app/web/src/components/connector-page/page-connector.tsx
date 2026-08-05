/**
 * page-connector — 连接器页根
 * 参考: specs/ui/components/connector-page/page-connector.md
 *       UI 协议: specs/ui/overall/05-connectors.md §1/§2
 *       状态机: specs/tech/config/[P1]connectors.md §3
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10/§3.11（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形）
 *
 * 组合：header(标题「连接器」+ desc) + tab 栏（v0.0.23 仅「浏览器」，预埋多 tab）+
 * section-browser-connector。
 *
 * 数据：挂载 GET /config/connectors 取初值；轮询感知 connection 迁移
 * （v0.0.46 起 toggle 不再触发 connect，connecting/connected/error 由 LLM
 * lazy connect 时后端推动；前端只订阅 + 派发 enable/disable，不本地推测）。
 *
 * [v0.0.92] 起：POLL_INTERVAL_MS 2s→5s（terminal 态迁移感知延迟可接受，减负）。
 * [v0.0.94] 数据流走 useLifecycle 四方法：ctx=Snapshot<ConnectorState>（单聚合快照）。
 *   - onInit: GET /config/connectors + effect.startTimer(5s) 声明轮询（禁裸 setInterval）；
 *     返回 browser 项 state（后端未返则 DEFAULT_STATE 兜底）。
 *   - onTick: 5s 到点重读 GET 返新快照（useLifecycle ref-latest 写回 + 排队渲染）。
 *     **保 5s poll 兜底**：connector connecting→终态由后端 lazy connect 推动，无 SSE topic
 *     感知（design-decisions §6）。visibility 暂停/切回 reload 归 useLifecycle 自动管。
 *   - handleToggle: PUT enable/disable 后 reload() 命令式（唯一命令式口子）取后端稳态。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listConnectors,
  putConnectorToggle,
  type ConnectorId,
  type ConnectorState,
} from '../../lib/api-client';
import { useLifecycle } from '../../lib/use-lifecycle';
import type { Snapshot } from '../../lib/lifecycle-shapes';
import { SectionBrowserConnector } from './section-browser-connector';
import { SectionComputerConnector } from './section-computer-connector';

/** tab 列表。label 在 page 内 i18n 注入。
 *  [v0.0.105] 落地第 2 tab computer（架构验证 spike：走 Electron IPC 权限主体，非后端 HTTP）。 */
const TAB_IDS: { id: string; testid: string }[] = [
  { id: 'browser', testid: 'connector-tab-browser' },
  { id: 'computer', testid: 'connector-tab-computer' },
];

/** 连接器 id（v0.0.23 仅 browser） */
const CONNECTOR_ID: ConnectorId = 'browser';

/** 缺省 state（后端未返回 browser 项时兜底，避免 UI 空） */
const DEFAULT_STATE: ConnectorState = {
  id: CONNECTOR_ID,
  switch: 'off',
  connection: 'disconnected',
};

/** 轮询间隔：[v0.0.92] 2s→5s（connecting→终态感知延迟可接受，减负） */
const POLL_INTERVAL_MS = 5000;

/** 从 GET /config/connectors items 中取 browser 项（未返则 DEFAULT_STATE 兜底） */
function pickBrowser(items: ConnectorState[]): ConnectorState {
  return items.find((it) => it.id === CONNECTOR_ID) ?? DEFAULT_STATE;
}

/**
 * 渲染连接器页根。挂载取 state；5s onTick 轮询感知终态；toggle 派发 enable/disable 后 reload。
 * 本地态：当前 tab（默认 browser）。
 */
export function PageConnector() {
  // ctx=Snapshot<ConnectorState>（单聚合快照）。onInit GET + startTimer(5s)；onTick 5s 重读。
  // 无 SSE topic 携带 connector 状态 → 无 onEvent，纯 poll 兜底（不变量④ justification 必写）。
  const { ctx: state, reload } = useLifecycle<Snapshot<ConnectorState>>({
    onInit: async ({ signal, startTimer }) => {
      startTimer({
        intervalMs: POLL_INTERVAL_MS,
        justification: 'connector connecting→终态由后端 lazy connect 推动，无 SSE topic 感知',
      });
      const items = await listConnectors();
      // 不变量②：fetch 后必须校验 signal.aborted 才能「生效」（杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return pickBrowser(items);
    },
    // onTick: 5s 到点重读，返回新快照（useLifecycle ref-latest 写回 + 排队渲染）
    onTick: async () => {
      const items = await listConnectors();
      return pickBrowser(items);
    },
    deps: [],
  });

  const [tab, setTab] = useState('browser');
  // [v0.0.62 i18n] 连接器页 UI 文案走 connector ns
  const { t } = useTranslation('connector');
  // 注入 i18n label
  const TABS = TAB_IDS.map((tab) => ({ ...tab, label: t('tab.' + tab.id) }));

  /**
   * 派发 enable/disable（08-web-tools.md §6.2）。
   * v0.0.46：toggle 只切 intent（switch），后端不触发 connect —— 立即回推
   * `{switch:'on', connection:'disconnected'}` 稳态；UI 不本地推测 connecting。
   * connecting/connected/error 由 LLM 触发 lazy connect 时后端推动，前端靠 onTick 轮询感知。
   * PUT 后 reload() 取后端稳态（唯一命令式口子）。
   */
  const handleToggle = async (enable: boolean) => {
    try {
      await putConnectorToggle(CONNECTOR_ID, enable);
    } catch {
      // 派发失败：reload 兜底（保持与后端一致，避免 UI 假态）
    }
    // 立即 reload：让 UI 拿到后端稳态（switch 变化 + connection=disconnected）
    await reload();
  };

  return (
    <main

      className="flex-1 overflow-y-auto flex flex-col"
    >
      {/* header：标题 + sub desc（对齐 skill-page header 风格） */}
      <div className="px-8 pt-6 pb-[18px] border-b border-border shrink-0">
        <div

          className="text-[20px] font-bold tracking-[-0.02em] text-fg"
        >
          {t('header.title')}
        </div>
        <div

          className="mt-[3px] text-[12px] text-muted font-mono"
        >
          {t('header.desc')}
        </div>
      </div>

      {/* body：tab 栏 + 当前 tab 内容（对齐 skill-page body，max-width 880px） */}
      <div className="px-8 pt-5 pb-10 flex-1" style={{ maxWidth: '880px' }}>
        {/* tab 栏（v0.0.23 仅 browser，预埋多 tab；对齐 skill-tabs 风格） */}
        <div

          className="flex gap-1 mb-[18px] border-b border-border"
        >
          {TABS.map((t) => {
            const isActive = t.id === tab;
            return (
              <div
                key={t.id}
                data-action-key={`connector.${t.id}.open-tab`}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setTab(t.id);
                  }
                }}
                className={
                  'text-[13px] font-semibold px-[14px] py-2 border-b-2 -mb-px cursor-pointer transition-colors ' +
                  (isActive
                    ? 'text-accent border-accent'
                    : 'text-muted-2 border-transparent hover:text-fg-2')
                }
              >
                {t.label}
              </div>
            );
          })}
        </div>

        {/* tab 内容：browser 受控（onInit 未完成用 DEFAULT_STATE 兜底）；
            [v0.0.105] computer 自管 IPC 态（不受 ConnectorState 驱动，无需 state/onToggle） */}
        {tab === 'browser' && (
          <SectionBrowserConnector state={state ?? DEFAULT_STATE} onToggle={handleToggle} />
        )}
        {tab === 'computer' && <SectionComputerConnector />}
      </div>
    </main>
  );
}

export default PageConnector;
