"""FastAPI 入口：提供裁决 API、设备日志合并预览 API、成绩公告发布/只读 API 与静态页面。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .adjudication import AdjudicationError, adjudicate, diagnose, find_missing
from .bulletins import (
    BulletinConflict,
    BulletinError,
    BulletinNotFound,
    get_bulletin_latest,
    get_bulletin_version,
    publish_bulletin,
    build_publication,
    validate_bulletin_id,
)
from .merge import MergeError, preview_merge

app = FastAPI(title="本地赛道计次裁决台", version="1.3.0")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@app.post("/api/adjudicate")
async def api_adjudicate(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            status_code=400, content={"ok": False, "error": "请求体不是合法的 JSON"}
        )
    try:
        result = adjudicate(payload)
    except AdjudicationError as exc:
        # 非法输入：返回错误，不展示任何部分结果。
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})
    return JSONResponse(content={"ok": True, "result": result})


@app.post("/api/diagnose")
async def api_diagnose(request: Request) -> JSONResponse:
    """替代性诊断：请求体与 /api/adjudicate 完全相同（同一套校验与状态码）。

    纯只读分析：不改变任何裁决行为，只针对各选手的未采纳记录给出
    “同优可替代 / 仅次优可用 / 无法成趟”分类及同优替代方案。
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            status_code=400, content={"ok": False, "error": "请求体不是合法的 JSON"}
        )
    try:
        result = diagnose(payload)
    except AdjudicationError as exc:
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})
    return JSONResponse(content={"ok": True, "result": result})


@app.post("/api/missing")
async def api_missing(request: Request) -> JSONResponse:
    """查找漏读：请求体与 /api/adjudicate 完全相同（同一套校验与状态码）。

    纯只读提示：不追加记录、不改变任何裁决行为。对每名选手枚举两条不同门
    记录与缺失门 S/M/F，返回“只补一条该门虚拟读数即可使最大计次数较原输入
    增加 1”的缺失读数秒数闭区间（覆盖全部可行秒数；不能增次的记录对不返回）。
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            status_code=400, content={"ok": False, "error": "请求体不是合法的 JSON"}
        )
    try:
        result = find_missing(payload)
    except AdjudicationError as exc:
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})
    return JSONResponse(content={"ok": True, "result": result})


async def _read_json_context(context: str | None) -> object:
    """读取 multipart 表单中的 context 字段（当前选手与记录表的 JSON）。"""
    if context is None:
        raise MergeError("缺少当前记录 context 字段")
    try:
        return json.loads(context)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise MergeError("当前记录 context 不是合法的 JSON")


async def _handle_merge_request(context: str | None, file: UploadFile | None) -> JSONResponse:
    if file is None:
        return JSONResponse(
            status_code=400, content={"ok": False, "error": "缺少上传的 CSV 文件（file）"}
        )
    try:
        context_obj = await _read_json_context(context)
        data = await file.read()
        result = preview_merge(context_obj, data)
    except MergeError as exc:
        # 整批拒绝：只返回中文原因，不产生任何合并结果。
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})
    except AdjudicationError as exc:
        # 当前记录本身非法（如选手编号重复、ID 重复）时同样拒绝预览。
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})
    return JSONResponse(content={"ok": True, "result": result})


@app.post("/api/import/preview")
async def api_import_preview(
    context: str | None = Form(default=None), file: UploadFile | None = File(default=None)
) -> JSONResponse:
    """设备日志合并预览（只读）：multipart 表单，context 为当前记录 JSON，
    file 为 UTF-8 CSV。返回新增与重复条目，不修改任何数据。
    """
    return await _handle_merge_request(context, file)


@app.post("/api/import/confirm")
async def api_import_confirm(
    context: str | None = Form(default=None), file: UploadFile | None = File(default=None)
) -> JSONResponse:
    """设备日志合并确认：与预览同一套解析与整批校验，返回同样的合并清单。

    服务端不保存状态：真正追加发生在页面端；确认时服务端重新独立校验，
    只有输入与预览所依据的当前记录、文件内容一致时结果才会与预览相同。
    """
    return await _handle_merge_request(context, file)


# ---------------------------------------------------------------------------
# 成绩公告：把“通过复核”的裁决发布为独立只读快照（SQLite 持久化、乐观版本）
# ---------------------------------------------------------------------------


@app.post("/api/bulletins")
async def api_bulletin_publish(request: Request) -> JSONResponse:
    """发布成绩公告：点击时快照（完整裁决输入/隔离/复核/罚秒/所见版本）提交，
    服务端重新裁决、核对复核与罚秒、重新生成名次；仅当版本匹配才落库下一版本。
    同版本并发只有一项成功，过期返回 409；失败不留版本、不改现公告。
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            status_code=400, content={"ok": False, "error": "请求体不是合法的 JSON"}
        )
    try:
        prepared = build_publication(payload)
        saved = publish_bulletin(prepared)
    except BulletinConflict as exc:
        # 期望版本过期：返回服务端当前版本，页面须重新读取最新公告后再决定。
        return JSONResponse(
            status_code=409,
            content={
                "ok": False,
                "error": "公告版本已过期：同一编号已有更新的公告版本，请读取最新版本后重新发布",
                "latestVersion": int(exc.args[0]),
            },
        )
    except BulletinError as exc:
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})
    return JSONResponse(content={"ok": True, "result": saved})


def _read_bulletin(bid_text: str, version_text: str | None) -> JSONResponse:
    try:
        bid = validate_bulletin_id(bid_text)
        if version_text is not None:
            # 版本必须是非负整数；任何其他写法（含非数字、负数）都按“未知版本”404。
            if not version_text.isdigit():
                raise BulletinNotFound
            version: int | None = int(version_text)
        else:
            version = None
        out = get_bulletin_latest(bid) if version is None else get_bulletin_version(bid, version)
    except BulletinError:
        return JSONResponse(status_code=404, content={"ok": False, "error": "公告不存在"})
    except BulletinNotFound:
        return JSONResponse(status_code=404, content={"ok": False, "error": "公告不存在"})
    out["url"] = f"/api/bulletins/{bid}/versions/{out['version']}"
    out["latestUrl"] = f"/api/bulletins/{bid}"
    out["viewUrl"] = f"/bulletin.html?id={bid}&version={out['version']}"
    out["latestViewUrl"] = f"/bulletin.html?id={bid}"
    return JSONResponse(content={"ok": True, "result": out})


@app.get("/api/bulletins/{bid}")
async def api_bulletin_read_latest(bid: str) -> JSONResponse:
    """按编号读取公告最新版本（缺省读最新）；未知编号返回 404。旧版本永久只读。"""
    return _read_bulletin(bid, None)


@app.get("/api/bulletins/{bid}/versions/{version}")
async def api_bulletin_read_version(bid: str, version: str) -> JSONResponse:
    """按编号与版本读取公告快照；未知编号、未知或非数字版本均返回 404。"""
    return _read_bulletin(bid, version)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
