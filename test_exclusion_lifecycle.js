/* 最小 DOM/事件 stub：加载真实 static/app.js，端到端验证可疑记录隔离的生命周期。 */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------------- mini DOM（与诊断生命周期测试同款的“解析 innerHTML”桩） ---------------- */

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
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "id") this.id = v;
    if (k.startsWith("data-")) this.dataset[k.slice(5)] = v;
  }
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
    const selfClose = t.endsWith("//>");
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
      if (v === undefined) {
        el.attrs[k] = true;
        if (k === "disabled") el.disabled = true;
        if (k === "hidden") el.hidden = true;
        if (k === "checked") el.checked = true;
        continue;
      }
      el.attrs[k] = v;
      if (k === "class") v.split(/\s+/).forEach((c) => c && el.classList.add(c));
      else if (k === "id") el.id = v;
      else if (k.startsWith("data-")) {
        const dk = k.slice(5);
        el.dataset[dk] = v;
        el.dataset[dk.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      }
      else if (k === "value") el.value = v;
      else if (k === "disabled") el.disabled = v !== "false";
      else if (k === "hidden") el.hidden = true;
      else if (k === "checked") el.checked = true;
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
const errorBox = mk("error-box"); const pendingHint = mk("pending-hint");
const results = mk("results");
mk("diagnosis-box").hidden = true;
mk("missing-box").hidden = true;
for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) mk(id, "input");
const sampleBtn = mk("sample-btn", "button");
const clearBtn = mk("clear-btn", "button");

for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) form.appendChild(byId.get(id));
form.appendChild(runnerRows);
form.appendChild(recordRows);

global.document = { getElementById: (id) => byId.get(id) };

/* ---------------- fetch stub：依据请求中的 excludedIds 现场计算结果 ---------------- */

function lapOf(s, m, f, st, mt, ft) {
  return {
    start: { id: s, time: st }, middle: { id: m, time: mt }, finish: { id: f, time: ft },
    smTime: mt - st, mfTime: ft - mt, totalTime: ft - st,
  };
}

const SM = [10, 60], MF = [10, 60];

// 依据当前请求现场构造“裁决/诊断/漏读”结果：只使用未隔离记录。
// 固定数据：101 的 a1-b1-c1(0/12/25) 与 a2-b2-c2(30/45/58) 为两趟；
// sx@130 是无法成趟的可疑 S；xm@200 孤立；102 的 d1-e1-f1(5/15/25) 一趟。
function trippable(s, m, f) {
  return SM[0] <= m[1] - s[1] && m[1] - s[1] <= SM[1] &&
    MF[0] <= f[1] - m[1] && f[1] - m[1] <= MF[1] && f[1] > 0;
}

function activeTrips(active) {
  // 小规模数据：枚举该选手全部合法趟，再暴力搜索最长不重叠链
  // （记录不共用、相邻趟起点严格晚于前一趟终点）。
  const S = active.filter((r) => r[2] === "S");
  const M = active.filter((r) => r[2] === "M");
  const F = active.filter((r) => r[2] === "F");
  const trips = [];
  for (const s of S) for (const m of M) for (const f of F) {
    if (trippable(s, m, f)) trips.push({ s, m, f });
  }
  // 按起点升序枚举选/不选，保证时间分离的约束可直接判定。
  trips.sort((a, b) => a.s[1] - b.s[1] || a.f[1] - b.f[1]);
  let best = [];
  function search(k, chosen, used, lastFinish) {
    if (k === trips.length) {
      if (chosen.length > best.length) best = chosen.slice();
      return;
    }
    search(k + 1, chosen, used, lastFinish);
    const t = trips[k];
    const ids = [t.s[0], t.m[0], t.f[0]];
    if (ids.every((id) => !used.has(id)) && t.s[1] > lastFinish) {
      chosen.push(t); ids.forEach((id) => used.add(id));
      search(k + 1, chosen, used, t.f[1]);
      ids.forEach((id) => used.delete(id));
      chosen.pop();
    }
  }
  search(0, [], new Set(), -1);
  // 输出按终点时间（计次顺序）排列。
  best.sort((a, b) => a.f[1] - b.f[1]);
  return { best };
}

function buildAdjudicate(body) {
  const excluded = new Set(body.excludedIds || []);
  const out = [];
  for (const runnerRow of body.runners) {
    const num = String(runnerRow.number).replace(/^0+(?=\d)/, "");
    const mine = body.records
      .filter((r) => String(r.runner).replace(/^0+(?=\d)/, "") === num)
      .map((r) => [r.id, parseInt(r.time, 10), r.gate]);
    const activeRecs = mine.filter((r) => !excluded.has(r[0]));
    const excludedRecs = mine.filter((r) => excluded.has(r[0]));
    const { best } = activeTrips(activeRecs);
    const used = new Set();
    best.forEach((t) => [t.s[0], t.m[0], t.f[0]].forEach((id) => used.add(id)));
    const laps = best.map((t) => lapOf(t.s[0], t.m[0], t.f[0], t.s[1], t.m[1], t.f[1]));
    const entry = (r) => ({ id: r[0], gate: r[2], time: r[1] });
    out.push({
      runner: Number(num),
      lapCount: best.length,
      totalTime: best.reduce((a, t) => a + (t.f[1] - t.s[1]), 0),
      laps,
      unused: activeRecs.filter((r) => !used.has(r[0])).map(entry),
      excluded: excludedRecs.map(entry),
    });
  }
  return { runners: out };
}

function buildDiagnose(body) {
  const adj = buildAdjudicate(body);
  return {
    runners: adj.runners.map((r) => ({
      runner: r.runner,
      lapCount: r.lapCount,
      totalTime: r.totalTime,
      diagnoses: r.unused.map((u) => ({
        id: u.id, gate: u.gate, time: u.time, classification: "unusable",
      })),
    })),
  };
}

const calls = { adjudicate: [], diagnose: [], missing: [] };
const server = { mode: "valid", hold: null };

global.fetch = async (url, opts) => {
  const respond = (data, ok = true, status = 200) => ({
    ok, status,
    json: async () => (typeof data === "string" ? JSON.parse(data) : data),
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const parsed = JSON.parse(opts.body);
  if (url === "/api/adjudicate") {
    calls.adjudicate.push(parsed);
    if (server.mode === "invalid") return respond({ ok: false, error: "模拟非法输入" }, false, 422);
    if (server.mode === "neterr") return Promise.reject(new TypeError("模拟断网"));
    if (server.mode === "hold") {
      return server.hold.then(
        (d) => respond(d, true, 200),
        (err) => Promise.reject(err)
      );
    }
    return respond({ ok: true, result: buildAdjudicate(parsed) });
  }
  if (url === "/api/diagnose") {
    calls.diagnose.push(parsed);
    if (server.mode === "invalid") return respond({ ok: false, error: "模拟诊断拒绝" }, false, 422);
    return respond({ ok: true, result: buildDiagnose(parsed) });
  }
  if (url === "/api/missing") {
    calls.missing.push(parsed);
    return respond({ ok: true, result: { runners: buildAdjudicate(parsed).runners
      .map((r) => ({ runner: r.runner, lapCount: r.lapCount, windows: [] })) } });
  }
  throw new Error(`unexpected url ${url}`);
};

/* ---------------- 加载真实 app.js ---------------- */

new Function(fs.readFileSync(path.join(__dirname, "static", "app.js"), "utf8"))();

/* ---------------- 测试辅助 ---------------- */

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓", msg);
  else { failures++; console.error("  ✗", msg); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = (id) => byId.get(id);
function setVal(id, v) { $(id).value = v; }
function fire(el, type) { el.dispatchEvent({ type, preventDefault() {}, target: el }); }
async function flush(n = 6) { for (let i = 0; i < n; i++) await tick(); }
async function adjudicate() { fire(form, "submit"); await flush(); }

function setRow(ids, runner, gate, time) {
  for (const row of recordRows.querySelectorAll(".record-row")) {
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
function excludeBtn(id) { return findRow(id).querySelector(".toggle-exclude"); }
function clickExclude(id) { fire(excludeBtn(id), "click"); }
function removeRow(id) { fire(findRow(id).querySelector(".remove-record"), "click"); }
const rendered = () => results.innerHTML;
const lastAdjBody = () => calls.adjudicate[calls.adjudicate.length - 1];

async function setup() {
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = "101";
  fire(runnerRows, "input");
  // 初始 2 空行；需要 10 条记录（101 八条 + 102 三条 = 11），补到 11 行。
  for (let i = 0; i < 9; i++) fire(addRecord, "click");
  const rows = [
    ["a1", "101", "S", "0"], ["b1", "101", "M", "12"], ["c1", "101", "F", "25"],
    ["a2", "101", "S", "30"], ["b2", "101", "M", "45"], ["c2", "101", "F", "58"],
    ["sx", "101", "S", "130"], ["xm", "101", "M", "200"],
    ["d1", "102", "S", "5"], ["e1", "102", "M", "15"], ["f1", "102", "F", "25"],
  ];
  for (const [i, r, g, t] of rows) setRow(i, r, g, t);
  fire(addRunner, "click");
  [...runnerRows.querySelectorAll(".runner-number")].find((e) => e.value === "").value = "102";
  fire(runnerRows, "input");
  await adjudicate();
}

async function main() {
  console.log("场景0：初始完整行的隔离按钮可用且文案为“隔离”，空行禁用");
  await setup();
  assert(rendered().includes("a2"), "初始两趟裁决渲染");
  assert(excludeBtn("a1").disabled === false && excludeBtn("a1").textContent === "隔离",
    "完整记录行显示“隔离”按钮且可点");
  const emptyRow = [...recordRows.querySelectorAll(".record-row")]
    .find((r) => r.querySelector(".rec-id").value === "");
  if (emptyRow) {
    assert(emptyRow.querySelector(".toggle-exclude").disabled, "空行的隔离按钮禁用");
  } else {
    assert(true, "（无空行）");
  }

  console.log("场景1：隔离可疑记录 sx → 自动重裁、载荷含 excludedIds、结果单列");
  clickExclude("sx");
  assert(excludeBtn("sx").textContent === "重新纳入", "按钮切换为“重新纳入”");
  assert(findRow("sx").classList.contains("excluded"), "隔离行添加 excluded 样式");
  await flush(); await new Promise((r) => setTimeout(r, 380)); await flush();
  let b = lastAdjBody();
  assert(JSON.stringify(b.excludedIds) === JSON.stringify(["sx"]), "裁决载荷 excludedIds=[sx]");
  assert(rendered().includes("隔离记录"), "结果出现“隔离记录”分列");
  assert(/隔离记录[\s\S]*sx/.test(rendered()), "sx 出现在隔离记录列");
  // 普通未采纳列与隔离列分别渲染：截取到“隔离记录”小节之前的部分不应出现 sx。
  const beforeExcluded = rendered().split("隔离记录")[0];
  assert(!/未采纳记录[\s\S]*sx/.test(beforeExcluded), "sx 不出现在普通未采纳列");
  assert(calls.diagnose.length === 0 && calls.missing.length === 0,
    "切换隔离不会自动发诊断/漏读请求");

  console.log("场景2：诊断与漏读请求也携带 excludedIds，且不含隔离记录");
  globalThis.__runDiagnosisForTest();
  await flush();
  assert(JSON.stringify(calls.diagnose[calls.diagnose.length - 1].excludedIds) === JSON.stringify(["sx"]),
    "诊断请求携带同样的 excludedIds");
  globalThis.__runMissingForTest();
  await flush();
  assert(JSON.stringify(calls.missing[calls.missing.length - 1].excludedIds) === JSON.stringify(["sx"]),
    "漏读请求携带同样的 excludedIds");

  console.log("场景3：隔离采纳记录 a2 → 计次数下降、分列正确，重新纳入恢复");
  clickExclude("a2");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  b = lastAdjBody();
  assert(JSON.stringify(b.excludedIds) === JSON.stringify(["a2", "sx"]),
    "excludedIds 按记录行顺序为 [a2, sx]");
  assert(rendered().includes("1 次完整计次"), "隔离 a2 后选手 101 降为 1 次");
  assert(/隔离记录[\s\S]*a2/.test(rendered()), "a2 出现在隔离列");
  // 重新纳入 a2：恢复两趟，a2 离开隔离列。
  clickExclude("a2");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(JSON.stringify(lastAdjBody().excludedIds) === JSON.stringify(["sx"]),
    "重新纳入 a2 后只剩 sx 隔离");
  assert(rendered().includes("2 次完整计次"), "恢复两趟");

  console.log("场景4：全部隔离按零次处理，原始读数仍在表中");
  for (const id of ["sx", "a1", "b1", "c1", "a2", "b2", "c2", "xm"]) {
    if (excludeBtn(id).textContent === "隔离") clickExclude(id);
  }
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(rendered().includes("0 次完整计次"), "101 全部隔离：按零次处理");
  const ids = ["sx", "a1", "b1", "c1", "a2", "b2", "c2", "xm"];
  assert(ids.every((id) => findRow(id)), "八条原始读数仍保留在记录表中，未删除");
  assert(ids.every((id) => excludeBtn(id).textContent === "重新纳入"), "八条全部处于隔离态");
  // 102 未隔离仍一趟。
  assert(/选手 102[\s\S]*1 次完整计次/.test(rendered()), "102 不受影响仍为 1 次");
  // 全部重新纳入恢复两趟。
  for (const id of ids) clickExclude(id);
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(JSON.stringify(lastAdjBody().excludedIds) === "[]", "全部重新纳入：excludedIds 为空");
  assert(rendered().includes("2 次完整计次"), "恢复两趟");

  console.log("场景5：任一绑定值改变即解除（改回不恢复），前导零等值保留");
  clickExclude("b1");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(JSON.stringify(lastAdjBody().excludedIds) === JSON.stringify(["b1"]), "b1 已隔离");
  const t = findRow("b1").querySelector(".rec-time");
  t.value = "13";
  fire(t, "input"); // 绑定秒数变化：立即解除
  assert(excludeBtn("b1").textContent === "隔离", "改绑定秒数：立即解除隔离");
  t.value = "12";
  fire(t, "input"); // 改回不恢复
  assert(excludeBtn("b1").textContent === "隔离", "秒数改回原值不恢复隔离");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(lastAdjBody().excludedIds.length === 0, "自动重裁载荷不含 b1（改回不恢复）");
  // 前导零等值写法不算改变：编号 0101、秒数 0013(=13 不相关) —— 用 b1 重新隔离后改 0101。
  clickExclude("b1");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  const runnerInp = findRow("b1").querySelector(".rec-runner");
  runnerInp.value = "0101";
  fire(runnerInp, "input");
  assert(excludeBtn("b1").textContent === "重新纳入", "编号改写为前导零等值 0101：隔离保留");
  const timeInp = findRow("b1").querySelector(".rec-time");
  timeInp.value = "012";
  fire(timeInp, "input");
  assert(excludeBtn("b1").textContent === "重新纳入", "秒数改写为前导零等值 012：隔离保留");
  // 门改变即解除，改回不恢复。
  const gateSel = findRow("b1").querySelector(".rec-gate");
  gateSel.value = "F";
  fire(gateSel, "change");
  assert(excludeBtn("b1").textContent === "隔离", "门改变：立即解除");
  gateSel.value = "M";
  fire(gateSel, "change");
  assert(excludeBtn("b1").textContent === "隔离", "门改回不恢复");

  console.log("场景6：删行即解除（改回同 ID 不恢复）；重排与无关编辑保留");
  clickExclude("c1");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(excludeBtn("c1").textContent === "重新纳入", "前置：c1 已隔离");
  removeRow("c1");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(!lastAdjBody().excludedIds.includes("c1"), "删除 c1：隔离解除且载荷不含 c1");
  // 重新添加同 ID 同内容行：不恢复。
  fire(addRecord, "click");
  setRow("c1", "101", "F", "25");
  fire(findRow("c1").querySelector(".rec-id"), "input");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(excludeBtn("c1").textContent === "隔离", "补回同 ID 记录不恢复隔离");
  assert(!lastAdjBody().excludedIds.includes("c1"), "载荷中仍无 c1");
  // 重排 + 无关新增：sx 的隔离保留。确认 sx 处于隔离态（场景4已全部重新纳入，这里重新隔离）。
  if (excludeBtn("sx").textContent === "隔离") clickExclude("sx");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  const sxStateBefore = excludeBtn("sx").textContent;
  const sxRow = findRow("sx");
  recordRows.appendChild(sxRow);
  fire(sxRow.querySelector(".rec-id"), "input");
  assert(excludeBtn("sx").textContent === sxStateBefore, "重排行不改变 sx 隔离状态");
  // 无关新增：给 102 加一条无法成趟的 S 记录（时间足够晚，不进入任何趟）。
  const freeBefore = recordRows.querySelectorAll(".record-row").length;
  if (freeBefore < 40) {
    fire(addRecord, "click");
    setRow("zz9", "102", "S", "500");
    fire(findRow("zz9").querySelector(".rec-id"), "input");
    await new Promise((r) => setTimeout(r, 380)); await flush();
    assert(lastAdjBody().excludedIds.includes("sx"), "重排+无关新增后 sx 隔离保留");
    removeRow("zz9");
    await new Promise((r) => setTimeout(r, 380)); await flush();
  } else {
    assert(lastAdjBody().excludedIds.includes("sx"), "重排后 sx 隔离保留");
  }

  console.log("场景7：切换立即清除旧结果/诊断/漏读窗口，迟到响应不回写");
  // 先在合法结果上产生诊断与漏读结果。
  globalThis.__runDiagnosisForTest();
  await flush();
  globalThis.__runMissingForTest();
  await flush();
  assert(!$("diagnosis-box").hidden && !$("missing-box").hidden, "前置：诊断与漏读卡可见");
  // 让下一次裁决请求挂起，再切换隔离：切换安排的防抖重裁将携带 xm 挂起。
  let resolveHold;
  server.mode = "hold";
  server.hold = new Promise((res) => { resolveHold = res; });
  clickExclude("xm"); // 此刻立即清除结果区与诊断/漏读
  assert(rendered() === "", "切换后旧结果立即清空（等待重裁）");
  assert($("diagnosis-box").hidden, "切换后诊断卡立即隐藏");
  assert($("missing-box").hidden, "切换后漏读卡立即隐藏");
  await new Promise((r) => setTimeout(r, 380)); await flush(); // 等防抖触发挂起请求
  assert(lastAdjBody().excludedIds.includes("xm"), "挂起的重裁请求载荷已含 xm");
  resolveHold({ ok: true, result: buildAdjudicate(lastAdjBody()) });
  await flush();
  server.mode = "valid";
  assert(lastAdjBody().excludedIds.includes("xm"), "最新载荷含 xm");
  assert(rendered().includes("隔离记录"), "最新结果正常渲染隔离列");
  // 迟到失败（断网）同样不回写：重新纳入 xm 的防抖请求挂起后，再编辑输入使版本前进，
  // 随后让挂起请求以断网失败——该迟到失败不得覆盖新状态。
  let rejectHold;
  const held = new Promise((_res, rej) => { rejectHold = rej; });
  held.catch(() => {}); // 挂起 Promise 被 reject 时避免 Node 未处理拒绝告警（应用侧经 fetch 捕获）
  server.mode = "hold";
  server.hold = held;
  clickExclude("xm"); // 重新纳入，防抖请求将挂起
  assert($("diagnosis-box").hidden && $("missing-box").hidden, "再次切换仍清除诊断/漏读");
  await new Promise((r) => setTimeout(r, 380)); await flush(); // 等防抖触发挂起请求
  assert(!lastAdjBody().excludedIds.includes("xm"), "重新纳入的挂起请求载荷已不含 xm");
  setVal("mfMax", "59");
  fire($("mfMax"), "change"); // 版本前进，挂起请求作废
  rejectHold(new TypeError("迟到断网"));
  await flush();
  assert(errorBox.hidden, "迟到断网不在新状态上显示错误");
  server.mode = "valid";
  setVal("mfMax", "60");
  fire($("mfMax"), "change");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(rendered().includes("2 次完整计次"), "迟到断网不回写；恢复合法输入后两趟结果回来");

  console.log("场景8：隔离不释放罚秒；复核沿原规则（隔离的趟失效，纳入不恢复）");
  // 罚秒保存在 101 上：隔离/纳入其记录不影响罚秒。
  const penalties = globalThis.__penaltiesForTest;
  penalties.set("101", { seconds: 7, reason: "设备故障" });
  clickExclude("a1");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(penalties.get("101") && penalties.get("101").seconds === 7,
    "隔离 101 的记录不释放 101 的罚秒");
  clickExclude("a1");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(penalties.get("101") && penalties.get("101").seconds === 7, "重新纳入后罚秒仍在");
  penalties.delete("101");

  console.log("场景9：清空 / 填入示例清除全部隔离");
  if (excludeBtn("sx").textContent === "隔离") clickExclude("sx");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(globalThis.__exclusionsForTest.size === 1, "前置：存在 1 条隔离");
  fire(clearBtn, "click");
  await flush();
  assert(globalThis.__exclusionsForTest.size === 0, "清空后隔离全部清除");
  // 唯一空行的按钮为禁用态。
  const onlyRow = recordRows.querySelectorAll(".record-row")[0];
  assert(onlyRow.querySelector(".toggle-exclude").disabled, "清空后空行按钮禁用");
  fire(sampleBtn, "click");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(globalThis.__exclusionsForTest.size === 0, "填入示例后无隔离");
  // 示例记录行的按钮全部可用（完整行）。
  const sampleRows = recordRows.querySelectorAll(".record-row");
  assert(sampleRows.every((r) => r.querySelector(".toggle-exclude").disabled === false),
    "示例完整行的隔离按钮均可用");

  console.log("场景10：超过 2^53 的秒数与编号——隔离绑定按精确整数比较，不被 Number 截断")
  ;
  fire(clearBtn, "click");
  await flush();
  const BIG = "9007199254740993";
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.querySelector(".runner-number").value = BIG;
  fire(runnerRows, "input");
  fire(addRecord, "click"); fire(addRecord, "click"); // 清空后 1 行 → 共 3 行
  const TS = "9007199254740992", TM = "9007199254741003", TF = "9007199254741014";
  setRow("h1", BIG, "S", TS);
  setRow("h2", BIG, "M", TM);
  setRow("h3", BIG, "F", TF);
  clickExclude("h2");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(excludeBtn("h2").textContent === "重新纳入", "大秒数记录 h2 已隔离");
  const bodyH = lastAdjBody();
  assert(JSON.stringify(bodyH.excludedIds) === JSON.stringify(["h2"]),
    "隔离大秒数记录：载荷 excludedIds=[h2]");
  assert(
    bodyH.records.find((r) => r.id === "h2").time === TM,
    "原始秒数 " + TM + " 仍以十进制字符串在载荷中无损发送"
  );
  // 把秒数改成相差 1 的相邻大整数：Number 精度下会混同，但精确比较应解除隔离。
  const h2Time = findRow("h2").querySelector(".rec-time");
  h2Time.value = "9007199254741004";
  fire(h2Time, "input");
  assert(excludeBtn("h2").textContent === "隔离", "大秒数相差 1：精确比较判定绑定已变，解除隔离");
  h2Time.value = TM;
  fire(h2Time, "input");
  assert(excludeBtn("h2").textContent === "隔离", "大秒数改回原值不恢复隔离");

  console.log("场景11：重复 ID（输入非法）期间隔离行不唯一定位，重号解除后不自动恢复");
  fire(addRecord, "click");
  setRow("h2", BIG, "M", TM); // 与已有 h2 同 ID（findRow 取第一行）
  fire(findRow("h2").querySelector(".rec-id"), "input");
  // 存在两行 h2：隔离集合中若有 h2 绑定应被剪枝（h2 此前已解除，断言无残留）。
  assert(globalThis.__exclusionsForTest.size === 0, "重号期间无残留隔离");
  // 隔离唯一行 h1，再用另一空行制造同 ID 的第二行 h1。
  clickExclude("h1");
  await new Promise((r) => setTimeout(r, 380)); await flush();
  assert(globalThis.__exclusionsForTest.size === 1, "前置：h1 已隔离");
  // 删掉刚才用于重号 h2 的行（记录行尾，内容为 h2），腾出一条空行。
  const dupH2Rows = recordRows.querySelectorAll(".record-row")
    .filter((r) => r.querySelector(".rec-id").value === "h2");
  assert(dupH2Rows.length === 2, "存在两行 h2");
  fire(dupH2Rows[1].querySelector(".remove-record"), "click");
  // 新加一条空行并填入与 h1 完全相同的内容，制造同 ID 第二行。
  fire(addRecord, "click");
  const blank = [...recordRows.querySelectorAll(".record-row")]
    .find((r) => r.querySelector(".rec-id").value === "");
  assert(blank, "存在用于制造重号的空行");
  blank.querySelector(".rec-id").value = "h1";
  blank.querySelector(".rec-runner").value = BIG;
  blank.querySelector(".rec-gate").value = "S";
  blank.querySelector(".rec-time").value = TS;
  fire(blank.querySelector(".rec-id"), "input");
  assert(globalThis.__exclusionsForTest.size === 0,
    "出现同 ID 第二行：h1 隔离立即解除（无法唯一定位）");
  fire(blank.querySelector(".remove-record"), "click");
  assert(globalThis.__exclusionsForTest.size === 0,
    "删除重复行使 ID 重新唯一后不自动恢复");

  console.log(failures === 0 ? "\nALL EXCLUSION LIFECYCLE SCENARIOS PASSED"
    : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
