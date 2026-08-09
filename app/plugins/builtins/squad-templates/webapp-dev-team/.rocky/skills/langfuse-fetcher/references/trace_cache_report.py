#!/usr/bin/env python3
"""trace_cache_report.py — 一键 trace 缓存分析（纯机械，零 LLM 参与）

输入 trace id（+ 可选目录），自动：
  1. 下载每 step 的 physical 请求负载（llm-N-physical 的 input）+ logical 的 usageDetails
  2. 相邻 step 两两对比 system（逐 block）/ tools（逐项）/ messages（逐条）——先报「前缀是否一致」
  3. 汇总每 step 缓存命中率 = cache_read/(cache_read+input)，低于阈值（默认 70%）❌ 高亮

用法:
  python3 trace_cache_report.py --trace=<traceId> [--dir=<目录>] [--threshold=70]
  python3 trace_cache_report.py --dir=<目录>          # 离线复分析（不联网，读已下载的 step-*.json + usage.json）

--dir 缺省 = ./logs/<traceId>/（落盘 step-01.json ... + usage.json，之后可离线复分析）。

口径（实测判据，2026-07）：
  - cache_control 断点标记前移不算前缀分歧（MiniMax 自动前缀缓存不受其影响——hit 99%+ 实证）；
    比较前递归剥离 cache_control 键，剥离后仍不同才是真分歧。
  - 命中数 ≈ 稳定前缀大小为正常；稳定前缀大却只命中 ~128 → provider 侧异常，单独记。
  - forked run 写 memory → 下一步 system 内嵌 memory 段重渲染 → 整段前缀失效（v0.0.189+ 已修：
    forked 无条件复用 parentSnapshot.system，见 context-engine.ts shouldRebuild）。

凭证（仅 --trace 模式）: env 或 repo 根 prod.env/test.env 的
LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY（prod.env 优先）。
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cache_prefix_analysis import load_creds, lf_get, lf_get_all, canon, norm_system, blocks_of  # noqa: E402

# ---------- cache_control 剥离（断点标记前移不算分歧） ----------

def strip_cc(x):
    if isinstance(x, dict):
        return {k: strip_cc(v) for k, v in x.items() if k != "cache_control"}
    if isinstance(x, list):
        return [strip_cc(v) for v in x]
    return x

def canon_ncc(x):
    return canon(strip_cc(x))

# ---------- 单对对比 ----------

def first_diff_off(sa, sb):
    """两字符串首个不同字符偏移 + 上下文片段；无 diff 返 None。"""
    if sa == sb:
        return None
    n = min(len(sa), len(sb))
    off = next((i for i in range(n) if sa[i] != sb[i]), n)
    return off, sa[max(0, off - 60):off + 100], sb[max(0, off - 60):off + 100]

def cmp_system(ra, rb):
    """逐 block 对比；返回 (ok, 首个 diff 描述, diff 片段 (A,B)|None)。"""
    ba, bb = norm_system(ra.get("system")), norm_system(rb.get("system"))
    if len(ba) != len(bb):
        return False, f"block 数 {len(ba)} → {len(bb)}", None
    for i in range(len(ba)):
        d = first_diff_off(canon_ncc(ba[i]), canon_ncc(bb[i]))
        if d:
            return False, f"system[{i}] @char{d[0]}", (d[1], d[2])
    return True, None, None

def cmp_tools(ra, rb):
    """按 name 逐项对比；返回 (ok, 描述, 首个 changed 项的 diff 片段|None)。"""
    ta = {t.get("name"): t for t in ra.get("tools") or []}
    tb = {t.get("name"): t for t in rb.get("tools") or []}
    added = sorted(set(tb) - set(ta)); removed = sorted(set(ta) - set(tb))
    changed = [n for n in sorted(set(ta) & set(tb)) if canon_ncc(ta[n]) != canon_ncc(tb[n])]
    if not (added or removed or changed):
        return True, None, None
    parts = []
    if added: parts.append(f"新增 {added}")
    if removed: parts.append(f"删除 {removed}")
    if changed: parts.append(f"内容变 {changed}")
    snip = None
    if changed:
        d = first_diff_off(canon_ncc(ta[changed[0]]), canon_ncc(tb[changed[0]]))
        if d:
            snip = (d[1], d[2])
    return False, "; ".join(parts), snip

def cmp_messages(ra, rb):
    """逐条对齐对比；返回 (公共前缀条数, 首个 diff 描述, diff 片段|None, B 尾部新增条数)。"""
    ma, mb = ra.get("messages", []), rb.get("messages", [])
    div = snip = None
    common = min(len(ma), len(mb))
    for i in range(min(len(ma), len(mb))):
        if ma[i].get("role") != mb[i].get("role"):
            div = f"messages[{i}] role {ma[i].get('role')} → {mb[i].get('role')}"
            break
        ca, cb = blocks_of(ma[i].get("content")), blocks_of(mb[i].get("content"))
        if len(ca) != len(cb):
            div = f"messages[{i}] block 数 {len(ca)} → {len(cb)}"
            break
        for j in range(len(ca)):
            d = first_diff_off(canon_ncc(ca[j]), canon_ncc(cb[j]))
            if d:
                div = f"messages[{i}].blocks[{j}] @char{d[0]}"
                snip = (d[1], d[2])
                break
        if div:
            common = i
            break
    return common, div, snip, len(mb) - len(ma)

# ---------- 下载 / 本地读取 ----------

def step_key(name):
    m = re.search(r"(\d+)", name or "")
    return int(m.group(1)) if m else 0

def fetch_trace(trace_id, outdir):
    obs = lf_get_all(f"observations?traceId={trace_id}&type=GENERATION")
    phys = [o for o in obs if (o.get("metadata") or {}).get("physicalWire")] \
        or [o for o in obs if (o.get("name") or "").endswith("-physical")]
    logs = [o for o in obs if o not in phys]
    phys.sort(key=lambda o: step_key(o.get("name")) or (o.get("startTime") or ""))
    logs.sort(key=lambda o: step_key(o.get("name")) or (o.get("startTime") or ""))
    os.makedirs(outdir, exist_ok=True)
    usage = []
    for o in logs:
        ud = o.get("usageDetails") or {}
        usage.append({"step": o.get("name"), "input": ud.get("input") or 0,
                      "cache_read": ud.get("cache_read_input_tokens") or 0,
                      "output": ud.get("output") or 0})
    steps = []
    for n, o in enumerate(phys, 1):
        full = lf_get(f"observations/{o['id']}")
        if not isinstance(full.get("input"), dict):
            continue
        fn = os.path.join(outdir, f"step-{n:02d}.json")
        with open(fn, "w") as f:
            json.dump(full["input"], f, ensure_ascii=False)
        steps.append(o.get("name") or f"step-{n:02d}")
    with open(os.path.join(outdir, "usage.json"), "w") as f:
        json.dump({"steps": steps, "usage": usage}, f, ensure_ascii=False, indent=1)
    return steps, usage

def load_local(d):
    files = sorted((f for f in os.listdir(d) if re.match(r"step-\d+\.json$", f)))
    meta = json.load(open(os.path.join(d, "usage.json"))) if os.path.exists(os.path.join(d, "usage.json")) else {}
    return files, meta.get("steps", files), meta.get("usage", [])

# ---------- 报告 ----------

def main():
    import time
    args = dict(a.split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    trace_id, d = args.get("--trace"), args.get("--dir")
    threshold = float(args.get("--threshold", 70))
    if not trace_id and not d:
        sys.exit(__doc__)
    if trace_id:
        load_creds()
        d = d or os.path.join("logs", trace_id)
        print(f"下载 trace {trace_id} → {d}", file=sys.stderr)
        step_names, usage = fetch_trace(trace_id, d)
        files = sorted(f for f in os.listdir(d) if re.match(r"step-\d+\.json$", f))
    else:
        files, step_names, usage = load_local(d)
    if len(files) < 2:
        sys.exit(f"只有 {len(files)} 个 step 负载，无法对比")
    reqs = [json.load(open(os.path.join(d, f))) for f in files]
    tid = trace_id or os.path.basename(os.path.abspath(d))

    out = [f"# trace 缓存分析报告 — {tid}", "",
           f"- steps: {len(files)} | LOW 阈值: {threshold}% | 生成: {time.strftime('%Y-%m-%d %H:%M:%S')}",
           f"- 负载: `{d}/step-NN.json` | 用量: `{d}/usage.json`", ""]
    emit = out.append

    # ① 逐步前缀对比（主输出）
    emit(f"## 逐步前缀对比（{len(files)} steps）")
    emit("")
    pair_verdicts = []
    for k in range(len(reqs) - 1):
        na, nb = step_names[k], step_names[k + 1]
        s_ok, s_desc, s_snip = cmp_system(reqs[k], reqs[k + 1])
        t_ok, t_desc, t_snip = cmp_tools(reqs[k], reqs[k + 1])
        common, m_div, m_snip, tail = cmp_messages(reqs[k], reqs[k + 1])
        mc = f"msgs {len(reqs[k].get('messages', []))}→{len(reqs[k + 1].get('messages', []))}（尾部+{tail}）"
        if s_ok and t_ok and m_div is None:
            emit(f"- ✅ **{na} → {nb}**: 前缀一致 | tools 一致 | {mc}")
            pair_verdicts.append((nb, None))
        else:
            loc = s_desc if not s_ok else (f"tools: {t_desc}" if not t_ok else m_div)
            snip = s_snip or t_snip or m_snip
            emit(f"- ❌ **{na} → {nb}**: 前缀分歧 @ `{loc}` | system {'✓' if s_ok else '✗'} tools {'✓' if t_ok else '✗'} | {mc} | 公共前缀 {common} 条")
            if snip:
                emit("")
                emit("```diff")
                emit(f"- A 原文: ...{snip[0]!r}...")
                emit(f"+ B 原文: ...{snip[1]!r}...")
                emit("```")
            pair_verdicts.append((nb, loc))
        # cache_control 断点前移提示（raw 不同但剥离后一致 → 无害）
        if s_ok and canon(norm_system(reqs[k].get("system"))) != canon(norm_system(reqs[k + 1].get("system"))):
            emit(f"  - ℹ️ system 仅 cache_control 断点位置变化（无害）")
    emit("")

    # ② 缓存命中率表
    if usage:
        emit(f"## 缓存命中率（阈值 {threshold}%）")
        emit("")
        emit("| step | input | cache_read | output | hit% | 判定 |")
        emit("|---|---:|---:|---:|---:|---|")
        low = []
        for u in usage:
            tot = u["input"] + u["cache_read"]
            hit = 100.0 * u["cache_read"] / tot if tot else 0.0
            is_low = hit < threshold
            if is_low:
                low.append(u["step"])
            emit(f"| {u['step']} | {u['input']:,} | {u['cache_read']:,} | {u['output']:,} | {hit:.1f}% | {'❌ LOW' if is_low else 'OK'} |")
        emit("")
        if low:
            emit("## 归因（LOW step ↔ 前缀对比）")
            emit("")
            for s in low:
                key = re.sub(r"-(physical|logical)$", "", s or "")
                v = next((l for n, l in pair_verdicts if re.sub(r"-(physical|logical)$", "", n or "") == key), None)
                emit(f"- **{s}**: {'前缀分歧 @ `' + v + '`' if v else '前缀一致但命中低 → provider 侧异常/TTL/冷启动，单独查'}")

    text = "\n".join(out) + "\n"
    print(text)
    rp = os.path.join(d, "result.md")
    with open(rp, "w") as f:
        f.write(text)
    print(f"报告已写入 {rp}", file=sys.stderr)

if __name__ == "__main__":
    main()
