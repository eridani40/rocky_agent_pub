/**
 * AppShell — 2 栏布局根（ui §2 v2.0）
 * 参考: specs/ui/overall/02-llm-chat.md §2.1 v2.0（窄图标栏 testid 表）/
 *       §2.2（激活态 + 布局稳定性）
 *
 * v0.0.5：从扁平 `components/AppShell.tsx` 迁入 `framework/app-shell/app-shell.tsx`
 * （纯结构迁移零行为变更）。左栏 nav 抽出为独立 NavRail 组件（framework/nav-rail/）。
 * [v0.0.33.1] nav 改造：testid `nav-chat`→`nav-playground`、新增 `nav-studio`、设置组收纳进
 *   `nav-settings-group`（齿轮，展开 `nav-settings-group-menu`）、去 `nav-theme-toggle`；
 *   view id `'chat'`→`'playground'` + 新增 `'studio'`（路由到 page-studio）。
 * [v0.0.47] nav 改造：删 `nav-settings-group` 齿轮子菜单 + 底部三独立入口（nav-skill/nav-connector/nav-settings-app）；
 *   view id 删 `'settings-dev'` / `'settings-plugin'`（合并入 `'settings-app'`），`'settings-app'`
 *   路由改到新 `<PageAppSettingsMerged />`（合并页：app tabs + 展开系统配置 + dev tabs + 插件 tab）。
 * [v0.0.150] 启动期迁移错误提示：useEffect 调 fetchBootstrapStatus → errors.length>0 渲染
 *   <MigrationErrorModal>（走 createPortal，无错零感知）。
 *
 * v0.0.4 修订背景：左栏从 ~220px 文字会话列表改为 ~56px 窄图标栏，
 * 4 个图标按钮，每个带 hover tooltip；nav-chat 可点击切 chat view；
 * 激活 view 对应图标视觉强调（terracotta 边框 / 左竖条）。移除 sidebar-sessions。
 */
import { useEffect, useState } from 'react';
import { useViewStore, type ViewId } from '../../../store/view-store';
// [v0.0.150] 启动期迁移错误提示通道
import { fetchBootstrapStatus, type BootstrapStatusResponse } from '../../../lib/bootstrap-status-api';
import { MigrationErrorModal, type MigrationErrorItem } from './migration-error-modal';
// v0.0.8：chat 主区从扁平 ChatPage 切换为组件式 PageChat（三栏 + 真实 session API）
import { PageChat } from '../../chat-page/page-chat';
// v0.0.5：从扁平 settings/*SettingsPage 切换为组件式 page（app-dev-config-page/、
// plugin-config-page/）。v0.0.7：providers 重做为 providers/ 三级流（list/detail/modal）
// 取代旧 settings/ProvidersSection + ProviderForm + ModelForm。
// [v0.0.47] PageAppConfig/PageDevConfig/PagePluginConfig 不再独立路由——
// 合并入 PageAppSettingsMerged（应用设置合并页：app tabs + 展开系统配置 + dev tabs + 插件 tab）。
// 三个原子页文件保留，作为合并页内嵌的 tab 内容复用（page-app-settings-merged.tsx import）。
import { PageAppSettingsMerged } from '../../app-dev-config-page/page-app-settings-merged';
// [v0.0.21] skill 管理页
import { PageSkill } from '../../skill-page/page-skill';
// [v0.0.23] 连接器页
import { PageConnector } from '../../connector-page/page-connector';
// 渠道页（IM 渠道接入层，飞书）
import { PageChannel } from '../../channel-page/page-channel';
// [v0.0.33.1] Studio 团队管理页（squad CRUD + 4-tab 面板 + 占位 chat）
import { PageStudio } from '../../studio-page/page-studio';
// [v0.0.210] Academy 教室培养页（双引擎：head/coach/student session + 训练引擎观察）
import { PageAcademy } from '../../academy-page/page-academy';
import { NavRail } from '../nav-rail/nav-rail';

/** AppShell 根：2 栏布局（窄图标栏 + 主区 currentView 路由）—— ui §2 v2.0 */
export function AppShell() {
  const currentView = useViewStore((s) => s.currentView);
  const setView = useViewStore((s) => s.setView);

  // [v0.0.150] 启动期迁移错误提示：拉 /bootstrap/status → errors>0 显示 modal
  // 仅跑一次（启动期一次性快照），失败兜底空 errors（不阻塞 UI）。
  const [migrationErrors, setMigrationErrors] = useState<MigrationErrorItem[]>([]);
  const [showMigrationModal, setShowMigrationModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status: BootstrapStatusResponse = await fetchBootstrapStatus();
      if (cancelled) return;
      if (status.migrationErrors.length > 0) {
        setMigrationErrors(status.migrationErrors);
        setShowMigrationModal(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg">
      {/* 左栏：窄图标栏 ~56px（w-14 = 56px），垂直均布排列 4 图标 —— ui §2.1 v2.0 */}
      <aside

        className="flex flex-col items-center w-14 shrink-0 gap-2 py-3 border-r border-border bg-surface"
      >
        <NavRail currentView={currentView} onChange={setView} />
      </aside>

      {/* 右栏主区：按 currentView 路由 —— ui §1.1 */}
      <main className="flex-1 min-w-0 overflow-hidden">
        {renderView(currentView)}
      </main>

      {/* [v0.0.150] 迁移错误 modal（仅 errors>0 时渲染；走 createPortal 脱离祖先链） */}
      {showMigrationModal && migrationErrors.length > 0 && (
        <MigrationErrorModal
          errors={migrationErrors}
          onConfirm={() => setShowMigrationModal(false)}
          onOpenLogDir={() => {
            // v0.0.253: window.rockyShell.openPath IPC 已就绪（见 open-external-ipc.ts）。
            // 但渲染层无 DATA_DIR 绝对路径（packaged 下由 runtime-config 注入主进程 env，
            // 不暴露给 renderer）——本回调暂留 noop；后续若加 logsDir IPC（main 侧解析 DATA_DIR/logs）可补全。
          }}
        />
      )}
    </div>
  );
}

/** 按 currentView 渲染对应主区页面（ui §1.1；[v0.0.33.1] chat→playground + 新增 studio；[v0.0.47] settings-dev/plugin 合并入 settings-app） */
function renderView(view: ViewId) {
  switch (view) {
    // [v0.0.33.1] Playground（原 'chat' 改名）：路由到 PageChat 不变，仅 view id 改名
    case 'playground':
      return <PageChat />;
    // [v0.0.33.1] Studio：squad 团队管理（06-studio.md）
    case 'studio':
      return <PageStudio />;
    // [v0.0.210] Academy：教室培养板块（12-academy.md）
    case 'academy':
      return <PageAcademy />;
    // [v0.0.47] 应用设置合并页（app config + dev config + 插件 三合一）—— 替代原 PageAppConfig
    case 'settings-app':
      return <PageAppSettingsMerged />;
    // [v0.0.21] skill 管理页
    case 'skill':
      return <PageSkill />;
    // [v0.0.23] 连接器页
    case 'connector':
      return <PageConnector />;
    // 渠道页（IM 渠道接入层，飞书）
    case 'channel':
      return <PageChannel />;
    default:
      return <PageChat />;
  }
}

export default AppShell;
