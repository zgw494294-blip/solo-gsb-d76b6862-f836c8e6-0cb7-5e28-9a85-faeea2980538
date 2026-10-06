"""设备日志 CSV 合并预览/确认端点与解析规则测试。"""

import json
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, ".")
from app.main import app
from app.merge import parse_csv, preview_merge
from app.merge import MergeError

client = TestClient(app)

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("  ✓", msg)
    else:
        failures += 1
        print("  ✗", msg)


CONTEXT = {
    "runners": [{"number": 101}, {"number": 102}],
    "records": [
        {"id": "a1", "runner": "101", "gate": "S", "time": "0"},
        {"id": "b1", "runner": "101", "gate": "M", "time": "12"},
        {"id": "c1", "runner": "101", "gate": "F", "time": "25"},
        # 全空占位行：不计入现有记录数
        {"id": "", "runner": "", "gate": "", "time": ""},
    ],
}


def post(endpoint, context=CONTEXT, data=b"", filename="log.csv"):
    files = {"file": (filename, data, "text/csv")}
    form = {"context": json.dumps(context)}
    return client.post(endpoint, data=form, files=files)


CSV_BASIC = (
    b"id,runner,gate,time\r\n"
    b'a1,101,S,0\r\n'              # 与现有完全一致 -> 重复
    b'"d1","101","S","100"\r\n'    # 全引号、新记录
    b'e1,102,M,200\r\n'            # 新记录
)


def test_basic_preview():
    print("场景1：基本预览——新增/重复分类、顺序、引号、CRLF/BOM")
    r = post("/api/import/preview", data=CSV_BASIC)
    check(r.status_code == 200, f"预览 200（实际 {r.status_code} {r.text}）")
    res = r.json()["result"]
    check([e["id"] for e in res["added"]] == ["d1", "e1"], "新增按文件首次出现顺序")
    check(res["added"][0]["runner"] == 101 and res["added"][0]["time"] == 100,
          "新增字段正确解析（含引号）")
    check([e["id"] for e in res["duplicates"]] == ["a1"], "同内容识别为重复")
    check(res["existingCount"] == 3, "现有记录数不含全空占位行")
    check(res["mergedCount"] == 5, "合并后计数正确")

    # UTF-8 BOM + 引号内逗号、CR 换行
    bom = "\ufeff".encode()
    csv_bom = bom + 'id,runner,gate,time\n"x,1",101,S,1\ny1,101,F,2\n'.encode()
    r2 = post("/api/import/preview", data=csv_bom)
    check(r2.status_code == 200 and [e["id"] for e in r2.json()["result"]["added"]] == ["x,1", "y1"],
          "支持 BOM、引号内逗号、LF 换行")


def test_csv_quoting_unit():
    print("场景2：CSV 引号转义与字段内换行（单元级）")
    csv_text = 'id,runner,gate,time\n"q""1",101,S,1\n"l\n2",101,M,2\n'.encode()
    rows = parse_csv(csv_text)
    check(rows[0]["id"] == 'q"1', '"" 转义为单个引号')
    check(rows[1]["id"] == "l\n2", "引号字段内允许换行")
    check(rows[1]["_line"] == 4, "字段内换行计入物理行号")

    for bad, label in [
        (b'id,runner,gate,time\n"a,101,S,1\n', "引号未闭合"),
        (b'id,runner,gate,time\na"b,101,S,1\n', "引号出现在字段中间"),
        (b'id,runner,gate,time\n"a"b,101,S,1\n', "闭合引号后有杂散字符"),
        (b'id,runner,gate,time\n"a"",101,S,1\n', "闭合后多余引号"),
        (b'id,runner,gate\na,101,S,1\n', "表头不符"),
        (b"", "空文件"),
        (b'id,runner,gate,time\na,101,S\n', "列数不足"),
        (b'id,runner,gate,time\na,101,S,\n', "秒数为空"),
        (b'id,runner,gate,time\n,101,S,1\n', "ID 为空"),
        (b'id,runner,gate,time\na,,S,1\n', "选手为空"),
        (b'id,runner,gate,time\na,101,,1\n', "门为空"),
    ]:
        try:
            parse_csv(bad)
            check(False, f"非法 CSV 被拒绝：{label}")
        except MergeError:
            check(True, f"非法 CSV 被拒绝：{label}")

    # 仅表头、无数据行合法
    res = preview_merge(CONTEXT, b"id,runner,gate,time\n")
    check(res["added"] == [] and res["duplicates"] == [] and res["mergedCount"] == 3,
          "仅表头：无新增无重复，原记录不变")

    # 非 UTF-8
    try:
        preview_merge(CONTEXT, b"\xff\xfe\xfa")
        check(False, "非 UTF-8 被拒绝")
    except MergeError as e:
        check("UTF-8" in str(e), f"非 UTF-8 被拒绝（{e}）")


def test_exact_integer_compare():
    print("场景3：编号、秒数按精确整数比较，ID 沿用去空白规则")
    csv = (
        b"id,runner,gate,time\n"
        b"  a1  ,0101,S,00\n"   # ID 去空白后等同 a1，前导零数值相同 -> 重复
        b"b1,101,M,012\n"       # 秒数 012 == 12 -> 重复
    )
    res = preview_merge(CONTEXT, csv)
    check([e["id"] for e in res["duplicates"]] == ["a1", "b1"] and res["added"] == [],
          "前导零等值写法与首尾空白按相同内容跳过")

    big = "9007199254740993"
    ctx = {
        "runners": [{"number": big}],
        "records": [{"id": "A", "runner": big, "gate": "S", "time": "9007199254741003"}],
    }
    csv = f'id,runner,gate,time\nA,0{big},"S","09007199254741003"\nB,{big},F,9007199254741014\n'
    res = preview_merge(ctx, csv.encode())
    check([e["id"] for e in res["duplicates"]] == ["A"], "超过 2^53 的编号与秒数精确比较为重复")
    check([e["id"] for e in res["added"]] == ["B"], "大秒数新记录正常新增")


def test_conflicts():
    print("场景4：同 ID 内容冲突（与现有/文件内）整批拒绝并给出原因")
    cases = [
        (b"id,runner,gate,time\na1,102,S,0\n", "现有冲突：选手编号不同"),
        (b"id,runner,gate,time\na1,101,M,0\n", "现有冲突：门不同"),
        (b"id,runner,gate,time\na1,101,S,9\n", "现有冲突：秒数不同"),
        (b"id,runner,gate,time\nz,101,S,1\nz,101,S,2\n", "文件内冲突：秒数不同"),
        (b"id,runner,gate,time\nz,101,S,1\nz,101,M,1\n", "文件内冲突：门不同"),
        (b"id,runner,gate,time\nz,101,S,1\nz,102,S,1\n", "文件内冲突：选手不同"),
    ]
    for data, label in cases:
        r = post("/api/import/preview", data=data)
        check(r.status_code == 422 and "冲突" in r.json()["error"],
             f"{label} -> 422（{r.json().get('error')}）")

    # 冲突是整批拒绝：哪怕新增行排在冲突行之前也不产生任何部分结果
    data = b"id,runner,gate,time\nnew1,101,S,50\na1,101,S,1\n"
    r = post("/api/import/preview", data=data)
    check(r.status_code == 422 and r.json().get("ok") is False,
          "冲突行在后仍整批拒绝，不返回部分新增")


def test_unknown_and_illegal_rows():
    print("场景5：未知选手、非法编号/秒数、非法门整批拒绝")
    for data, label in [
        (b"id,runner,gate,time\nx,9,S,1\n", "未知选手"),
        (b"id,runner,gate,time\nx,0,S,1\n", "选手编号为 0"),
        (b"id,runner,gate,time\nx,-1,S,1\n", "选手编号为负"),
        (b"id,runner,gate,time\nx,1.5,S,1\n", "选手编号非整数"),
        (b"id,runner,gate,time\nx,abc,S,1\n", "选手编号非数字"),
        (b"id,runner,gate,time\nx,101,X,1\n", "非法门"),
        (b"id,runner,gate,time\nx,101,S,-1\n", "秒数为负"),
        (b"id,runner,gate,time\nx,101,S,1.0\n", "秒数非整数"),
        (b"id,runner,gate,time\nx,true,S,1\n", "bool 不接受"),
    ]:
        r = post("/api/import/preview", data=data)
        check(r.status_code == 422, f"{label} -> 422（{r.json()['error']}）")


def test_over_limit():
    print("场景6：合并后超过 40 条整批拒绝")
    ctx = {
        "runners": [{"number": 1}],
        "records": [
            {"id": f"e{i}", "runner": 1, "gate": "S", "time": i}
            for i in range(39)
        ],
    }
    # 39 现有 + 1 新增 = 40：允许
    r = post("/api/import/preview", context=ctx, data=b"id,runner,gate,time\nn1,1,S,100\n")
    check(r.status_code == 200 and r.json()["result"]["mergedCount"] == 40, "恰好 40 条允许")
    # 41：拒绝
    ctx40 = {"runners": [{"number": 1}],
             "records": ctx["records"] + [{"id": "n0", "runner": 1, "gate": "M", "time": 1}]}
    r = post("/api/import/preview", context=ctx40,
             data=b"id,runner,gate,time\nn1,1,S,100\nn2,1,F,101\n")
    check(r.status_code == 422 and "40" in r.json()["error"], "41 条拒绝并指明上限")
    # 39 现有 + 39 条重复 + 1 新增 = 40：重复不计入，允许
    dup_then_new = (
        b"id,runner,gate,time\n" +
        b"".join(f"e{i},1,S,{i}\n".encode() for i in range(39)) +
        b"new,1,S,200\n"
    )
    r = post("/api/import/preview", context=ctx, data=dup_then_new)
    check(r.status_code == 200 and r.json()["result"]["mergedCount"] == 40,
          "重复条目不占位：39 现有 + 39 重复 + 1 新增 = 40 允许")
    # 39 现有 + 2 新增 = 41：拒绝
    r = post("/api/import/preview", context=ctx,
             data=b"id,runner,gate,time\nn1,1,S,100\nn2,1,F,101\n")
    check(r.status_code == 422, "39 现有 + 2 新增 = 41 拒绝")


def test_confirm_endpoint_and_contracts():
    print("场景7：confirm 与 preview 同校验；缺字段/坏表单的状态码；既有合同不变")
    r = post("/api/import/confirm", data=CSV_BASIC)
    check(r.status_code == 200, "确认端点 200")
    rp = post("/api/import/preview", data=CSV_BASIC)
    check(r.json()["result"] == rp.json()["result"], "确认与预览返回完全一致的清单")

    # 缺文件 -> 400
    r = client.post("/api/import/preview", data={"context": json.dumps(CONTEXT)})
    check(r.status_code == 400, f"缺文件 400（实际 {r.status_code}）")
    # 缺 context -> 422
    r = client.post("/api/import/preview",
                    files={"file": ("a.csv", b"id,runner,gate,time\n", "text/csv")})
    check(r.status_code == 422 and "context" in r.json()["error"], "缺 context 422")
    # context 不是 JSON -> 422
    r = client.post("/api/import/preview",
                    data={"context": "{not json"},
                    files={"file": ("a.csv", b"id,runner,gate,time\n", "text/csv")})
    check(r.status_code == 422, "坏 context JSON 422")

    # 当前记录本身非法（选手重号、记录 ID 重复、记录不完整）同样拒绝预览
    bad_ctx = {"runners": [{"number": 1}, {"number": 1}], "records": []}
    check(post("/api/import/preview", context=bad_ctx,
               data=b"id,runner,gate,time\nx,1,S,1\n").status_code == 422,
          "当前选手重号时拒绝预览")
    bad_ctx = {"runners": [{"number": 1}],
               "records": [{"id": "a", "runner": 1, "gate": "S", "time": 1},
                           {"id": "a", "runner": 1, "gate": "M", "time": 2}]}
    check(post("/api/import/preview", context=bad_ctx,
               data=b"id,runner,gate,time\nx,1,F,3\n").status_code == 422,
          "当前记录 ID 重复时拒绝预览")

    # 既有合同保持不变
    body = {"standards": {"smMin": 10, "smMax": 60, "mfMin": 10, "mfMax": 60},
            "runners": [{"number": 101}],
            "records": [{"id": "a1", "runner": 101, "gate": "S", "time": 0},
                        {"id": "b1", "runner": 101, "gate": "M", "time": 12},
                        {"id": "c1", "runner": 101, "gate": "F", "time": 25}]}
    ra = client.post("/api/adjudicate", json=body)
    check(ra.status_code == 200 and ra.json()["result"]["runners"][0]["lapCount"] == 1,
          "POST /api/adjudicate 合同不变")
    rd = client.post("/api/diagnose", json=body)
    check(rd.status_code == 200 and "diagnoses" in rd.json()["result"]["runners"][0],
          "POST /api/diagnose 合同不变")
    check(client.post("/api/adjudicate", data="{", headers={"Content-Type": "application/json"})
          .status_code == 400, "非 JSON 400 合同不变")


def main():
    test_basic_preview()
    test_csv_quoting_unit()
    test_exact_integer_compare()
    test_conflicts()
    test_unknown_and_illegal_rows()
    test_over_limit()
    test_confirm_endpoint_and_contracts()
    print("\nALL MERGE TESTS PASSED" if failures == 0 else f"\n{failures} ASSERTION(S) FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
