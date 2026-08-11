/**
 * section-team-sync — 团队同步页（v0.0.319）
 * 参考: specs/prd/v0.0.319-team-sync.md §2.1-§2.3
 *       specs/tech/version_logs/v0.0.321/change_plan.md D2（导出选择器）
 *
 * 三态：landing（入口）/ export（[v0.0.321] 弹选择器 modal → 选团队 → 下载）/ import（preview → execute）。
 * 边界：即时操作页，不走 page-tab dirty / SaveBar（TAB_KV_GROUPS.team_sync = []）；
 * toast 用 studio 页同款 flash 机制（useState + setTimeout，无全局 toast 框架）。
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listSquads, listStudioSessions } from '../../lib/squad-api';
import {
  executeImport, exportSquad, previewImport,
  type TeamSyncManifest,
} from '../../lib/team-sync-api';
import { ConfirmModal } from '../common/component-confirm-modal';
import { ExportTeamPickerModal, type ExportPickerState } from './component-export-team-picker-modal';

/** 视图状态机：landing（入口）→ importing（preview 预览态）→ 确认 modal → 建队中 */
type ViewState =
  | { kind: 'landing' }
  | { kind: 'importing'; importKey: string; manifest: TeamSyncManifest };

/** 团队同步 section（应用设置 → 团队同步 tab 右栏） */
export function SectionTeamSync(): ReactNode {
  const { t } = useTranslation('app-dev-config');
  // [v0.0.319 ET 修复] squadId 改从最近活跃 studio 会话取（useChatStore 是 playground 专属
  // store，chat-slice.ts:183 拒纳 biz=studio 会话 → studio 团队会话 squadId 永远 undefined）。
  // listStudioSessions（GET /session?biz=studio）按 updatedAt desc，首项 squadId = 最近活跃团队。
  // 无任何 studio 会话 → 导出 disabled + 提示（PRD 非 squad 场景语义保持）。
  const [squadId, setSquadId] = useState<string | undefined>(undefined);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    listStudioSessions()
      .then((items) => {
        if (cancelled) return;
        const latest = items.find((s) => s.squadId);
        setSquadId(latest?.squadId);
        setActiveSessionId(latest?.id);
      })
      .catch(() => { /* 拉取失败静默：导出保持 disabled 兜底 */ });
    return () => { cancelled = true; };
  }, []);

  const [view, setView] = useState<ViewState>({ kind: 'landing' });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [importName, setImportName] = useState('');
  const [dupWarning, setDupWarning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importedSquadId, setImportedSquadId] = useState<string | null>(null);
  // [v0.0.321 D2] 导出选择器状态（弹层 → listSquads → 选团队 → exportSquad）
  const [picker, setPicker] = useState<ExportPickerState>({
    open: false, loading: false, error: null, squads: [], selectedId: null,
  });
  // [v0.0.321 review MAJOR-1] 请求代数守卫：取消/关闭后旧 listSquads resolve 不得重弹 modal
  const exportGenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showFlash = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 3000);
  };

  // ── 导出（v0.0.321：弹选择器 → 选团队 → 下载）──
  const openExportPicker = async () => {
    const gen = ++exportGenRef.current;
    setPicker({ open: true, loading: true, error: null, squads: [], selectedId: null });
    try {
      const squads = await listSquads();
      if (gen !== exportGenRef.current) return; // 过期请求丢弃（已被取消/重开）
      // 默认选中：当前 squadId 在列表内则用它（最近活跃），否则列表第一项；空列表 → null
      const selectedId = squads.length > 0
        ? (squadId && squads.some((s) => s.id === squadId) ? squadId : squads[0]!.id)
        : null;
      setPicker({ open: true, loading: false, error: null, squads, selectedId });
    } catch (e) {
      if (gen !== exportGenRef.current) return;
      setPicker({
        open: true, loading: false,
        error: e instanceof Error ? e.message : t('team_sync.export_picker.load_failed'),
        squads: [], selectedId: null,
      });
    }
  };

  const handleExport = () => {
    if (busy) return;
    // 无 studio 会话但列表有团队 → 仍弹层选团队（PRD 边界）；仅 1 团队也弹层不短路
    void openExportPicker();
  };

  const handlePickerConfirm = () => {
    if (!picker.selectedId || picker.loading) return;
    exportSquad(picker.selectedId);
    exportGenRef.current++; // 关闭 → 作废在途 listSquads（防竞态重弹）
    setPicker({ open: false, loading: false, error: null, squads: [], selectedId: null });
    showFlash(t('team_sync.export_success'));
  };

  /** 关闭导出选择器（取消/遮罩）：递增 gen 使在途 listSquads 作废，不重弹 modal */
  const closeExportPicker = () => {
    exportGenRef.current++;
    setPicker({ open: false, loading: false, error: null, squads: [], selectedId: null });
  };

  const handlePickerRetry = () => {
    void openExportPicker();
  };

  // ── 导入 step1：选文件 → preview ──
  const handleFileChosen = async (file: File) => {
    setBusy(true);
    try {
      const { importKey, manifest } = await previewImport(file);
      setView({ kind: 'importing', importKey, manifest });
      setImportName(manifest.name);
      // 重名检测（前端 listSquads 比对；提醒不阻止，PRD §2.5）
      const squads = await listSquads();
      setDupWarning(squads.some((s) => s.name === manifest.name));
    } catch (e) {
      showFlash(e instanceof Error ? e.message : t('team_sync.import_invalid'));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // 团队名输入变更 → 实时重名检测
  const handleNameChange = async (name: string) => {
    setImportName(name);
    try {
      const squads = await listSquads();
      setDupWarning(squads.some((s) => s.name === name));
    } catch {
      setDupWarning(false); // 检测失败静默（不阻断导入）
    }
  };

  // ── 导入 step2：确认 → execute ──
  const handleExecute = async () => {
    if (view.kind !== 'importing') return;
    setConfirmOpen(false);
    setBusy(true);
    try {
      const result = await executeImport(view.importKey, importName.trim(), activeSessionId ?? undefined);
      setImportedSquadId(result.squadId);
      setView({ kind: 'landing' });
      showFlash(t('team_sync.import_success', { name: importName.trim(), count: result.created.length + 1 }));
    } catch (e) {
      showFlash(e instanceof Error ? e.message : t('team_sync.import_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="team-sync-section">
      <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('tab.team_sync.label')}</h3>

      {/* landing 态：当前团队信息 + 导出/导入入口 */}
      {view.kind === 'landing' && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted-2 m-0">{t('team_sync.desc')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="team-sync-export-btn"
              disabled={busy || picker.open}
              onClick={handleExport}
              className="px-4 py-1.5 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('team_sync.export_btn')}
            </button>
            <button
              type="button"
              data-testid="team-sync-import-btn"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-1.5 rounded-md text-sm border border-border text-fg-2 hover:bg-bg-warm disabled:opacity-50"
            >
              {t('team_sync.import_btn')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              data-testid="team-sync-file-input"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFileChosen(f);
              }}
            />
          </div>
          {!squadId && (
            <p className="text-[12px] text-muted-2 m-0" data-testid="team-sync-no-squad-hint">
              {t('team_sync.no_squad_hint')}
            </p>
          )}
          {importedSquadId && (
            <p className="text-[12px] text-muted-2 m-0" data-testid="team-sync-imported-hint">
              {t('team_sync.imported_hint')}
            </p>
          )}
        </div>
      )}

      {/* importing 态：manifest 预览 + 团队名输入框 */}
      {view.kind === 'importing' && (
        <div className="flex flex-col gap-3" data-testid="team-sync-preview">
          <div className="rounded-lg border border-border p-4 bg-surface">
            <p className="text-[13px] text-fg m-0 mb-1">
              {t('team_sync.preview_team')}: <strong>{view.manifest.name}</strong>
            </p>
            <p className="text-[12px] text-muted-2 m-0 mb-1">
              {t('team_sync.preview_leader')}: {view.manifest.leaderName}
            </p>
            <p className="text-[12px] text-muted-2 m-0">
              {t('team_sync.preview_members', { count: view.manifest.members.length })}
              {view.manifest.members.length > 0 && `（${view.manifest.members.map((m) => m.name).join('、')}）`}
            </p>
          </div>
          <label className="text-[13px] text-fg-2 flex flex-col gap-1">
            {t('team_sync.name_label')}
            <input
              type="text"
              data-testid="team-sync-name-input"
              value={importName}
              onChange={(e) => void handleNameChange(e.target.value)}
              className="px-3 py-1.5 rounded-md border border-border bg-surface text-sm text-fg"
            />
          </label>
          {dupWarning && (
            <p className="text-[12px] text-amber-600 m-0" data-testid="team-sync-dup-warning">
              {t('team_sync.dup_warning')}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="team-sync-confirm-import-btn"
              disabled={!importName.trim() || busy}
              onClick={() => setConfirmOpen(true)}
              className="px-4 py-1.5 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('team_sync.import_btn')}
            </button>
            <button
              type="button"
              data-testid="team-sync-cancel-btn"
              onClick={() => setView({ kind: 'landing' })}
              className="px-4 py-1.5 rounded-md text-sm border border-border text-fg-2 hover:bg-bg-warm"
            >
              {t('team_sync.cancel_btn')}
            </button>
          </div>
        </div>
      )}

      {/* 导入确认 modal */}
      {confirmOpen && view.kind === 'importing' && (
        <ConfirmModal
          title={t('team_sync.confirm_title')}
          body={t('team_sync.confirm_body', { name: importName.trim(), count: view.manifest.members.length })}
          okLabel={t('team_sync.confirm_ok')}
          cancelLabel={t('team_sync.cancel_btn')}
          onOk={() => void handleExecute()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {/* 导出选择器 modal（v0.0.321 D2：点导出 → 选团队 → 下载） */}
      <ExportTeamPickerModal
        open={picker.open}
        loading={picker.loading}
        error={picker.error}
        squads={picker.squads}
        selectedId={picker.selectedId}
        onSelect={(id) => setPicker((p) => ({ ...p, selectedId: id }))}
        onConfirm={handlePickerConfirm}
        onCancel={closeExportPicker}
        onRetry={() => void handlePickerRetry()}
      />

      {/* flash toast（studio 页同款最小可见反馈） */}
      {flash && (
        <div
          data-testid="team-sync-toast"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-fg text-surface px-4 py-2 text-[13px] shadow-lg"
        >
          {flash}
        </div>
      )}
    </div>
  );
}
