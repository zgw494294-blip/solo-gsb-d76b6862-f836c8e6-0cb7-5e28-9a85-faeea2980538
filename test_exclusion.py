"""可疑记录隔离（excludedIds）规则测试：裁决/诊断/漏读共用一套校验与语义。"""

import copy
import json
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, ".")
from app.adjudication import AdjudicationError, adjudicate, diagnose, find_missing
from app.main import app

client = TestClient(app)

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("  ✓", msg)
    else:
        failures += 1
        print("  ✗", msg)


RANGES = {"smMin": 10, "smMax": 60, "mfMin": 10, "mfMax": 60}


def body(records, runners=(101, 102), excluded=None, standards=None):
    return {
        "standards": standards or RANGES,
        "runners": [{"number": n} for n in runners],
        "records": records,
        **({"excludedIds": excluded} if excluded is not None else {}),
    }


def rec(i, r, g, t):
    return {"id": i, "runner": r, "gate": g, "time": t}


# 选手 101：两趟 a1-b1-c1 / a2-b2-c2，外加可疑起点 sx（时间太晚，无法成趟）
# 与孤立中途门 xm(200)；sx、xm 都不被现方案采纳。
SPEC_101 = [
    ("a1", 101, "S", 0), ("b1", 101, "M", 12), ("c1", 101, "F", 25),
    ("a2", 101, "S", 30), ("b2", 101, "M", 45), ("c2", 101, "F", 58),
    ("sx", 101, "S", 130), ("xm", 101, "M", 200),
]
# 选手 102：一趟 d1-e1-f1。
SPEC_102 = [
    ("d1", 102, "S", 5), ("e1", 102, "M", 15), ("f1", 102, "F", 25),
]
SPEC = [rec(*s) for s in SPEC_101 + SPEC_102]


def test_no_excluded_contract_unchanged():
    print("场景1：不传 / 传空 excludedIds 时行为与字段保持原合同")
    out = adjudicate(body(SPEC))["runners"][0]
    check("excluded" in out and out["excluded"] == [], "裁决结果新增空 excluded 列")
    check(out["lapCount"] == 2, "不计隔离：仍为两趟")
    check(sorted(u["id"] for u in out["unused"]) == ["sx", "xm"], "未采纳记录不变")

    out_empty = adjudicate(body(SPEC, excluded=[]))["runners"][0]
    check(out_empty["lapCount"] == 2 and out_empty["excluded"] == [], "空数组等同缺省")

    diag = diagnose(body(SPEC))["runners"][0]
    check([d["id"] for d in diag["diagnoses"]] == ["sx", "xm"], "诊断合同不变")
    check(find_missing(body(SPEC))["runners"][0]["runner"] == 101, "漏读合同不变")

    # 原始 HTTP 合同：不带 excludedIds 的请求仍 200，且结构兼容。
    payload = body(SPEC)
    r = client.post("/api/adjudicate", json=payload)
    check(r.status_code == 200, "POST /api/adjudicate 200")
    check(r.json()["result"]["runners"][0]["excluded"] == [], "响应含空 excluded 列")
    print("test_no_excluded_contract_unchanged OK")


def test_exclude_changes_count_and_split_sections():
    print("场景2：隔离可疑记录后只用未隔离记录计算，且结果分列")
    # 隔离 sx（31）：两趟方案本就不用它，结果不变但它不再出现在未采纳列。
    out = adjudicate(body(SPEC, excluded=["sx"]))["runners"][0]
    check(out["lapCount"] == 2, "隔离未采纳记录：计次数不变")
    check([u["id"] for u in out["unused"]] == ["xm"], "普通未采纳只剩 xm")
    check([x["id"] for x in out["excluded"]] == ["sx"], "sx 单列到隔离记录")
    check(out["excluded"][0] == {"id": "sx", "gate": "S", "time": 130}, "隔离记录保留门与原始秒数")

    # 隔离第二趟的起点 a2：最大计次数降到 1，a2 进隔离列而非未采纳列。
    out2 = adjudicate(body(SPEC, excluded=["a2"]))["runners"][0]
    check(out2["lapCount"] == 1, "隔离采纳记录后少一趟")
    check([l["start"]["id"] for l in out2["laps"]] == ["a1"], "只剩第一趟")
    check([x["id"] for x in out2["excluded"]] == ["a2"], "a2 列入隔离")
    check(
        sorted(u["id"] for u in out2["unused"]) == ["b2", "c2", "sx", "xm"],
        "第二趟其余记录与 sx/xm 成为普通未采纳",
    )
    check("a2" not in [u["id"] for u in out2["unused"]], "a2 不重复出现在未采纳列")

    # 隔离不影响其他选手：102 仍一趟。
    out_102 = adjudicate(body(SPEC, excluded=["a2"]))["runners"][1]
    check(out_102["lapCount"] == 1 and out_102["excluded"] == [], "其他选手不受影响")
    print("test_exclude_changes_count_and_split_sections OK")


def test_exclude_all_means_zero():
    print("场景3：全部隔离按零次处理，原始记录全部留在隔离列")
    ids_101 = [s[0] for s in SPEC_101]
    out = adjudicate(body(SPEC, excluded=ids_101))["runners"][0]
    check(out["lapCount"] == 0 and out["laps"] == [], "全部隔离：0 趟")
    check(out["unused"] == [], "没有普通未采纳记录")
    check([x["id"] for x in out["excluded"]] == ids_101, "八条全部列入隔离（按录入顺序）")
    # 102 未隔离，仍正常计一趟。
    out_102 = adjudicate(body(SPEC, excluded=ids_101))["runners"][1]
    check(out_102["lapCount"] == 1, "未隔离的其他选手照常计次")

    # 诊断与漏读也只基于未隔离记录：101 无任何活动记录。
    diag = diagnose(body(SPEC, excluded=ids_101))["runners"][0]
    check(diag["lapCount"] == 0 and diag["diagnoses"] == [], "全隔离：诊断无记录")
    missing = find_missing(body(SPEC, excluded=ids_101))["runners"][0]
    check(missing["lapCount"] == 0 and missing["windows"] == [], "全隔离：漏读无窗口")
    print("test_exclude_all_means_zero OK")


def test_diagnose_and_missing_use_active_only():
    print("场景4：诊断/漏读只用未隔离记录，且不含隔离记录")
    # xm(200) 本 unusable；隔离它后诊断中彻底消失。
    diag = diagnose(body(SPEC, excluded=["xm"]))["runners"][0]
    check([d["id"] for d in diag["diagnoses"]] == ["sx"], "隔离记录不进入诊断")
    check(diag["lapCount"] == 2, "诊断的现方案计次仍按活动记录为 2")

    # 隔离采纳记录 a2 后，没有另一条可替代起点（sx@130 无法与 b2 成趟）：
    # 最大计次数降为 1，a2 不在诊断中，诊断基于隔离后的方案。
    diag2 = diagnose(body(SPEC, excluded=["a2"]))["runners"][0]
    check(diag2["lapCount"] == 1, "隔离 a2 后第二趟无法组成，现方案为 1 趟")
    check("a2" not in [d["id"] for d in diag2["diagnoses"]], "a2 不出现在诊断")
    check(
        "b2" in [d["id"] for d in diag2["diagnoses"]]
        and "c2" in [d["id"] for d in diag2["diagnoses"]],
        "b2/c2 作为隔离后方案的未采纳记录被诊断",
    )
    # 漏读请求可带 excludedIds 且正常 200（窗口内容随活动记录变化，只校验形状一致）。
    r = client.post("/api/missing", json=body(SPEC, excluded=["xm"]))
    check(r.status_code == 200 and "windows" in r.json()["result"]["runners"][0],
          "POST /api/missing 支持 excludedIds")
    print("test_diagnose_and_missing_use_active_only OK")


def test_excluded_ids_validation():
    print("场景5：excludedIds 校验——类型、空白、重复、不存在均 422")
    base = body(SPEC)

    def must_422(tweak, label):
        p = copy.deepcopy(base)
        tweak(p)
        try:
            adjudicate(p)
        except AdjudicationError:
            pass
        else:
            raise AssertionError(f"应当 422: {label}")
        # 三个端点同一套校验。
        for ep in ("/api/adjudicate", "/api/diagnose", "/api/missing"):
            r = client.post(ep, json=p)
            check(r.status_code == 422 and r.json()["ok"] is False,
                  f"{label} -> {ep} 422（{r.json().get('error')}）")

    must_422(lambda p: p.update(excludedIds="sx"), "不是数组")
    must_422(lambda p: p.update(excludedIds={}), "对象而非数组")
    must_422(lambda p: p.update(excludedIds=None), "显式 null")
    must_422(lambda p: p.update(excludedIds=["sx", 1]), "含非字符串元素")
    must_422(lambda p: p.update(excludedIds=["  "]), "空白 ID")
    must_422(lambda p: p.update(excludedIds=["sx", "sx"]), "字面重复")
    must_422(lambda p: p.update(excludedIds=[" sx ", "sx"]), "去空白后重复")
    must_422(lambda p: p.update(excludedIds=["nope"]), "ID 不存在")

    # 去空白等值：" a1 " 等同于现有 ID "a1"，合法。
    p = copy.deepcopy(base)
    p["excludedIds"] = [" a1 "]
    out = adjudicate(p)["runners"][0]
    check([x["id"] for x in out["excluded"]] == ["a1"], "带空白的 ID 按去空白规则匹配")
    print("test_excluded_ids_validation OK")


def test_full_input_validated_before_exclusion():
    print("场景6：完整输入与 40 条限额先按原规则校验，隔离不能救非法/超限额")
    # 41 条且把多余一条隔离：仍因超过 40 条而 422。
    recs41 = [rec(f"r{i}", 101, "S", i) for i in range(41)]
    p = body(recs41, runners=(101,), excluded=["r40"])
    for ep in ("/api/adjudicate", "/api/diagnose", "/api/missing"):
        r = client.post(ep, json=p)
        check(r.status_code == 422 and "40" in r.json()["error"],
              f"超 40 条即使隔离仍 422：{ep}")

    # 未登记选手的记录即使被隔离也非法（隔离不跳过字段校验）。
    bad = body(SPEC + [rec("zz", 999, "S", 0)], excluded=["zz"])
    r = client.post("/api/adjudicate", json=bad)
    check(r.status_code == 422 and "未登记" in r.json()["error"], "隔离未知选手记录仍 422")

    # 区间非法时 excludedIds 合法也不返回部分结果。
    bad_range = body(SPEC, excluded=["sx"],
                     standards={"smMin": 61, "smMax": 60, "mfMin": 10, "mfMax": 60})
    r = client.post("/api/adjudicate", json=bad_range)
    check(r.status_code == 422, "区间非法仍 422，不展示部分结果")

    # excludedIds 引用不存在 ID 时与“记录不完整”等原有非法同时存在：仍是 422。
    incomplete = copy.deepcopy(body(SPEC, excluded=["ghost"]))
    incomplete["records"].append({"id": "p", "runner": 101, "gate": "S"})
    r = client.post("/api/adjudicate", json=incomplete)
    check(r.status_code == 422, "记录不完整与坏 excludedIds 并存仍 422")
    print("test_full_input_validated_before_exclusion OK")


def test_excluded_ids_order_and_shape():
    print("场景7：excludedIds 顺序无关，裁决隔离列按录入顺序；JSON 大整数秒数无损")
    # 隔离第二趟全部三条：只剩第一趟；隔离列按录入顺序。
    ids = ["b2", "a2", "c2"]
    out_a = adjudicate(body(SPEC, excluded=ids))["runners"][0]
    out_b = adjudicate(body(SPEC, excluded=list(reversed(ids))))["runners"][0]
    check(out_a["lapCount"] == out_b["lapCount"] == 1, "隔离集合与传入顺序无关")
    check([x["id"] for x in out_a["excluded"]] == ["a2", "b2", "c2"],
          "隔离列按记录录入顺序而非 excludedIds 顺序")

    # 大整数秒数：隔离记录的原始秒数在响应中精确返回（不截断）。
    big_t = 9007199254741014
    big_spec = [
        rec("h1", 101, "S", 9007199254740992),
        rec("h2", 101, "M", 9007199254741003),
        rec("h3", 101, "F", big_t),
    ]
    p = body(big_spec, runners=(101,), excluded=["h3"])
    text = json.dumps(client.post("/api/adjudicate", json=p).json())
    check(f'"time": {big_t}' in text, "隔离记录的超大秒数在 JSON 中精确原样返回")
    out = adjudicate(p)["runners"][0]
    check(out["excluded"][0]["time"] == big_t and out["lapCount"] == 0,
          "大秒数隔离后精确保留且按零次处理")
    print("test_excluded_ids_order_and_shape OK")


def test_merge_still_uses_full_table():
    print("场景8：设备日志合并不受隔离影响——冲突与 40 条限额仍对完整原表生效")
    # 现有 a1 被隔离；CSV 里 a1 改了秒数 → 同 ID 冲突仍整批拒绝（隔离不能跳过冲突）。
    context = {
        "runners": [{"number": 101}],
        "records": [
            rec("a1", "101", "S", 0), rec("b1", "101", "M", 12), rec("c1", "101", "F", 25)
        ],
    }
    files = {"file": ("log.csv", b"id,runner,gate,time\na1,101,S,9\n", "text/csv")}
    r = client.post("/api/import/preview",
                    data={"context": json.dumps(context)}, files=files)
    check(r.status_code == 422 and "冲突" in r.json()["error"],
          "被隔离 ID 的内容冲突仍整批拒绝")

    # 40 条现有全部隔离，再并入 1 条新记录：仍因完整原表达 41 条而拒绝。
    ctx40 = {
        "runners": [{"number": 1}],
        "records": [rec(f"e{i}", 1, "S", i) for i in range(40)],
    }
    files = {"file": ("n.csv", b"id,runner,gate,time\nn1,1,S,100\n", "text/csv")}
    r = client.post("/api/import/preview",
                    data={"context": json.dumps(ctx40)}, files=files)
    check(r.status_code == 422 and "40" in r.json()["error"],
          "40 条全隔离后新增仍超限额拒绝")

    # 内容一致的重复照常跳过：隔离不改变去重语义。
    files = {"file": ("d.csv", b"id,runner,gate,time\nc1,101,F,25\nn2,101,S,90\n",
                      "text/csv")}
    r = client.post("/api/import/preview",
                    data={"context": json.dumps(context)}, files=files)
    check(r.status_code == 200, "一致重复 + 新增：200")
    res = r.json()["result"]
    check([e["id"] for e in res["duplicates"]] == ["c1"], "c1 仍识别为重复")
    check([e["id"] for e in res["added"]] == ["n2"] and res["mergedCount"] == 4,
          "对完整原表计数（3+1=4）")
    print("test_merge_still_uses_full_table OK")


def main():
    test_no_excluded_contract_unchanged()
    test_exclude_changes_count_and_split_sections()
    test_exclude_all_means_zero()
    test_diagnose_and_missing_use_active_only()
    test_excluded_ids_validation()
    test_full_input_validated_before_exclusion()
    test_excluded_ids_order_and_shape()
    test_merge_still_uses_full_table()
    print("\nALL EXCLUSION TESTS PASSED" if failures == 0 else f"\n{failures} ASSERTION(S) FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
