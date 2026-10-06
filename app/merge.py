"""设备感应日志 CSV 并入当前记录表：解析与整批合并预览。

规则摘要（与页面约定一一对应）：
- 文件为 UTF-8 文本，表头必须恰好为 id,runner,gate,time，支持 RFC 4180 风格
  的 CSV 引号（双引号包裹、字段内逗号/换行/引号以 "" 转义）；
- 比较一律按规范化后的值进行：ID 沿用裁决模块“去首尾空白”的规则，
  选手编号与秒数按精确整数比较（"007" 与 "7"、"011" 与 "11" 视为相同）；
- 同 ID 在文件内重复出现或与现有记录内容一致时跳过；同 ID 但
  （选手编号 / 门 / 秒数）任一不一致即为冲突；
- 未知选手编号、非法行、合并后记录超过 40 条等任何问题均整批拒绝，
  由调用方保留原表不动。
"""

from __future__ import annotations

from typing import Any

from .adjudication import (
    AdjudicationError,
    MAX_RECORDS,
    Record,
    _parse_nonneg_int,
    _parse_positive_int,
    _require_object,
    parse_records,
    parse_runners,
)

CSV_HEADER = ("id", "runner", "gate", "time")
GATES = ("S", "M", "F")


class MergeError(ValueError):
    """CSV 或合并请求非法；message 为可直接展示的中文说明。"""


def parse_csv(data: bytes) -> list[dict[str, str]]:
    """解析 UTF-8、表头 id,runner,gate,time 的 CSV，返回按文件顺序排列的行。

    支持：CRLF/CR/LF 换行、开头 UTF-8 BOM、RFC 4180 双引号字段（字段内可含
    逗号与换行，"" 表示一个引号）。任何非法之处（非 UTF-8、引号未闭合、
    引号字段外有杂散字符、列数不为 4、表头不符）均抛 MergeError。
    仅有表头、没有数据行是合法的（没有任何可并入的记录）。
    """
    if not isinstance(data, (bytes, bytearray)):
        raise MergeError("上传内容不是 CSV 文件")
    try:
        text = bytes(data).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MergeError(f"文件不是合法的 UTF-8 文本（第 {exc.start + 1} 字节附近无法解码）")
    if text.startswith("\ufeff"):
        text = text[1:]
    # 统一换行：解析行号以换行符计数，引用字段内的换行也计入物理行号。
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    rows: list[list[str]] = []
    fields: list[str] = []
    field = ""
    in_quotes = False
    quote_closed = False  # 当前字段的引号已闭合：其后只允许逗号、换行或文件结束
    line_no = 1
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if in_quotes:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field += '"'
                    i += 2
                    continue
                in_quotes = False
                quote_closed = True
                i += 1
                continue
            if c == "\n":
                line_no += 1
            field += c
            i += 1
            continue
        if c == '"':
            if field != "" or quote_closed:
                # 引号只能出现在字段开头；"a"b、""x 这类杂散写法一律拒绝。
                raise MergeError(f"第 {line_no} 行：引号字段格式不正确")
            in_quotes = True
            i += 1
            continue
        if c == ",":
            fields.append(field)
            field = ""
            in_quotes = False
            quote_closed = False
            i += 1
            continue
        if c == "\n":
            fields.append(field)
            rows.append((line_no, fields))
            fields = []
            field = ""
            in_quotes = False
            quote_closed = False
            line_no += 1
            i += 1
            continue
        if quote_closed:
            # 引号闭合后只允许逗号或换行结束本字段，其余字符都是杂散内容。
            raise MergeError(f"第 {line_no} 行：引号字段格式不正确")
        field += c
        i += 1

    if in_quotes:
        raise MergeError("CSV 引号未闭合（缺少结束双引号）")
    # 末尾有内容（文件不以换行结尾）补最后一行；纯空文件不会产生任何行。
    if field != "" or fields:
        fields.append(field)
        rows.append((line_no, fields))

    if not rows:
        raise MergeError("CSV 为空：缺少表头 id,runner,gate,time")

    header_line, header = rows[0]
    if tuple(h.strip() for h in header) != CSV_HEADER:
        raise MergeError(
            f"第 {header_line} 行：表头必须为 id,runner,gate,time（实际为 "
            f"{','.join(h.strip() for h in header) or '（空）'}）"
        )

    out: list[dict[str, str]] = []
    for row_line, raw in rows[1:]:
        if len(raw) != 4:
            raise MergeError(f"第 {row_line} 行：应有 4 列（id,runner,gate,time），实际 {len(raw)} 列")
        rid, runner, gate, time_s = (v.strip() for v in raw)
        if rid == "":
            raise MergeError(f"第 {row_line} 行：ID 不能为空")
        if runner == "":
            raise MergeError(f"第 {row_line} 行（ID {rid}）：选手编号不能为空")
        if gate == "":
            raise MergeError(f"第 {row_line} 行（ID {rid}）：门不能为空")
        if time_s == "":
            raise MergeError(f"第 {row_line} 行（ID {rid}）：秒数不能为空")
        out.append(
            {"id": rid, "runner": runner, "gate": gate, "time": time_s, "_line": row_line}
        )
    return out


def _same_content(existing: Record, runner: int, gate: str, time_s: int) -> bool:
    """内容是否一致：编号、秒数按精确整数比较，门按字符串精确比较。"""
    return existing.runner == runner and existing.gate == gate and existing.time == time_s


def preview_merge(context: Any, data: bytes) -> dict[str, Any]:
    """根据当前记录（context，与 /api/adjudicate 同形状但无需 standards）
    与设备 CSV 字节流，计算整批合并预览。

    返回：
      {
        "added":      [{id, runner, gate, time, line}, ...]  # 文件首次出现顺序
        "duplicates": [{id, runner, gate, time, line}, ...]  # 跳过（文件内或同内容）
        "existingCount": 合并前有效记录条数,
        "mergedCount":  合并后有效记录条数,
      }
    任何非法情形均抛 MergeError（整批拒绝，原表由调用方保留）。
    """
    root = _require_object(context, "当前记录")
    runner_ids = parse_runners(root.get("runners"))
    valid_runners = set(runner_ids)
    existing = parse_records(root.get("records"), valid_runners)

    rows = parse_csv(data)

    # 现有记录按 ID 索引（parse_records 已保证 ID 唯一）。
    by_id: dict[str, Record] = {r.id: r for r in existing}
    # 文件内首次出现的规范化内容；重复行若与首次内容一致则跳过。
    file_first: dict[str, tuple[int, str, int]] = {}

    added: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []

    for row in rows:
        line = row["_line"]
        rid = row["id"]

        try:
            runner = _parse_positive_int(row["runner"], "选手编号")
        except AdjudicationError:
            raise MergeError(f"第 {line} 行（ID {rid}）：选手编号必须是正整数")
        if runner not in valid_runners:
            raise MergeError(f"第 {line} 行（ID {rid}）：选手编号 {runner} 未登记")

        gate = row["gate"]
        if gate not in GATES:
            raise MergeError(f"第 {line} 行（ID {rid}）：门必须为 S / M / F 之一")

        try:
            time_s = _parse_nonneg_int(row["time"], "秒数")
        except AdjudicationError:
            raise MergeError(f"第 {line} 行（ID {rid}）：秒数必须是非负整数")

        entry = {"id": rid, "runner": runner, "gate": gate, "time": time_s, "line": line}

        if rid in by_id:
            cur = by_id[rid]
            if not _same_content(cur, runner, gate, time_s):
                diffs = []
                if cur.runner != runner:
                    diffs.append(f"选手编号：现有 {cur.runner}，文件 {runner}")
                if cur.gate != gate:
                    diffs.append(f"门：现有 {cur.gate}，文件 {gate}")
                if cur.time != time_s:
                    diffs.append(f"秒数：现有 {cur.time}，文件 {time_s}")
                raise MergeError(
                    f"第 {line} 行：ID {rid} 与现有记录内容冲突（{'；'.join(diffs)}）"
                )
            duplicates.append(entry)
            continue

        if rid in file_first:
            fr, fg, ft = file_first[rid]
            if (fr, fg, ft) != (runner, gate, time_s):
                raise MergeError(
                    f"第 {line} 行：ID {rid} 在文件内内容冲突（选手编号、门或秒数与首次出现不一致）"
                )
            duplicates.append(entry)
            continue

        file_first[rid] = (runner, gate, time_s)
        added.append(entry)

    merged_count = len(existing) + len(added)
    if merged_count > MAX_RECORDS:
        raise MergeError(
            f"合并后感应记录为 {merged_count} 条，超过上限 {MAX_RECORDS} 条；整批拒绝"
        )

    return {
        "added": added,
        "duplicates": duplicates,
        "existingCount": len(existing),
        "mergedCount": merged_count,
    }
