/* 最小 DOM/事件 stub：加载真实 static/app.js，端到端验证名次表与罚秒生命周期。
   与 test_review_lifecycle.js 的差异：结果区 innerHTML 会解析为子节点，
   以便通过 querySelector 找到名次表槽位与罚秒编辑器并模拟真实点击。 */
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
    this.children = [];
    // 解析为子节点：名次表槽位、罚秒编辑器等都可被 querySelector 找到。
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
      // 保留原始 innerHTML 字符串（含文本），便于测试直接断言内容。
      const el = stack.pop();
      if (el && el._contentStart !== undefined) {
        el._html = html.slice(el._contentStart, tok.index);
      }
      continue;
    }
    const el = new El(tag);
    const attrRe = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    const raw = t.replace(/^<\/?[\w-]+/, "").replace(/\/?>$/, "");
    while ((am = attrRe.exec(raw))) {
      const [, k, v] = am;
      if (!k || k === "/") continue;
      if (v === undefined) { el.attrs[k] = true; continue; }
      el.attrs[k] = v;
      if (k === "class") v.split(/\s+/).forEach((c) => c && el.classList.add(c));
      else if (k === "id") el.id = v;
      else if (k.startsWith("data-")) {
        // 与真实 DOM 一致：data-key-index 同时映射为 dataset.keyIndex。
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

for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) form.appendChild(byId.get(id));
form.appendChild(runnerRows);
form.appendChild(recordRows);

global.document = {
  getElementById: (id) => byId.get(id),
};

/* ---------------- fetch stub（可切换：合法 / 422 / 挂起），并计数 ---------------- */

function lap(s, m, f, st, mt, ft) {
  return {
    start: { id: s, time: st }, middle: { id: m, time: mt }, finish: { id: f, time: ft },
    smTime: mt - st, mfTime: ft - mt, totalTime: ft - st,
  };
}
// 三名选手均有完整计次：20 / 22 / 30 秒。
const fixtureA = {
  runners: [
    { runner: 101, lapCount: 1, totalTime: 20, laps: [lap("a1", "b1", "c1", 0, 10, 20)], unused: [] },
    { runner: 102, lapCount: 1, totalTime: 22, laps: [lap("d1", "e1", "f1", 0, 11, 22)], unused: [] },
    { runner: 103, lapCount: 1, totalTime: 30, laps: [lap("g1", "h1", "i1", 0, 15, 30)], unused: [] },
  ],
};
// 101、103 零次，102 一次。
const fixtureB = {
  runners: [
    { runner: 101, lapCount: 0, totalTime: 0, laps: [], unused: [{ id: "a1", gate: "S", time: 0 }] },
    { runner: 102, lapCount: 1, totalTime: 20, laps: [lap("d1", "e1", "f1", 0, 10, 20)], unused: [] },
    { runner: 103, lapCount: 0, totalTime: 0, laps: [], unused: [{ id: "g1", gate: "S", time: 0 }] },
  ],
};

const server = { mode: "valid", result: fixtureA, hold: null, raw: null };
let fetchCount = 0;
global.fetch = async (_url, opts) => {
  fetchCount++;
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
async function adjudicate() { fire(form, "submit"); await flush(); }

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
const numInputs = () => [...runnerRows.querySelectorAll(".runner-number")];
// 按当前编号唯一定位选手行；调用方须确保该编号在表单中只出现一次（无重号）。
function rowOfRunner(v) {
  const hits = [...runnerRows.querySelectorAll(".runner-row")]
    .filter((x) => x.querySelector(".runner-number").value === v);
  if (hits.length !== 1) throw new Error(`runner ${v} 出现 ${hits.length} 次，无法唯一定位`);
  return hits[0];
}

// 名次表槽位的实时 HTML（罚秒保存后会被原地重排）。
const slotHtml = () => results.querySelector(".ranking-table-slot").innerHTML;
const rowHtml = (runner, laps, total, pen, adj, rank) =>
  `<td>${runner}</td><td>${laps}</td><td>${total} 秒</td><td>${pen} 秒</td><td>${adj} 秒</td><td>${rank}</td>`;
const rowOrder = (...nums) => {
  const h = slotHtml();
  const idx = nums.map((n) => h.indexOf(`<td>${n}</td>`));
  return idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || idx[i - 1] < v);
};

function editorOf(runner) {
  return results.querySelectorAll(".penalty-editor").find((e) => e.dataset.runner === String(runner));
}
// 通过真实的 resultsBox click 监听保存罚秒。
function savePenalty(runner, seconds, reason) {
  const ed = editorOf(runner);
  ed.querySelector(".penalty-seconds").value = seconds;
  ed.querySelector(".penalty-reason").value = reason;
  fire(ed.querySelector(".penalty-save"), "click");
  return {
    error: ed.querySelector(".penalty-error"),
    current: ed.querySelector(".penalty-current"),
  };
}

/* ---------------- 场景 ---------------- */

async function main() {
  // 初始合法输入：区间 10~60 / 10~60，选手 101/102/103，各一趟。
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  fire(addRunner, "click"); fire(addRunner, "click"); // 共 3 行选手
  numInputs()[0].value = "101"; numInputs()[1].value = "102"; numInputs()[2].value = "103";
  fire(runnerRows, "input"); // 与真实页面一致：录入编号触发输入事件，建立各行的编号基线
  for (let i = 0; i < 7; i++) fire(addRecord, "click"); // 共 9 行记录
  [
    ["a1", "101", "S", "0"], ["b1", "101", "M", "10"], ["c1", "101", "F", "20"],
    ["d1", "102", "S", "0"], ["e1", "102", "M", "11"], ["f1", "102", "F", "22"],
    ["g1", "103", "S", "0"], ["h1", "103", "M", "15"], ["i1", "103", "F", "30"],
  ].forEach((r) => setRow(...r));
  server.result = fixtureA;
  await adjudicate();

  console.log("名次表初始渲染（无罚秒，默认 0）");
  assert(
    slotHtml().includes("<th>选手编号</th><th>计次数</th><th>原总用时</th><th>罚秒</th><th>调整后用时</th><th>名次</th>"),
    "表头包含选手编号/计次数/原总用时/罚秒/调整后用时/名次"
  );
  assert(slotHtml().includes(rowHtml(101, 1, 20, 0, 20, "第 1 名")), "101：1 次、20 秒、第 1 名");
  assert(slotHtml().includes(rowHtml(102, 1, 22, 0, 22, "第 2 名")), "102：1 次、22 秒、第 2 名");
  assert(slotHtml().includes(rowHtml(103, 1, 30, 0, 30, "第 3 名")), "103：1 次、30 秒、第 3 名");
  assert(results.querySelectorAll(".penalty-editor").length === 3, "每名选手都有罚秒编辑区");
  assert(editorOf(101).querySelector(".penalty-seconds").value === "0", "默认罚秒为 0");

  console.log("保存罚秒立即重排名次，无需重算");
  let before = fetchCount;
  let r = savePenalty(102, "2", "踩线");
  assert(fetchCount === before, "保存罚秒未发起重新裁决");
  assert(slotHtml().includes(rowHtml(102, 1, 22, 2, 24, "第 2 名")), "102 罚秒 2、调整后 24 立即生效");
  assert(
    r.current.innerHTML.includes("当前已保存：2 秒") && r.current.innerHTML.includes("踩线"),
    "已保存罚秒与原因回显"
  );
  assert(r.error.hidden, "合法保存无错误提示");

  console.log("并列共享名次并跳号（1、1、3），并列按编号升序展示");
  savePenalty(101, "4", "抢跑"); // 101 调整后 24，与 102 并列
  assert(slotHtml().includes(rowHtml(101, 1, 20, 4, 24, "第 1 名")), "101 并列第 1 名");
  assert(slotHtml().includes(rowHtml(102, 1, 22, 2, 24, "第 1 名")), "102 并列第 1 名");
  assert(slotHtml().includes(rowHtml(103, 1, 30, 0, 30, "第 3 名")), "103 跳号为第 3 名");
  assert(!slotHtml().includes("第 2 名"), "名次跳号：不存在第 2 名");
  assert(rowOrder(101, 102, 103), "并列者按编号升序展示");

  console.log("非法罚秒保存失败并保留原罚秒和原因");
  const snapshot = slotHtml();
  r = savePenalty(103, "abc", "原因");
  assert(!r.error.hidden && r.error.textContent.includes("非负整数"), "非数字罚秒被拒绝");
  r = savePenalty(103, "-1", "原因");
  assert(!r.error.hidden && r.error.textContent.includes("非负整数"), "负数罚秒被拒绝");
  r = savePenalty(103, "", "原因");
  assert(!r.error.hidden && r.error.textContent.includes("非负整数"), "空罚秒被拒绝");
  r = savePenalty(103, "5", "");
  assert(!r.error.hidden && r.error.textContent.includes("原因"), "罚秒大于 0 时原因必填");
  r = savePenalty(103, "5", "x".repeat(201));
  assert(!r.error.hidden && r.error.textContent.includes("200"), "原因至多 200 字");
  assert(r.error.textContent.includes("已保留原罚秒和原因"), "失败提示保留原值");
  assert(slotHtml() === snapshot, "保存失败不改变名次表");
  assert(slotHtml().includes(rowHtml(103, 1, 30, 0, 30, "第 3 名")), "103 罚秒仍为 0");

  console.log("罚秒 0 允许空原因；原因做 HTML 转义");
  r = savePenalty(103, "5", "迟到");
  assert(slotHtml().includes(rowHtml(103, 1, 30, 5, 35, "第 3 名")), "103 罚秒 5、调整后 35");
  r = savePenalty(103, "1", "违规<抢跑>");
  assert(r.current.innerHTML.includes("违规&lt;抢跑&gt;"), "原因中的尖括号被转义");
  r = savePenalty(103, "0", "");
  assert(r.error.hidden && slotHtml().includes(rowHtml(103, 1, 30, 0, 30, "第 3 名")), "罚秒 0 空原因保存成功");

  console.log("罚秒只影响名次表，不改变采纳记录、裁决用时与人工复核");
  const reviewBox = results.querySelector(".review-box");
  const passRadio = [...reviewBox.querySelectorAll("input[type=radio]")].find((x) => x.value === "pass");
  passRadio.checked = true;
  reviewBox.querySelector(".review-note").value = "复核备注";
  fire(reviewBox.querySelector(".review-save"), "click");
  savePenalty(103, "3", "绕行");
  assert(results.innerHTML.includes("各趟用时之和：20 秒"), "选手卡仍显示原裁决用时");
  assert(
    results.querySelector(".review-current").innerHTML.includes("复核备注"),
    "保存罚秒后复核内容不变"
  );
  savePenalty(103, "0", "");

  console.log("记录或区间编辑保留罚秒");
  // 当前罚秒：101→4，102→2
  findRow("a1").querySelector(".rec-time").value = "1";
  fire(findRow("a1").querySelector(".rec-time"), "input");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(101, 1, 20, 4, 24, "第 1 名")), "修改记录后 101 罚秒保留");
  setVal("smMin", "5"); fire($("smMin"), "input");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(102, 1, 22, 2, 24, "第 1 名")), "修改区间后 102 罚秒保留");
  setVal("smMin", "10"); fire($("smMin"), "input");
  await adjudicate();

  console.log("修改选手编号立即清除对应罚秒，改回不恢复");
  numInputs().find((e) => e.value === "102").value = "105";
  fire(runnerRows, "input"); // 此刻即应清除 102 的罚秒
  numInputs().find((e) => e.value === "105").value = "102";
  fire(runnerRows, "input"); // 改回不恢复
  await adjudicate();
  assert(slotHtml().includes(rowHtml(102, 1, 22, 0, 22, "第 1 名")), "102 罚秒被清除且不恢复（22 秒重回第 1）");
  assert(slotHtml().includes(rowHtml(101, 1, 20, 4, 24, "第 2 名")), "101 罚秒不受影响");

  console.log("删除选手立即清除其罚秒，补回同编号不恢复");
  const row101 = [...runnerRows.querySelectorAll(".runner-row")].find(
    (x) => x.querySelector(".runner-number").value === "101"
  );
  fire(row101.querySelector(".remove-runner"), "click"); // 此刻即应清除 101 的罚秒
  fire(addRunner, "click");
  numInputs().find((e) => e.value === "").value = "101";
  fire(runnerRows, "input");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(101, 1, 20, 0, 20, "第 1 名")), "101 罚秒被清除且不恢复");
  assert(slotHtml().includes(rowHtml(102, 1, 22, 0, 22, "第 2 名")), "102 同样无罚秒");

  console.log("零次者排末尾、按编号升序且无名次");
  server.result = fixtureB;
  await adjudicate();
  assert(rowOrder(102, 101, 103), "有计次的 102 在前，零次者 101、103 按编号升序排末尾");
  assert(slotHtml().includes(rowHtml(102, 1, 20, 0, 20, "第 1 名")), "102 第 1 名");
  assert(slotHtml().includes(rowHtml(101, 0, 0, 0, 0, "—")), "101 零次、无名次");
  assert(slotHtml().includes(rowHtml(103, 0, 0, 0, 0, "—")), "103 零次、无名次");
  r = savePenalty(101, "3", "设备故障");
  assert(slotHtml().includes(rowHtml(101, 0, 0, 3, 3, "—")), "零次者可保存罚秒但仍无名次");
  assert(rowOrder(102, 101, 103), "零次者顺序不受罚秒影响");

  console.log("输入非法或重算期间隐藏名次，旧响应不能恢复");
  server.mode = "invalid";
  setVal("smMin", ""); fire($("smMin"), "input");
  await adjudicate();
  assert(results.innerHTML === "" && !$("error-box").hidden, "非法输入：名次表隐藏，只显示错误");
  setVal("smMin", "10"); fire($("smMin"), "input");
  server.mode = "hold";
  let resolveHold;
  server.hold = new Promise((res) => { resolveHold = res; });
  fire(form, "submit"); // 请求在途
  setVal("smMin", "5"); fire($("smMin"), "input"); // 输入已变，名次隐藏
  assert(results.innerHTML === "", "重算期间名次表隐藏");
  resolveHold({ ok: true, result: fixtureB }); // 旧响应回来
  await flush();
  assert(results.innerHTML === "", "过期响应未恢复名次表");
  server.mode = "valid";
  setVal("smMin", "10"); fire($("smMin"), "input");
  await adjudicate();
  assert(
    slotHtml().includes(rowHtml(101, 0, 0, 3, 3, "—")),
    "最新合法结果套用当时已保存的罚秒（区间编辑保留罚秒）"
  );

  console.log("临时重号：改号瞬间即清除原编号罚秒，即使另一行仍占用该编号");
  // 当前名次状态（fixtureB）：102 有 1 趟 20 秒，101/103 零次；
  // 已保存罚秒：101→3。再给 102 保存 7 秒、103 保存 9 秒（103 此行始终不改）。
  savePenalty(102, "7", "压线");
  savePenalty(103, "9", "迟到");
  assert(slotHtml().includes(rowHtml(102, 1, 20, 7, 27, "第 1 名")), "前置：102 罚秒 7 已生效");
  // 三行互异时按当前编号各取一次稳定引用；之后出现重号也不会找错行。
  const dup102 = rowOfRunner("102");
  const dup101 = rowOfRunner("101");
  const setRunnerAndFire = (row, v) => {
    row.querySelector(".runner-number").value = v;
    fire(runnerRows, "input");
  };
  // 步骤 1：把 101 行改成 102（临时重号，输入非法）。改行离开的原编号是 101，
  // 故只清 101；原 102 行（罚秒的归属行）尚未改号，其 7 秒在本步仍保留。
  setRunnerAndFire(dup101, "102");
  assert(!globalThis.__penaltiesForTest.has("101"), "临时重号瞬间：改行的原编号 101 的 3 秒立即清除");
  assert(globalThis.__penaltiesForTest.get("102").seconds === 7,
    "原 102 行尚未改号：102 的 7 秒仍归属该行，本步保留");
  assert(globalThis.__penaltiesForTest.get("103").seconds === 9, "同一事件中未改号的 103 不受影响");
  await adjudicate(); // 桩服务器不校验重号仍返回结果
  assert(slotHtml().includes(rowHtml(102, 1, 20, 7, 27, "第 1 名")), "归属行未改号前，名次仍按 102 的 7 秒展示");
  // 步骤 2：把原 102 行改为 104——此刻另一行仍占用 102，但该行离开了原编号 102，
  // 102 的 7 秒与原因必须在输入事件当下立即清除（不等待重算、不因重号而残留）。
  setRunnerAndFire(dup102, "104");
  assert(!globalThis.__penaltiesForTest.has("102"),
    "原 102 行改号瞬间：另一行仍占用 102，其 7 秒与原因仍被立即清除");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(102, 1, 20, 0, 20, "第 1 名")), "原 102 的 7 秒未留存：102 现为默认 0 秒");
  let ed102 = editorOf(102);
  assert(ed102.querySelector(".penalty-seconds").value === "0", "占用 102 编号的行只显示默认 0 秒");
  assert(ed102.querySelector(".penalty-reason").value === "", "占用 102 编号的行原因已清空");
  assert(slotHtml().includes(rowHtml(103, 0, 0, 9, 9, "—")), "未改号的 103 罚秒 9 不受影响");
  // 步骤 3：把 104 行改回 102（再次临时重号），罚秒同样不得恢复。
  setRunnerAndFire(dup102, "102");
  assert(!globalThis.__penaltiesForTest.has("102"), "再次临时重号瞬间：102 罚秒仍为空，不恢复");
  // 步骤 4：把第一行改回 101，重号全部解除。
  setRunnerAndFire(dup101, "101");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(102, 1, 20, 0, 20, "第 1 名")), "改回 102 后仍是默认 0 秒，旧 7 秒不恢复");
  assert(slotHtml().includes(rowHtml(101, 0, 0, 0, 0, "—")), "改回 101 后仍是默认 0 秒，旧 3 秒不恢复");
  ed102 = editorOf(102);
  assert(ed102.querySelector(".penalty-seconds").value === "0", "改回后编辑器回显 0 秒");
  assert(ed102.querySelector(".penalty-reason").value === "", "改回后原因仍为空");
  const ed101 = editorOf(101);
  assert(ed101.querySelector(".penalty-seconds").value === "0", "101 编辑器回显 0 秒");
  assert(ed101.querySelector(".penalty-reason").value === "", "101 原因仍为空");
  assert(slotHtml().includes(rowHtml(103, 0, 0, 9, 9, "—")), "全程未改号的 103 罚秒始终保留");
  // 后续区间编辑与重算也不得恢复已释放的罚秒。
  setVal("smMin", "8"); fire($("smMin"), "input");
  setVal("smMin", "10"); fire($("smMin"), "input");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(102, 1, 20, 0, 20, "第 1 名")), "区间编辑重算后 102 仍为 0 秒");
  assert(slotHtml().includes(rowHtml(101, 0, 0, 0, 0, "—")), "区间编辑重算后 101 仍为 0 秒");
  assert(slotHtml().includes(rowHtml(103, 0, 0, 9, 9, "—")), "区间编辑重算后 103 的 9 秒保留");

  console.log("删除选手行时即使另一行仍占用同编号也立即清除该编号罚秒");
  // 三行：101 / 102 / 103。给 103 保存罚秒后，把 101 行改成 103（临时重号），
  // 再删除原 103 行：删除瞬间 103 的罚秒必须清掉，尽管改成 103 的另一行仍占用该编号。
  savePenalty(103, "6", "阻挡");
  assert(globalThis.__penaltiesForTest.get("103").seconds === 6, "前置：103 罚秒 6 已生效");
  const rowDel101 = dup101; // 上一场景结束时该行正是 101
  setRunnerAndFire(rowDel101, "103"); // 101→103，103 原行还在：改号释放的是 101（无罚秒）
  assert(globalThis.__penaltiesForTest.get("103").seconds === 6, "改号行只是占用 103：原 103 的 6 秒在原行删除前仍在");
  // 出现两个 103 行：删除的是“原本就是 103”的那一行，不是刚改过来的行。
  const rowOrig103 = [...runnerRows.querySelectorAll(".runner-row")]
    .find((x) => x !== rowDel101 && x.querySelector(".runner-number").value === "103");
  fire(rowOrig103.querySelector(".remove-runner"), "click"); // 删除原 103 行
  assert(!globalThis.__penaltiesForTest.has("103"), "删除瞬间：另一行仍占用 103，其 6 秒与原因仍被立即清除");

  // 补一名 101 选手，恢复三行状态进入后续场景。
  fire(addRunner, "click");
  numInputs().find((e) => e.value === "").value = "101";
  fire(runnerRows, "input");
  await adjudicate();

  console.log("填入示例与清空清除全部罚秒");
  savePenalty(102, "7", "绕行");
  assert(slotHtml().includes(rowHtml(102, 1, 20, 7, 27, "第 1 名")), "102 罚秒 7 已生效");
  fire($("sample-btn"), "click");
  await new Promise((res) => setTimeout(res, 450)); // 超过 350ms 防抖，自动重算
  await flush();
  assert(slotHtml().includes(rowHtml(102, 1, 20, 0, 20, "第 1 名")), "填入示例后全部罚秒被清除");
  fire($("clear-btn"), "click");
  await flush();
  assert(results.innerHTML === "" && $("error-box").hidden, "清空后名次表立即隐藏");

  console.log("大整数编号：超过 2^53 的编号显示、罚秒归属与排序均不混同");
  // 2^53 与 2^53+1：JS Number 无法区分（都会变成 9007199254740992），
  // 后端按任意精度整数接收并原样返回，页面从响应到展示须全程无损。
  const BIG_A = "9007199254740992";
  const BIG_B = "9007199254740993";
  const bigLapA =
    `{"start":{"id":"ba1","time":0},"middle":{"id":"bb1","time":10},` +
    `"finish":{"id":"bc1","time":20},"smTime":10,"mfTime":10,"totalTime":20}`;
  const bigLapB =
    `{"start":{"id":"bd1","time":0},"middle":{"id":"be1","time":11},` +
    `"finish":{"id":"bf1","time":22},"smTime":11,"mfTime":11,"totalTime":22}`;
  const bigRunner = (num, lap, laps, total) =>
    `{"runner":${num},"lapCount":${laps},"totalTime":${total},"laps":[${lap}],"unused":[]}`;
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  fire(addRunner, "click"); // 共 2 行选手
  numInputs()[0].value = BIG_A; numInputs()[1].value = BIG_B;
  fire(runnerRows, "input");
  for (let i = 0; i < 5; i++) fire(addRecord, "click"); // 共 6 行记录
  [
    ["ba1", BIG_A, "S", "0"], ["bb1", BIG_A, "M", "10"], ["bc1", BIG_A, "F", "20"],
    ["bd1", BIG_B, "S", "0"], ["be1", BIG_B, "M", "11"], ["bf1", BIG_B, "F", "22"],
  ].forEach((r) => setRow(...r));
  server.raw = `{"ok":true,"result":{"runners":[` +
    `${bigRunner(BIG_A, bigLapA, 1, 20)},${bigRunner(BIG_B, bigLapB, 1, 22)}]}}`;
  await adjudicate();
  assert(
    slotHtml().includes(`<td>${BIG_A}</td>`) && slotHtml().includes(`<td>${BIG_B}</td>`),
    "名次表分别显示两个大编号（不再显示成同一编号）"
  );
  assert(
    results.innerHTML.includes(`选手 ${BIG_A}`) && results.innerHTML.includes(`选手 ${BIG_B}`),
    "选手卡分别显示两个大编号"
  );
  assert(!!editorOf(BIG_A) && !!editorOf(BIG_B), "两个大编号各有独立的罚秒编辑区");
  r = savePenalty(BIG_A, "7", "大编号踩线");
  assert(r.error.hidden, "大编号罚秒保存成功");
  assert(globalThis.__penaltiesForTest.get(BIG_A).seconds === 7, "前者的 7 秒按精确编号归属");
  assert(!globalThis.__penaltiesForTest.has(BIG_B), "保存前者罚秒不影响后者");
  assert(slotHtml().includes(rowHtml(BIG_A, 1, 20, 7, 27, "第 2 名")), "前者调整后 27 秒排第 2");
  assert(slotHtml().includes(rowHtml(BIG_B, 1, 22, 0, 22, "第 1 名")), "后者仍 0 秒排第 1");
  assert(editorOf(BIG_B).querySelector(".penalty-seconds").value === "0", "后者编辑区仍显示 0 秒");
  savePenalty(BIG_B, "9", "后者迟到");
  assert(
    globalThis.__penaltiesForTest.get(BIG_A).seconds === 7 &&
      globalThis.__penaltiesForTest.get(BIG_B).seconds === 9,
    "两个大编号的罚秒互不影响"
  );

  console.log("大整数编号：删行与改号立即释放原编号罚秒，改回不恢复");
  fire(rowOfRunner(BIG_B).querySelector(".remove-runner"), "click"); // 删除后者行
  assert(!globalThis.__penaltiesForTest.has(BIG_B), "删除后者行：其 9 秒立即释放");
  assert(globalThis.__penaltiesForTest.get(BIG_A).seconds === 7, "前者罚秒不受影响");
  // 仅剩前者时把编号改成后者：前者的 7 秒必须在输入事件当下立即清除
  // （Number 精度下两个编号相同，旧实现检测不到这次改号）。
  numInputs()[0].value = BIG_B;
  fire(runnerRows, "input");
  assert(!globalThis.__penaltiesForTest.has(BIG_A), "改号为另一个大编号：原编号罚秒立即清除");
  numInputs()[0].value = BIG_A; // 改回不恢复
  fire(runnerRows, "input");
  fire(addRunner, "click"); // 重新添加后者，恢复两行合法状态
  numInputs()[1].value = BIG_B;
  fire(runnerRows, "input");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(BIG_A, 1, 20, 0, 20, "第 1 名")), "改回后前者仍是默认 0 秒");
  assert(slotHtml().includes(rowHtml(BIG_B, 1, 22, 0, 22, "第 2 名")), "重新添加的后者也是默认 0 秒");

  console.log("大整数编号：前导零等值改写不算改号");
  savePenalty(BIG_A, "5", "前导零测试");
  numInputs()[0].value = "0" + BIG_A; // 09007199254740992，与前者等值
  fire(runnerRows, "input");
  assert(globalThis.__penaltiesForTest.get(BIG_A).seconds === 5, "前导零等值改写：罚秒保留");
  await adjudicate();
  assert(slotHtml().includes(rowHtml(BIG_A, 1, 20, 5, 25, "第 2 名")), "前导零改写后罚秒仍生效");

  console.log("大整数编号：名次表按编号数值升序，不被浮点截断误导");
  fire(addRunner, "click"); // 共 3 行选手
  numInputs()[2].value = "5";
  fire(runnerRows, "input");
  server.raw = `{"ok":true,"result":{"runners":[` +
    `{"runner":${BIG_B},"lapCount":0,"totalTime":0,"laps":[],"unused":[]},` +
    `{"runner":5,"lapCount":0,"totalTime":0,"laps":[],"unused":[]},` +
    `{"runner":${BIG_A},"lapCount":0,"totalTime":0,"laps":[],"unused":[]}]}}`;
  await adjudicate();
  assert(rowOrder(5, BIG_A, BIG_B), "零次者按编号数值升序：5 < 2^53 < 2^53+1");
  // 并列同分时也按编号数值升序展示（响应顺序故意打乱）。
  savePenalty(BIG_A, "0", ""); // 清掉前者的 5 秒，让三者调整后用时相同
  server.raw = `{"ok":true,"result":{"runners":[` +
    `${bigRunner(BIG_B, bigLapB, 1, 20)},` +
    `${bigRunner(5, bigLapA, 1, 20)},` +
    `${bigRunner(BIG_A, bigLapA, 1, 20)}]}}`;
  await adjudicate();
  assert(rowOrder(5, BIG_A, BIG_B), "并列第 1 时按编号数值升序展示");
  assert(slotHtml().includes(rowHtml(BIG_A, 1, 20, 0, 20, "第 1 名")), "并列：前者第 1 名");
  assert(slotHtml().includes(rowHtml(BIG_B, 1, 20, 0, 20, "第 1 名")), "并列：后者第 1 名");
  server.raw = null;

  console.log("超过 2^53 的总用时：原总用时与调整后用时按十进制精确展示和排名");
  // 两条趟的总用时相差 11 秒：Number 精度下会被截断成同值，名次与罚秒叠加都必须
  // 仍按精确整数处理（与复核绑定共用同一套秒数字符串，不经过 Number）。
  const T1 = "9007199254740992"; // 2^53
  const T2 = "9007199254741003"; // +11
  const bigTimeRunner = (num, total) =>
    `{"runner":${num},"lapCount":1,"totalTime":${total},"laps":[` +
    `{"start":{"id":"x${num}a","time":0},"middle":{"id":"x${num}b","time":11},` +
    `"finish":{"id":"x${num}c","time":${total}},"smTime":11,"mfTime":${BigInt(total) - 11n},"totalTime":${total}}],"unused":[]}`;
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  fire($("clear-btn"), "click");
  await flush();
  fire(addRunner, "click"); // 共 2 行选手
  numInputs()[0].value = "201"; numInputs()[1].value = "202";
  fire(runnerRows, "input");
  for (let i = 0; i < 5; i++) fire(addRecord, "click"); // 清空后 1 行 → 共 6 行记录
  setRow("x201a", "201", "S", "0"); setRow("x201b", "201", "M", "11"); setRow("x201c", "201", "F", T1);
  setRow("x202a", "202", "S", "0"); setRow("x202b", "202", "M", "11"); setRow("x202c", "202", "F", T2);
  server.raw = `{"ok":true,"result":{"runners":[` +
    `${bigTimeRunner(201, T1)},${bigTimeRunner(202, T2)}]}}`;
  await adjudicate();
  assert(slotHtml().includes(`<td>${T1} 秒</td>`) && slotHtml().includes(`<td>${T2} 秒</td>`),
    "原总用时大整数原样展示，不截断");
  assert(slotHtml().includes(rowHtml(201, 1, T1, 0, T1, "第 1 名")), "总用时小者（相差 11 秒）排第 1");
  assert(slotHtml().includes(rowHtml(202, 1, T2, 0, T2, "第 2 名")), "总用时长者排第 2，不被浮点误判并列");
  // 给领先者加 11 秒罚秒：调整后用时精确相等（T1+11 == T2），应并列第 1 并跳号。
  r = savePenalty(201, "11", "大秒数罚秒");
  assert(r.error.hidden, "大秒数场景下罚秒保存成功");
  assert(slotHtml().includes(rowHtml(201, 1, T1, 11, T2, "第 1 名")), "201 加 11 秒后与 202 精确并列第 1");
  assert(slotHtml().includes(rowHtml(202, 1, T2, 0, T2, "第 1 名")), "202 并列第 1");
  assert(!slotHtml().includes("第 2 名"), "大整数并列同样跳号：不存在第 2 名");
  server.raw = null;

  console.log(failures === 0 ? "\nALL RANKING SCENARIOS PASSED" : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
