/**
 * use-squad-mutations —— page-studio 的 squad CRUD 变更 handler 簇
 * 参考: specs/ui/overall/06-studio.md §2.3（SeatsPanel 唯一首页）
 *
 * 职责：
 *   - reloadSquads / reloadDetail / refresh 三 fetch 工具
 *   - handleCreateSquad / handleHire / handleBench / handleDeploy / handleSaveMeta
 *     / handleDeleteSquad 六 mutation handler（含 toast）
 * 边界：
 *   - 不管 MainView 状态机（mutation 后统一调 fallbackToHome 回落首页 seats）
 *   - 不订阅 SSE；不派生视图态；不 fetch member/session 详情
 *   - 所有 handler 走 useCallback，deps 显式列全
 */
import { useCallback } from 'react';
import type { TFunction } from 'i18next';
import {
  benchMember,
  createSquad,
  deleteSquad,
  deployMember,
  getSquad,
  hireMember,
  listSquads,
  patchSquad,
} from '../../lib/squad-api';
import type {
  CreateSquadBody,
  HireMemberBody,
  Member,
  PatchSquadBody,
  SquadDetail,
  SquadSummary,
} from './squad-types';

/** hook 消费方传入的 state setters + 派生 handler（page-studio 提供） */
export interface UseSquadMutationsDeps {
  selectedSquadId: string | null;
  detail: SquadDetail | null;
  setSquads: (updater: (prev: SquadSummary[]) => SquadSummary[]) => void;
  overwriteSquads: (list: SquadSummary[]) => void;
  setSelectedSquadId: (id: string | null) => void;
  setDetail: (d: SquadDetail | null) => void;
  setModalClose: () => void;
  /** 关闭 chat/member 主区，回落到首页 seats（mutation 后统一收敛，也用于 squad 删除） */
  fallbackToHome: () => void;
  flash: (msg: string) => void;
  t: TFunction;
}

/** hook 暴露的 mutation 簇（page-studio 消费） */
export interface SquadMutations {
  reloadSquads: () => Promise<void>;
  reloadDetail: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  handleCreateSquad: (body: CreateSquadBody) => Promise<void>;
  handleHire: (body: HireMemberBody) => Promise<void>;
  handleBench: (member: Member, reason: string) => Promise<void>;
  handleDeploy: (memberId: string) => Promise<void>;
  handleSaveMeta: (p: PatchSquadBody) => Promise<void>;
  /** 删除 squad → true=成功（含 toast/列表 filter/fallbackToHome），false=失败（仅 toast） */
  handleDeleteSquad: () => Promise<boolean>;
}

/**
 * page-studio 的 mutation handler 簇（含 reload 工具 + toast）。
 */
export function useSquadMutations(deps: UseSquadMutationsDeps): SquadMutations {
  const {
    selectedSquadId, detail,
    setSquads, overwriteSquads, setSelectedSquadId, setDetail,
    setModalClose, fallbackToHome,
    flash, t,
  } = deps;

  /** GET /squad 列表（失败保留旧值，不致命） */
  const reloadSquads = useCallback(async () => {
    try { overwriteSquads(await listSquads()); } catch { /* ignore */ }
  }, [overwriteSquads]);

  /** GET /squad/:id 详情（失败置 null 走 loading 兜底） */
  const reloadDetail = useCallback(async (id: string) => {
    try { setDetail(await getSquad(id)); } catch { setDetail(null); }
  }, [setDetail]);

  /** mutation 后统一刷新：并行重拉详情 + 列表（两 GET 独立无依赖） */
  const refresh = useCallback(async () => {
    await Promise.all([
      selectedSquadId ? reloadDetail(selectedSquadId) : Promise.resolve(),
      reloadSquads(),
    ]);
  }, [selectedSquadId, reloadDetail, reloadSquads]);

  /** POST /squad → 选中新 squad + 刷新（回落首页 seats） */
  const handleCreateSquad = useCallback(
    async (body: CreateSquadBody) => {
      const created = await createSquad(body);
      setModalClose();
      await reloadSquads();
      setSelectedSquadId(created.id);
      setDetail(created);
      fallbackToHome();
      flash(t('studio:toast.squadCreated', { name: created.name }));
    },
    [reloadSquads, setModalClose, setSelectedSquadId, setDetail, fallbackToHome, flash, t],
  );

  /** POST /squad/:id/member */
  const handleHire = useCallback(
    async (body: HireMemberBody) => {
      if (!selectedSquadId) return;
      const res = await hireMember(selectedSquadId, body);
      setModalClose();
      await refresh();
      flash(t('studio:toast.memberHired', { name: res.member.name }));
    },
    [selectedSquadId, refresh, setModalClose, flash, t],
  );

  /** bench member + toast */
  const handleBench = useCallback(
    async (member: Member, reason: string) => {
      if (!selectedSquadId) return;
      try {
        await benchMember(selectedSquadId, member.id, reason);
        setModalClose();
        await refresh();
        flash(t('studio:toast.memberBenched', { name: member.name, reason: reason ? ' · ' + reason : '' }));
      } catch (e) {
        flash(e instanceof Error ? e.message : t('studio:toast.benchFail'));
      }
    },
    [selectedSquadId, refresh, setModalClose, flash, t],
  );

  /** deploy member + toast */
  const handleDeploy = useCallback(
    async (memberId: string) => {
      if (!selectedSquadId) return;
      await deployMember(selectedSquadId, memberId);
      await refresh();
      flash(t('studio:toast.memberDeployed'));
    },
    [selectedSquadId, refresh, flash, t],
  );

  /** squad 元信息 patch + toast（save meta 快捷 alias） */
  const handleSaveMeta = useCallback(
    async (p: PatchSquadBody) => {
      if (!selectedSquadId) return;
      const updated = await patchSquad(selectedSquadId, p);
      setDetail(updated);
      await reloadSquads();
      flash(t('studio:toast.metaSaved'));
    },
    [selectedSquadId, reloadSquads, setDetail, flash, t],
  );

  /** 硬删除 squad（解散）—— 本地即时清 + 切走选中 + reload。返回 true=成功 / false=失败（上层据此决定是否关弹层） */
  const handleDeleteSquad = useCallback(async () => {
    if (!selectedSquadId) return false;
    const id = selectedSquadId;
    const name = detail?.name ?? '';
    try {
      await deleteSquad(id);
      setSquads((prev) => prev.filter((s) => s.id !== id));
      setSelectedSquadId(null);
      setDetail(null);
      fallbackToHome();
      await reloadSquads();
      flash(t('studio:toast.squadDeleted', { name }));
      return true;
    } catch (e) {
      flash(e instanceof Error ? e.message : t('studio:toast.squadDeleteFail'));
      return false;
    }
  }, [selectedSquadId, detail, reloadSquads, setSquads, setSelectedSquadId, setDetail, fallbackToHome, flash, t]);

  return {
    reloadSquads, reloadDetail, refresh,
    handleCreateSquad, handleHire, handleBench, handleDeploy,
    handleSaveMeta, handleDeleteSquad,
  };
}
