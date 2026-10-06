"""成绩公告（只读裁决快照）规则测试：发布/读取 HTTP 合同、复核与罚秒核对、
乐观版本并发、SQLite 跨“重启”持久化、大整数精度、隔离快照与旧合同不变。"""

import json
import os
import sys
import tempfile
import threading

from fastapi.testclient import TestClient

sys.path.insert(0, ".")

# 公告库使用临时文件，避免污染默认路径。
_tmpdir = tempfile.mkdtemp(prefix="bulletin-test-")
os.environ["BULLETIN_DB_PATH"] = os.path.join(_tmpdir, "bulletins.db")

from app.bulletins import close_store_for_tests, reset_store_for_tests  # noqa: E402
from app.main import app  # noqa: E402

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


def rec(i, r, g, t):
    return {"id": i, "runner": r, "gate": g, "time": t}


SPEC_101 = [
    ("a1", 101, "S", 0), ("b1", 101, "M", 12), ("c1", 101, "F", 25),
    ("a2", 101, "S", 30), ("b2", 101, "M", 45), ("c2", 101, "F", 58),
    ("sx", 101, "S", 130), ("xm", 101, "M", 200),
]
SPEC_102 = [
    ("d1", 102, "S", 5), ("e1", 102, "M", 15), ("f1", 102, "F", 25),
]
SPEC = [rec(*s) for s in SPEC_101 + SPEC_102]

REVIEWS_ALL_PASS = [
    {"runner": 101,
     "start": {"id": "a1", "gate": "S", "time": 0},
     "middle": {"id": "b1", "gate": "M", "time": 12},
     "finish": {"id": "c1", "gate": "F", "time": 25},
     "smTime": 12, "mfTime": 13, "status": "pass", "note": "一趟通过"},
    {"runner": 101,
     "start": {"id": "a2", "gate": "S", "time": 30},
     "middle": {"id": "b2", "gate": "M", "time": 45},
     "finish": {"id": "c2", "gate": "F", "time": 58},
     "smTime": 15, "mfTime": 13, "status": "pass", "note": ""},
    {"runner": 102,
     "start": {"id": "d1", "gate": "S", "time": 5},
     "middle": {"id": "e1", "gate": "M", "time": 15},
     "finish": {"id": "f1", "gate": "F", "time": 25},
     "smTime": 10, "mfTime": 10, "status": "pass", "note": ""},
]


def publish_body(bid="B1", expected=0, reviews=None, penalties=None,
                 records=None, runners=(101, 102), excluded=None, standards=None):
    body = {
        "bulletinId": bid,
        "expectedVersion": expected,
        "standards": standards or RANGES,
        "runners": [{"number": n} for n in runners],
        "records": SPEC if records is None else records,
        "excludedIds": [] if excluded is None else excluded,
        "reviews": REVIEWS_ALL_PASS if reviews is None else reviews,
        "penalties": [] if penalties is None else penalties,
    }
    return body


def test_happy_path_and_read():
    print("场景1：全部通过复核 → 发布 v0，按编号/版本读取，未知 404")
    reset_store_for_tests()
    r = client.post("/api/bulletins", json=publish_body())
    check(r.status_code == 200, f"发布 200（实际 {r.status_code} {r.json() if r.status_code != 200 else ''}）")
    res = r.json()["result"]
    check(res["version"] == 0 and res["latestVersion"] == 0, "首次发布版本为 0")
    check(res["url"].endswith("/api/bulletins/B1/versions/0"), "返回本版 JSON 链接")
    check(res["latestUrl"].endswith("/api/bulletins/B1"), "返回最新链接")
    check(res["viewUrl"].endswith("/bulletin.html?id=B1&version=0"), "返回只读页面链接")

    # 最新与定版读取内容一致。
    got_latest = client.get("/api/bulletins/B1").json()["result"]
    got_v0 = client.get("/api/bulletins/B1/versions/0").json()["result"]
    check(got_latest["version"] == got_v0["version"] == 0, "缺省读最新 = 第 0 版")
    check(client.get("/api/bulletins/NOPE").status_code == 404, "未知编号 404")
    check(client.get("/api/bulletins/B1/versions/9").status_code == 404, "未知版本 404")

    # 快照含完整输入、采纳方案、复核、处罚与名次，且记录秒数精确。
    check(len(got_v0["input"]["records"]) == len(SPEC), "保存完整输入记录")
    check(got_v0["input"]["excludedIds"] == [], "隔离列表为空数组")
    adj = {r["runner"]: r for r in got_v0["adjudication"]["runners"]}
    check(adj[101]["lapCount"] == 2 and adj[102]["lapCount"] == 1, "服务端重新裁决：2 / 1 趟")
    check(len(got_v0["reviews"]) == 3, "保存三条通过复核")
    check(all(rv["status"] == "pass" for rv in got_v0["reviews"]), "复核均为通过")
    ranking = {row["runner"]: row for row in got_v0["ranking"]}
    check(ranking[101]["rank"] == 1 and ranking[102]["rank"] == 2,
          "名次按原规则：101 两趟第一，102 一趟第二")
    print("test_happy_path_and_read OK")


def test_version_chain_and_409():
    print("场景2：连续发布版本递增；过期版本 409 且不留版本不改现公告")
    reset_store_for_tests()
    r1 = client.post("/api/bulletins", json=publish_body())
    check(r1.status_code == 200 and r1.json()["result"]["version"] == 0, "v0 成功")
    # 见过 v0（所见版本 0）再次发布 → 落库 v1。
    r2 = client.post("/api/bulletins", json=publish_body(expected=0))
    check(r2.status_code == 200 and r2.json()["result"]["version"] == 1, "以所见 0 发布 v1")
    # 成功后页面所见版本前进为 1；仍用旧的 0 发布：409，且不产生 v2。
    r3 = client.post("/api/bulletins", json=publish_body(expected=0))
    check(r3.status_code == 409, "过期发布 409")
    check(r3.json()["latestVersion"] == 1, "409 返回服务端当前版本 1")
    check(client.get("/api/bulletins/B1").json()["result"]["version"] == 1,
          "失败不留版本：最新仍是 v1")
    # 以最新所见 1 发布 → v2。
    r4 = client.post("/api/bulletins", json=publish_body(expected=1))
    check(r4.status_code == 200 and r4.json()["result"]["version"] == 2, "以所见 1 发布 v2")
    # v0/v1 仍可读取且内容未被后续版本改动（旧版永久只读）。
    v0 = client.get("/api/bulletins/B1/versions/0").json()["result"]
    v1 = client.get("/api/bulletins/B1/versions/1").json()["result"]
    check(v0["version"] == 0 and v0["latestVersion"] == 2, "旧版 v0 仍可读取且自标 0")
    check(v1["version"] == 1, "旧版 v1 仍可读取")
    # 缺省 expectedVersion 视为 0；当前最新为 2，应 409。
    body_no_expected = publish_body()
    del body_no_expected["expectedVersion"]
    check(client.post("/api/bulletins", json=body_no_expected).status_code == 409,
          "最新版本已前进后缺省版本（0）同样 409")
    print("test_version_chain_and_409 OK")


def test_review_verification():
    print("场景3：复核按选手/三条记录 ID/门/秒数与区间核对；每趟必须通过")
    reset_store_for_tests()

    def must_reject(reviews, label, *, tweak_body=None):
        b = publish_body(reviews=reviews)
        if tweak_body:
            tweak_body(b)
        r = client.post("/api/bulletins", json=b)
        check(r.status_code == 422, f"{label} -> 422（{r.json().get('error')}）")

    # 少一条通过复核（102 的趟未复核）。
    must_reject(REVIEWS_ALL_PASS[:2], "缺少 102 的通过复核")
    # 只缺 101 的第二趟。
    must_reject([REVIEWS_ALL_PASS[0], REVIEWS_ALL_PASS[2]], "缺少 101 第二趟复核")
    # 复核趟与采纳不匹配：改一条记录 ID。
    bad = json.loads(json.dumps(REVIEWS_ALL_PASS))
    bad[0]["start"]["id"] = "sx"
    must_reject(bad, "复核 ID 与采纳趟不匹配")
    # 秒数不一致。
    bad = json.loads(json.dumps(REVIEWS_ALL_PASS))
    bad[0]["middle"]["time"] = 13
    bad[0]["smTime"] = 13
    must_reject(bad, "复核秒数与采纳趟不匹配")
    # 门不匹配。
    bad = json.loads(json.dumps(REVIEWS_ALL_PASS))
    bad[0]["start"]["gate"] = "M"
    must_reject(bad, "复核门不匹配")
    # 选手编号不属于任何登记选手。
    bad = json.loads(json.dumps(REVIEWS_ALL_PASS))
    bad[0]["runner"] = 999
    must_reject(bad, "复核选手不匹配（未采纳该趟）")
    # 同一趟重复提交。
    must_reject(REVIEWS_ALL_PASS + [REVIEWS_ALL_PASS[0]], "同趟重复复核")
    # 状态为存疑/未复核（即使趟匹配）也拒绝。
    bad = json.loads(json.dumps(REVIEWS_ALL_PASS))
    bad[0]["status"] = "doubt"
    bad[0]["note"] = "存疑备注"
    must_reject(bad, "存疑复核不能发布")
    bad = json.loads(json.dumps(REVIEWS_ALL_PASS))
    bad[0]["status"] = "pending"
    must_reject(bad, "未复核不能发布")
    # 备注超长（沿用原校验，至多 200 字）。
    bad = json.loads(json.dumps(REVIEWS_ALL_PASS))
    bad[0]["note"] = "长" * 201
    must_reject(bad, "复核备注超长 422")

    # 区间改变使两段耗时越界：复核与新输入的区间不绑定趟（趟根本不被采纳）→ 拒绝。
    b = publish_body(
        standards={"smMin": 10, "smMax": 11, "mfMin": 10, "mfMax": 60},
        reviews=[
            # 101 第一趟 sm=12，新区间下不成趟；构造 0 条匹配复核必然被拒。
        ],
    )
    check(client.post("/api/bulletins", json=b).status_code == 422,
          "区间变化后原趟不再采纳：缺少通过复核 422")

    # 0 次选手无需复核：给一个只有非法成趟记录的选手，全 0 次，零条复核即可发布。
    zero_records = [rec("z1", 7, "S", 0), rec("z2", 7, "M", 200), rec("z3", 7, "F", 201)]
    r = client.post("/api/bulletins",
                    json=publish_body(bid="Z1", runners=(7,), records=zero_records, reviews=[]))
    check(r.status_code == 200, f"0 次选手无需复核即可发布（{r.status_code} {r.json() if r.status_code != 200 else ''}）")
    got = client.get("/api/bulletins/Z1").json()["result"]
    check(got["adjudication"]["runners"][0]["lapCount"] == 0, "公告记录 0 次")
    check(got["reviews"] == [], "0 次选手无复核快照")
    z_rank = got["ranking"][0]
    check(z_rank["rank"] is None and z_rank["lapCount"] == 0, "0 次选手无名次")
    print("test_review_verification OK")


def test_penalty_validation_and_ranking():
    print("场景4：未知选手处罚整次拒绝；罚秒/原因沿用原校验；名次服务端重算")
    reset_store_for_tests()

    def must_reject(penalties, label):
        r = client.post("/api/bulletins", json=publish_body(penalties=penalties))
        check(r.status_code == 422, f"{label} -> 422（{r.json().get('error')}）")

    must_reject([{"runner": 555, "seconds": 3, "reason": "幽灵选手"}], "未知选手处罚")
    must_reject([{"runner": 101, "seconds": -1, "reason": "负罚秒"}], "负罚秒")
    must_reject([{"runner": 101, "seconds": 1.5, "reason": "小数罚秒"}], "小数罚秒")
    must_reject([{"runner": 101, "seconds": 5, "reason": ""}], "罚秒大于 0 无原因")
    long_reason = [{"runner": 101, "seconds": 5, "reason": "因" * 201}]
    must_reject(long_reason, "原因超长")
    must_reject([
        {"runner": 101, "seconds": 1, "reason": "x"},
        {"runner": 101, "seconds": 2, "reason": "y"},
    ], "同选手重复罚秒")

    # 名次首键是计次数降序：101 两趟即使被罚也压过 102 一趟。
    # 要翻转名次需用计次数相同的数据（见下方并列场景）；这里先验证罚秒精确参与
    # 调整后用时但不跨越计次数层级。
    body = publish_body(penalties=[{"runner": 101, "seconds": 70, "reason": "抢跑"}])
    r = client.post("/api/bulletins", json=body)
    check(r.status_code == 200, f"合法罚秒发布 200（{r.status_code}）")
    got = r.json()["result"]
    ranking = {row["runner"]: row for row in got["ranking"]}
    check(ranking[101]["rank"] == 1 and ranking[102]["rank"] == 2,
          "计次数为首键：被罚的两趟 101 仍排在一趟 102 之前")
    check(ranking[101]["adjustedTime"] == 53 + 70 and ranking[101]["penaltySeconds"] == 70,
          "调整后用时（53+70=123）与罚秒精确")
    check(ranking[101]["penaltyReason"] == "抢跑", "原因保存")

    # 同计次数下罚秒改变名次：两人各一趟，101 原总 25 罚 70 → 95；102 原总 20 → 第一。
    tie_records = [
        rec("a1", 101, "S", 0), rec("b1", 101, "M", 12), rec("c1", 101, "F", 25),
        rec("d1", 102, "S", 5), rec("e1", 102, "M", 15), rec("f1", 102, "F", 25),
    ]
    one_lap_reviews = [
        {"runner": 101, "start": {"id": "a1", "gate": "S", "time": 0},
         "middle": {"id": "b1", "gate": "M", "time": 12},
         "finish": {"id": "c1", "gate": "F", "time": 25},
         "smTime": 12, "mfTime": 13, "status": "pass", "note": ""},
        {"runner": 102, "start": {"id": "d1", "gate": "S", "time": 5},
         "middle": {"id": "e1", "gate": "M", "time": 15},
         "finish": {"id": "f1", "gate": "F", "time": 25},
         "smTime": 10, "mfTime": 10, "status": "pass", "note": ""},
    ]
    body = publish_body(bid="FLIP", records=tie_records, reviews=one_lap_reviews, penalties=[
        {"runner": 101, "seconds": 70, "reason": "抢跑"},
    ])
    r = client.post("/api/bulletins", json=body)
    check(r.status_code == 200, f"罚秒翻转名次 200（{r.status_code} {r.json() if r.status_code != 200 else ''}）")
    flip = {row["runner"]: row for row in r.json()["result"]["ranking"]}
    check(flip[102]["rank"] == 1 and flip[101]["rank"] == 2,
          "同计次数下罚秒使 102 升至第一")
    check(flip[101]["adjustedTime"] == 95, "101 调整后用时 25+70=95")

    # 并列共享名次：101 罚 0、102 罚 5，两人调整后均为 25，并列第 1。
    body = publish_body(bid="TIE", records=tie_records, reviews=one_lap_reviews, penalties=[
        {"runner": 101, "seconds": 0, "reason": ""},
        {"runner": 102, "seconds": 5, "reason": "x"},
    ])
    r = client.post("/api/bulletins", json=body)
    check(r.status_code == 200, f"并列场景发布 200（{r.status_code} {r.json() if r.status_code != 200 else ''}）")
    ranks = sorted(r.json()["result"]["ranking"], key=lambda x: x["rank"] or 99)
    check([row["rank"] for row in ranks if row["rank"] is not None] == [1, 1],
          "并列共享名次（1、1）")
    # 未提交罚秒的选手按 0 秒处理。
    body = publish_body(bid="NOPEN", penalties=[])
    check(client.post("/api/bulletins", json=body).status_code == 200, "全部缺省罚秒合法")
    print("test_penalty_validation_and_ranking OK")


def test_bulletin_id_validation_and_bad_inputs():
    print("场景5：公告编号非空；输入非法沿用原裁决校验；非 JSON 400")
    reset_store_for_tests()
    for bad_id in ["", "   "]:
        r = client.post("/api/bulletins", json=publish_body(bid=bad_id))
        check(r.status_code == 422, f"编号 {bad_id!r} -> 422")
    r = client.post("/api/bulletins", json=publish_body(bid="a/b"))
    check(r.status_code == 422, "编号含斜杠 422")
    r = client.post("/api/bulletins", json=publish_body(bid="x" * 101))
    check(r.status_code == 422, "编号超长 422")

    # 裁决输入非法（重号选手）整次 422。
    bad = publish_body(runners=(101, 101))
    check(client.post("/api/bulletins", json=bad).status_code == 422, "选手重号 422")
    # 41 条记录。
    recs41 = [rec(f"r{i}", 101, "S", i) for i in range(41)]
    bad = publish_body(runners=(101,), records=recs41, reviews=[])
    check(client.post("/api/bulletins", json=bad).status_code == 422, "超 40 条 422")
    # 非法 excludedIds（不存在 ID）：先按原裁决校验拒绝。
    bad = publish_body(excluded=["ghost"])
    check(client.post("/api/bulletins", json=bad).status_code == 422, "非法隔离 ID 422")
    # 非 JSON：400。
    r = client.post("/api/bulletins", content="not-json",
                    headers={"Content-Type": "application/json"})
    check(r.status_code == 400, "非 JSON 请求体 400")
    # 负的所见版本：422。
    bad = publish_body(expected=-1)
    check(client.post("/api/bulletins", json=bad).status_code == 422, "负版本号 422")
    print("test_bulletin_id_validation_and_bad_inputs OK")


def test_exclusion_snapshot():
    print("场景6：隔离进入快照；发布后重新纳入不影响公告，服务端按隔离重裁")
    reset_store_for_tests()
    # 隔离 a2：101 只应剩 1 趟，因此只需 101 第一趟 + 102 的通过复核。
    reviews = [REVIEWS_ALL_PASS[0], REVIEWS_ALL_PASS[2]]
    r = client.post("/api/bulletins",
                    json=publish_body(bid="EX1", reviews=reviews, excluded=["a2"]))
    check(r.status_code == 200, f"带隔离发布 200（{r.status_code} {r.json() if r.status_code != 200 else ''}）")
    got = r.json()["result"]
    adj101 = {x["runner"]: x for x in got["adjudication"]["runners"]}[101]
    check(adj101["lapCount"] == 1, "服务端按隔离重新裁决：101 只剩一趟")
    check(got["input"]["excludedIds"] == ["a2"], "快照保存隔离 ID")
    check([x["id"] for x in adj101["excluded"]] == ["a2"], "采纳方案保留隔离列")
    # 快照里的输入仍是完整原表（原始读数保留）。
    check(len(got["input"]["records"]) == len(SPEC), "完整原表（含隔离记录）入快照")

    # 发布新 v1（去掉隔离、需补回第二趟通过复核）：v0 内容不变。
    r2 = client.post("/api/bulletins", json=publish_body(bid="EX1", expected=0, reviews=None))
    check(r2.status_code == 200 and r2.json()["result"]["version"] == 1, "重纳入后发布 v1")
    v0 = client.get("/api/bulletins/EX1/versions/0").json()["result"]
    check(v0["input"]["excludedIds"] == ["a2"], "旧版 v0 的隔离状态永久不变")
    check({x["runner"]: x for x in v0["adjudication"]["runners"]}[101]["lapCount"] == 1,
          "旧版 v0 的裁决结果永久不变")
    print("test_exclusion_snapshot OK")


def test_big_integer_precision():
    print("场景7：超大编号/秒数/罚秒在发布与读取中全程精确")
    reset_store_for_tests()
    ts, tm, tf = 9007199254740992, 9007199254741003, 9007199254741014
    big_runner = 9007199254740993
    body = {
        "bulletinId": "BIG1",
        "expectedVersion": 0,
        "standards": {"smMin": "10", "smMax": "60", "mfMin": "10", "mfMax": "60"},
        "runners": [{"number": str(big_runner)}],
        "records": [
            {"id": "h1", "runner": str(big_runner), "gate": "S", "time": str(ts)},
            {"id": "h2", "runner": str(big_runner), "gate": "M", "time": str(tm)},
            {"id": "h3", "runner": str(big_runner), "gate": "F", "time": str(tf)},
        ],
        "excludedIds": [],
        "reviews": [{
            "runner": str(big_runner),
            "start": {"id": "h1", "gate": "S", "time": str(ts)},
            "middle": {"id": "h2", "gate": "M", "time": str(tm)},
            "finish": {"id": "h3", "gate": "F", "time": str(tf)},
            "smTime": "11", "mfTime": "11", "status": "pass", "note": "",
        }],
        "penalties": [{"runner": str(big_runner), "seconds": "9007199254741100", "reason": "大罚秒"}],
    }
    r = client.post("/api/bulletins", json=body)
    check(r.status_code == 200, f"大整数发布 200（{r.status_code} {r.json() if r.status_code != 200 else ''}）")
    text = client.get("/api/bulletins/BIG1/versions/0").text
    check(str(big_runner) in text, "超大编号精确出现在读取 JSON")
    check(str(ts) in text and str(tm) in text and str(tf) in text, "三条超大秒数精确")
    check('"smTime":11' in text and '"mfTime":11' in text, "两段 11 秒差值精确（不被截成 12/10）")
    check("9007199254741100" in text, "超大罚秒精确")
    # 前导零等值：复核编号 "09007..." 与登记编号等值，趟可匹配发布。
    body2 = json.loads(json.dumps(body))
    body2["bulletinId"] = "BIG2"
    body2["reviews"][0]["runner"] = "0" + str(big_runner)
    check(client.post("/api/bulletins", json=body2).status_code == 200,
          "前导零等值编号复核可匹配")
    print("test_big_integer_precision OK")


def test_concurrent_publish_only_one_wins():
    print("场景8：同版本并发发布恰好一项成功，其余 409，仅产生一个新版本")
    reset_store_for_tests()
    client.post("/api/bulletins", json=publish_body())  # 先建立 v0

    results = []

    def worker():
        # 每个线程使用独立 TestClient（共享同一进程内服务与 SQLite 连接）。
        local = TestClient(app)
        r = local.post("/api/bulletins", json=publish_body(expected=0))
        results.append(r.status_code)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check(sorted(results).count(200) == 1, f"并发 8 个同版本发布仅一项 200（实际：{sorted(results)}）")
    check(sorted(results).count(409) == 7, "其余 7 项 409")
    latest = client.get("/api/bulletins/B1").json()["result"]["version"]
    check(latest == 1, "只产生了一个新版本（最新 = 1）")
    check(client.get("/api/bulletins/B1/versions/2").status_code == 404, "没有 v2")
    print("test_concurrent_publish_only_one_wins OK")


def test_persistence_across_restart():
    print("场景9：SQLite 数据跨“重启”保留（重置内存连接后旧公告仍在，且为只读）")
    client.post("/api/bulletins", json=publish_body(bid="PERSIST"))
    client.post("/api/bulletins", json=publish_body(bid="PERSIST", expected=0))
    # 模拟进程重启：清掉模块级连接（并 TRUNCATE 检查点），保留库文件；
    # 新连接应从同一数据卷文件读回两个版本。
    close_store_for_tests()
    r = client.get("/api/bulletins/PERSIST")
    check(r.status_code == 200 and r.json()["result"]["version"] == 1,
          "重启后仍能读到最新 v1")
    r0 = client.get("/api/bulletins/PERSIST/versions/0")
    check(r0.status_code == 200 and r0.json()["result"]["version"] == 0,
          "重启后旧版 v0 仍在且只读")
    # 重启后乐观版本仍然连续：所见 0 已过期（最新为 1），需以 1 发布。
    check(client.post("/api/bulletins", json=publish_body(bid="PERSIST", expected=0)).status_code == 409,
          "重启后期望 0 仍判过期")
    r = client.post("/api/bulletins", json=publish_body(bid="PERSIST", expected=1))
    check(r.status_code == 200 and r.json()["result"]["version"] == 2,
          "以重启后所见最新 1 发布得到 v2")
    print("test_persistence_across_restart OK")


def test_old_contract_unchanged():
    print("场景10：原 HTTP 合同不受影响（裁决/诊断/漏读/导入与静态页面）")
    r = client.post("/api/adjudicate", json={
        "standards": RANGES,
        "runners": [{"number": 101}],
        "records": [rec("a1", 101, "S", 0), rec("b1", 101, "M", 12), rec("c1", 101, "F", 25)],
    })
    check(r.status_code == 200 and r.json()["result"]["runners"][0]["lapCount"] == 1,
          "/api/adjudicate 合同不变")
    for ep in ("/api/diagnose", "/api/missing"):
        check(client.post(ep, json={"standards": RANGES, "runners": [{"number": 101}],
                                   "records": []}).status_code == 200,
              f"{ep} 合同不变")
    files = {"file": ("log.csv", b"id,runner,gate,time\n", "text/csv")}
    r = client.post("/api/import/preview",
                    data={"context": json.dumps({"runners": [{"number": 101}], "records": []})},
                    files=files)
    check(r.status_code == 200, "导入预览合同不变")
    # 静态页面与只读公告页可经 8000 端口同款静态服务读取。
    check(client.get("/").status_code == 200, "主页 200")
    check(client.get("/bulletin.html").status_code == 200, "/bulletin.html 只读页 200")
    check(client.get("/bulletin-view.js").status_code == 200, "/bulletin-view.js 200")
    print("test_old_contract_unchanged OK")


def main():
    test_happy_path_and_read()
    test_version_chain_and_409()
    test_review_verification()
    test_penalty_validation_and_ranking()
    test_bulletin_id_validation_and_bad_inputs()
    test_exclusion_snapshot()
    test_big_integer_precision()
    test_concurrent_publish_only_one_wins()
    test_persistence_across_restart()
    test_old_contract_unchanged()
    print("\nALL BULLETIN TESTS PASSED" if failures == 0 else f"\n{failures} ASSERTION(S) FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
