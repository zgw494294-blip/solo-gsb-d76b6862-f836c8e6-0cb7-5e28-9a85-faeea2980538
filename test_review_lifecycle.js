/* 最小 DOM/事件 stub：加载真实 static/app.js，端到端验证复核即时失效逻辑。 */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------------- mini DOM ---------------- */

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
    if (html === "") this.children = [];
    // 结果区写入的是渲染字符串（测试直接断言其内容），不解析。
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
    // evt.target 始终是派发事件的元素；listener 的 this 沿冒泡链路变化。
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
    if (closing) { stack.pop(); continue; }
    const el = new El(tag);
    const attrRe = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    const attrSrc = t.slice(1 + tag.length, selfClose ? -2 : t.endsWith(">") ? -1 : t.length);
    void attrSrc;
    const raw = t.replace(/^<\/?[\w-]+/, "").replace(/\/?>$/, "");
    while ((am = attrRe.exec(raw))) {
      const [, k, v] = am;
      if (!k || k === "/") continue;
      if (v === undefined) { el.attrs[k] = true; continue; }
      el.attrs[k] = v;
      if (k === "class") v.split(/\s+/).forEach((c) => c && el.classList.add(c));
      else if (k === "id") el.id = v;
      else if (k.startsWith("data-")) el.dataset[k.slice(5)] = v;
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = true;
      else if (k === "hidden") el.hidden = true;
      else if (k === "name") el.name = v;
      else if (k === "type") el.type = v;
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
  }
  return root.children;
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
mk("diagnosis-box");
for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) mk(id, "input");
mk("sample-btn", "button"); mk("clear-btn", "button");

// 静态层级：所有控件挂在 form 下，输入事件可冒泡到 form 监听器（与真实 DOM 一致）。
for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) form.appendChild(byId.get(id));
form.appendChild(runnerRows);
form.appendChild(recordRows);

global.document = {
  getElementById: (id) => byId.get(id),
};

/* ---------------- fetch stub（可切换：合法 / 422 / 挂起） ---------------- */

function lap(runner, s, m, f, st, mt, ft) {
  return {
    start: { id: s, time: st }, middle: { id: m, time: mt }, finish: { id: f, time: ft },
    smTime: mt - st, mfTime: ft - mt, totalTime: ft - st,
  };
}
const validResult = {
  runners: [
    { runner: 101, lapCount: 1, totalTime: 22, laps: [lap(101, "a1", "b1", "c1", 0, 12, 22)], unused: [] },
  ],
};
const twoLapResult = {
  runners: [
    { runner: 101, lapCount: 1, totalTime: 22, laps: [lap(101, "a1", "b1", "c1", 0, 12, 22)], unused: [] },
    { runner: 102, lapCount: 1, totalTime: 20, laps: [lap(102, "d1", "e1", "f1", 5, 15, 25)], unused: [] },
  ],
};

const server = { mode: "valid", result: validResult, hold: null, raw: null };
global.fetch = async (_url, opts) => {
  JSON.parse(opts.body); // 前端始终发送合法 JSON
  // raw：直接以原文返回，模拟后端精确输出的大整数编号（JSON 数字可超过 2^53）。
  const respond = (data, ok, status) => ({
    ok,
    status,
    json: async () => (typeof data === "string" ? JSON.parse(data) : data),
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  if (server.mode === "invalid") {
    return respond({ ok: false, error: "模拟非法输入" }, false, 422);
  }
  if (server.mode === "hold") {
    return respond(await server.hold, true, 200);
  }
  if (server.raw !== null) {
    return respond(server.raw, true, 200);
  }
  return respond({ ok: true, result: server.result }, true, 200);
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
async function flush(n = 5) { for (let i = 0; i < n; i++) await tick(); }

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
function findRow(id) {
  return recordRows.querySelectorAll(".record-row").find((r) => r.querySelector(".rec-id").value === id);
}
function removeRow(id) {
  const row = findRow(id);
  fire(row.querySelector(".remove-record"), "click");
}
function rowOf(id) { return findRow(id); }

// 通过真实的 resultsBox click 监听保存复核。
function saveReview(keyIndex, status, note) {
  const box = new El("div");
  box.classList.add("review-box");
  box.dataset.keyIndex = String(keyIndex);
  const radio = { value: status };
  const noteEl = { value: note };
  const errEl = { hidden: false, textContent: "" };
  const current = { innerHTML: "" };
  box.querySelector = (sel) => {
    if (sel === "input[type=radio]:checked") return radio;
    if (sel === ".review-note") return noteEl;
    if (sel === ".review-error") return errEl;
    if (sel === ".review-current") return current;
    return undefined;
  };
  const btn = new El("button");
  btn.classList.add("btn", "review-save");
  box.appendChild(btn);
  results.appendChild(box);
  fire(btn, "click");
  box.parent = null;
  return current.innerHTML;
}
async function adjudicate() { fire(form, "submit"); await flush(); }
const rendered = () => results.innerHTML;
const fresh = (note) =>
  !rendered().includes(note) && rendered().includes("当前：未复核");

/* ---------------- 场景 ---------------- */

async function main() {
  // 初始合法输入：区间 10~60 / 10~60，选手 101，一趟 a1-b1-c1。
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = "101";
  for (let i = 0; i < 6; i++) fire(addRecord, "click");
  setRow("a1", "101", "S", "0");
  setRow("b1", "101", "M", "12");
  setRow("c1", "101", "F", "22");
  await adjudicate();
  assert(rendered().includes("a1"), "初始合法裁决已渲染");

  console.log("保存复核（通过 + 备注）");
  saveReview(0, "pass", "已核对OK");
  await adjudicate();
  assert(rendered().includes("已核对OK") && rendered().includes("当前：通过"), "复核已保存并渲染");

  console.log("场景1：清空下限→422非法→改回，旧复核不得恢复");
  server.mode = "invalid";
  setVal("smMin", "");
  fire($("smMin"), "input");
  await adjudicate();
  assert(rendered() === "" && !$("error-box").hidden, "非法响应：只显示错误、无部分结果");
  setVal("smMin", "10");
  fire($("smMin"), "input");
  server.mode = "valid";
  await adjudicate();
  assert(fresh("已核对OK"), "改回合法后该趟显示未复核、空备注");

  console.log("场景2：防抖提交前改动绑定值立即改回");
  saveReview(0, "pass", "备注B");
  rowOf("b1").querySelector(".rec-time").value = "99";
  fire(rowOf("b1").querySelector(".rec-time"), "input"); // 此刻即应丢弃
  rowOf("b1").querySelector(".rec-time").value = "12";
  fire(rowOf("b1").querySelector(".rec-time"), "input"); // 改回不恢复
  await adjudicate();
  assert(fresh("备注B"), "防抖前瞬时改回，旧复核仍被丢弃");

  console.log("场景3：请求在途时改动再改回，过期响应不得恢复");
  saveReview(0, "doubt", "备注C");
  let resolveHold;
  server.hold = new Promise((res) => { resolveHold = res; });
  server.mode = "hold";
  fire(form, "submit"); // 请求在途
  setVal("smMin", "5");
  fire($("smMin"), "input"); // 绑定已变 → 立即丢弃
  setVal("smMin", "10");
  fire($("smMin"), "input"); // 改回
  resolveHold({ ok: true, result: validResult }); // 旧响应回来
  await flush();
  server.mode = "valid";
  await adjudicate();
  assert(fresh("备注C"), "在途请求的旧响应未恢复被丢弃的复核");

  console.log("场景4：重排 / 增删改无关记录，绑定未变且仍采纳 → 保留");
  saveReview(0, "pass", "保留备注D");
  const a1 = rowOf("a1");
  recordRows.appendChild(a1); // 重排到末尾
  fire(a1.querySelector(".rec-id"), "input");
  fire(addRecord, "click");
  setRow("z9", "101", "S", "900");
  fire(findRow("z9").querySelector(".rec-id"), "input");
  await adjudicate();
  assert(rendered().includes("保留备注D"), "重排+新增无关记录后保留");
  findRow("z9").querySelector(".rec-time").value = "901";
  fire(findRow("z9").querySelector(".rec-time"), "change");
  await adjudicate();
  assert(rendered().includes("保留备注D"), "修改无关记录后保留");
  removeRow("z9");
  await adjudicate();
  assert(rendered().includes("保留备注D"), "删除无关记录后保留");

  console.log("场景5：删除绑定记录后即使补回同编号也不恢复");
  removeRow("c1");
  fire(addRecord, "click");
  setRow("c1", "101", "F", "22"); // 改回
  fire(findRow("c1").querySelector(".rec-id"), "input");
  await adjudicate();
  assert(fresh("保留备注D"), "绑定记录被删即丢弃，补回不恢复");

  console.log("场景6：删除绑定选手后即使补回同编号也不恢复");
  saveReview(0, "pass", "备注E");
  fire(addRunner, "click");
  [...runnerRows.querySelectorAll(".runner-number")].find((e) => e.value === "").value = "102";
  fire(runnerRows, "input");
  const r101 = [...runnerRows.querySelectorAll(".runner-row")].find(
    (r) => r.querySelector(".runner-number").value === "101"
  );
  fire(r101.querySelector(".remove-runner"), "click");
  fire(addRunner, "click");
  [...runnerRows.querySelectorAll(".runner-number")].find((e) => e.value === "").value = "101";
  fire(runnerRows, "input");
  await adjudicate();
  assert(fresh("备注E"), "绑定选手被删即丢弃，补回同编号不恢复");

  console.log("场景7：逐趟独立失效——改一条趟的绑定不影响另一趟");
  // 重建为两名选手各一趟。
  fire(addRecord, "click");
  setRow("d1", "102", "S", "5");
  setRow("e1", "102", "M", "15");
  setRow("f1", "102", "F", "25");
  server.result = twoLapResult;
  await adjudicate();
  saveReview(0, "pass", "第一趟备注");
  saveReview(1, "doubt", "第二趟备注");
  await adjudicate();
  assert(rendered().includes("第一趟备注") && rendered().includes("第二趟备注"), "两趟复核均保存");
  rowOf("b1").querySelector(".rec-time").value = "13";
  fire(rowOf("b1").querySelector(".rec-time"), "input"); // 只动第一趟
  rowOf("b1").querySelector(".rec-time").value = "12";
  fire(rowOf("b1").querySelector(".rec-time"), "input");
  await adjudicate();
  assert(!rendered().includes("第一趟备注"), "被改绑定的第一趟丢弃");
  assert(rendered().includes("第二趟备注"), "第二趟复核保留");

  console.log("场景8：区间绑定值改变但趟仍被合法裁决采纳，仍须丢弃；改回不恢复");
  saveReview(0, "pass", "区间备注F");
  setVal("smMin", "5"); // sm=12 仍落在 5~60，趟依旧被采纳
  fire($("smMin"), "input");
  await adjudicate();
  assert(!rendered().includes("区间备注F"), "区间下限改变即丢弃（即使趟仍采纳）");
  setVal("smMin", "10");
  fire($("smMin"), "input");
  await adjudicate();
  assert(fresh("区间备注F"), "区间改回后旧复核不恢复");

  console.log("场景9：真实防抖计时路径（不手动提交），瞬时改回后自动重算也不恢复");
  saveReview(0, "pass", "防抖备注G");
  rowOf("b1").querySelector(".rec-time").value = "14";
  fire(rowOf("b1").querySelector(".rec-time"), "input");
  rowOf("b1").querySelector(".rec-time").value = "12";
  fire(rowOf("b1").querySelector(".rec-time"), "input");
  await new Promise((r) => setTimeout(r, 450)); // 超过 350ms 防抖，自动提交一次
  await flush();
  assert(fresh("防抖备注G"), "防抖自动重算后显示未复核、空备注");

  console.log("场景10：填入示例清除全部复核；清空立即清除结果且不发请求");
  saveReview(0, "pass", "示例前备注");
  let fetchCount = 0;
  const origFetch = global.fetch;
  global.fetch = (...a) => { fetchCount++; return origFetch(...a); };
  fire($("sample-btn"), "click");
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  assert(!rendered().includes("示例前备注"), "填入示例后旧备注消失");
  const sampleFetched = fetchCount;
  fire($("clear-btn"), "click");
  await flush();
  assert(rendered() === "" && $("error-box").hidden, "清空后结果与错误立即消失");
  assert(fetchCount === sampleFetched, "清空不会再发请求（在途版本守卫之外的防抖已取消）");

  console.log("场景11：大整数编号的复核绑定互不混同");
  // 2^53 与 2^53+1：JS Number 无法区分（都会变成 9007199254740992），
  // 复核绑定中的选手编号必须按规范十进制精确比较。
  const BIG_A = "9007199254740992";
  const BIG_B = "9007199254740993";
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  fire(addRunner, "click"); // 共 2 行选手
  const bigInputs = [...runnerRows.querySelectorAll(".runner-number")];
  bigInputs[0].value = BIG_A; bigInputs[1].value = BIG_B;
  fire(runnerRows, "input");
  for (let i = 0; i < 5; i++) fire(addRecord, "click"); // 共 6 行记录
  setRow("ba1", BIG_A, "S", "0"); setRow("bb1", BIG_A, "M", "10"); setRow("bc1", BIG_A, "F", "20");
  setRow("bd1", BIG_B, "S", "0"); setRow("be1", BIG_B, "M", "11"); setRow("bf1", BIG_B, "F", "22");
  server.raw = `{"ok":true,"result":{"runners":[` +
    `{"runner":${BIG_A},"lapCount":1,"totalTime":20,"laps":[` +
    `{"start":{"id":"ba1","time":0},"middle":{"id":"bb1","time":10},"finish":{"id":"bc1","time":20},` +
    `"smTime":10,"mfTime":10,"totalTime":20}],"unused":[]},` +
    `{"runner":${BIG_B},"lapCount":1,"totalTime":22,"laps":[` +
    `{"start":{"id":"bd1","time":0},"middle":{"id":"be1","time":11},"finish":{"id":"bf1","time":22},` +
    `"smTime":11,"mfTime":11,"totalTime":22}],"unused":[]}]}}`;
  await adjudicate();
  assert(
    rendered().includes(`选手 ${BIG_A}`) && rendered().includes(`选手 ${BIG_B}`),
    "两个大编号分别渲染，不混同"
  );
  saveReview(0, "pass", "大编号备注A"); // 前者（BIG_A）的趟
  await adjudicate();
  assert(rendered().includes("大编号备注A"), "前者趟的复核已保存");
  assert(
    (rendered().match(/当前：通过/g) || []).length === 1,
    "后者同形状趟保持未复核（不被前者的复核覆盖）"
  );
  // 删除前者选手行：前者的复核必须在输入事件当下立即失效——
  // 即使后者编号在 Number 精度下与前者相同（旧实现会误判绑定仍有效）。
  const rowBigA = [...runnerRows.querySelectorAll(".runner-row")].find(
    (r) => r.querySelector(".runner-number").value === BIG_A
  );
  fire(rowBigA.querySelector(".remove-runner"), "click");
  await adjudicate();
  assert(!rendered().includes("大编号备注A"), "删除前者行：其复核立即失效（不与后者混同）");
  // 后者的复核保存后，把后者改号为前者：后者的复核按原绑定立即失效。
  saveReview(1, "doubt", "大编号备注B"); // 后者（BIG_B）的趟
  await adjudicate();
  assert(rendered().includes("大编号备注B"), "后者趟的复核已保存");
  const rowBigB = [...runnerRows.querySelectorAll(".runner-row")].find(
    (r) => r.querySelector(".runner-number").value === BIG_B
  );
  rowBigB.querySelector(".runner-number").value = BIG_A;
  fire(runnerRows, "input");
  await adjudicate();
  assert(!rendered().includes("大编号备注B"), "后者改号为前者：后者的复核立即失效");
  server.raw = null;

  console.log("场景12：超过 2^53 的记录秒数与 11 秒差值——展示精确、无关编辑保留复核");
  // 复现：两段区间 10~60，S/M/F 秒数为 9007199254740992 / …1003 / …1014，
  // 后端裁决两段各 11 秒（差值在 Number 精度下会被算成 12、10）。
  fire($("clear-btn"), "click");
  await flush();
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = "101";
  fire(runnerRows, "input");
  fire(addRecord, "click"); fire(addRecord, "click"); // 清空后 1 行 → 共 3 行记录
  const T_S = "9007199254740992";
  const T_M = "9007199254741003";
  const T_F = "9007199254741014";
  setRow("h1", "101", "S", T_S);
  setRow("h2", "101", "M", T_M);
  setRow("h3", "101", "F", T_F);
  let sentBody = null;
  const prevFetch = global.fetch;
  global.fetch = async (url, opts) => { sentBody = opts.body; return prevFetch(url, opts); };
  server.raw = `{"ok":true,"result":{"runners":[` +
    `{"runner":101,"lapCount":1,"totalTime":22,"laps":[` +
    `{"start":{"id":"h1","time":${T_S}},"middle":{"id":"h2","time":${T_M}},"finish":{"id":"h3","time":${T_F}},` +
    `"smTime":11,"mfTime":11,"totalTime":22}],"unused":[]}]}}`;
  await adjudicate();
  global.fetch = prevFetch;
  assert(
    rendered().includes(T_S) && rendered().includes(T_M) && rendered().includes(T_F),
    "三条大秒数原样精确展示"
  );
  assert(!rendered().includes("9007199254741004"), "中间门秒数未被浮点截断成 9007199254741004");
  assert(
    rendered().includes("起点→中途门 <strong>11</strong> 秒") &&
      rendered().includes("中途门→终点 <strong>11</strong> 秒"),
    "两段耗时都精确显示为 11 秒（不是 12 / 10）"
  );
  const bodyParsed = JSON.parse(sentBody);
  assert(
    bodyParsed.records[0].time === T_S &&
      bodyParsed.records[1].time === T_M &&
      bodyParsed.records[2].time === T_F,
    "请求中的秒数以十进制字符串原样发送，不截断、不缩小取值范围"
  );

  console.log("  12a：保存“通过”+备注后，添加空记录行并重算，复核保留");
  saveReview(0, "pass", "大秒数备注H");
  fire(addRecord, "click"); // 仅添加一条空记录行（报告中的复现操作）
  await adjudicate();
  assert(
    rendered().includes("大秒数备注H") && rendered().includes("当前：通过"),
    "添加空记录行并重算后复核仍在（旧实现此刻变回未复核、备注消失）"
  );

  console.log("  12b：重排绑定记录、增删无关记录、手动重算均保留");
  const h1 = rowOf("h1");
  recordRows.appendChild(h1); // 重排到末尾
  fire(h1.querySelector(".rec-id"), "input");
  fire(addRecord, "click");
  setRow("zbig", "101", "S", "9007199254740000");
  fire(findRow("zbig").querySelector(".rec-id"), "input");
  await adjudicate();
  assert(rendered().includes("大秒数备注H"), "重排+新增无关大秒数记录后保留");
  removeRow("zbig");
  fire(form, "submit"); // 手动重新计算
  await flush();
  assert(rendered().includes("大秒数备注H"), "删除无关记录并手动重算后保留");

  console.log("  12c：绑定秒数改变立即失效；改回原值不恢复");
  rowOf("h2").querySelector(".rec-time").value = "9007199254741004"; // 与原值相差 1
  fire(rowOf("h2").querySelector(".rec-time"), "input"); // 此刻即丢弃
  rowOf("h2").querySelector(".rec-time").value = T_M;
  fire(rowOf("h2").querySelector(".rec-time"), "input"); // 改回不恢复
  await adjudicate();
  assert(fresh("大秒数备注H"), "绑定秒数变化即失效，改回 9007199254741003 也不恢复");
  server.raw = null;

  console.log(failures === 0 ? "\nALL FRONTEND SCENARIOS PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
