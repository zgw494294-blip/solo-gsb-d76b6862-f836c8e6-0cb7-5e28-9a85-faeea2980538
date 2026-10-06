"""成绩公告：把通过复核的裁决发布为独立的只读公告（SQLite 持久化，版本化）。

规则摘要：
- 发布时服务端按提交的完整裁决输入**重新裁决**（不信任页面缓存的任何结果），
  并逐条核对人工复核：按选手、三条记录的 ID/门/秒数及区间匹配到被采纳的趟；
  每趟均须“通过”（零次选手无需复核），未知选手处罚或不匹配复核整次拒绝；
- 备注、罚秒与原因沿用页面原校验（备注/原因至多 200 字、罚秒非负整数、
  罚秒大于 0 时原因必填）；名次按原规则在服务端生成（计次数降序、调整后
  用时升序、并列共享名次跳号、零次者末尾无名次）；
- 乐观版本控制：只有“所见公告版本”与当前最新版本一致时才把快照保存为下一
  版本（首次发布所见版本为 0）；同一版本并发发布只有一项成功，过期返回 409；
  任何失败都不留版本、也不改动现有公告；
- 公告按编号与可选版本读取，缺省读最新，未知编号/版本返回 404；旧版本永久
  只读，后续编辑、清空与刷新都不影响已发布的公告；
- 公告编号、记录秒数与用时全程按任意精度整数/原样字符串处理，不发生截断。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from .adjudication import (
    GATES,
    AdjudicationError,
    _parse_nonneg_int,
    _parse_positive_int,
    adjudicate,
    parse_payload,
)

# 与页面一致的原校验上限。
MAX_REVIEW_NOTE = 200
MAX_PENALTY_REASON = 200

REVIEW_STATUSES = ("pending", "pass", "doubt")


class BulletinError(ValueError):
    """公告请求非法，message 为可直接展示的中文说明（端点返回 422）。"""


class BulletinConflict(Exception):
    """所见版本过期：当前最新版本与提交的 baseVersion 不一致（端点返回 409）。"""

    def __init__(self, current_version: int):
        super().__init__(f"公告版本已变化：当前最新版本为 {current_version}")
        self.current_version = current_version


class BulletinStore:
    """公告的 SQLite 存储：按 (编号, 版本) 保存只读快照，跨重启保留。"""

    def __init__(self, path: str):
        self._path = path
        directory = os.path.dirname(os.path.abspath(path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        # 单连接 + 进程内锁：发布是“读最新版本 + 插入下一版本”的短事务，
        # BEGIN IMMEDIATE 保证同版本并发写入只有一项成功。
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS bulletins ("
                " number TEXT NOT NULL,"
                " version INTEGER NOT NULL,"
                " payload TEXT NOT NULL,"
                " created_at TEXT NOT NULL,"
                " PRIMARY KEY (number, version))"
            )

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def current_version(self, number: str) -> int:
        """当前最新版本号；没有任何版本时为 0。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT MAX(version) FROM bulletins WHERE number = ?", (number,)
            ).fetchone()
        return row[0] if row and row[0] is not None else 0

    def publish(self, number: str, base_version: int, payload: dict) -> int:
        """版本匹配时把快照保存为下一版本并返回新版本号；过期抛 BulletinConflict。

        失败不留任何版本、也不改动现有公告：插入与版本检查在同一事务中，
        冲突或异常都整体回滚。
        """
        body = json.dumps(payload, ensure_ascii=False)
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute(
                    "SELECT MAX(version) FROM bulletins WHERE number = ?", (number,)
                ).fetchone()
                current = row[0] if row and row[0] is not None else 0
                if current != base_version:
                    raise BulletinConflict(current)
                new_version = current + 1
                cur.execute(
                    "INSERT INTO bulletins (number, version, payload, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    (
                        number,
                        new_version,
                        body,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
            except BulletinConflict:
                cur.execute("ROLLBACK")
                raise
            except sqlite3.IntegrityError:
                # 兜底：多进程写同一库文件时的主键冲突同样视为版本冲突，
                # 同版本并发发布只有先提交的一项成功。
                cur.execute("ROLLBACK")
                row = self._conn.execute(
                    "SELECT MAX(version) FROM bulletins WHERE number = ?", (number,)
                ).fetchone()
                current = row[0] if row and row[0] is not None else 0
                raise BulletinConflict(current)
            except BaseException:
                cur.execute("ROLLBACK")
                raise
            cur.execute("COMMIT")
            return new_version

    def read(self, number: str, version: int | None = None) -> dict | None:
        """按编号与可选版本读取公告；缺省读最新版本。不存在返回 None。"""
        with self._lock:
            if version is None:
                row = self._conn.execute(
                    "SELECT version, payload, created_at FROM bulletins"
                    " WHERE number = ? ORDER BY version DESC LIMIT 1",
                    (number,),
                ).fetchone()
            else:
                row = self._conn.execute(
                    "SELECT version, payload, created_at FROM bulletins"
                    " WHERE number = ? AND version = ?",
                    (number, version),
                ).fetchone()
        if row is None:
            return None
        payload = json.loads(row[1])
        # 编号与版本是表列，快照正文不含它们，读取时合并返回。
        return {"number": number, "version": row[0], "publishedAt": row[2], **payload}


def _as_bulletin_error(exc: AdjudicationError) -> BulletinError:
    return BulletinError(str(exc))


def _parse_bulletin_number(value: Any) -> str:
    """公告编号：非空字符串（去首尾空白）；JSON 整数按十进制文本接受。

    编号按原样文本保存与匹配，任意长的数字串都精确保留，不做数值归一。
    """
    if isinstance(value, bool):
        raise BulletinError("公告编号必须是非空字符串")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        number = value.strip()
        if number == "":
            raise BulletinError("公告编号不能为空")
        return number
    raise BulletinError("公告编号必须是非空字符串")


def _parse_base_version(value: Any) -> int:
    if value is None:
        raise BulletinError("缺少所见公告版本（baseVersion）")
    try:
        return _parse_nonneg_int(value, "所见公告版本")
    except AdjudicationError as exc:
        raise _as_bulletin_error(exc)


def _parse_review_records(value: Any, index: int) -> tuple[tuple[str, str, int], ...]:
    """解析一条复核的三条记录声明，按门序返回 (S, M, F) 三个 (ID, 门, 秒数)。"""
    if not isinstance(value, list) or len(value) != 3:
        raise BulletinError(f"第 {index} 条复核必须包含起点/中途门/终点三条记录")
    claims: dict[str, tuple[str, str, int]] = {}
    for item in value:
        if not isinstance(item, dict):
            raise BulletinError(f"第 {index} 条复核的记录格式不正确")
        rid = item.get("id")
        if not isinstance(rid, str) or rid.strip() == "":
            raise BulletinError(f"第 {index} 条复核的记录 ID 必须是非空字符串")
        rid = rid.strip()
        gate = item.get("gate")
        if gate not in GATES:
            raise BulletinError(f"第 {index} 条复核的门必须为 S / M / F 之一")
        try:
            time_s = _parse_nonneg_int(item.get("time"), f"第 {index} 条复核的记录秒数")
        except AdjudicationError as exc:
            raise _as_bulletin_error(exc)
        if gate in claims:
            raise BulletinError(f"第 {index} 条复核与当前裁决的采纳趟不匹配（门 {gate} 重复）")
        claims[gate] = (rid, gate, time_s)
    if set(claims) != set(GATES):
        raise BulletinError(f"第 {index} 条复核与当前裁决的采纳趟不匹配（须各含 S/M/F 一条）")
    return (claims["S"], claims["M"], claims["F"])


def _match_reviews(raw: Any, adjudication: dict, records: list) -> list[dict]:
    """核对已保存复核并返回按选手/趟序排列的复核列表。

    核对规则：每条复核按 选手 + 三条记录的 ID/门/秒数 匹配到该选手被采纳的
    具体一趟（区间由服务端按提交输入重新裁决保证）；三条记录必须真实存在、
    门/秒数一致且属于该选手。每趟均须“通过”：所有采纳趟都必须有一条状态为
    “通过”的复核；零次选手无需复核。未知选手、不匹配或重复的复核整次拒绝。
    """
    if not isinstance(raw, list):
        raise BulletinError("复核列表（reviews）必须是数组")
    rec_by_id = {r.id: r for r in records}
    runner_ids = {r["runner"] for r in adjudication["runners"]}

    # 全部采纳趟：(选手, S/M/F 记录 ID) -> 趟序号（从 1 起）。
    lap_index: dict[tuple, int] = {}
    for r in adjudication["runners"]:
        for i, lap in enumerate(r["laps"], 1):
            key = (
                r["runner"],
                lap["start"]["id"],
                lap["middle"]["id"],
                lap["finish"]["id"],
            )
            lap_index[key] = i

    matched: dict[tuple, dict] = {}
    for i, entry in enumerate(raw, 1):
        if not isinstance(entry, dict):
            raise BulletinError(f"第 {i} 条复核格式不正确")
        try:
            runner = _parse_positive_int(entry.get("runner"), f"第 {i} 条复核的选手编号")
        except AdjudicationError as exc:
            raise _as_bulletin_error(exc)
        if runner not in runner_ids:
            raise BulletinError(f"第 {i} 条复核的选手编号 {runner} 未登记")
        triple = _parse_review_records(entry.get("records"), i)
        status = entry.get("status")
        if status not in REVIEW_STATUSES:
            raise BulletinError(f"第 {i} 条复核的状态非法")
        note = entry.get("note", "")
        if not isinstance(note, str):
            raise BulletinError(f"第 {i} 条复核的备注必须是字符串")
        if len(note) > MAX_REVIEW_NOTE:
            raise BulletinError(f"第 {i} 条复核的备注至多 {MAX_REVIEW_NOTE} 字")
        # 三条记录必须真实存在、门/秒数一致且属于该选手（区间由重新裁决保证）。
        for cid, cgate, ctime in triple:
            rec = rec_by_id.get(cid)
            if (
                rec is None
                or rec.gate != cgate
                or rec.time != ctime
                or rec.runner != runner
            ):
                raise BulletinError(
                    f"第 {i} 条复核与当前裁决的采纳趟不匹配（记录 {cid}）"
                )
        key = (runner, triple[0][0], triple[1][0], triple[2][0])
        if key not in lap_index:
            raise BulletinError(f"第 {i} 条复核与当前裁决的采纳趟不匹配")
        if key in matched:
            raise BulletinError(f"选手 {runner} 的同一趟存在重复复核")
        if status != "pass":
            raise BulletinError(
                f"选手 {runner} 的第 {lap_index[key]} 趟复核须为“通过”才能发布"
            )
        matched[key] = {
            "runner": runner,
            "records": [
                {"id": cid, "gate": cgate, "time": ctime} for cid, cgate, ctime in triple
            ],
            "status": status,
            "note": note,
        }

    # 每趟均须“通过”：所有采纳趟都必须有复核（零次选手没有任何趟，无需复核）。
    for r in adjudication["runners"]:
        for i, lap in enumerate(r["laps"], 1):
            key = (
                r["runner"],
                lap["start"]["id"],
                lap["middle"]["id"],
                lap["finish"]["id"],
            )
            if key not in matched:
                raise BulletinError(
                    f"选手 {r['runner']} 的第 {i} 趟缺少“通过”的人工复核"
                )

    ordered: list[dict] = []
    for r in adjudication["runners"]:
        for lap in r["laps"]:
            key = (
                r["runner"],
                lap["start"]["id"],
                lap["middle"]["id"],
                lap["finish"]["id"],
            )
            ordered.append(matched[key])
    return ordered


def _validate_penalties(raw: Any, runner_ids: set[int]) -> dict[int, dict]:
    """校验处罚列表（罚秒与原因沿用页面原校验），返回 选手编号 -> 处罚 的映射。

    未知选手处罚、重复处罚、非法罚秒或原因都整次拒绝。
    """
    if not isinstance(raw, list):
        raise BulletinError("处罚列表（penalties）必须是数组")
    result: dict[int, dict] = {}
    for i, entry in enumerate(raw, 1):
        if not isinstance(entry, dict):
            raise BulletinError(f"第 {i} 条处罚格式不正确")
        try:
            runner = _parse_positive_int(entry.get("runner"), f"第 {i} 条处罚的选手编号")
            seconds = _parse_nonneg_int(entry.get("seconds"), f"第 {i} 条处罚的罚秒")
        except AdjudicationError as exc:
            raise _as_bulletin_error(exc)
        if runner not in runner_ids:
            raise BulletinError(f"选手 {runner} 未登记，不能接受处罚")
        if runner in result:
            raise BulletinError(f"选手 {runner} 的处罚重复")
        reason = entry.get("reason", "")
        if not isinstance(reason, str):
            raise BulletinError(f"第 {i} 条处罚的原因必须是字符串")
        if len(reason) > MAX_PENALTY_REASON:
            raise BulletinError(f"第 {i} 条处罚的原因至多 {MAX_PENALTY_REASON} 字")
        if seconds > 0 and reason.strip() == "":
            raise BulletinError(f"选手 {runner} 罚秒大于 0 时必须填写原因")
        result[runner] = {"runner": runner, "seconds": seconds, "reason": reason}
    return result


def _compute_ranking(adjudication: dict, penalties: dict[int, dict]) -> list[dict]:
    """按页面名次表同款规则在服务端生成名次（不信任页面缓存的名次）。

    调整后用时 = 原总用时 + 罚秒；有完整计次者按计次数降序、调整后用时升序
    排名，两项都相同者共享名次并跳号（1、1、3），并列按编号升序展示；
    计 0 次者排末尾、按编号升序且无名次。编号、用时与罚秒都是任意精度整数。
    """
    rows: list[dict] = []
    for r in adjudication["runners"]:
        saved = penalties.get(r["runner"])
        seconds = saved["seconds"] if saved else 0
        rows.append(
            {
                "runner": r["runner"],
                "lapCount": r["lapCount"],
                "totalTime": r["totalTime"],
                "penalty": seconds,
                "adjusted": r["totalTime"] + seconds,
                "rank": None,
            }
        )
    ranked = sorted(
        (row for row in rows if row["lapCount"] > 0),
        key=lambda row: (-row["lapCount"], row["adjusted"], row["runner"]),
    )
    for i, row in enumerate(ranked):
        if (
            i > 0
            and row["lapCount"] == ranked[i - 1]["lapCount"]
            and row["adjusted"] == ranked[i - 1]["adjusted"]
        ):
            row["rank"] = ranked[i - 1]["rank"]
        else:
            row["rank"] = i + 1
    zeros = sorted((row for row in rows if row["lapCount"] == 0), key=lambda row: row["runner"])
    return ranked + zeros


def publish_bulletin(payload: Any, store: BulletinStore) -> dict:
    """发布成绩公告：校验 → 重新裁决 → 核对复核/处罚 → 生成名次 → 按版本保存。

    非法输入抛 AdjudicationError，公告自身的校验失败抛 BulletinError（均为
    422），所见版本过期抛 BulletinConflict（409）。任何失败都不留版本、
    也不改动现有公告。
    """
    if not isinstance(payload, dict):
        raise BulletinError("请求体格式不正确")
    number = _parse_bulletin_number(payload.get("number"))
    base_version = _parse_base_version(payload.get("baseVersion"))
    input_payload = payload.get("input")
    if input_payload is None:
        raise BulletinError("缺少完整裁决输入（input）")

    # 服务端重新裁决：完整输入沿用裁决端点同一套校验（含隔离列表与 40 条限额）。
    adjudication = adjudicate(input_payload)
    runner_ids, _ranges, records, _excluded = parse_payload(input_payload)

    reviews = _match_reviews(payload.get("reviews", []), adjudication, records)
    penalties = _validate_penalties(payload.get("penalties", []), set(runner_ids))
    ranking = _compute_ranking(adjudication, penalties)

    snapshot = {
        "input": input_payload,
        "adjudication": adjudication,
        "reviews": reviews,
        "penalties": [penalties[r] for r in runner_ids if r in penalties],
        "ranking": ranking,
    }
    version = store.publish(number, base_version, snapshot)
    return {
        "number": number,
        "version": version,
        "url": f"/api/bulletins/{quote(number, safe='')}?version={version}",
    }
