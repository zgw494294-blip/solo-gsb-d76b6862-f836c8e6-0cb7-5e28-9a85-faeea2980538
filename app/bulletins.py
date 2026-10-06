"""成绩公告（裁决快照）发布与只读读取：SQLite 持久化 + 乐观版本并发控制。

规则摘要（与页面“发布成绩公告”约定一一对应）：
- 发布请求是一次“点击时快照”：完整裁决输入（含隔离 ID）、已保存复核、
  罚秒与“页面所见版本”（首次为 0）一起提交；服务端不信任任何页面缓存，
  重新裁决、重新核对复核、重新校验罚秒、重新生成名次。
- 每一名有已采纳趟的选手，其每一趟都必须恰好有一条“通过”复核；
  0 次选手无需任何复核。未知选手的处罚、与已采纳趟不匹配的复核、
  沿用原校验失败的备注/罚秒与原因，均整次拒绝（不产生任何版本）。
- 仅当期望版本等于服务端当前版本时才落库为“下一版本”；同版本并发发布
  只有一项成功，其余返回 409（过期）。失败不留版本、不改现公告。
- 公告按编号与可选版本经 HTTP 只读读取（缺省读最新），未知编号/版本 404；
  旧版本永久只读，后续编辑、清空与刷新不影响已发布公告。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .adjudication import (
    AdjudicationError,
    GATES,
    Record,
    _parse_nonneg_int,
    _parse_positive_int,
    adjudicate,
    parse_payload,
)

MAX_BULLETIN_ID_LEN = 100
MAX_NOTE_LEN = 200
REVIEW_PASS = "pass"


class BulletinError(ValueError):
    """发布请求非法（输入/复核/罚秒）；message 为可直接展示的中文说明。"""


class BulletinConflict(Exception):
    """期望版本过期（与服务端当前版本不一致）：端点返回 409。"""


class BulletinNotFound(Exception):
    """公告编号或版本不存在：端点返回 404。"""


# ---------------------------------------------------------------------------
# SQLite 连接（单进程内单连接 + 写锁；WAL 允许读写并发，重启后数据保留）
# ---------------------------------------------------------------------------

_db_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def default_db_path() -> Path:
    """公告库路径：环境变量 BULLETIN_DB_PATH 优先；否则优先 /data（容器挂载点），
    再退回到项目根下 data/bulletins.db，保证本地直接运行也能持久化。
    """
    env = os.environ.get("BULLETIN_DB_PATH")
    if env:
        return Path(env)
    data_dir = Path("/data")
    try:
        if data_dir.is_dir() and os.access(data_dir, os.W_OK):
            return data_dir / "bulletins.db"
    except OSError:
        pass
    return Path(__file__).resolve().parent.parent / "data" / "bulletins.db"


def close_store_for_tests() -> None:
    """测试专用：关闭内存连接（模拟进程重启），保留库文件。

    关闭前执行 TRUNCATE 检查点，把 WAL 并入主库，保证随后由新连接打开时
    能立即看到全部已提交版本（模拟重启后从同一数据卷恢复）。
    """
    global _conn
    with _db_lock:
        if _conn is not None:
            try:
                _conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            _conn.close()
            _conn = None


def reset_store_for_tests() -> None:
    """测试专用：删除现有库文件并重置连接（跨“重启”持久化测试用临时路径）。"""
    close_store_for_tests()
    with _db_lock:
        path = default_db_path()
        for suffix in ("", "-wal", "-shm"):
            p = path.with_name(path.name + suffix) if suffix else path
            try:
                p.unlink()
            except FileNotFoundError:
                pass


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        with _db_lock:
            if _conn is None:
                path = default_db_path()
                path.parent.mkdir(parents=True, exist_ok=True)
                # check_same_thread=False：FastAPI 同步端点可能跑在线程池的不同
                # 工作线程上；所有访问都由 _db_lock 串行化（见各调用点），
                # 杜绝跨线程事务交错（BEGIN/COMMIT 被另一线程插入）。
                conn = sqlite3.connect(str(path), check_same_thread=False)
                conn.row_factory = sqlite3.Row
                # WAL：读不阻塞写、写不阻塞读；单写者由 _db_lock + IMMEDIATE 串行。
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA busy_timeout=5000")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS bulletin_versions (
                        bulletin_id TEXT NOT NULL,
                        version     INTEGER NOT NULL,
                        snapshot    TEXT NOT NULL,
                        created_at  TEXT NOT NULL,
                        PRIMARY KEY (bulletin_id, version)
                    )
                    """
                )
                conn.commit()
                _conn = conn
    return _conn


# ---------------------------------------------------------------------------
# 请求校验与快照构建
# ---------------------------------------------------------------------------


def validate_bulletin_id(value: Any) -> str:
    """公告编号：非空字符串、去首尾空白后非空；不允许 '/' 与控制字符
    （避免与按编号读取的 HTTP 路径冲突），长度至多 100。
    """
    if not isinstance(value, str):
        raise BulletinError("公告编号必须是非空字符串")
    bid = value.strip()
    if bid == "":
        raise BulletinError("公告编号不能为空")
    if len(bid) > MAX_BULLETIN_ID_LEN:
        raise BulletinError(f"公告编号至多 {MAX_BULLETIN_ID_LEN} 个字符")
    if "/" in bid:
        raise BulletinError("公告编号不能包含字符“/”")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in bid):
        raise BulletinError("公告编号不能包含控制字符")
    return bid


def _parse_expected_version(value: Any) -> int:
    # 缺省/显式 null 视为首次发布（0）；只接受非负整数。
    if value is None:
        return 0
    if isinstance(value, bool):
        raise BulletinError("所见版本必须是非负整数")
    if isinstance(value, int):
        n = value
    elif isinstance(value, str) and value.strip().isdigit():
        n = int(value.strip())
    else:
        raise BulletinError("所见版本必须是非负整数")
    if n < 0:
        raise BulletinError("所见版本必须是非负整数")
    return n


def _require_list(value: Any, field: str) -> list:
    if not isinstance(value, list):
        raise BulletinError(f"{field}必须是数组")
    return value


def _check_note(note: Any, field: str) -> str:
    if not isinstance(note, str):
        raise BulletinError(f"{field}必须是字符串")
    if len(note) > MAX_NOTE_LEN:
        raise BulletinError(f"{field}至多 {MAX_NOTE_LEN} 字")
    return note


def _lap_token(runner: int, lap: dict) -> tuple:
    """趟的核对键：选手 + 三条记录的 ID/门/秒数 + 两段耗时（区间由整份输入绑定）。"""
    s, m, f = lap["start"], lap["middle"], lap["finish"]
    return (
        runner,
        s["id"], "S", s["time"],
        m["id"], "M", m["time"],
        f["id"], "F", f["time"],
        lap["smTime"],
        lap["mfTime"],
    )


def verify_reviews(reviews_raw: Any, result: dict) -> list[dict]:
    """核对已保存复核：每条必须恰好匹配一个已采纳趟且为“通过”，每趟恰好一条。

    0 次选手无需复核；任何不匹配、重复、状态非“通过”或备注超长均整次拒绝。
    返回按选手编号数值升序、趟时间顺序排列的“通过”复核快照。
    """
    entries = _require_list(reviews_raw, "复核列表")
    adopted: dict[tuple, tuple[int, int]] = {}
    for r in result["runners"]:
        for lap_index, lap in enumerate(r["laps"]):
            adopted[_lap_token(r["runner"], lap)] = (r["runner"], lap_index)

    matched: dict[tuple, dict] = {}
    for i, item in enumerate(entries, 1):
        if not isinstance(item, dict):
            raise BulletinError(f"第 {i} 条复核格式不正确")
        runner = item.get("runner")
        try:
            if isinstance(runner, bool):
                raise AdjudicationError
            runner_n = _parse_positive_int(runner, "复核选手编号")
        except AdjudicationError:
            raise BulletinError(f"第 {i} 条复核的选手编号必须是正整数")

        records_by_gate: dict[str, dict] = {}
        for gate in GATES:
            rec = item.get({"S": "start", "M": "middle", "F": "finish"}[gate])
            if not isinstance(rec, dict):
                raise BulletinError(f"第 {i} 条复核缺少{gate}门记录")
            rid = rec.get("id")
            gate_got = rec.get("gate", gate)
            time_v = rec.get("time")
            if not isinstance(rid, str) or rid.strip() == "":
                raise BulletinError(f"第 {i} 条复核的记录 ID 不正确")
            if gate_got != gate:
                raise BulletinError(f"第 {i} 条复核的门与记录位置不匹配")
            try:
                time_n = _parse_nonneg_int(time_v, "复核记录秒数")
            except AdjudicationError:
                raise BulletinError(f"第 {i} 条复核的记录秒数必须是非负整数")
            records_by_gate[gate] = {"id": rid.strip(), "time": time_n}

        sm_v = item.get("smTime")
        mf_v = item.get("mfTime")
        try:
            sm_n = _parse_nonneg_int(sm_v, "复核两段耗时")
            mf_n = _parse_nonneg_int(mf_v, "复核两段耗时")
        except AdjudicationError:
            raise BulletinError(f"第 {i} 条复核的两段耗时必须是非负整数")

        note = _check_note(item.get("note", ""), "复核备注")

        status = item.get("status", REVIEW_PASS)
        if status != REVIEW_PASS:
            raise BulletinError("只有“通过”的复核可以发布；存疑或未复核的趟不能发布")

        token = (
            runner_n,
            records_by_gate["S"]["id"], "S", records_by_gate["S"]["time"],
            records_by_gate["M"]["id"], "M", records_by_gate["M"]["time"],
            records_by_gate["F"]["id"], "F", records_by_gate["F"]["time"],
            sm_n, mf_n,
        )
        if token not in adopted:
            raise BulletinError(
                f"复核（选手 {runner_n}，趟 {records_by_gate['S']['id']}/"
                f"{records_by_gate['M']['id']}/{records_by_gate['F']['id']}）"
                "与服务端重新裁决采纳的趟不匹配"
            )
        if token in matched:
            raise BulletinError("同一趟提交了重复的“通过”复核")
        matched[token] = {"note": note}

    # 每趟必须恰好一条“通过”复核。
    out: list[dict] = []
    for r in sorted(result["runners"], key=lambda x: x["runner"]):
        for lap_index, lap in enumerate(r["laps"]):
            token = _lap_token(r["runner"], lap)
            saved = matched.get(token)
            if saved is None:
                raise BulletinError(
                    f"选手 {r['runner']} 第 {lap_index + 1} 趟尚无“通过”复核，不能发布"
                )
            out.append(
                {
                    "runner": r["runner"],
                    "lapIndex": lap_index,
                    "start": lap["start"],
                    "middle": lap["middle"],
                    "finish": lap["finish"],
                    "smTime": lap["smTime"],
                    "mfTime": lap["mfTime"],
                    "totalTime": lap["totalTime"],
                    "status": REVIEW_PASS,
                    "note": saved["note"],
                }
            )
    return out


def verify_penalties(penalties_raw: Any, runner_ids: list[int]) -> dict[int, dict]:
    """核对罚秒：编号必须是已登记选手（未知选手处罚整次拒绝）；非负整数秒、
    原因至多 200 字、罚秒大于 0 时原因必填（沿用页面原校验）；编号不得重复。
    未提交的选手按 0 秒、空原因处理。
    """
    entries = _require_list(penalties_raw, "罚秒列表")
    valid = set(runner_ids)
    parsed: dict[int, dict] = {}
    for i, item in enumerate(entries, 1):
        if not isinstance(item, dict):
            raise BulletinError(f"第 {i} 条罚秒格式不正确")
        runner_v = item.get("runner")
        try:
            runner = _parse_positive_int(runner_v, "罚秒选手编号")
        except AdjudicationError:
            raise BulletinError(f"第 {i} 条罚秒的选手编号必须是正整数")
        if runner not in valid:
            raise BulletinError(f"选手编号 {runner} 未登记，不能保存处罚")
        if runner in parsed:
            raise BulletinError(f"选手 {runner} 提交了重复的罚秒")
        seconds_v = item.get("seconds", 0)
        try:
            seconds = _parse_nonneg_int(seconds_v, "罚秒")
        except AdjudicationError:
            raise BulletinError(f"第 {i} 条罚秒必须是非负整数")
        reason = _check_note(item.get("reason", ""), "罚秒原因")
        if seconds > 0 and reason.strip() == "":
            raise BulletinError(f"选手 {runner} 的罚秒大于 0 时必须填写原因")
        parsed[runner] = {"seconds": seconds, "reason": reason}
    return parsed


# ---------------------------------------------------------------------------
# 名次生成（服务端重新计算，不信任页面缓存；规则与页面 computeRanking 一致）
# ---------------------------------------------------------------------------


def build_ranking(result: dict, penalties: dict[int, dict]) -> list[dict]:
    rows = []
    for r in result["runners"]:
        pen = penalties.get(r["runner"], {"seconds": 0, "reason": ""})
        total = r["totalTime"]
        adjusted = total + pen["seconds"]
        rows.append(
            {
                "runner": r["runner"],
                "lapCount": r["lapCount"],
                "totalTime": total,
                "penaltySeconds": pen["seconds"],
                "penaltyReason": pen["reason"],
                "adjustedTime": adjusted,
                "rank": None,
            }
        )
    ranked = sorted(
        [row for row in rows if row["lapCount"] > 0],
        key=lambda x: (-x["lapCount"], x["adjustedTime"], x["runner"]),
    )
    for i, row in enumerate(ranked):
        if (
            i > 0
            and row["lapCount"] == ranked[i - 1]["lapCount"]
            and row["adjustedTime"] == ranked[i - 1]["adjustedTime"]
        ):
            row["rank"] = ranked[i - 1]["rank"]
        else:
            row["rank"] = i + 1
    zeros = sorted([row for row in rows if row["lapCount"] == 0], key=lambda x: x["runner"])
    return ranked + zeros


# ---------------------------------------------------------------------------
# 规范化输入快照（把服务端解析后的精确值落库；前导零等写法按数值归一）
# ---------------------------------------------------------------------------


def canonical_input(
    runner_ids: list[int],
    ranges: dict[str, tuple[int, int]],
    records: list[Record],
    excluded_ids: set[str],
) -> dict:
    return {
        "standards": {
            "smMin": ranges["SM"][0],
            "smMax": ranges["SM"][1],
            "mfMin": ranges["MF"][0],
            "mfMax": ranges["MF"][1],
        },
        "runners": [{"number": n} for n in runner_ids],
        "records": [
            {"id": rec.id, "runner": rec.runner, "gate": rec.gate, "time": rec.time}
            for rec in records
        ],
        "excludedIds": [rec.id for rec in records if rec.id in excluded_ids],
    }


def build_publication(payload: Any) -> dict:
    """把发布请求构建为待落库快照（除版本冲突外的全部校验都在此完成）。

    服务端重新裁决并核对：输入非法 -> BulletinError；复核不匹配/未全部通过 ->
    BulletinError；未知选手处罚或罚秒校验失败 -> BulletinError。
    名次按原规则在服务端重新生成。
    """
    if not isinstance(payload, dict):
        raise BulletinError("请求体格式不正确")
    bid = validate_bulletin_id(payload.get("bulletinId"))
    expected = _parse_expected_version(payload.get("expectedVersion"))

    # 输入沿用原裁决校验（含 40 条限额、隔离 ID 合法性），并重新裁决。
    try:
        runner_ids, ranges, records, excluded_ids = parse_payload(payload)
        result = adjudicate(payload)
    except AdjudicationError as exc:
        raise BulletinError(str(exc))

    reviews = verify_reviews(payload.get("reviews", []), result)
    penalties = verify_penalties(payload.get("penalties", []), runner_ids)
    ranking = build_ranking(result, penalties)

    input_snapshot = canonical_input(runner_ids, ranges, records, excluded_ids)
    snapshot = {
        "bulletinId": bid,
        "input": input_snapshot,
        "adjudication": result,
        "reviews": reviews,
        "penalties": [
            {
                "runner": r,
                "seconds": penalties.get(r, {"seconds": 0})["seconds"],
                "reason": penalties.get(r, {"reason": ""})["reason"],
            }
            for r in runner_ids
        ],
        "ranking": ranking,
    }
    return {"bulletinId": bid, "expectedVersion": expected, "snapshot": snapshot}


# ---------------------------------------------------------------------------
# 落库（乐观版本：仅当 expected == 当前版本才写入下一版本）
# ---------------------------------------------------------------------------


def _row_to_snapshot(row: sqlite3.Row) -> dict:
    snap = json.loads(row["snapshot"])
    return {
        "bulletinId": snap["bulletinId"],
        "version": row["version"],
        "latestVersion": row["version"],
        "createdAt": row["created_at"],
        "input": snap["input"],
        "adjudication": snap["adjudication"],
        "reviews": snap["reviews"],
        "penalties": snap["penalties"],
        "ranking": snap["ranking"],
    }


def current_version(conn: sqlite3.Connection, bid: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(MAX(version), -1) AS v FROM bulletin_versions WHERE bulletin_id = ?",
        (bid,),
    ).fetchone()
    return row["v"]  # 尚无公告时为 -1（期望首次发布须为 0）


def publish_bulletin(prepared: dict) -> dict:
    """乐观并发发布：同版本并发只有一项成功；过期抛 BulletinConflict(409)。

    成功返回带公告链接的新版本快照；失败不留版本、不改现公告。
    """
    bid = prepared["bulletinId"]
    expected = prepared["expectedVersion"]
    snapshot_obj = prepared["snapshot"]

    conn = get_conn()
    with _db_lock:
        # IMMEDIATE 立即取写锁：同版本并发发布在进程锁内被串行化，
        # 第二个事务读到的当前版本已前进，必然 409。
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = current_version(conn, bid)  # 尚无公告时为 -1
            # “所见版本”语义：首次发布（无任何版本）所见为 0；之后所见版本
            # 即当前最新版本号本身（见过 v0 再发布则落库为 v1）。匹配才前进。
            seen_required = 0 if cur < 0 else cur
            if expected != seen_required:
                conn.rollback()
                raise BulletinConflict(0 if cur < 0 else cur)
            next_version = cur + 1
            created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            conn.execute(
                "INSERT INTO bulletin_versions (bulletin_id, version, snapshot, created_at)"
                " VALUES (?, ?, ?, ?)",
                (bid, next_version, json.dumps(snapshot_obj, ensure_ascii=False), created_at),
            )
            conn.commit()
        except BulletinConflict:
            raise
        except Exception:
            conn.rollback()
            raise

    saved = get_bulletin_version(bid, next_version)
    saved["url"] = f"/api/bulletins/{bid}/versions/{next_version}"
    saved["latestUrl"] = f"/api/bulletins/{bid}"
    saved["viewUrl"] = f"/bulletin.html?id={bid}&version={next_version}"
    saved["latestViewUrl"] = f"/bulletin.html?id={bid}"
    return saved


def get_bulletin_latest(bid: str) -> dict:
    conn = get_conn()
    with _db_lock:
        row = conn.execute(
            "SELECT * FROM bulletin_versions WHERE bulletin_id = ?"
            " ORDER BY version DESC LIMIT 1",
            (bid,),
        ).fetchone()
        latest = current_version(conn, bid)
    if row is None:
        raise BulletinNotFound
    out = _row_to_snapshot(row)
    out["latestVersion"] = latest
    return out


def get_bulletin_version(bid: str, version: int) -> dict:
    conn = get_conn()
    with _db_lock:
        row = conn.execute(
            "SELECT * FROM bulletin_versions WHERE bulletin_id = ? AND version = ?",
            (bid, version),
        ).fetchone()
        latest = current_version(conn, bid)
    if row is None:
        raise BulletinNotFound
    out = _row_to_snapshot(row)
    out["latestVersion"] = latest
    return out
