/* 最小 DOM/事件 stub：加载真实 static/app.js，端到端验证“成绩公告”发布卡的生命周期。 */
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
missingBox.hidden = true;
const bulletinBox = mk("bulletin-box");
bulletinBox.hidden = true; // 真实 HTML 中带 hidden 属性，由 app.js 首次绘制后显示
for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) mk(id, "input");
const sampleBtn = mk("sample-btn", "button");
const clearBtn = mk("clear-btn", "button");

for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) form.appendChild(byId.get(id));
form.appendChild(runnerRows);
form.appendChild(recordRows);

global.document = { getElementById: (id) => byId.get(id) };

/* ---------------- fetch stub：裁决 + 公告发布，可挂起/报错/冲突 ---------------- */

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

const server = {
  adjMode: "valid",   // valid | invalid | neterr | hold
  bulMode: "ok",      // ok | conflict | invalid | neterr | hold
  adjHold: null,
  bulHold: null,
};
const calls = { adjudicate: 0, bulletin: [] };

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
  if (url === "/api/bulletins/publish") {
    const body = JSON.parse(opts.body);
    calls.bulletin.push(body);
    if (server.bulMode === "neterr") throw new TypeError("模拟断网");
    if (server.bulMode === "hold") return respond(await server.bulHold, true, 200);
    if (server.bulMode === "conflict") {
      return respond(
        {
          ok: false,
          error: "公告版本已变化：当前最新版本为 3，本次未发布；请基于最新版本重新发布",
          currentVersion: 3,
        },
        false,
        409
      );
    }
    if (server.bulMode === "invalid") {
      return respond(
        { ok: false, error: "选手 101 的第 1 趟复核须为“通过”才能发布" },
        false,
        422
      );
    }
    // 模拟真实服务端：版本匹配时保存为 baseVersion + 1 并返回公告链接。
    const v = (body.baseVersion || 0) + 1;
    return respond(
      {
        ok: true,
        result: {
          number: body.number,
          version: v,
          url: `/api/bulletins/${encodeURIComponent(body.number)}?version=${v}`,
        },
      },
      true,
      200
    );
  }
  if (url === "/api/diagnose") {
    return respond({ ok: true, result: { runners: [{ runner: 101, lapCount: 2, totalTime: 52, diagnoses: [] }] } }, true, 200);
  }
  if (url === "/api/missing") {
    return respond({ ok: true, result: { runners: [{ runner: 101, lapCount: 2, windows: [] }] } }, true, 200);
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

const bulState = () => globalThis.__getBulletinStateForTest();
const bulVersions = () => globalThis.__bulletinVersionsForTest;
const bulHtml = () => bulletinBox.innerHTML;

function clickPublish() {
  const btn = bulletinBox.querySelector(".bulletin-publish");
  assert(btn, "发布按钮存在");
  fire(btn, "click");
  return btn;
}
function setBulletinNumber(v) {
  const input = bulletinBox.querySelector(".bulletin-number");
  input.value = v;
  fire(input, "input");
}
async function adjudicate() { fire(form, "submit"); await flush(); }

function saveReview(idx, status, note) {
  const box = results.querySelectorAll(".review-box")[idx];
  for (const r of box.querySelectorAll('input[type="radio"]')) r.checked = r.value === status;
  box.querySelector(".review-note").value = note;
  fire(box.querySelector(".review-save"), "click");
}
function saveAllReviews() {
  saveReview(0, "pass", "第一趟无误");
  saveReview(1, "pass", "");
}
function savePenalty() {
  const ed = results.querySelectorAll(".penalty-editor")[0];
  ed.querySelector(".penalty-seconds").value = "5";
  ed.querySelector(".penalty-reason").value = "设备故障";
  fire(ed.querySelector(".penalty-save"), "click");
}

async function setupValid(extraRecordRows = 5) {
  setVal("smMin", "10"); setVal("smMax", "60");
  setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = "101";
  for (let i = 0; i < extraRecordRows; i++) fire(addRecord, "click");
  const rows = [
    ["a1", "101", "S", "0"], ["b1", "101", "M", "12"], ["c1", "101", "F", "25"],
    ["a2", "101", "S", "30"], ["b2", "101", "M", "45"], ["c2", "101", "F", "57"],
    ["x2", "101", "S", "30"],
  ];
  for (const [i, r, g, t] of rows) setRow(i, r, g, t);
  await adjudicate();
}

async function main() {
  console.log("场景0：公告卡独立常驻，初始即显示发布入口，且不发任何请求");
  assert(!bulletinBox.hidden, "初始公告卡即显示（独立于裁决结果）");
  assert(bulHtml().includes("发布成绩公告"), "显示发布按钮");
  assert(bulletinBox.querySelector(".bulletin-number"), "公告编号输入框存在");
  assert(bulState().status === "idle", "初始状态 idle");
  assert(calls.bulletin.length === 0, "初始不发发布请求");

  console.log("场景1：公告编号为空时客户端拦截，不发请求；输入非法也不影响公告卡");
  clickPublish();
  await flush();
  assert(bulState().status === "error", "空编号 → error 态");
  assert(bulHtml().includes("公告编号不能为空"), "提示编号非空");
  assert(calls.bulletin.length === 0, "空编号不发请求");
  setVal("smMin", "");
  fire($("smMin"), "input");
  assert(!bulletinBox.hidden, "赛道输入非法期间公告卡仍独立显示");
  setVal("smMin", "10");

  await setupValid();
  console.log("场景2：点击时快照提交完整输入、复核与罚秒，首次所见版本为 0");
  saveAllReviews();
  savePenalty();
  setBulletinNumber("2026-001");
  clickPublish();
  assert(bulState().status === "loading", "点击后立即 loading");
  await flush();
  assert(bulState().status === "done", "发布成功 done");
  assert(calls.bulletin.length === 1, "恰好一次发布请求");
  const body1 = calls.bulletin[0];
  assert(body1.number === "2026-001", "提交公告编号");
  assert(body1.baseVersion === 0, "首次所见版本为 0");
  assert(body1.input.standards.smMin === "10" && body1.input.runners[0].number === "101",
    "快照含完整裁决输入");
  assert(body1.input.records.length === 7, "快照含全部记录行");
  assert(Array.isArray(body1.input.excludedIds) && body1.input.excludedIds.length === 0,
    "无隔离时 excludedIds 为空数组");
  assert(body1.reviews.length === 2, "快照含两趟复核");
  const rv = body1.reviews[0];
  assert(rv.runner === "101" && rv.status === "pass" && rv.note === "第一趟无误",
    "复核含选手、状态与备注");
  assert(
    rv.records[0].id === "a1" && rv.records[0].gate === "S" && rv.records[0].time === "0" &&
    rv.records[1].id === "b1" && rv.records[1].gate === "M" && rv.records[1].time === "12" &&
    rv.records[2].id === "c1" && rv.records[2].gate === "F" && rv.records[2].time === "25",
    "复核含三条记录的 ID/门/秒数");
  assert(body1.penalties.length === 1 && body1.penalties[0].runner === "101" &&
    body1.penalties[0].seconds === 5 && body1.penalties[0].reason === "设备故障",
    "快照含已保存罚秒与原因");
  assert(bulHtml().includes("已发布为版本 1"), "显示已发布版本 1");
  assert(bulHtml().includes("/api/bulletins/2026-001?version=1"), "显示公告链接");
  assert(bulletinBox.querySelector(".bulletin-link"), "链接可点击");
  assert(bulVersions().get("2026-001") === 1, "所见版本更新为 1");
  assert(bulletinBox.querySelector(".bulletin-number").value === "2026-001",
    "重绘后编号输入框保留原值");

  console.log("场景3：再次发布同一编号基于已见版本 1");
  clickPublish();
  await flush();
  assert(calls.bulletin.length === 2 && calls.bulletin[1].baseVersion === 1,
    "第二次发布 baseVersion 为 1");
  assert(bulHtml().includes("已发布为版本 2"), "发布为版本 2");
  assert(bulVersions().get("2026-001") === 2, "所见版本更新为 2");

  console.log("场景4：409 过期 → 采用服务端当前版本，再次发布成功");
  server.bulMode = "conflict";
  clickPublish();
  await flush();
  assert(bulState().status === "error", "409 → error 态");
  assert(bulHtml().includes("版本已变化"), "显示冲突原因");
  assert(bulVersions().get("2026-001") === 3, "所见版本采用服务端 currentVersion 3");
  server.bulMode = "ok";
  clickPublish();
  await flush();
  assert(calls.bulletin[calls.bulletin.length - 1].baseVersion === 3,
    "再次发布基于最新版本 3");
  assert(bulState().status === "done" && bulHtml().includes("已发布为版本 4"),
    "冲突后再次发布成功（版本 4）");

  console.log("场景5：422 与断网只在公告卡内报错");
  server.bulMode = "invalid";
  clickPublish();
  await flush();
  assert(bulState().status === "error", "422 → error 态");
  assert(bulHtml().includes("须为“通过”才能发布"), "显示服务端校验原因");
  assert($("error-box").hidden, "主错误框不显示发布错误");
  server.bulMode = "neterr";
  clickPublish();
  await flush();
  assert(bulState().status === "error" && bulHtml().includes("无法连接公告服务"),
    "断网 → 显示无法连接");
  server.bulMode = "ok";
  clickPublish();
  await flush();
  assert(bulState().status === "done", "恢复后可重新发布成功");

  console.log("场景6：发布响应不改写编辑区、结果区、复核与罚秒");
  const resultsSnapshot = results.innerHTML;
  const reviewCurrent = results.querySelectorAll(".review-current")[0].innerHTML;
  const penaltyCurrent = results.querySelector(".penalty-current").innerHTML;
  const smMinValue = $("smMin").value;
  clickPublish();
  await flush();
  assert(bulState().status === "done", "前置：再次发布成功");
  assert(results.innerHTML === resultsSnapshot, "结果区未被发布响应改写");
  assert(results.querySelectorAll(".review-current")[0].innerHTML === reviewCurrent,
    "复核回显不变");
  assert(results.querySelector(".penalty-current").innerHTML === penaltyCurrent,
    "罚秒回显不变");
  assert($("smMin").value === smMinValue && $("smMin").value === "10", "编辑区输入不变");
  assert(recordRows.querySelectorAll(".record-row").length === 7, "记录行数不变");

  console.log("场景7：loading 期间按钮禁用，重复点击与直接调用都不再发请求");
  let resolveBul;
  server.bulMode = "hold";
  server.bulHold = new Promise((res) => { resolveBul = res; });
  clickPublish();
  assert(bulState().status === "loading", "进入 loading");
  const inFlight = calls.bulletin.length;
  const btn = bulletinBox.querySelector(".bulletin-publish");
  assert(btn.attrs.disabled === true, "loading 时按钮禁用");
  assert(bulletinBox.querySelector(".bulletin-number").attrs.disabled === true,
    "loading 时编号输入禁用");
  fire(btn, "click");
  globalThis.__runBulletinPublishForTest();
  await flush();
  assert(calls.bulletin.length === inFlight, "loading 期间不再发新请求");
  resolveBul({
    ok: true,
    result: { number: "2026-001", version: 9, url: "/api/bulletins/2026-001?version=9" },
  });
  await flush();
  server.bulMode = "ok";
  assert(bulState().status === "done" && bulHtml().includes("已发布为版本 9"),
    "挂起的发布完成后显示结果");
  assert(bulVersions().get("2026-001") === 9, "所见版本更新为 9");

  console.log("场景8：在途时输入变更——迟到成功只落在公告卡，不改写编辑区");
  let resolveBul2;
  server.bulMode = "hold";
  server.bulHold = new Promise((res) => { resolveBul2 = res; });
  clickPublish();
  assert(bulState().status === "loading", "再次进入 loading");
  $("smMax").value = "61";
  fire($("smMax"), "input"); // 输入变更：清除旧结果并触发防抖重算
  assert(results.innerHTML === "", "输入变更后旧结果已清除");
  resolveBul2({
    ok: true,
    result: { number: "2026-001", version: 10, url: "/api/bulletins/2026-001?version=10" },
  });
  await flush();
  server.bulMode = "ok";
  assert(bulState().status === "done" && bulHtml().includes("已发布为版本 10"),
    "迟到的发布成功仍只在公告卡展示（公告是历史事实）");
  assert(results.innerHTML === "", "发布响应没有恢复/改写结果区");
  assert(bulVersions().get("2026-001") === 10, "所见版本更新为 10");
  // 恢复输入并等待自动重算（复核已按绑定规则失效，后续场景重新保存）。
  $("smMax").value = "60";
  fire($("smMax"), "input");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  assert(results.innerHTML.includes("a1"), "自动重算恢复结果");

  console.log("场景9：存疑复核按原样提交，服务端 422 原因展示在公告卡");
  saveAllReviews();
  saveReview(0, "doubt", "起点存疑");
  const before9 = calls.bulletin.length;
  clickPublish();
  await flush();
  const body9 = calls.bulletin[before9];
  assert(body9.reviews.some((r) => r.status === "doubt" && r.note === "起点存疑"),
    "存疑复核原样进入快照");
  // 本桩 ok 模式不校验内容；改由 422 桩验证服务端拒绝的展示
  server.bulMode = "invalid";
  clickPublish();
  await flush();
  assert(bulState().status === "error" && bulHtml().includes("须为“通过”才能发布"),
    "服务端拒绝原因展示在公告卡");
  server.bulMode = "ok";
  saveReview(0, "pass", "第一趟无误");

  console.log("场景10：隔离记录随快照提交（excludedIds）");
  const row = [...recordRows.querySelectorAll(".record-row")]
    .find((r) => r.querySelector(".rec-id").value === "x2");
  fire(row.querySelector(".toggle-exclude"), "click");
  const before10 = calls.bulletin.length;
  clickPublish();
  await flush();
  const body10 = calls.bulletin[before10];
  assert(Array.isArray(body10.input.excludedIds) && body10.input.excludedIds.includes("x2"),
    "快照的 excludedIds 含被隔离记录");
  fire(row.querySelector(".toggle-exclude"), "click"); // 重新纳入
  await new Promise((r) => setTimeout(r, 450));
  await flush();

  console.log("场景11：超过 2^53 的编号与秒数在发布快照中全程精确");
  const BIG = "9007199254740993";
  fire(clearBtn, "click");
  await flush();
  assert(!bulletinBox.hidden, "清空后公告卡仍独立显示");
  setVal("smMin", "10"); setVal("smMax", "60");
  setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = BIG;
  for (let i = 0; i < 2; i++) fire(addRecord, "click");
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
  saveReview(0, "pass", "大数复核");
  setBulletinNumber(BIG);
  const before11 = calls.bulletin.length;
  clickPublish();
  await flush();
  const body11 = calls.bulletin[before11];
  assert(body11.number === BIG, "公告编号为大数字符串，精确提交");
  assert(body11.input.runners[0].number === BIG, "大编号选手精确提交");
  assert(body11.reviews[0].runner === BIG, "复核选手大编号精确");
  assert(body11.reviews[0].records[1].time === TM, "复核记录秒数超过 2^53 仍精确");
  assert(body11.reviews[0].records[0].time === TS, "起点大秒数精确");
  assert(bulState().status === "done", "大编号公告发布成功");
  assert(bulHtml().includes(`/api/bulletins/${BIG}?version=1`), "公告链接含精确大编号");
  assert(bulVersions().get(BIG) === 1, "大编号公告的所见版本独立追踪");

  console.log(failures === 0 ? "\nALL BULLETIN SCENARIOS PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
