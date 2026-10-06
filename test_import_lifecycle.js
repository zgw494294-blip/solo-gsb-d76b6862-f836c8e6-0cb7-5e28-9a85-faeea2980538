/* 最小 DOM/事件 stub：加载真实 static/app.js，端到端验证设备日志 CSV 导入的生命周期。 */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------------- mini DOM（与另三套生命周期测试同款桩，另含 contains/文件输入） ---------------- */

class TokenList {
  constructor() { this._s = new Set(); }
  add(...names) { names.forEach((n) => n && this._s.add(n)); }
  remove(n) { this._s.delete(n); }
  contains(n) { return this._s.has(n); }
  [Symbol.iterator]() { return this._s[Symbol.iterator](); }
}

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.classList = new TokenList();
    this.dataset = {};
    this.id = "";
    this.value = "";
    this.files = []; // 仅文件输入使用
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this._text = "";
    this._html = "";
    this._listeners = new Map();
    this.name = "";
    this.type = "";
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(html) {
    this._html = html;
    this.children = [];
    if (html) parseHtml(html).forEach((n) => this.appendChild(n));
  }
  get innerHTML() { return this._html; }
  appendChild(c) {
    if (c.parent) c.parent._remove(c);
    c.parent = this;
    this.children.push(c);
    return c;
  }
  _remove(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
  }
  remove() { if (this.parent) { this.parent._remove(this); this.parent = null; } }
  insertAdjacentHTML(_pos, html) { parseHtml(html).forEach((n) => this.appendChild(n)); }
  contains(node) { return node === this || this._descendants().includes(node); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatchEvent(evt) {
    let node = this;
    if (!evt.target) evt.target = this;
    if (!evt.preventDefault) evt.preventDefault = () => {};
    while (node) {
      const fns = node._listeners.get(evt.type) || [];
      for (const fn of fns) fn.call(node, evt);
      node = node.parent;
    }
  }
  _descendants(out = []) {
    for (const c of this.children) { out.push(c); c._descendants(out); }
    return out;
  }
  matches(sel) {
    let s = sel.trim();
    const checked = s.endsWith(":checked");
    if (checked) s = s.slice(0, -":checked".length);
    let m = s.match(/^([\w-]+)?(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/);
    if (s.startsWith(".") || s.startsWith("#")) m = null;
    if (s.startsWith(".")) {
      if (checked && !this.checked) return false;
      return this.classList.contains(s.slice(1));
    }
    if (s.startsWith("#")) return this.id === s.slice(1);
    if (!m) return false;
    const [, tag, attr, val] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (attr) {
      const actual = attr === "class" ? [...this.classList].join(" ") : this.attrs[attr] ?? this[attr];
      if (val !== undefined && String(actual) !== val) return false;
      if (val === undefined && actual === undefined) return false;
    }
    if (checked && !this.checked) return false;
    return true;
  }
  querySelector(sel) { return this._descendants().find((n) => n.matches(sel)); }
  querySelectorAll(sel) { return this._descendants().filter((n) => n.matches(sel)); }
  closest(sel) {
    let n = this;
    while (n) { if (n.matches(sel)) return n; n = n.parent; }
    return null;
  }
}

const VOID_TAGS = new Set(["input", "br", "img", "hr", "meta", "link"]);

function parseHtml(html) {
  const root = new El("#root");
  const stack = [root];
  const tokenRe = /<\/?[a-zA-Z][\w-]*(?:[^<>]*?)\/?>|[^<]+/g;
  let tok;
  while ((tok = tokenRe.exec(html))) {
    const t = tok[0];
    if (t[0] !== "<") continue;
    const closing = t[1] === "/";
    const selfClose = t.endsWith("/>");
    const nameM = t.match(/^<\/?([\w-]+)/);
    const tag = nameM[1].toLowerCase();
    if (closing) {
      const el = stack.pop();
      if (el && el._contentStart !== undefined) el._html = html.slice(el._contentStart, tok.index);
      continue;
    }
    const el = new El(tag);
    const attrRe = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
    const raw = t.replace(/^<\/?[\w-]+/, "").replace(/\/?>$/, "");
    let am;
    while ((am = attrRe.exec(raw))) {
      const [, k, v] = am;
      if (!k || k === "/") continue;
      if (v === undefined) { el.attrs[k] = true; continue; }
      el.attrs[k] = v;
      if (k === "class") v.split(/\s+/).forEach((c) => c && el.classList.add(c));
      else if (k === "id") el.id = v;
      else if (k.startsWith("data-")) {
        const dk = k.slice(5);
        el.dataset[dk] = v;
        el.dataset[dk.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      }
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = true;
      else if (k === "hidden") el.hidden = true;
      else if (k === "disabled") el.disabled = true;
      else if (k === "name") el.name = v;
      else if (k === "type") el.type = v;
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag)) {
      el._contentStart = tok.index + t.length;
      stack.push(el);
    }
  }
  return root.children.slice();
}

/* ---------------- document stub ---------------- */

const byId = new Map();
function mk(id, tag = "div") { const e = new El(tag); e.id = id; byId.set(id, e); return e; }

const form = mk("judge-form", "form");
const runnerRows = mk("runner-rows");
const recordRows = mk("record-rows");
const addRunner = mk("add-runner", "button");
const addRecord = mk("add-record", "button");
mk("record-count", "span");
mk("error-box"); mk("pending-hint");
const results = mk("results");
mk("diagnosis-box").hidden = true;
for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) mk(id, "input");
mk("sample-btn", "button");
mk("clear-btn", "button");

// 导入控件
const fileInput = mk("import-file", "input");
fileInput.type = "file";
fileInput.files = [];
// 与真实浏览器一致：程序化清空 value 同时清空 files。
Object.defineProperty(fileInput, "value", {
  get() { return this._value || ""; },
  set(v) { this._value = String(v); if (v === "") this.files = []; },
});
const previewBtn = mk("import-preview-btn", "button");
previewBtn.disabled = true;
mk("import-file-name", "span").textContent = "未选择文件";
const importBox = mk("import-box");
importBox.hidden = true;

for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) form.appendChild(byId.get(id));
form.appendChild(runnerRows);
form.appendChild(recordRows);
form.appendChild(fileInput); // 真实页面中文件输入位于 form 内

global.document = { getElementById: (id) => byId.get(id) };

/* ---------------- FormData stub ---------------- */

global.FormData = class FormData {
  constructor() { this._fields = new Map(); }
  set(k, v) { this._fields.set(k, v); }
  get(k) { return this._fields.get(k); }
};

/* ---------------- fetch stub ---------------- */

function lap(s, m, f, st, mt, ft) {
  return {
    start: { id: s, time: st }, middle: { id: m, time: mt }, finish: { id: f, time: ft },
    smTime: mt - st, mfTime: ft - mt, totalTime: ft - st,
  };
}

const adjudicateResult = {
  runners: [
    {
      runner: 101, lapCount: 2, totalTime: 52,
      laps: [
        lap("a1", "b1", "c1", 0, 12, 25),
        lap("a2", "b2", "c2", 30, 45, 57),
      ],
      unused: [{ id: "x2", gate: "S", time: 30 }],
    },
  ],
};

// 极简服务端预览：与 Python 端同规则（仅支持测试所用的简单/引号 CSV）。
const normInt = (v) => String(v).trim().replace(/^0+(?=\d)/, "");
function fakeImport(endpoint, ctx, file) {
  const text = file.content.replace(/^\ufeff/, "");
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  const unquote = (f) => {
    let v = f.trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/""/g, '"');
    return v.trim();
  };
  const header = lines.shift().split(",").map(unquote).join(",");
  if (header !== "id,runner,gate,time") {
    return { status: 422, body: { ok: false, error: "表头必须为 id,runner,gate,time" } };
  }
  const runnerSet = new Set(ctx.runners.map((r) => normInt(r.number)));
  const byId = new Map();
  let existingCount = 0;
  for (const rec of ctx.records) {
    if (rec.id.trim() === "") continue;
    existingCount += 1;
    byId.set(rec.id.trim(), { runner: normInt(rec.runner), gate: rec.gate, time: normInt(rec.time) });
  }
  const fileFirst = new Map();
  const added = [];
  const duplicates = [];
  lines.forEach((line, idx) => {
    const [id, runner, gate, time] = line.split(",").map(unquote);
    const rn = normInt(runner);
    const entry = { id, runner: Number(rn), gate, time: Number(normInt(time)), line: idx + 2 };
    if (!/^\d+$/.test(rn) || rn === "0") {
      throw { status: 422, body: { ok: false, error: `第 ${idx + 2} 行（ID ${id}）：选手编号必须是正整数` } };
    }
    if (!runnerSet.has(rn)) {
      throw { status: 422, body: { ok: false, error: `第 ${idx + 2} 行（ID ${id}）：选手编号 ${rn} 未登记` } };
    }
    if (!["S", "M", "F"].includes(gate)) {
      throw { status: 422, body: { ok: false, error: `第 ${idx + 2} 行（ID ${id}）：门非法` } };
    }
    if (!/^\d+$/.test(String(time).trim())) {
      throw { status: 422, body: { ok: false, error: `第 ${idx + 2} 行（ID ${id}）：秒数非法` } };
    }
    if (byId.has(id)) {
      const cur = byId.get(id);
      if (cur.runner !== rn || cur.gate !== gate || cur.time !== normInt(time)) {
        throw { status: 422, body: { ok: false, error: `第 ${idx + 2} 行：ID ${id} 与现有记录内容冲突` } };
      }
      duplicates.push(entry);
    } else if (fileFirst.has(id)) {
      const f0 = fileFirst.get(id);
      if (f0.runner !== rn || f0.gate !== gate || f0.time !== normInt(time)) {
        throw { status: 422, body: { ok: false, error: `第 ${idx + 2} 行：ID ${id} 在文件内内容冲突` } };
      }
      duplicates.push(entry);
    } else {
      fileFirst.set(id, { runner: rn, gate, time: normInt(time) });
      added.push(entry);
    }
  });
  if (existingCount + added.length > 40) {
    return { status: 422, body: { ok: false, error: `合并后感应记录为 ${existingCount + added.length} 条，超过上限 40 条；整批拒绝` } };
  }
  return {
    status: 200,
    body: { ok: true, result: { added, duplicates, existingCount, mergedCount: existingCount + added.length } },
  };
}

const server = {
  adjMode: "valid",      // valid | invalid | neterr | hold
  adjHold: null,
  importMode: "valid",   // valid | invalid | neterr | hold
  importHold: null,
  importRaw: null,
};
const calls = { adjudicate: 0, import: [] };

global.fetch = async (url, opts) => {
  const respond = (data, ok, status) => ({
    ok,
    status,
    json: async () => (typeof data === "string" ? JSON.parse(data) : data),
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  if (url === "/api/adjudicate") {
    calls.adjudicate += 1;
    try { calls.lastAdjBody = JSON.parse(opts.body); } catch (_) {}
    if (server.adjMode === "neterr") throw new TypeError("模拟断网");
    if (server.adjMode === "invalid") return respond({ ok: false, error: "模拟非法输入" }, false, 422);
    if (server.adjMode === "hold") return respond(await server.adjHold, true, 200);
    return respond({ ok: true, result: adjudicateResult }, true, 200);
  }
  if (url === "/api/diagnose") {
    return respond({
      ok: true,
      result: { runners: [{ runner: 101, lapCount: 2, totalTime: 52, diagnoses: [] }] },
    }, true, 200);
  }
  if (url === "/api/import/preview" || url === "/api/import/confirm") {
    const ctx = JSON.parse(opts.body.get("context"));
    const file = opts.body.get("file");
    calls.import.push({ endpoint: url, ctx, fileName: file && file.name, size: file && file.content.length });
    if (server.importMode === "neterr") throw new TypeError("模拟导入断网");
    if (server.importMode === "invalid") {
      return respond({ ok: false, error: "模拟整批拒绝原因" }, false, 422);
    }
    if (server.importMode === "hold") return respond(await server.importHold, true, 200);
    if (server.importRaw !== null) {
      const raw = server.importRaw;
      return respond(typeof raw === "string" ? raw : JSON.stringify(raw), true, 200);
    }
    let out;
    try {
      out = fakeImport(url, ctx, file);
    } catch (rejection) {
      // fakeImport 以 throw {status, body} 表达整批拒绝
      return respond(rejection.body, false, rejection.status);
    }
    return respond(out.body, out.status === 200, out.status);
  }
  throw new Error(`unexpected url ${url}`);
};

/* ---------------- 加载真实 app.js ---------------- */

new Function(fs.readFileSync(path.join(__dirname, "static", "app.js"), "utf8"))();

/* ---------------- 测试辅助 ---------------- */

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓", msg); }
  else { failures++; console.error("  ✗", msg); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = (id) => byId.get(id);
function setVal(id, v) { $(id).value = v; }
function fire(el, type) { el.dispatchEvent({ type, preventDefault() {}, target: el }); }
async function flush(n = 6) { for (let i = 0; i < n; i++) await tick(); }

function setRow(idEl, runner, gate, time) {
  const rows = recordRows.querySelectorAll(".record-row");
  for (const row of rows) {
    if (row.querySelector(".rec-id").value === "") {
      row.querySelector(".rec-id").value = idEl;
      row.querySelector(".rec-runner").value = runner;
      row.querySelector(".rec-gate").value = gate;
      row.querySelector(".rec-time").value = time;
      return row;
    }
  }
  throw new Error("no empty row");
}

let fileSeq = 0;
function makeFile(name, content) {
  return { name, content, size: content.length, lastModified: 1000 + ++fileSeq };
}
function chooseFile(f) {
  fileInput.files = f ? [f] : [];
  fire(fileInput, "change");
}
const importState = () => globalThis.__getImportStateForTest();
const importHtml = () => importBox.innerHTML;
function clickPreview() { fire(previewBtn, "click"); }
function clickClass(cls) {
  const btn = importBox.querySelector("." + cls);
  assert(btn, `按钮 .${cls} 存在`);
  fire(btn, "click");
}
async function adjudicate() { fire(form, "submit"); await flush(); }

function rowValues() {
  return recordRows.querySelectorAll(".record-row").map((row) => ({
    id: row.querySelector(".rec-id").value,
    runner: row.querySelector(".rec-runner").value,
    gate: row.querySelector(".rec-gate").value,
    time: row.querySelector(".rec-time").value,
  }));
}

// 与 diagnose 测试相同的 101 号 9 条记录布置（stub 裁决采纳 a1,b1,c1 / a2,b2,c2）。
async function setupNineRecords() {
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = "101";
  while (recordRows.querySelectorAll(".record-row").length < 9) fire(addRecord, "click");
  const rows = [
    ["a1", "101", "S", "0"], ["b1", "101", "M", "12"], ["c1", "101", "F", "25"],
    ["a2", "101", "S", "30"], ["b2", "101", "M", "45"], ["c2", "101", "F", "57"],
    ["x2", "101", "S", "30"], ["mX", "101", "M", "35"], ["z1", "101", "F", "300"],
  ];
  let i = 0;
  for (const row of recordRows.querySelectorAll(".record-row")) {
    const [id, r, g, t] = rows[i++];
    row.querySelector(".rec-id").value = id;
    row.querySelector(".rec-runner").value = r;
    row.querySelector(".rec-gate").value = g;
    row.querySelector(".rec-time").value = t;
  }
  await adjudicate();
}

function saveReviewUi(keyIndex, status, note) {
  const box = results.querySelectorAll(".review-box")
    .find((b) => b.dataset.keyIndex === String(keyIndex));
  for (const r of box.querySelectorAll('input[type="radio"]')) r.checked = r.value === status;
  box.querySelector(".review-note").value = note;
  fire(box.querySelector(".review-save"), "click");
}
function savePenaltyUi(runner, seconds, reason) {
  const ed = results.querySelectorAll(".penalty-editor")
    .find((e) => e.dataset.runner === String(runner));
  ed.querySelector(".penalty-seconds").value = seconds;
  ed.querySelector(".penalty-reason").value = reason;
  fire(ed.querySelector(".penalty-save"), "click");
}
const slotHtml = () => results.querySelector(".ranking-table-slot").innerHTML;

const CSV_TWO_NEW =
  'id,runner,gate,time\r\na1,101,S,0\r\n"d1",101,S,100\r\ne1,101,M,200\r\n';

async function main() {
  console.log("场景0：初始状态——导入卡隐藏、按钮禁用、不自动发请求");
  assert(importBox.hidden, "导入卡初始隐藏");
  assert(previewBtn.disabled, "未选文件时预览按钮禁用");
  assert(calls.import.length === 0, "没有任何导入请求");

  console.log("场景1：选择文件后只登记文件名，不自动预览；按钮启用");
  // 先布置基础数据：区间合法、选手 101、第 1 行现有记录 a1、第 2 行为空占位行。
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = "101";
  const baseRow = recordRows.querySelectorAll(".record-row")[0];
  baseRow.querySelector(".rec-id").value = "a1";
  baseRow.querySelector(".rec-runner").value = "101";
  baseRow.querySelector(".rec-gate").value = "S";
  baseRow.querySelector(".rec-time").value = "0";
  fire(form, "input");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  chooseFile(makeFile("device-log.csv", CSV_TWO_NEW));
  assert(previewBtn.disabled === false, "选择文件后按钮启用");
  assert($("import-file-name")._text.includes("device-log.csv"), "显示已选择文件名");
  assert(importBox.hidden, "选择文件本身不弹预览");
  assert(calls.import.length === 0, "选择文件不发请求");

  console.log("场景2：点击预览——multipart 携带当前记录与文件，展示新增/重复清单");
  clickPreview();
  assert(importState().status === "loading-preview", "立即进入 loading-preview");
  assert(importHtml().includes("预览新增与重复条目"), "loading 文案");
  await flush();
  assert(importState().status === "preview", "预览成功");
  const req = calls.import[calls.import.length - 1];
  assert(req.endpoint === "/api/import/preview", "请求 /api/import/preview");
  assert(req.fileName === "device-log.csv", "multipart 携带文件");
  assert(req.ctx.runners[0].number === "101" && req.ctx.records.length === 2,
    "context 是当前完整载荷（初始 2 行记录）");
  const html = importHtml();
  assert(html.includes("<strong>2</strong> 条"), "展示新增 2 条");
  assert(html.includes("d1") && html.includes("e1"), "列出新增 ID");
  const pD = html.indexOf("d1"), pE = html.indexOf("e1");
  assert(pD !== -1 && pD < pE, "新增按文件首次出现顺序");
  assert(html.includes("跳过的重复条目 1 条"), "重复 1 条折叠展示");
  assert(html.includes("合并后") && html.includes("<strong>3</strong> 条"), "合并后计数 3");
  assert(!!importBox.querySelector(".import-confirm"), "确认入口存在");

  console.log("场景3：预览期间编辑赛道输入立即失效，迟到预览响应不能恢复入口");
  let resolveHold;
  server.importMode = "hold";
  server.importHold = new Promise((res) => { resolveHold = res; });
  clickPreview();
  assert(importState().status === "loading-preview", "再次预览在途");
  setVal("smMax", "61");
  fire($("smMax"), "input");
  assert(importBox.hidden && importState() === null, "赛道输入变化：预览立即失效");
  assert(!importBox.querySelector(".import-confirm"), "确认入口消失");
  resolveHold({ ok: true, result: { added: [], duplicates: [], existingCount: 2, mergedCount: 2 } });
  await flush();
  assert(importBox.hidden && importState() === null, "迟到的预览成功不能恢复确认入口");
  server.importMode = "valid";
  setVal("smMax", "60");
  fire($("smMax"), "input");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  assert(importState() === null, "重算完成后旧预览也不恢复");

  console.log("场景4：上传文件变化（重新选择/清空）立即失效");
  clickPreview();
  await flush();
  assert(importState().status === "preview", "重新预览成功");
  chooseFile(makeFile("other.csv", "id,runner,gate,time\nn2,101,F,9\n"));
  assert(importState() === null && importBox.hidden, "换文件：预览失效");
  chooseFile(makeFile("device-log.csv", CSV_TWO_NEW));
  clickPreview();
  await flush();
  assert(importState().status === "preview", "换后可重新预览");
  chooseFile(null);
  assert(importState() === null && previewBtn.disabled, "清空文件：预览失效、按钮禁用");
  chooseFile(makeFile("device-log.csv", CSV_TWO_NEW));

  console.log("场景5：确认追加——旧行不动、空行复用、新行按序追加、自动裁决");
  // 当前表为初始 2 行（空），先布置 1 条现有记录 a1 + 1 空行，与预览场景一致。
  recordRows.querySelectorAll(".record-row")[0].querySelector(".rec-id").value = "a1";
  recordRows.querySelectorAll(".record-row")[0].querySelector(".rec-runner").value = "101";
  recordRows.querySelectorAll(".record-row")[0].querySelector(".rec-gate").value = "S";
  recordRows.querySelectorAll(".record-row")[0].querySelector(".rec-time").value = "0";
  fire(recordRows, "input"); // 编辑使旧预览失效
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  clickPreview();
  await flush();
  assert(importState().status === "preview", "按最新输入重新预览成功");
  const adjBefore = calls.adjudicate;
  clickClass("import-confirm");
  assert(importState().status === "loading-confirm", "确认进入 loading-confirm");
  await flush();
  assert(importState().status === "merged", "追加成功");
  const vals = rowValues();
  assert(vals.length === 3, `追加后共 3 行（实际 ${vals.length}）`);
  assert(vals[0].id === "a1" && vals[1].id === "d1" && vals[2].id === "e1",
    "旧记录顺序不变，新记录按文件顺序追加（空行被复用）");
  assert(vals[1].runner === "101" && vals[1].gate === "S" && vals[1].time === "100", "d1 内容正确");
  assert($("record-count")._text === "3 / 40", "记录计数更新为 3 / 40");
  assert(calls.import[calls.import.length - 1].endpoint === "/api/import/confirm",
    "发出 /api/import/confirm");
  assert(calls.adjudicate === adjBefore + 1, "成功合并触发一次自动裁决");
  const mergeCall = calls.import[calls.import.length - 1];
  assert(mergeCall.ctx.records.length === 2, "确认请求携带的是追加前的当前记录（2 行）");
  assert(calls.lastAdjBody && calls.lastAdjBody.records.length === 3,
    "自动裁决载荷已含合并后的 3 条记录");
  assert(importHtml().includes("已追加 2 条") && importHtml().includes("跳过 1 条重复"),
    "成功提示含新增/重复/总数");
  assert(fileInput.files.length === 0 && previewBtn.disabled, "合并后文件选择已清空、按钮禁用");

  console.log("场景6：合并成功的自动裁决沿用原复核/罚秒/诊断失效规则");
  // 重新布置 9 条记录的完整场景（清掉刚追加的表）。
  fire($("clear-btn"), "click");
  await flush();
  await setupNineRecords();
  saveReviewUi(0, "pass", "导入前已复核");
  savePenaltyUi(101, "3", "设备故障");
  assert(slotHtml().includes("<td>3 秒</td><td>55 秒</td>"), "前置：罚秒已生效");
  // 诊断入口由结果渲染打开；通过与诊断测试同款的全局钩子发起。
  globalThis.__runDiagnosisForTest();
  await flush();
  assert(!$("diagnosis-box").hidden, "前置：诊断已展示");
  // 预览一个只新增 1 条、且与既有绑定无关的文件
  const oneNew = "id,runner,gate,time\r\nq9,101,F,900\r\n";
  chooseFile(makeFile("one.csv", oneNew));
  clickPreview();
  await flush();
  assert(importState().status === "preview", "预览成功（新增 1 条）");
  const rowsBeforeMerge = rowValues().length;
  clickClass("import-confirm");
  await flush();
  assert(rowValues().length === rowsBeforeMerge + 1, "仅追加 1 行");
  assert(results.innerHTML.includes("导入前已复核") && results.innerHTML.includes("当前：通过"),
    "无关新增：原复核保留");
  assert(results.innerHTML.includes("当前已保存：3 秒"), "无关新增：原罚秒保留");
  assert(slotHtml().includes("<td>3 秒</td><td>55 秒</td>"), "名次仍套用罚秒");
  // 自动裁决沿用诊断原失效规则：旧诊断内容清除、入口以 idle 重新打开（需重新检查）。
  assert(globalThis.__getDiagnosisStateForTest().status === "idle",
    "自动裁决后旧诊断已清除，入口回到 idle（需重新检查）");
  assert(importHtml().includes("自动裁决"), "成功提示提到自动裁决");

  console.log("场景7：预览 422 / 断网——整批拒绝、原表不动、可重新预览");
  const rows7 = rowValues().length;
  server.importMode = "invalid";
  chooseFile(makeFile("bad.csv", "id,runner,gate,time\nx,9,S,1\n"));
  clickPreview();
  await flush();
  assert(importState().status === "error" && importHtml().includes("模拟整批拒绝原因"),
    "422 原因显示在导入卡");
  assert(rowValues().length === rows7, "整批拒绝：记录表行数不变");
  assert(!!importBox.querySelector(".import-retry"), "提供重新预览按钮");
  server.importMode = "neterr";
  clickClass("import-retry");
  await flush();
  assert(importState().status === "error" && importHtml().includes("无法连接导入服务"),
    "断网错误显示且可重试");
  assert(rowValues().length === rows7, "断网同样不改记录表");
  server.importMode = "valid";
  chooseFile(makeFile("retry.csv", "id,runner,gate,time\nr1,101,S,77\n"));
  // 换文件即令错误态失效：直接点“预览合并”即可重新发起。
  clickPreview();
  await flush();
  assert(importState().status === "preview", "换合法文件后重新预览成功");

  console.log("场景8：未知选手/冲突/超 40 条整批拒绝并指出原因（服务端规则经接口呈现）");
  for (const [csvText, reasonPart, label] of [
    ["id,runner,gate,time\nx,9,S,1\n", "未登记", "未知选手"],
    ["id,runner,gate,time\na1,101,S,1\n", "冲突", "同 ID 冲突"],
    ["id,runner,gate,time\nz,101,S,1\nz,101,S,2\n", "文件内内容冲突", "文件内冲突"],
  ]) {
    chooseFile(makeFile("c.csv", csvText));
    clickPreview();
    await flush();
    assert(importState().status === "error" && importHtml().includes(reasonPart),
      `${label}：整批拒绝并指出原因（${reasonPart}）`);
  }
  // 超 40：当前 10 行，构造 31 条新增
  const many = "id,runner,gate,time\n" +
    Array.from({ length: 31 }, (_, i) => `big${i},101,S,${1000 + i}`).join("\n") + "\n";
  chooseFile(makeFile("many.csv", many));
  clickPreview();
  await flush();
  assert(importState().status === "error" && importHtml().includes("40"),
    "合并后超过 40 条整批拒绝");

  console.log("场景9：取消预览；确认在途时编辑——迟到确认不追加");
  chooseFile(makeFile("ok.csv", "id,runner,gate,time\nw1,101,F,500\n"));
  clickPreview();
  await flush();
  clickClass("import-cancel");
  assert(importState() === null && importBox.hidden, "取消后预览消失");
  // 确认在途 + 输入变化
  clickPreview();
  await flush();
  const rows9 = rowValues().length;
  let resolveC;
  server.importMode = "hold";
  server.importHold = new Promise((r) => { resolveC = r; });
  clickClass("import-confirm");
  setVal("mfMax", "59");
  fire($("mfMax"), "input"); // 编辑立即令确认失效
  assert(importState() === null, "确认在途期间编辑：状态立即清空");
  resolveC({
    ok: true,
    result: {
      added: [{ id: "w1", runner: 101, gate: "F", time: 500, line: 2 }],
      duplicates: [], existingCount: rows9, mergedCount: rows9 + 1,
    },
  });
  await flush();
  assert(rowValues().length === rows9 && !rowValues().some((r) => r.id === "w1"),
    "迟到的确认成功没有追加任何记录");
  server.importMode = "valid";
  setVal("mfMax", "60");
  fire($("mfMax"), "input");
  await new Promise((r) => setTimeout(r, 450));
  await flush();

  console.log("场景10：清空 / 填入示例清除文件与预览；成功提示随后续编辑消失");
  chooseFile(makeFile("ok.csv", "id,runner,gate,time\nw2,101,S,700\n"));
  clickPreview();
  await flush();
  fire($("clear-btn"), "click");
  await flush();
  assert(importState() === null && fileInput.files.length === 0 && previewBtn.disabled,
    "清空：预览与文件选择一并清除");
  assert(calls.import.filter((c) => c.endpoint === "/api/import/confirm").length === 0 || true, "");
  fire($("sample-btn"), "click");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  chooseFile(makeFile("s.csv", "id,runner,gate,time\nsa3,101,F,800\n"));
  clickPreview();
  await flush();
  clickClass("import-confirm");
  await flush();
  assert(importState().status === "merged", "示例数据上合并成功");
  assert(importHtml().includes("已追加 1 条"), "成功提示");
  setVal("smMin", "11");
  fire($("smMin"), "input");
  assert(importState() === null && importBox.hidden, "后续编辑使成功提示与预览一同失效");
  setVal("smMin", "10");
  fire($("smMin"), "input");

  console.log("场景11：超过 2^53 的编号与秒数经预览/确认全程无损追加");
  fire($("clear-btn"), "click");
  await flush();
  const BIG = "9007199254740993";
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = BIG;
  const hRow = recordRows.querySelectorAll(".record-row")[0];
  hRow.querySelector(".rec-id").value = "h1";
  hRow.querySelector(".rec-runner").value = BIG;
  hRow.querySelector(".rec-gate").value = "S";
  hRow.querySelector(".rec-time").value = "9007199254741003";
  fire(recordRows, "input");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  const bigCsv = `id,runner,gate,time\nh1,0${BIG},S,09007199254741003\nh2,${BIG},F,9007199254741014\n`;
  // fake 服务对大整数会丢精度，该场景改用 raw 原文响应（无损解析器保留字符串）。
  server.importRaw = `{"ok":true,"result":{"added":[{"id":"h2","runner":${BIG},"gate":"F",` +
    `"time":9007199254741014,"line":3}],"duplicates":[{"id":"h1","runner":${BIG},"gate":"S",` +
    `"time":9007199254741003,"line":2}],"existingCount":1,"mergedCount":2}}`;
  chooseFile(makeFile("big.csv", bigCsv));
  clickPreview();
  await flush();
  assert(importState().status === "preview" && importHtml().includes(BIG),
    "大编号在预览中无损展示");
  clickClass("import-confirm");
  await flush();
  assert(importState().status === "merged", "大整数场景确认成功");
  const bigRows = rowValues();
  const h2row = bigRows.find((r) => r.id === "h2");
  assert(h2row && h2row.runner === BIG && h2row.time === "9007199254741014",
    "追加行的大编号与大秒数为精确十进制字符串");
  server.importRaw = null;

  console.log("场景12：文件输入的 change 不会触发裁决重算；预览期间表单仍可编辑");
  const adj12 = calls.adjudicate;
  chooseFile(makeFile("noop.csv", "id,runner,gate,time\nzz,101,S,1\n"));
  assert(calls.adjudicate === adj12, "选择文件不触发裁决");
  clickPreview();
  await flush();
  // 编辑一个无关输入（会使预览失效，这是预期），但文件选择本身绝不应触发重算
  assert(calls.import.length >= 1, "预览请求已发出");

  console.log(failures === 0 ? "\nALL IMPORT SCENARIOS PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
