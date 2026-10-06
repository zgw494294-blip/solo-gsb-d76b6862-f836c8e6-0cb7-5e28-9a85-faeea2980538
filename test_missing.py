"""查找漏读（只补一条读数即可多完成一趟的时间窗）的算法与端点测试。

包含：三种缺失门（S/M/F）的固定用例、计数条件对区间的裁剪、零次选手、
不能增次的记录对不返回、排序规则、超过 2^53 的大整数编号/秒数、
与裁决一致的输入校验、HTTP 端点合同，以及 400 组随机数据与
“逐秒暴力 + 记忆化递归”参考实现的对拍。
"""

import functools
import json
import random
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, ".")
from app.adjudication import (
    AdjudicationError,
    Record,
    _build_trips,
    adjudicate,
    find_missing,
    parse_payload,
)
from app.main import app

client = TestClient(app)

RANGES = {"SM": (10, 60), "MF": (10, 60)}

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("  ✓", msg)
    else:
        failures += 1
        print("  ✗", msg)


def payload_of(spec, runners=(1,), ranges=RANGES):
    return {
        "standards": {
            "smMin": ranges["SM"][0],
            "smMax": ranges["SM"][1],
            "mfMin": ranges["MF"][0],
            "mfMax": ranges["MF"][1],
        },
        "runners": [{"number": r} for r in runners],
        "records": [
            {"id": i, "runner": r, "gate": g, "time": t} for i, r, g, t in spec
        ],
    }


def windows_of(spec, runners=(1,), ranges=RANGES):
    return find_missing(payload_of(spec, runners, ranges))["runners"]


def wmap(runner_entry):
    return {
        (w["missingGate"], tuple(w["ids"])): (w["timeMin"], w["timeMax"])
        for w in runner_entry["windows"]
    }


def test_missing_f_full_interval():
    print("场景1：缺终点 F——K=0 时整段成趟区间都可行")
    # 没有任何完整趟（K=0）：S@0、M@12 配虚拟 F@t ∈ [22, 72] 即得 1 趟。
    ws = windows_of([("s1", 1, "S", 0), ("m1", 1, "M", 12)])
    check(ws[0]["lapCount"] == 0, "原输入 0 次")
    check(wmap(ws[0]) == {("F", ("s1", "m1")): (22, 72)}, "缺 F 完整闭区间 [22, 72]")


def test_missing_f_trimmed_by_count():
    print("场景2：缺终点 F——计数条件把区间从 [55,105] 裁到 [55,99]")
    # 两趟 (0,12,25)、(100,112,125)，K=2；S@30、M@45 补 F@t：
    # 新趟终点 t 必须让第二趟 (起点100) 仍能接上 → t+1 ≤ 100 → t ≤ 99。
    spec = [
        ("a1", 1, "S", 0), ("b1", 1, "M", 12), ("c1", 1, "F", 25),
        ("a2", 1, "S", 100), ("b2", 1, "M", 112), ("c2", 1, "F", 125),
        ("sX", 1, "S", 30), ("mX", 1, "M", 45),
    ]
    ws = windows_of(spec)
    check(ws[0]["lapCount"] == 2, "原输入 2 次")
    check(wmap(ws[0]) == {("F", ("sX", "mX")): (55, 99)},
          "缺 F 区间被计数条件裁剪为 [55, 99]")


def test_missing_s_trimmed_by_count():
    print("场景3：缺起点 S——计数条件把区间从 [15,65] 裁到 [26,65]，且不出现负秒")
    # 两趟 (0,12,25)、(100,112,125)，K=2；M@75、F@90 补 S@t ∈ [15,65]：
    # 须 A(t-1) ≥ 1（第一趟终点 25 ≤ t-1）→ t ≥ 26。
    spec = [
        ("a1", 1, "S", 0), ("b1", 1, "M", 12), ("c1", 1, "F", 25),
        ("a2", 1, "S", 100), ("b2", 1, "M", 112), ("c2", 1, "F", 125),
        ("mX", 1, "M", 75), ("fX", 1, "F", 90),
    ]
    ws = windows_of(spec)
    check(wmap(ws[0]) == {("S", ("mX", "fX")): (26, 65)},
          "缺 S 区间被裁剪为 [26, 65]")
    # M@10、F@25（K=0 的对照）：t ∈ [max(0, 10-60), 10-10] → 下界钳到 0，t=0 恰可行。
    spec2 = [("m1", 1, "M", 10), ("f1", 1, "F", 25)]
    ws2 = windows_of(spec2)
    check(wmap(ws2[0]) == {("S", ("m1", "f1")): (0, 0)},
          "缺 S 下界钳到 0（非负整数秒），t=0 恰可行")
    # M@8、F@25：t ∈ [0, -2] → 空，不返回。
    spec3 = [("m1", 1, "M", 8), ("f1", 1, "F", 25)]
    check(wmap(windows_of(spec3)[0]) == {}, "下界 0 仍大于上界时不返回")


def test_missing_m_whole_interval():
    print("场景4：缺中途门 M——计数条件与 t 无关，整段成立或整体不成立")
    # 两趟之间 S@30、F@80：A(29)=1、B(81)=1，1+1=2=K → t ∈ [40,70]∩[20,70]=[40,70]。
    spec = [
        ("a1", 1, "S", 0), ("b1", 1, "M", 12), ("c1", 1, "F", 25),
        ("a2", 1, "S", 100), ("b2", 1, "M", 112), ("c2", 1, "F", 125),
        ("sX", 1, "S", 30), ("fX", 1, "F", 80),
    ]
    ws = windows_of(spec)
    check(wmap(ws[0]) == {("M", ("sX", "fX")): (40, 70)}, "缺 M 区间 [40, 70]")
    # 对照：F@80 换成 F@200（B(201)=0，1+0<2）→ 整体不成立，不返回。
    spec_bad = spec[:-1] + [("fX", 1, "F", 200)]
    check(wmap(windows_of(spec_bad)[0]) == {}, "计数条件不成立时缺 M 不返回")


def test_pairs_that_cannot_increase_are_omitted():
    print("场景5：不能增次的记录对不返回；同门记录不组成对")
    # 已两趟占满时间线，中间的 S/M 对无法插出第三趟。
    spec = [
        ("a1", 1, "S", 0), ("b1", 1, "M", 12), ("c1", 1, "F", 25),
        ("a2", 1, "S", 26), ("b2", 1, "M", 40), ("c2", 1, "F", 57),
        ("sX", 1, "S", 26), ("mX", 1, "M", 41),
    ]
    # sX(26) 与 a2 同秒：新趟 (26,41,t) 与第二趟 (26,40,57) 共用时间段，
    # A(25)=1、B(t+1)：t ∈ [51,101]，B(52) 以后为 0 → 需要 1 趟后缀但 t≥51>57-1…
    # 直接断言：sX/mX 不在任何窗口中。
    wm = wmap(windows_of(spec)[0])
    check(all("sX" not in ids and "mX" not in ids for ids in wm),
          "无法增次的记录对不返回")
    # 只有两条 S 记录：同门不能组成对，无任何窗口。
    spec_same_gate = [("s1", 1, "S", 0), ("s2", 1, "S", 10)]
    check(wmap(windows_of(spec_same_gate)[0]) == {}, "同门记录不组成对")


def test_sorting_and_multi_runner_isolation():
    print("场景6：排序——编号数值升序、缺失门 S/M/F、ID 序列字典序；选手互不串台")
    # 输入顺序 102 在前、7 在后；响应应按编号数值升序为 7、102。
    spec = [
        # 选手 102：缺 M 与缺 F 各一个窗口
        ("sB", 102, "S", 0), ("fB", 102, "F", 30),          # 缺 M: t ∈ [10,20]∩[10,20]
        ("sB2", 102, "S", 100), ("mB2", 102, "M", 115),     # 缺 F: t ∈ [125,175]
        # 选手 7：缺 S 一个窗口
        ("mA", 7, "M", 20), ("fA", 7, "F", 35),             # 缺 S: t ∈ [0,10]
    ]
    out = windows_of(spec, runners=(102, 7))
    check([r["runner"] for r in out] == [7, 102], "选手按编号数值升序（非输入顺序）")
    w7 = wmap(out[0])
    check(w7 == {("S", ("mA", "fA")): (0, 10)}, "选手 7 缺 S 窗口 [0, 10]")
    w102 = out[1]["windows"]
    check([(w["missingGate"], tuple(w["ids"])) for w in w102] == [
        ("M", ("sB", "fB")),
        ("F", ("sB2", "mB2")),
    ], "窗口按缺失门 S/M/F 排序")
    check(wmap(out[1]) == {
        ("M", ("sB", "fB")): (10, 20),
        ("F", ("sB2", "mB2")): (125, 175),
    }, "选手 102 两个窗口的区间")
    # ID 序列字典序：同选手同缺失门，按 (id1, id2) 字典序。
    spec_ids = [
        ("zS", 5, "S", 0), ("aS", 5, "S", 0),
        ("m1", 5, "M", 12),
    ]
    ws = windows_of(spec_ids, runners=(5,))[0]["windows"]
    check([tuple(w["ids"]) for w in ws] == [("aS", "m1"), ("zS", "m1")],
          "同缺失门内按两条 ID 序列字典序")
    # 选手隔离：102 的记录不参与 7 的窗口（7 只有 mA/fA 两条记录，无法自组对）。
    check(all("sB" not in str(w) and "mB2" not in str(w) for w in out[0]["windows"]),
          "窗口不混用其他选手的记录")


def test_big_integers_lossless():
    print("场景7：超过 2^53 的编号与秒数全程无损")
    big_runner = 9007199254740993  # 2^53 + 1
    ts, tm = 9007199254740992, 9007199254741003  # 相差 11
    payload = {
        "standards": {"smMin": 10, "smMax": 60, "mfMin": 10, "mfMax": 60},
        "runners": [{"number": str(big_runner)}],
        "records": [
            {"id": "h1", "runner": str(big_runner), "gate": "S", "time": str(ts)},
            {"id": "h2", "runner": str(big_runner), "gate": "M", "time": str(tm)},
        ],
    }
    out = find_missing(payload)
    w = out["runners"][0]["windows"][0]
    check(out["runners"][0]["runner"] == big_runner, "大编号原样返回")
    check(w["missingGate"] == "F" and w["ids"] == ["h1", "h2"], "大秒数记录对")
    check((w["timeMin"], w["timeMax"]) == (tm + 10, tm + 60),
          "区间端点按任意精度整数计算（不截断）")
    text = json.dumps(out)
    check(f'"timeMin": {tm + 10}' in text and str(big_runner) in text,
          "JSON 序列化保持精确值")


def test_validation_identical_to_adjudicate():
    print("场景8：与裁决完全相同的输入校验")
    bad = {
        "standards": {"smMin": 10, "smMax": 9, "mfMin": 10, "mfMax": 60},
        "runners": [{"number": 1}],
        "records": [],
    }
    for fn in (find_missing, adjudicate):
        try:
            fn(bad)
            check(False, f"{fn.__name__} 非法输入应报错")
        except AdjudicationError:
            check(True, f"{fn.__name__} 非法输入报错")
    # 41 条记录同样拒绝（虚拟读数不占名额，但输入本身仍须合法）。
    too_many = payload_of([("r%02d" % i, 1, "S", 0) for i in range(41)])
    try:
        find_missing(too_many)
        check(False, "41 条记录应报错")
    except AdjudicationError:
        check(True, "41 条记录报错")


def test_virtual_reading_not_counted_in_40():
    print("场景9：40 条记录仍可查询（虚拟读数不占录入名额）")
    # 12 趟（36 条）+ sX/mX（缺 F 的对）+ zS/zM（另一对）= 恰 40 条（上限）。
    spec = []
    for i in range(12):
        base = i * 100
        spec += [
            (f"s{i}", 1, "S", base),
            (f"m{i}", 1, "M", base + 12),
            (f"f{i}", 1, "F", base + 25),
        ]
    spec += [("sX", 1, "S", 1300), ("mX", 1, "M", 1312)]
    spec += [("zS", 1, "S", 2000), ("zM", 1, "M", 2012)]
    assert len(spec) == 40
    parse_payload(payload_of(spec))  # 恰 40 条：输入本身合法
    ws = windows_of(spec)
    check(ws[0]["lapCount"] == 12, "40 条记录录入合法（12 趟）")
    check(wmap(ws[0]).get(("F", ("sX", "mX"))) == (1322, 1372),
          "40 条记录时漏读窗口仍正常返回（虚拟读数不占名额）")


def test_http_endpoint_contract():
    print("场景10：HTTP 端点合同 200 / 422 / 400")
    ok_payload = payload_of([("s1", 1, "S", 0), ("m1", 1, "M", 12)])
    r = client.post("/api/missing", json=ok_payload)
    check(r.status_code == 200 and r.json()["ok"] is True, "合法输入 200")
    w = r.json()["result"]["runners"][0]["windows"][0]
    check(w == {"missingGate": "F", "ids": ["s1", "m1"], "timeMin": 22, "timeMax": 72},
          "端点返回窗口内容正确")

    bad = payload_of([("s1", 1, "S", 0)])
    bad["standards"]["smMin"] = 0
    r = client.post("/api/missing", json=bad)
    check(r.status_code == 422 and r.json()["ok"] is False and "区间" in r.json()["error"],
          "非法输入 422 中文原因")
    r = client.post(
        "/api/missing", content=b"{not json", headers={"Content-Type": "application/json"}
    )
    check(r.status_code == 400, "非 JSON 请求体 400")
    # 旧端点合同不变
    r = client.post("/api/adjudicate", json=ok_payload)
    check(r.status_code == 200 and r.json()["ok"], "裁决端点不受影响")
    r = client.post("/api/diagnose", json=ok_payload)
    check(r.status_code == 200 and r.json()["ok"], "诊断端点不受影响")


# ---------------------------------------------------------------------------
# 对拍：逐秒暴力 + 记忆化递归参考实现
# ---------------------------------------------------------------------------

def brute_max_count(records, ranges):
    """独立参考实现：在按终点排序的趟上做“选/不选”的记忆化递归（只比趟数）。"""
    trips = _build_trips(records, ranges)
    n = len(trips)

    @functools.lru_cache(maxsize=None)
    def solve(i, bound):
        if i >= n:
            return 0
        best = solve(i + 1, bound)
        t = trips[i]
        if t.s.time > bound:
            best = max(best, 1 + solve(i + 1, t.f.time))
        return best

    return solve(0, -1)


def brute_feasible_windows(spec, ranges=RANGES):
    """逐秒暴力：对每对不同门记录与每个候选秒 t，判定
    “t 与这两条记录成趟 且 存在包含该趟的 K+1 趟合法方案”。

    包含新趟 L 的最优方案规模 = A(L.起点-1) + 1 + B(L.终点+1)，其中
    A(x) = 只用秒数 ≤ x 的原记录的最大趟数、B(y) = 只用秒数 ≥ y 的原记录的
    最大趟数（前/后缀与新趟时间严格分离，记录必不共用）——与生产代码的
    前缀/后缀 DP 是两种独立写法。
    返回 {(missingGate, id1, id2): 可行秒数集合}（id1/id2 依门序）。
    """
    records = [Record(id=i, runner=1, gate=g, time=t) for i, r, g, t in spec]
    base = brute_max_count(records, ranges)
    sm_lo, sm_hi = ranges["SM"]
    mf_lo, mf_hi = ranges["MF"]
    t_limit = max((r.time for r in records), default=0) + sm_hi + mf_hi + 2

    def count_before(x):
        return brute_max_count([r for r in records if r.time <= x], ranges)

    def count_after(y):
        return brute_max_count([r for r in records if r.time >= y], ranges)

    feasible = {}
    for missing in "SMF":
        g1, g2 = [g for g in "SMF" if g != missing]
        for r1 in [r for r in records if r.gate == g1]:
            for r2 in [r for r in records if r.gate == g2]:
                ts = set()
                for t in range(t_limit + 1):
                    times = {g1: r1.time, g2: r2.time, missing: t}
                    if not (sm_lo <= times["M"] - times["S"] <= sm_hi):
                        continue
                    if not (mf_lo <= times["F"] - times["M"] <= mf_hi):
                        continue
                    start = min(times.values())
                    finish = max(times.values())
                    if count_before(start - 1) + 1 + count_after(finish + 1) == base + 1:
                        ts.add(t)
                if ts:
                    feasible[(missing, r1.id, r2.id)] = ts
    return feasible, base


def test_fuzz_against_bruteforce():
    print("场景11：随机数据对拍（逐秒暴力）x400")
    for seed in range(400):
        rng = random.Random(10_000 + seed)
        n = rng.randint(2, 12)
        tmax = rng.choice((60, 90, 200))
        spec = [(f"r{i:02d}", 1, rng.choice("SMF"), rng.randint(0, tmax)) for i in range(n)]
        out = windows_of(spec)[0]
        feasible, base = brute_feasible_windows(spec)
        check_lap = brute_max_count(
            [Record(id=i, runner=1, gate=g, time=t) for i, r, g, t in spec], RANGES
        )
        assert out["lapCount"] == check_lap == base, (seed, out["lapCount"], base)

        got = {}
        for w in out["windows"]:
            key = (w["missingGate"], w["ids"][0], w["ids"][1])
            assert key not in got, (seed, "重复窗口", key)
            assert 0 <= w["timeMin"] <= w["timeMax"], (seed, "区间非法", w)
            got[key] = (w["timeMin"], w["timeMax"])

        # 键集合一致：能增次的对恰好是返回的对
        assert set(got) == set(feasible), (
            seed,
            "窗口键集合不一致",
            sorted(set(got) ^ set(feasible)),
        )
        # 每个返回区间恰好覆盖全部可行秒数（不多不少）
        for key, (lo, hi) in got.items():
            want = feasible[key]
            assert want == set(range(lo, hi + 1)), (
                seed,
                key,
                (lo, hi),
                sorted(want ^ set(range(lo, hi + 1)))[:5],
            )
        # 排序：缺失门 S/M/F，再按两条 ID 序列字典序
        order = [
            ({"S": 0, "M": 1, "F": 2}[w["missingGate"]], w["ids"]) for w in out["windows"]
        ]
        assert order == sorted(order), (seed, "窗口排序")
    check(True, "400 组随机数据：窗口键、区间端点、排序全部与暴力一致")


def test_fuzz_multi_runner():
    print("场景12：多选手随机对拍（各选手独立）x100")
    for seed in range(100):
        rng = random.Random(20_000 + seed)
        runners = sorted(rng.sample(range(1, 10_000), 3))[: rng.randint(1, 3)]
        spec = []
        for rid in runners:
            for i in range(rng.randint(2, 8)):
                spec.append((f"r{rid}_{i}", rid, rng.choice("SMF"), rng.randint(0, 120)))
        out = windows_of(spec, runners=runners)
        check_sorted = [r["runner"] for r in out] == sorted(runners)
        assert check_sorted, (seed, "选手排序")
        for entry in out:
            rid = entry["runner"]
            mine = [(i, r, g, t) for i, r, g, t in spec if r == rid]
            solo = windows_of(mine, runners=(rid,))[0]
            assert entry == solo, (seed, rid, "多选手结果与单选手独立计算不一致")
    check(True, "100 组多选手：按编号升序且各选手结果互不影响")


if __name__ == "__main__":
    test_missing_f_full_interval()
    test_missing_f_trimmed_by_count()
    test_missing_s_trimmed_by_count()
    test_missing_m_whole_interval()
    test_pairs_that_cannot_increase_are_omitted()
    test_sorting_and_multi_runner_isolation()
    test_big_integers_lossless()
    test_validation_identical_to_adjudicate()
    test_virtual_reading_not_counted_in_40()
    test_http_endpoint_contract()
    test_fuzz_against_bruteforce()
    test_fuzz_multi_runner()
    if failures:
        print(f"\n{failures} ASSERTION(S) FAILED")
        sys.exit(1)
    print("\nALL MISSING-WINDOW TESTS PASSED")
