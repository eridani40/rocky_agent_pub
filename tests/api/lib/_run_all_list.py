"""
run_all v2 case 发现辅助脚本。
由 run_all.sh 调用，不直接使用。

用法：
  python3 _run_all_list.py <base_dir> <module> <cases> [--map]
    无 --map：打印可读列表（LIST_ONLY 模式）
    有 --map ：打印 "cid\tcdir\tmod" 行供 bash 读取
"""
import os
import sys
import glob


def main():
    base = sys.argv[1]
    module = sys.argv[2] if len(sys.argv) > 2 else ""
    cases_str = sys.argv[3] if len(sys.argv) > 3 else ""
    as_map = "--map" in sys.argv

    flt = set(filter(None, (s.strip() for s in cases_str.split(",")))) if cases_str else set()
    rows = []
    for yf in sorted(glob.glob(os.path.join(base, "*", "*", "case.yaml"))):
        cdir = os.path.dirname(yf)
        cid = os.path.basename(cdir)
        mod = os.path.basename(os.path.dirname(cdir))
        if module and mod != module:
            continue
        if flt and cid not in flt:
            continue
        rows.append((cid, cdir, mod))

    if as_map:
        for cid, cdir, mod in rows:
            print(f"{cid}\t{cdir}\t{mod}")
    else:
        if rows:
            for cid, cdir, mod in rows:
                print(f"  {cid}  ({mod})")
        else:
            print("  (无匹配 case)")
        print(f"共 {len(rows)} 个 AT v2 case")


if __name__ == "__main__":
    main()
