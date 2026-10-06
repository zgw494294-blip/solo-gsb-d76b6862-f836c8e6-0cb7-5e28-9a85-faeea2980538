/* 最小 DOM/事件 stub：加载真实 static/app.js，端到端验证“查找漏读”的生命周期。 */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------------- mini DOM（与其余生命周期测试同款桩） ---------------- */

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
    this.checked = false;
    this.hidden = false;
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
      if (el && el._contentStart !== undefined) {
        el._html = html.slice(el._contentStart, tok.index);
      }
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
const diagnosisBox = mk("diagnosis-box");
diagnosisBox.hidden = true;
const missingBox = mk("missing-box");
missingBox.hidden = true; // 真实 HTML 中带 hidden 属性
for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) mk(id, "input");
const sampleBtn = mk("sample-btn", "button");
const clearBtn = mk("clear-btn", "button");

for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) form.appendChild(byId.get(id));
form.appendChild(runnerRows);
form.appendChild(recordRows);

global.document = { getElementById: (id) => byId.get(id) };

/* ---------------- fetch stub：按 URL 分流裁决/诊断/漏读，可挂起/报错 ---------------- */

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
      unused: [
        { id: "x2", gate: "S", time: 30 },
        { id: "mX", gate: "M", time: 35 },
        { id: "z1", gate: "F", time: 300 },
      ],
    },
  ],
};

// 漏读窗口：缺 S（mX+z1，[0,5]）与缺 F（s3+m3 不在记录里也无妨——这里直接用
// 与记录一致的对，便于断言展示）。为贴合输入，用 x2/mX（缺 F）与 mX/z1（缺 S）。
const missingResult = {
  runners: [
    {
      runner: 101, lapCount: 2,
      windows: [
        { missingGate: "S", ids: ["mX", "z1"], timeMin: 0, timeMax: 25 },
        { missingGate: "F", ids: ["x2", "mX"], timeMin: 45, timeMax: 95 },
      ],
    },
  ],
};

const missingEmptyResult = {
  runners: [{ runner: 101, lapCount: 2, windows: [] }],
};

const server = {
  adjMode: "valid",       // valid | invalid | neterr | hold
  missMode: "valid",      // valid | invalid | neterr | hold | empty
  adjHold: null,
  missHold: null,
  missRaw: null,
};
const calls = { adjudicate: 0, diagnose: 0, missing: [] };

global.fetch = async (url, opts) => {
  const respond = (data, ok, status) => ({
    ok,
    status,
    json: async () => (typeof data === "string" ? JSON.parse(data) : data),
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  if (url === "/api/adjudicate") {
    calls.adjudicate += 1;
    JSON.parse(opts.body);
    if (server.adjMode === "neterr") throw new TypeError("模拟断网");
    if (server.adjMode === "invalid") {
      return respond({ ok: false, error: "模拟非法输入" }, false, 422);
    }
    if (server.adjMode === "hold") return respond(await server.adjHold, true, 200);
    return respond({ ok: true, result: adjudicateResult }, true, 200);
  }
  if (url === "/api/diagnose") {
    calls.diagnose += 1;
    return respond({ ok: true, result: { runners: [{ runner: 101, lapCount: 2, totalTime: 52, diagnoses: [] }] } }, true, 200);
  }
  if (url === "/api/missing") {
    calls.missing.push(JSON.parse(opts.body));
    if (server.missMode === "neterr") throw new TypeError("模拟断网");
    if (server.missMode === "invalid") {
      return respond({ ok: false, error: "模拟漏读拒绝" }, false, 422);
    }
    if (server.missMode === "hold") {
      return respond(await server.missHold, true, 200);
    }
    if (server.missMode === "empty") {
      return respond({ ok: true, result: missingEmptyResult }, true, 200);
    }
    if (server.missRaw !== null) return respond(server.missRaw, true, 200);
    return respond({ ok: true, result: missingResult }, true, 200);
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

function setRow(ids, runner, gate, time) {
  const rows = recordRows.querySelectorAll(".record-row");
  for (const row of rows) {
    if (row.querySelector(".rec-id").value === "") {
      row.querySelector(".rec-id").value = ids;
      row.querySelector(".rec-runner").value = runner;
      row.querySelector(".rec-gate").value = gate;
      row.querySelector(".rec-time").value = time;
      return row;
    }
  }
  throw new Error("no empty row");
}

const missState = () => globalThis.__getMissingStateForTest();
const missHtml = () => missingBox.innerHTML;
function clickMissing() {
  const btn = missingBox.querySelector(".missing-run") ||
    missingBox.querySelector(".missing-rerun");
  assert(btn, "漏读按钮存在");
  fire(btn, "click");
  return btn;
}
async function adjudicate() { fire(form, "submit"); await flush(); }

async function setupValid(extraRecordRows = 7) {
  setVal("smMin", "10"); setVal("smMax", "60");
  setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = "101";
  // 初始页面有 2 空行（需补 7 行）；“清空”后只有 1 空行（需补 8 行），共 9 行。
  for (let i = 0; i < extraRecordRows; i++) fire(addRecord, "click");
  const rows = [
    ["a1", "101", "S", "0"], ["b1", "101", "M", "12"], ["c1", "101", "F", "25"],
    ["a2", "101", "S", "30"], ["b2", "101", "M", "45"], ["c2", "101", "F", "57"],
    ["x2", "101", "S", "30"], ["mX", "101", "M", "35"], ["z1", "101", "F", "300"],
  ];
  for (const [i, r, g, t] of rows) setRow(i, r, g, t);
  await adjudicate();
}

async function main() {
  console.log("场景0：初始无结果时漏读卡隐藏，无按钮可点");
  assert(missingBox.hidden, "无裁决结果时漏读卡隐藏");

  await setupValid();
  console.log("场景1：合法裁决后出现“查找漏读”按钮，且不自动发漏读请求");
  assert(!missingBox.hidden, "合法结果后漏读卡显示");
  assert(missHtml().includes("查找漏读"), "显示查找漏读按钮");
  assert(missState().status === "idle", "状态为 idle");
  assert(calls.missing.length === 0, "裁决不会自动调用漏读接口");
  assert(results.innerHTML.includes("a1") && results.innerHTML.includes("a2"), "采纳结果正常展示");

  console.log("场景2：点击后发 POST /api/missing，载荷为当前完整裁决输入");
  clickMissing();
  assert(missState().status === "loading", "点击后立即进入 loading");
  assert(missHtml().includes("推测漏读时间窗"), "loading 态渲染");
  await flush();
  assert(missState().status === "done", "成功后 done");
  assert(calls.missing.length === 1, "恰好发出一次漏读请求");
  const body = calls.missing[0];
  assert(body.standards.smMin === "10" && body.runners[0].number === "101",
    "漏读请求体即当前完整裁决输入");
  assert(body.records.length === 9, "漏读请求包含全部记录行");

  console.log("场景3：窗口按 缺失门 S/M/F 排序渲染，含两条 ID 与闭区间");
  const html = missHtml();
  assert(html.includes("共找到 <strong>2</strong> 个漏读窗口"), "显示窗口总数");
  const pS = html.indexOf("补 起点 S 读数");
  const pF = html.indexOf("补 终点 F 读数");
  assert(pS !== -1 && pF !== -1 && pS < pF, "缺失门按 S 在 F 前排序");
  assert(html.includes("中途门 M · mX") && html.includes("终点 F · z1"), "缺 S 窗口的两条记录");
  assert(html.includes("起点 S · x2"), "缺 F 窗口的起点记录");
  assert(html.includes("0 ～ 25 秒") && html.includes("45 ～ 95 秒"), "闭区间端点展示");
  assert(html.includes("选手 101 · 当前 2 次 · 补 1 条即可 3 次"), "选手头展示当前与可达次数");
  assert(html.includes("不追加记录"), "标注只读提示");
  // 采纳结果区未被漏读改动
  assert(results.innerHTML.includes("a2") && !results.innerHTML.includes("漏读窗口"),
    "采纳结果区不受漏读影响");

  console.log("场景4：无解时明确提示");
  server.missMode = "empty";
  clickMissing(); // done 态“重新查找”
  await flush();
  assert(missState().status === "done", "无解查询完成");
  assert(missHtml().includes("无解"), "明确提示无解");
  assert(missHtml().includes("任何两条不同门记录都无法"), "无解原因说明");
  assert(!missHtml().includes("选手 101 · 当前"), "无解时不逐选手展开");
  server.missMode = "valid";
  clickMissing();
  await flush();
  assert(missHtml().includes("共找到"), "恢复有解展示");

  console.log("场景5：输入一改立即清除，非法/重算期间不可查询，新结果需重新查询");
  setVal("smMin", "");
  fire($("smMin"), "input");
  assert(missingBox.hidden, "输入一改漏读卡立即隐藏");
  assert(missState().status === "idle" && missHtml() === "", "漏读状态与内容清除");
  server.adjMode = "invalid";
  await adjudicate();
  assert(missingBox.hidden, "非法输入期间漏读卡保持隐藏（不可查询）");
  assert(missingBox.querySelector(".missing-run") === undefined, "非法期间没有查询按钮");
  setVal("smMin", "10");
  fire($("smMin"), "input"); // 防抖重算在途
  assert(missingBox.hidden, "重算期间漏读卡隐藏");
  server.adjMode = "valid";
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  assert(!missingBox.hidden && missState().status === "idle",
    "新合法结果到达后恢复 idle，需重新查询（旧窗口不恢复）");
  assert(!missHtml().includes("45 ～ 95 秒"), "旧窗口内容未随重算恢复");

  console.log("场景6：迟到的漏读成功不得覆盖新输入状态");
  let resolveHold;
  server.missMode = "hold";
  server.missHold = new Promise((res) => { resolveHold = res; });
  clickMissing();
  assert(missState().status === "loading", "再次查询进入 loading");
  assert(missingBox.querySelector(".missing-run") === undefined, "loading 态没有可点按钮");
  const inFlight = calls.missing.length;
  $("smMax").value = "61";
  fire($("smMax"), "input");
  assert(missingBox.hidden, "输入改变后漏读卡隐藏");
  resolveHold({ ok: true, result: missingResult });
  await flush();
  assert(missingBox.hidden, "迟到的成功响应没有让漏读卡重新出现");
  assert(calls.missing.length === inFlight, "loading 期间未发出额外请求");
  server.missMode = "valid";

  console.log("场景7：漏读 422 只在漏读卡报错，采纳结果/错误框不受影响，可重试");
  $("smMax").value = "60";
  fire($("smMax"), "input");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  assert(missState().status === "idle", "重算完成后回到 idle");
  server.missMode = "invalid";
  globalThis.__runMissingForTest();
  await flush();
  assert(missState().status === "error", "漏读 422 → error 态");
  assert(missHtml().includes("模拟漏读拒绝"), "漏读卡显示服务端原因");
  assert(results.innerHTML.includes("a2"), "采纳结果仍在（未被漏读失败清掉）");
  assert($("error-box").hidden, "主错误框不显示漏读错误");
  server.missMode = "valid";
  clickMissing(); // 错误态“重试查找”
  await flush();
  assert(missState().status === "done" && missHtml().includes("共找到"), "重试后恢复成功");

  console.log("场景8：非迟到的网络失败可展示并重试；迟到失败不覆盖新状态");
  server.missMode = "neterr";
  globalThis.__runMissingForTest(); // done 态“重新查找”
  await flush();
  assert(missState().status === "error" && missHtml().includes("无法连接漏读服务"),
    "非迟到网络失败显示在漏读卡");
  server.missMode = "valid";
  globalThis.__runMissingForTest();
  await flush();
  assert(missState().status === "done", "重试成功");
  // 迟到失败：挂起 → 输入改变 → 以断网失败
  let resolveHold2;
  server.missMode = "hold";
  server.missHold = new Promise((res) => { resolveHold2 = res; });
  globalThis.__runMissingForTest();
  $("mfMax").value = "59";
  fire($("mfMax"), "input");
  assert(missingBox.hidden, "输入变更后漏读卡隐藏");
  resolveHold2(Promise.reject(new TypeError("模拟断网迟到")));
  await flush();
  assert(missingBox.hidden, "迟到的失败响应没有覆盖新状态");
  server.missMode = "valid";
  $("mfMax").value = "60";
  fire($("mfMax"), "input");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  assert(missState().status === "idle", "新合法结果后恢复 idle");

  console.log("场景9：清空 / 填入示例清除漏读且不残留、不发请求");
  clickMissing();
  await flush();
  assert(missState().status === "done", "前置：查询完成");
  fire(clearBtn, "click");
  await flush();
  assert(missingBox.hidden && missHtml() === "", "清空后漏读卡隐藏并清空");
  const missCallsAtClear = calls.missing.length;
  fire(sampleBtn, "click");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  assert(!missingBox.hidden && missState().status === "idle",
    "填入示例重算后漏读为初始 idle（旧窗口清除）");
  assert(calls.missing.length === missCallsAtClear, "示例/清空本身不发起漏读请求");

  console.log("场景10：输入未变的手动重算——开始即清除并禁止查询，完成后恢复入口");
  fire(clearBtn, "click");
  await flush();
  await setupValid(8); // 清空后只剩 1 空记录行，补 8 行共 9 行
  clickMissing();
  await flush();
  assert(missState().status === "done", "前置：漏读查询已完成");
  let resolveAdj;
  server.adjMode = "hold";
  server.adjHold = new Promise((res) => { resolveAdj = res; });
  const missCallsBeforeRecompute = calls.missing.length;
  fire(form, "submit");
  assert(missingBox.hidden, "重算开始：漏读卡立即隐藏（禁止查询）");
  assert(missState().status === "idle" && missHtml() === "", "重算开始：旧窗口已清除");
  assert(missingBox.querySelector(".missing-run") === undefined, "重算期间没有查询按钮");
  globalThis.__runMissingForTest(); // 绕过界面也发不出
  await flush();
  assert(calls.missing.length === missCallsBeforeRecompute, "重算期间不会发出漏读请求");
  assert(results.innerHTML.includes("a2"), "重算等待期间原采纳结果仍展示");
  resolveAdj({ ok: true, result: adjudicateResult });
  await flush();
  server.adjMode = "valid";
  assert(!missingBox.hidden && missState().status === "idle",
    "最新合法裁决完成后恢复可查询入口");
  assert(missHtml().includes("查找漏读"), "恢复后显示查找按钮");
  assert(!missHtml().includes("45 ～ 95 秒"), "旧窗口内容未随重算恢复");

  console.log("场景11：重算前发出的漏读 M1 迟到（成功/服务错误/断网）不得覆盖重算后状态");
  // 11a：M1 挂起 → 手动重算 → M2 完成 → M1 迟到成功被丢弃
  server.missMode = "hold";
  let resolveM1;
  server.missHold = new Promise((res) => { resolveM1 = res; });
  clickMissing();
  assert(missState().status === "loading", "M1 在途（loading）");
  fire(form, "submit"); // 输入未变的手动重算：M1 即刻作废
  await flush();
  assert(missState().status === "idle", "重算后漏读回到 idle（M1 在途状态被清除）");
  server.missMode = "valid";
  clickMissing(); // M2
  await flush();
  assert(missState().status === "done", "M2 完成");
  const m2Html = missHtml();
  resolveM1({ ok: true, result: { runners: [{ runner: 101, lapCount: 2, windows: [
    { missingGate: "F", ids: ["M1LATE", "mX"], timeMin: 1, timeMax: 2 }] }] } });
  await flush();
  assert(missState().status === "done" && missHtml() === m2Html, "M1 迟到成功未改写 M2");
  assert(!missHtml().includes("M1LATE"), "M1 的结果没有重新显示");
  // 11b：M1' 挂起 → 手动重算 → 迟到服务错误不得显示
  server.missMode = "hold";
  let resolveM1b;
  server.missHold = new Promise((res) => { resolveM1b = res; });
  clickMissing();
  assert(missState().status === "loading", "M1' 在途（loading）");
  fire(form, "submit");
  await flush();
  resolveM1b({ ok: false, error: "M1迟到服务错误" });
  await flush();
  assert(missState().status === "idle", "M1' 迟到的服务错误未显示（保持 idle）");
  assert(!missHtml().includes("M1迟到服务错误"), "服务错误内容未出现");
  // 11c：M1'' 挂起 → 手动重算 → 迟到断网不得显示
  server.missMode = "hold";
  let resolveM1c;
  server.missHold = new Promise((res) => { resolveM1c = res; });
  clickMissing();
  assert(missState().status === "loading", "M1'' 在途（loading）");
  fire(form, "submit");
  await flush();
  resolveM1c(Promise.reject(new TypeError("M1迟到断网")));
  await flush();
  assert(missState().status === "idle", "M1'' 迟到断网未显示错误");
  assert(!missHtml().includes("无法连接漏读服务"), "断网错误未出现");
  server.missMode = "valid";

  console.log("场景12：手动重算失败（非法/断网）时保持不可查询，旧窗口不恢复");
  clickMissing();
  await flush();
  assert(missState().status === "done", "前置：查询完成");
  server.adjMode = "invalid";
  fire(form, "submit");
  await flush();
  assert(!$("error-box").hidden, "重算 422：错误框显示");
  assert(missingBox.hidden && missHtml() === "", "重算 422：漏读卡保持隐藏，旧窗口不恢复");
  const missCallsAtFail = calls.missing.length;
  globalThis.__runMissingForTest();
  await flush();
  assert(calls.missing.length === missCallsAtFail, "裁决失败期间不会发出漏读请求");
  server.adjMode = "neterr";
  fire(form, "submit");
  await flush();
  assert(missingBox.hidden && missingBox.querySelector(".missing-run") === undefined,
    "重算断网：漏读卡保持隐藏，不可查询");
  server.adjMode = "valid";
  fire(form, "submit");
  await flush();
  assert(!missingBox.hidden && missState().status === "idle", "重新裁决成功后恢复可查询入口");

  console.log("场景13：漏读只读——复核、罚秒、名次与诊断均不受影响");
  // 保存复核与罚秒
  const box = results.querySelectorAll(".review-box")[0];
  for (const r of box.querySelectorAll('input[type="radio"]')) r.checked = r.value === "pass";
  box.querySelector(".review-note").value = "漏读只读复核";
  fire(box.querySelector(".review-save"), "click");
  const ed = results.querySelectorAll(".penalty-editor")[0];
  ed.querySelector(".penalty-seconds").value = "3";
  ed.querySelector(".penalty-reason").value = "设备故障";
  fire(ed.querySelector(".penalty-save"), "click");
  const resultsSnapshot = results.innerHTML;
  clickMissing();
  await flush();
  assert(missState().status === "done", "漏读查询完成");
  assert(results.innerHTML === resultsSnapshot, "漏读只读：复核、罚秒与名次不受影响");
  // 复核/罚秒的回显在子元素上（mini-DOM 不回写父级 innerHTML 字符串），逐元素核对。
  assert(
    results.querySelector(".review-current").innerHTML.includes("漏读只读复核") &&
      results.querySelector(".penalty-current").innerHTML.includes("当前已保存：3 秒"),
    "复核与罚秒保持原样");
  // 诊断入口与漏读互不影响
  assert(!diagnosisBox.hidden, "诊断卡仍可用");
  globalThis.__runDiagnosisForTest();
  await flush();
  assert(globalThis.__getDiagnosisStateForTest().status === "done", "诊断可独立完成");
  assert(missState().status === "done" && missHtml().includes("共找到"), "诊断不影响漏读窗口");

  console.log("场景14：超过 2^53 的编号与秒数：漏读卡精确渲染，不被 Number 截断");
  const BIG = "9007199254740993";
  fire(clearBtn, "click");
  await flush();
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = BIG;
  fire(runnerRows, "input");
  for (let i = 0; i < 4; i++) fire(addRecord, "click"); // 共 5 行记录
  const TS = "9007199254740992", TM = "9007199254741003", TF = "9007199254741014";
  setRow("h1", BIG, "S", TS);
  setRow("h2", BIG, "M", TM);
  setRow("h3", BIG, "F", TF);
  const adjRaw = `{"ok":true,"result":{"runners":[{"runner":${BIG},"lapCount":1,"totalTime":22,` +
    `"laps":[{"start":{"id":"h1","time":${TS}},"middle":{"id":"h2","time":${TM}},` +
    `"finish":{"id":"h3","time":${TF}},"smTime":11,"mfTime":11,"totalTime":22}],` +
    `"unused":[]}]}}`;
  server.adjMode = "hold";
  server.adjHold = Promise.resolve(adjRaw);
  fire(form, "submit");
  await flush();
  server.adjMode = "valid";
  server.missRaw = `{"ok":true,"result":{"runners":[{"runner":${BIG},"lapCount":1,` +
    `"windows":[{"missingGate":"F","ids":["h1","h2"],` +
    `"timeMin":${TM},"timeMax":${TF}}]}]}}`;
  globalThis.__runMissingForTest();
  await flush();
  assert(missHtml().includes(`选手 ${BIG}`), "漏读卡精确显示大编号");
  assert(missHtml().includes(`${TM} ～ ${TF} 秒`), "区间端点精确显示超大秒数");
  assert(calls.missing[calls.missing.length - 1].runners[0].number === BIG,
    "漏读请求中的大编号以十进制字符串原样发送");
  server.missRaw = null;

  console.log(failures === 0 ? "\nALL MISSING SCENARIOS PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
