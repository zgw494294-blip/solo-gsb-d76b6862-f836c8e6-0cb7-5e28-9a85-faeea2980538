"""成绩公告：发布（重新裁决 + 复核/处罚核对 + 版本控制）与只读读取的测试。"""

import json
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

# 公告库文件指向临时目录：测试不污染项目 data/，且每个进程独立。
_TMPDIR = tempfile.mkdtemp(prefix="bulletin-test-")
os.environ["BULLETIN_DB_PATH"] = os.path.join(_TMPDIR, "bulletins.db")

from fastapi.testclient import TestClient

sys.path.insert(0, ".")
from app.bulletin import BulletinConflict, BulletinStore
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

# 选手 101：两趟 a1-b1-c1（25 秒）/ a2-b2-c2（28 秒），总用时 53；
# 选手 102：一趟 d1-e1-f1（20 秒）。
RECORDS = [
    {"id": "a1", "runner": 101, "gate": "S", "time": 0},
    {"id": "b1", "runner": 101, "gate": "M", "time": 12},
    {"id": "c1", "runner": 101, "gate": "F", "time": 25},
    {"id": "a2", "runner": 101, "gate": "S", "time": 30},
    {"id": "b2", "runner": 101, "gate": "M", "time": 45},
    {"id": "c2", "runner": 101, "gate": "F", "time": 58},
    {"id": "d1", "runner": 102, "gate": "S", "time": 5},
    {"id": "e1", "runner": 102, "gate": "M", "time": 15},
    {"id": "f1", "runner": 102, "gate": "F", "time": 25},
]

INPUT = {
    "standards": RANGES,
    "runners": [{"number": 101}, {"number": 102}],
    "records": RECORDS,
}


def review(runner, triple, status="pass", note=""):
    """triple: ((sid, stime), (mid, mtime), (fid, ftime))"""
    (sid, st), (mid, mt), (fid, ft) = triple
    return {
        "runner": runner,
        "records": [
            {"id": sid, "gate": "S", "time": st},
            {"id": mid, "gate": "M", "time": mt},
            {"id": fid, "gate": "F", "time": ft},
        ],
        "status": status,
        "note": note,
    }


ALL_REVIEWS = [
    review(101, (("a1", 0), ("b1", 12), ("c1", 25)), note="第一趟无误"),
    review(101, (("a2", 30), ("b2", 45), ("c2", 58))),
    review(102, (("d1", 5), ("e1", 15), ("f1", 25))),
]


def pub_body(number, base=0, input_=None, reviews=None, penalties=None):
    return {
        "number": number,
        "baseVersion": base,
        "input": input_ if input_ is not None else INPUT,
        "reviews": ALL_REVIEWS if reviews is None else reviews,
        "penalties": [] if penalties is None else penalties,
    }


def publish(number, base=0, **kw):
    return client.post("/api/bulletins/publish", json=pub_body(number, base, **kw))


def read(number, version=None):
    q = "" if version is None else f"?version={version}"
    return client.get(f"/api/bulletins/{number}{q}")


def test_publish_and_read():
    print("场景1：发布成功返回公告链接；按编号读取缺省最新、可指定版本；名次按原规则在服务端生成")
    r = publish("n-basic", penalties=[{"runner": 102, "seconds": 40, "reason": "抢跑"}])
    check(r.status_code == 200, "发布成功 200")
    body = r.json()
    check(body["ok"] is True, "发布 ok")
    result = body["result"]
    check(result["number"] == "n-basic" and result["version"] == 1, "首次发布为版本 1")
    check(result["url"] == "/api/bulletins/n-basic?version=1", "返回公告链接")

    latest = read("n-basic")
    check(latest.status_code == 200 and latest.json()["ok"], "读取最新 200")
    b = latest.json()["result"]
    check(b["number"] == "n-basic" and b["version"] == 1, "缺省读最新版本")
    check("publishedAt" in b, "含发布时间")
    check(b["input"]["records"][0]["id"] == "a1", "快照保存完整裁决输入")
    check(b["adjudication"]["runners"][0]["lapCount"] == 2, "快照保存服务端重新裁决的采纳方案")
    check(len(b["reviews"]) == 3 and b["reviews"][0]["status"] == "pass", "快照保存复核")
    check(b["reviews"][0]["note"] == "第一趟无误", "复核备注保留")
    check(b["penalties"] == [{"runner": 102, "seconds": 40, "reason": "抢跑"}], "快照保存处罚")
    # 名次：102 罚 40 秒 → 调整后 60；101 为 53。101 第 1，102 第 2。
    ranking = b["ranking"]
    check([row["runner"] for row in ranking] == [101, 102], "名次按调整后用时排序")
    check(ranking[0]["rank"] == 1 and ranking[0]["adjusted"] == 53, "101 第 1（53 秒）")
    check(
        ranking[1]["rank"] == 2 and ranking[1]["adjusted"] == 60 and ranking[1]["penalty"] == 40,
        "102 罚 40 秒后排第 2（60 秒）",
    )
    by_version = read("n-basic", 1)
    check(by_version.status_code == 200 and by_version.json()["result"]["version"] == 1,
          "按版本读取同一公告")
    print("test_publish_and_read OK")


def test_review_matching():
    print("场景2：复核按选手、三条记录 ID/门/秒数及区间核对；每趟均须“通过”")
    r = publish("n-pending", reviews=[ALL_REVIEWS[0], {**ALL_REVIEWS[1], "status": "pending"}, ALL_REVIEWS[2]])
    check(r.status_code == 422 and "通过" in r.json()["error"], "未复核（pending）的趟拒绝发布")
    r = publish("n-doubt", reviews=[ALL_REVIEWS[0], {**ALL_REVIEWS[1], "status": "doubt", "note": "存疑"}])
    check(r.status_code == 422 and "通过" in r.json()["error"], "存疑的趟拒绝发布")
    r = publish("n-missing", reviews=ALL_REVIEWS[:2])
    check(r.status_code == 422 and "缺少" in r.json()["error"], "缺少某趟复核拒绝发布")
    bad_time = review(101, (("a1", 0), ("b1", 13), ("c1", 25)))
    r = publish("n-badtime", reviews=[bad_time] + ALL_REVIEWS[1:])
    check(r.status_code == 422 and "不匹配" in r.json()["error"], "记录秒数不符 → 不匹配整次拒绝")
    bad_gate = {
        "runner": 101,
        "records": [
            {"id": "a1", "gate": "M", "time": 0},
            {"id": "b1", "gate": "S", "time": 12},
            {"id": "c1", "gate": "F", "time": 25},
        ],
        "status": "pass",
        "note": "",
    }
    r = publish("n-badgate", reviews=[bad_gate] + ALL_REVIEWS[1:])
    check(r.status_code == 422 and "不匹配" in r.json()["error"], "门不符 → 不匹配整次拒绝")
    bad_id = review(101, (("ghost", 0), ("b1", 12), ("c1", 25)))
    r = publish("n-badid", reviews=[bad_id] + ALL_REVIEWS[1:])
    check(r.status_code == 422 and "不匹配" in r.json()["error"], "记录 ID 不存在 → 不匹配整次拒绝")
    wrong_runner = review(102, (("a1", 0), ("b1", 12), ("c1", 25)))
    r = publish("n-xrunner", reviews=[wrong_runner] + ALL_REVIEWS[1:])
    check(r.status_code == 422 and "不匹配" in r.json()["error"], "记录不属于该选手 → 不匹配")
    unknown = review(999, (("a1", 0), ("b1", 12), ("c1", 25)))
    r = publish("n-ur", reviews=ALL_REVIEWS + [unknown])
    check(r.status_code == 422 and "未登记" in r.json()["error"], "未知选手复核整次拒绝")
    r = publish("n-dup", reviews=ALL_REVIEWS + [ALL_REVIEWS[0]])
    check(r.status_code == 422 and "重复" in r.json()["error"], "同一趟重复复核拒绝")
    extra = review(101, (("a1", 0), ("b1", 12), ("c1", 25)), note="x" * 201)
    r = publish("n-longnote", reviews=[extra] + ALL_REVIEWS[1:])
    check(r.status_code == 422 and "200" in r.json()["error"], "备注超过 200 字拒绝")
    # 复核拒绝不留版本：以上编号读取均 404。
    for num in ("n-pending", "n-doubt", "n-missing", "n-badtime", "n-badgate", "n-badid",
                "n-xrunner", "n-ur", "n-dup", "n-longnote"):
        check(read(num).status_code == 404, f"失败不留版本：{num} 读取 404")
    print("test_review_matching OK")


def test_zero_lap_needs_no_review():
    print("场景3：零次选手无需复核；针对零次选手的复核视为不匹配")
    zero_input = {
        "standards": RANGES,
        "runners": [{"number": 7}],
        "records": [{"id": "s1", "runner": 7, "gate": "S", "time": 0}],
    }
    r = publish("n-zero", input_=zero_input, reviews=[])
    check(r.status_code == 200 and r.json()["result"]["version"] == 1, "零次无需复核可发布")
    b = read("n-zero").json()["result"]
    check(b["ranking"][0]["lapCount"] == 0 and b["ranking"][0]["rank"] is None,
          "零次选手排末尾无名次")
    ghost_review = review(7, (("s1", 0), ("s1", 0), ("s1", 0)))
    r = publish("n-zero2", input_=zero_input, reviews=[ghost_review])
    check(r.status_code == 422, "零次选手多出的复核整次拒绝")
    # 一名选手有趟、另一名零次：只核对有趟选手的复核。
    mixed = {
        "standards": RANGES,
        "runners": [{"number": 101}, {"number": 7}],
        "records": RECORDS[:3] + [{"id": "s9", "runner": 7, "gate": "S", "time": 0}],
    }
    r = publish("n-mixed", input_=mixed, reviews=[ALL_REVIEWS[0]])
    check(r.status_code == 200, "零次选手无需复核（混合场景）")
    ranking = read("n-mixed").json()["result"]["ranking"]
    check([row["runner"] for row in ranking] == [101, 7], "零次选手排在有计次者之后")
    print("test_zero_lap_needs_no_review OK")


def test_penalty_validation():
    print("场景4：罚秒与原因沿用原校验；未知选手处罚整次拒绝")
    r = publish("n-p-unknown", penalties=[{"runner": 999, "seconds": 1, "reason": "x"}])
    check(r.status_code == 422 and "未登记" in r.json()["error"], "未知选手处罚整次拒绝")
    r = publish("n-p-noreason", penalties=[{"runner": 101, "seconds": 5, "reason": ""}])
    check(r.status_code == 422 and "原因" in r.json()["error"], "罚秒大于 0 时原因必填")
    r = publish("n-p-longreason", penalties=[{"runner": 101, "seconds": 0, "reason": "y" * 201}])
    check(r.status_code == 422 and "200" in r.json()["error"], "原因超过 200 字拒绝")
    r = publish("n-p-neg", penalties=[{"runner": 101, "seconds": -1, "reason": ""}])
    check(r.status_code == 422, "负罚秒拒绝")
    r = publish("n-p-float", penalties=[{"runner": 101, "seconds": 1.5, "reason": "x"}])
    check(r.status_code == 422, "非整数罚秒拒绝")
    r = publish("n-p-dup", penalties=[
        {"runner": 101, "seconds": 0, "reason": ""},
        {"runner": 101, "seconds": 2, "reason": "重复"},
    ])
    check(r.status_code == 422 and "重复" in r.json()["error"], "同一选手处罚重复拒绝")
    r = publish("n-p-ok", penalties=[{"runner": 101, "seconds": 0, "reason": ""}])
    check(r.status_code == 200, "罚秒 0 允许空原因")
    for num in ("n-p-unknown", "n-p-noreason", "n-p-longreason", "n-p-neg", "n-p-float", "n-p-dup"):
        check(read(num).status_code == 404, f"失败不留版本：{num} 读取 404")
    print("test_penalty_validation OK")


def test_ranking_ties_and_skip():
    print("场景5：并列共享名次并跳号（1、1、3），名次由服务端生成")
    tied_input = {
        "standards": RANGES,
        "runners": [{"number": 1}, {"number": 2}, {"number": 3}],
        "records": [
            {"id": "s1", "runner": 1, "gate": "S", "time": 0},
            {"id": "m1", "runner": 1, "gate": "M", "time": 12},
            {"id": "f1", "runner": 1, "gate": "F", "time": 25},
            {"id": "s2", "runner": 2, "gate": "S", "time": 0},
            {"id": "m2", "runner": 2, "gate": "M", "time": 12},
            {"id": "f2", "runner": 2, "gate": "F", "time": 25},
            {"id": "s3", "runner": 3, "gate": "S", "time": 0},
            {"id": "m3", "runner": 3, "gate": "M", "time": 15},
            {"id": "f3", "runner": 3, "gate": "F", "time": 30},
        ],
    }
    tied_reviews = [
        review(1, (("s1", 0), ("m1", 12), ("f1", 25))),
        review(2, (("s2", 0), ("m2", 12), ("f2", 25))),
        review(3, (("s3", 0), ("m3", 15), ("f3", 30))),
    ]
    r = publish("n-tie", input_=tied_input, reviews=tied_reviews)
    check(r.status_code == 200, "并列场景发布成功")
    ranking = read("n-tie").json()["result"]["ranking"]
    check([row["rank"] for row in ranking] == [1, 1, 3], "并列共享名次并跳号（1、1、3）")
    check([row["runner"] for row in ranking] == [1, 2, 3], "并列按编号升序展示")
    print("test_ranking_ties_and_skip OK")


def test_version_conflict_and_immutability():
    print("场景6：版本匹配才保存；过期 409；旧版永久只读；失败不改现公告")
    r = publish("n-ver", base=0)
    check(r.status_code == 200 and r.json()["result"]["version"] == 1, "首次发布版本 1")
    r = publish("n-ver", base=0)
    check(r.status_code == 409, "同版本再次发布返回 409")
    check(r.json()["currentVersion"] == 1, "409 返回当前最新版本")
    check(read("n-ver").json()["result"]["version"] == 1, "409 不改现公告")
    # 基于最新版本发布 v2（罚秒不同）。
    r = publish("n-ver", base=1, penalties=[{"runner": 101, "seconds": 100, "reason": "迟到"}])
    check(r.status_code == 200 and r.json()["result"]["version"] == 2, "版本匹配发布为下一版本")
    check(r.json()["result"]["url"] == "/api/bulletins/n-ver?version=2", "v2 公告链接")
    v1 = read("n-ver", 1).json()["result"]
    check(v1["ranking"][0]["penalty"] == 0, "旧版本永久只读：v1 名次不受 v2 影响")
    latest = read("n-ver").json()["result"]
    check(latest["version"] == 2 and latest["ranking"][0]["penalty"] == 100, "缺省读最新版本 v2")
    r = publish("n-ver", base=1)
    check(r.status_code == 409 and r.json()["currentVersion"] == 2, "过期基线再次 409")
    # 422 的失败发布同样不留版本、不改现公告。
    r = publish("n-ver", base=2, reviews=ALL_REVIEWS[:1])
    check(r.status_code == 422, "缺复核发布被拒")
    check(read("n-ver").json()["result"]["version"] == 2, "失败发布不改现公告")
    check(read("n-ver", 3).status_code == 404, "失败不留版本：v3 不存在")
    print("test_version_conflict_and_immutability OK")


def test_concurrent_publish_single_winner():
    print("场景7：同版本并发发布只能一项成功")
    path = os.path.join(_TMPDIR, "concurrent.db")
    store = BulletinStore(path)
    outcomes = []

    def attempt(i):
        try:
            store.publish("race", 0, {"mark": i})
            return "ok"
        except BulletinConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(attempt, range(8)))
    check(outcomes.count("ok") == 1, "8 个并发发布恰好一项成功")
    check(outcomes.count("conflict") == 7, "其余 7 个全部版本冲突")
    check(store.current_version("race") == 1, "只留一个版本")
    # 紧接着并发抢下一版本：同样只有一项成功。
    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(lambda i: attempt2(store, i), range(8)))
    check(outcomes.count("ok") == 1 and store.current_version("race") == 2, "下一版本并发同样单项成功")
    store.close()
    print("test_concurrent_publish_single_winner OK")


def attempt2(store, i):
    try:
        store.publish("race", 1, {"mark": i})
        return "ok"
    except BulletinConflict:
        return "conflict"


def test_read_errors():
    print("场景8：未知编号/版本 404；非法版本参数 400；坏 JSON 400")
    check(read("no-such").status_code == 404, "未知编号 404")
    publish("n-readerr")
    check(read("n-readerr", 99).status_code == 404, "未知版本 404")
    check(read("n-readerr", "abc").status_code == 400, "非数字版本 400")
    check(read("n-readerr", 0).status_code == 400, "版本 0 非法 400")
    r = client.post("/api/bulletins/publish", content=b"{not json",
                    headers={"Content-Type": "application/json"})
    check(r.status_code == 400, "请求体不是 JSON 返回 400")
    print("test_read_errors OK")


def test_precision():
    print("场景9：公告编号、记录秒数与用时全程精确（超过 2^53 不截断）")
    big_runner = "9007199254740993"
    ts, tm, tf = "9007199254740992", "9007199254741003", "9007199254741014"
    big_input = {
        "standards": RANGES,
        "runners": [{"number": big_runner}],
        "records": [
            {"id": "h1", "runner": big_runner, "gate": "S", "time": ts},
            {"id": "h2", "runner": big_runner, "gate": "M", "time": tm},
            {"id": "h3", "runner": big_runner, "gate": "F", "time": tf},
        ],
    }
    big_review = review(big_runner, (("h1", ts), ("h2", tm), ("h3", tf)))
    big_number = "9007199254740993"
    r = publish(big_number, input_=big_input, reviews=[big_review],
                penalties=[{"runner": big_runner, "seconds": "9007199254740996", "reason": "大罚秒"}])
    check(r.status_code == 200, "大编号/大秒数发布成功")
    text = read(big_number).text
    check(f'"number":"{big_number}"' in text.replace(" ", ""), "公告编号精确保留")
    check(ts in text and tm in text and tf in text, "超过 2^53 的记录秒数精确保留")
    b = read(big_number).json()["result"]
    lap = b["adjudication"]["runners"][0]["laps"][0]
    check(lap["smTime"] == 11 and lap["mfTime"] == 11, "两段耗时精确为 11/11 秒")
    check(b["ranking"][0]["totalTime"] == 22, "总用时精确")
    check(b["ranking"][0]["adjusted"] == 9007199254741018, "调整后用时按任意精度相加")
    check(b["reviews"][0]["records"][0]["time"] == 9007199254740992, "复核快照秒数精确")
    # 相差 1 的大公告编号是两个不同公告。
    check(read("9007199254740992").status_code == 404, "相差 1 的大编号互不相同")
    print("test_precision OK")


def test_excluded_ids_in_snapshot():
    print("场景10：隔离列表随输入快照提交，服务端按未隔离记录重新裁决")
    r = publish("n-excl", input_={**INPUT, "excludedIds": ["a2", "b2", "c2"]},
                reviews=[ALL_REVIEWS[0], ALL_REVIEWS[2]])
    check(r.status_code == 200, "隔离后发布成功")
    b = read("n-excl").json()["result"]
    r101 = b["adjudication"]["runners"][0]
    check(r101["lapCount"] == 1, "被隔离记录不参与服务端重新裁决")
    check([x["id"] for x in r101["excluded"]] == ["a2", "b2", "c2"], "隔离记录单列保存")
    check(b["input"]["excludedIds"] == ["a2", "b2", "c2"], "隔离列表保存在输入快照中")
    # 隔离后仍按被隔离趟提交复核 → 不匹配整次拒绝；有趟却完全不复核 → 缺少“通过”复核。
    r = publish("n-excl2", input_={**INPUT, "excludedIds": ["a2", "b2", "c2"]})
    check(r.status_code == 422 and "不匹配" in r.json()["error"], "被隔离趟的复核不再匹配")
    r = publish("n-excl3", input_={**INPUT, "excludedIds": ["a2", "b2", "c2"]}, reviews=[])
    check(r.status_code == 422 and "缺少" in r.json()["error"], "有趟未复核整次拒绝")
    print("test_excluded_ids_in_snapshot OK")


def test_persistence_across_restart():
    print("场景11：SQLite 持久化，跨重启保留")
    path = os.path.join(_TMPDIR, "persist.db")
    s1 = BulletinStore(path)
    s1.publish("keep", 0, {"input": {"x": 1}, "ranking": []})
    s1.close()
    s2 = BulletinStore(path)  # 模拟重启后重新打开同一库文件
    b = s2.read("keep")
    check(b is not None and b["version"] == 1 and b["input"] == {"x": 1}, "重启后公告仍在")
    check(s2.read("keep", 1)["publishedAt"], "发布时间保留")
    s2.close()
    print("test_persistence_across_restart OK")


def test_request_validation():
    print("场景12：编号非空、baseVersion 与 input 必填、reviews/penalties 须为数组")
    r = publish("  ")
    check(r.status_code == 422 and "编号" in r.json()["error"], "空白公告编号拒绝")
    body = pub_body("n-missing-base")
    del body["baseVersion"]
    r = client.post("/api/bulletins/publish", json=body)
    check(r.status_code == 422, "缺少所见公告版本拒绝")
    body = pub_body("n-missing-input")
    del body["input"]
    r = client.post("/api/bulletins/publish", json=body)
    check(r.status_code == 422, "缺少完整裁决输入拒绝")
    r = publish("n-badreviews", reviews="pass")
    check(r.status_code == 422, "reviews 非数组拒绝")
    r = publish("n-badpen", penalties={})
    check(r.status_code == 422, "penalties 非数组拒绝")
    r = publish("n-badbase", base=-1)
    check(r.status_code == 422, "负版本号拒绝")
    bad_input = {**INPUT, "records": RECORDS + [{"id": "zz", "runner": 999, "gate": "S", "time": 0}]}
    r = publish("n-badinput", input_=bad_input)
    check(r.status_code == 422 and "未登记" in r.json()["error"], "裁决输入非法沿用原校验")
    for num in ("n-missing-base", "n-missing-input", "n-badreviews", "n-badpen",
                "n-badbase", "n-badinput"):
        check(read(num).status_code == 404, f"失败不留版本：{num} 读取 404")
    print("test_request_validation OK")


def test_original_contract_untouched():
    print("场景13：原 HTTP 合同不变（裁决端点冒烟）")
    r = client.post("/api/adjudicate", json=INPUT)
    check(r.status_code == 200 and r.json()["ok"], "裁决端点仍可用")
    check(r.json()["result"]["runners"][0]["lapCount"] == 2, "裁决结果不变")
    r = client.post("/api/adjudicate", json={**INPUT, "runners": []})
    check(r.status_code == 422, "裁决非法输入仍 422")
    print("test_original_contract_untouched OK")


def main():
    test_publish_and_read()
    test_review_matching()
    test_zero_lap_needs_no_review()
    test_penalty_validation()
    test_ranking_ties_and_skip()
    test_version_conflict_and_immutability()
    test_concurrent_publish_single_winner()
    test_read_errors()
    test_precision()
    test_excluded_ids_in_snapshot()
    test_persistence_across_restart()
    test_request_validation()
    test_original_contract_untouched()
    print("\nALL BULLETIN TESTS PASSED" if failures == 0 else f"\n{failures} ASSERTION(S) FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
