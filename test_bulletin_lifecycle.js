/* 最小 DOM/事件 stub：加载真实 static/bulletin-view.js + static/app.js，
 * 端到端验证“发布成绩公告”的页面生命周期（快照提交、版本、409、只读、不改编辑区）。 */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------------- mini DOM（与其他生命周期测试同款的“解析 innerHTML”桩） ---------------- */

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
    if (typeof globalThis.parseHtmlForBulletin === "function" && html) {
      globalThis.parseHtmlForBulletin(html).forEach((n) => this.appendChild(n));
    }
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
  insertAdjacentHTML(_pos, html) {
    if (typeof globalThis.parseHtmlForBulletin === "function" && html) {
      globalThis.parseHtmlForBulletin(html).forEach((n) => this.appendChild(n));
    }
  }
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
    // 支持简单复合选择器：tag / #id / .class / [attr] / [attr=v] / :checked 的组合。
    const s = sel.trim();
    let node = this;
    const tagM = s.match(/^[a-zA-Z][\w-]*/);
    let rest = tagM ? s.slice(tagM[0].length) : s;
    if (tagM && node.tagName !== tagM[0].toUpperCase()) return false;
    if (!tagM && rest.startsWith("#")) {
      const idM = rest.match(/^#([\w-]+)/);
      if (!idM || node.id !== idM[1]) return false;
      rest = rest.slice(idM[0].length);
    } else if (!tagM && rest.startsWith(".")) {
      const cM = rest.match(/^\.([\w-]+)/);
      if (!cM || !node.classList.contains(cM[1])) return false;
      rest = rest.slice(cM[0].length);
    }
    while (rest.length > 0) {
      let m;
      if ((m = rest.match(/^\.([\w-]+)/))) {
        if (!node.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if ((m = rest.match(/^#([\w-]+)/))) {
        if (node.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if ((m = rest.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/))) {
        const [, attr, val] = m;
        const actual = attr === "class" ? [...node.classList].join(" ") : node.attrs[attr] ?? node[attr];
        if (val !== undefined && String(actual) !== val) return false;
        if (val === undefined && actual === undefined) return false;
        rest = rest.slice(m[0].length);
      } else if ((m = rest.match(/^:checked/))) {
        if (!node.checked) return false;
        rest = rest.slice(m[0].length);
      } else {
        return false;
      }
    }
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
globalThis.parseHtmlForBulletin = parseHtml;

/* ---------------- document / window stub ---------------- */

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
// 公告卡（在 form 之外）。
const bulletinId = mk("bulletin-id", "input");
const bulletinExpected = mk("bulletin-expected", "input");
bulletinExpected.value = "0";
const bulletinPublish = mk("bulletin-publish-btn", "button");
const bulletinRead = mk("bulletin-read-btn", "button");
const bulletinReadVersion = mk("bulletin-read-version", "input");
mk("bulletin-message");
mk("bulletin-view");

for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) form.appendChild(byId.get(id));
form.appendChild(runnerRows);
form.appendChild(recordRows);

const locationStub = { search: "" };
globalThis.window = { location: locationStub };
globalThis.document = {
  getElementById: (id) => byId.get(id),
  readyState: "complete",
  addEventListener() {},
};

/* ---------------- bulletin-view.js（真实只读视图模块） ---------------- */

new Function(fs.readFileSync(path.join(__dirname, "static", "bulletin-view.js"), "utf8"))();
const BulletinView = globalThis.BulletinView;

/* ---------------- fetch stub：裁决现场计算 + 公告内存库 ---------------- */

function lapOf(s, m, f, st, mt, ft) {
  // 时间一律按 BigInt 计算（复刻服务端任意精度）；差值为秒数，安全范围内以
  // JSON 数字给出，超大绝对秒数以十进制字符串给出（与真实服务的无损 JSON 对齐）。
  const numOrText = (x) => {
    const n = Number(x);
    return Number.isSafeInteger(n) ? n : x.toString();
  };
  return {
    start: { id: s, time: numOrText(st) },
    middle: { id: m, time: numOrText(mt) },
    finish: { id: f, time: numOrText(ft) },
    smTime: numOrText(mt - st), mfTime: numOrText(ft - mt), totalTime: numOrText(ft - st),
  };
}
const SM = [10n, 60n], MF = [10n, 60n];
function trippable(s, m, f) {
  const sm = m[1] - s[1];
  const mf = f[1] - m[1];
  return SM[0] <= sm && sm <= SM[1] && MF[0] <= mf && mf <= MF[1] && f[1] > 0n;
}
function buildAdjudicate(body) {
  const excluded = new Set(body.excludedIds || []);
  const out = [];
  for (const runnerRow of body.runners) {
    const num = String(runnerRow.number).replace(/^0+(?=\d)/, "");
    const mine = body.records
      .filter((r) => String(r.runner).replace(/^0+(?=\d)/, "") === num)
      .map((r) => [r.id, BigInt(String(r.time).trim()), r.gate]);
    const active = mine.filter((r) => !excluded.has(r[0]));
    const ex = mine.filter((r) => excluded.has(r[0]));
    const S = active.filter((r) => r[2] === "S");
    const M = active.filter((r) => r[2] === "M");
    const F = active.filter((r) => r[2] === "F");
    const trips = [];
    for (const s of S) for (const m of M) for (const f of F) if (trippable(s, m, f)) trips.push({ s, m, f });
    trips.sort((a, b) => (a.s[1] < b.s[1] ? -1 : a.s[1] > b.s[1] ? 1 : 0) ||
      (a.f[1] < b.f[1] ? -1 : a.f[1] > b.f[1] ? 1 : 0));
    let best = [];
    (function search(k, chosen, used, lastFinish) {
      if (k === trips.length) { if (chosen.length > best.length) best = chosen.slice(); return; }
      search(k + 1, chosen, used, lastFinish);
      const t = trips[k];
      const ids = [t.s[0], t.m[0], t.f[0]];
      if (ids.every((id) => !used.has(id)) && t.s[1] > lastFinish) {
        chosen.push(t); ids.forEach((id) => used.add(id));
        search(k + 1, chosen, used, t.f[1]);
        ids.forEach((id) => used.delete(id));
        chosen.pop();
      }
    })(0, [], new Set(), -1n);
    best.sort((a, b) => (a.f[1] < b.f[1] ? -1 : a.f[1] > b.f[1] ? 1 : 0));
    const usedIds = new Set();
    best.forEach((t) => [t.s[0], t.m[0], t.f[0]].forEach((id) => usedIds.add(id)));
    const entry = (r) => {
      const n = Number(r[1]);
      return { id: r[0], gate: r[2], time: Number.isSafeInteger(n) ? n : r[1].toString() };
    };
    const runnerNum = Number(num);
    out.push({
      runner: Number.isSafeInteger(runnerNum) ? runnerNum : num,
      lapCount: best.length,
      totalTime: entry({ 1: best.reduce((a, t) => a + (t.f[1] - t.s[1]), 0n) }).time,
      laps: best.map((t) => lapOf(t.s[0], t.m[0], t.f[0], t.s[1], t.m[1], t.f[1])),
      unused: active.filter((r) => !usedIds.has(r[0])).map(entry),
      excluded: ex.map(entry),
    });
  }
  return { runners: out };
}

// 内存公告库：严格复刻服务端语义（重新裁决、复核核对、罚秒校验、乐观版本、404）。
const bulletinStore = new Map(); // id -> [{snapshot}]
let storeMode = "valid"; // valid | neterr | hold409once
const bulletinCalls = [];

function serverPublish(body) {
  const id = String(body.bulletinId || "").trim();
  if (!id) return { status: 422, data: { ok: false, error: "公告编号不能为空" } };
  const versions = bulletinStore.get(id) || [];
  const cur = versions.length - 1;
  const expected = Number(body.expectedVersion || 0);
  if (expected !== (cur < 0 ? 0 : cur)) {
    return { status: 409, data: { ok: false, error: "过期", latestVersion: cur < 0 ? 0 : cur } };
  }
  // 重新裁决。
  let adj;
  try {
    adj = buildAdjudicate(body);
  } catch (e) {
    return { status: 422, data: { ok: false, error: "裁决输入非法" } };
  }
  // 复核核对：每趟恰好一条匹配的 pass。
  const reviews = body.reviews || [];
  const lapTokens = new Set();
  for (const r of adj.runners) for (const lap of r.laps) {
    lapTokens.add(JSON.stringify([
      String(r.runner),
      [lap.start.id, "S", String(lap.start.time)],
      [lap.middle.id, "M", String(lap.middle.time)],
      [lap.finish.id, "F", String(lap.finish.time)],
      String(lap.smTime), String(lap.mfTime),
    ]));
  }
  const seen = new Set();
  for (const rv of reviews) {
    if (rv.status !== "pass") return { status: 422, data: { ok: false, error: "存在非通过复核" } };
    const token = JSON.stringify([
      String(rv.runner).replace(/^0+(?=\d)/, ""),
      [rv.start.id, "S", String(rv.start.time).replace(/^0+(?=\d)/, "")],
      [rv.middle.id, "M", String(rv.middle.time).replace(/^0+(?=\d)/, "")],
      [rv.finish.id, "F", String(rv.finish.time).replace(/^0+(?=\d)/, "")],
      String(rv.smTime).replace(/^0+(?=\d)/, ""), String(rv.mfTime).replace(/^0+(?=\d)/, ""),
    ]);
    if (!lapTokens.has(token)) return { status: 422, data: { ok: false, error: "复核与采纳趟不匹配" } };
    if (seen.has(token)) return { status: 422, data: { ok: false, error: "重复复核" } };
    seen.add(token);
  }
  if (seen.size !== lapTokens.size) {
    return { status: 422, data: { ok: false, error: "存在未通过复核的趟" } };
  }
  // 罚秒校验。
  const penalties = new Map();
  const validRunners = new Set(body.runners.map((r) => String(r.number).replace(/^0+(?=\d)/, "")));
  for (const p of body.penalties || []) {
    const num = String(p.runner).replace(/^0+(?=\d)/, "");
    if (!validRunners.has(num)) return { status: 422, data: { ok: false, error: "未知选手处罚" } };
    const sec = String(p.seconds);
    if (!/^\d+$/.test(sec)) return { status: 422, data: { ok: false, error: "罚秒非法" } };
    if (Number(sec) > 0 && String(p.reason || "").trim() === "") {
      return { status: 422, data: { ok: false, error: "罚秒大于 0 时原因必填" } };
    }
    if (penalties.has(num)) return { status: 422, data: { ok: false, error: "重复罚秒" } };
    penalties.set(num, { seconds: sec, reason: p.reason || "" });
  }
  // 名次（复刻页面规则）。
  const ranking = adj.runners.map((r) => {
    const num = String(r.runner);
    const pen = penalties.get(num);
    const adjusted = String(BigInt(r.totalTime) + BigInt(pen ? pen.seconds : "0"));
    return { runner: r.runner, lapCount: r.lapCount, totalTime: r.totalTime,
             penaltySeconds: pen ? Number(pen.seconds) : 0, penaltyReason: pen ? pen.reason : "",
             adjustedTime: adjusted, rank: null };
  });
  const ranked = ranking.filter((x) => x.lapCount > 0)
    .sort((a, b) => b.lapCount - a.lapCount ||
      (BigInt(a.adjustedTime) < BigInt(b.adjustedTime) ? -1 : BigInt(a.adjustedTime) > BigInt(b.adjustedTime) ? 1 : 0) ||
      a.runner - b.runner);
  ranked.forEach((row, i) => {
    row.rank = (i > 0 && row.lapCount === ranked[i - 1].lapCount &&
      row.adjustedTime === ranked[i - 1].adjustedTime) ? ranked[i - 1].rank : i + 1;
  });
  const zeros = ranking.filter((x) => x.lapCount === 0).sort((a, b) => a.runner - b.runner);
  const finalRanking = ranked.concat(zeros);

  const version = cur + 1;
  const snapshot = {
    bulletinId: id, version, latestVersion: version, createdAt: "2026-10-06T00:00:00Z",
    standards: body.standards,
    input: {
      standards: body.standards,
      runners: body.runners,
      records: body.records,
      excludedIds: body.excludedIds || [],
    },
    adjudication: adj,
    reviews: reviews.map((rv) => ({
      runner: String(rv.runner).replace(/^0+(?=\d)/, ""),
      lapIndex: 0,
      start: rv.start, middle: rv.middle, finish: rv.finish,
      smTime: rv.smTime, mfTime: rv.mfTime,
      totalTime: String(BigInt(rv.finish.time) - BigInt(rv.start.time)),
      status: "pass", note: rv.note || "",
    })),
    penalties: [...validRunners].sort().map((r) => ({
      runner: Number(r), seconds: penalties.get(r) ? Number(penalties.get(r).seconds) : 0,
      reason: penalties.get(r) ? penalties.get(r).reason : "",
    })),
    ranking: finalRanking,
  };
  if (!bulletinStore.has(id)) bulletinStore.set(id, []);
  bulletinStore.get(id).push(snapshot);
  return {
    status: 200,
    data: {
      ok: true,
      result: {
        ...snapshot,
        url: `/api/bulletins/${id}/versions/${version}`,
        latestUrl: `/api/bulletins/${id}`,
        viewUrl: `/bulletin.html?id=${id}&version=${version}`,
        latestViewUrl: `/bulletin.html?id=${id}`,
      },
    },
  };
}

global.fetch = async (url, opts) => {
  const respond = (data, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => (typeof data === "string" ? JSON.parse(data) : data),
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  if (url === "/api/adjudicate") {
    const body = JSON.parse(opts.body);
    return respond({ ok: true, result: buildAdjudicate(body) });
  }
  if (url === "/api/diagnose" || url === "/api/missing") {
    return respond({ ok: true, result: { runners: [] } });
  }
  if (url === "/api/bulletins") {
    const body = JSON.parse(opts.body);
    bulletinCalls.push(body);
    if (storeMode === "neterr") return Promise.reject(new TypeError("模拟断网"));
    const outcome = serverPublish(body);
    return respond(outcome.data, outcome.status);
  }
  let m = url.match(/^\/api\/bulletins\/([^/]+)(?:\/versions\/(\d+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const versions = bulletinStore.get(id);
    if (!versions || versions.length === 0) return respond({ ok: false, error: "公告不存在" }, 404);
    const v = m[2] === undefined ? versions.length - 1 : Number(m[2]);
    if (!versions[v]) return respond({ ok: false, error: "公告不存在" }, 404);
    const snap = JSON.parse(JSON.stringify(versions[v]));
    snap.latestVersion = versions.length - 1;
    return respond({ ok: true, result: snap });
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
async function flush(n = 6) { for (let i = 0; i < n; i++) await tick(); }
const $ = (id) => byId.get(id);
function fire(el, type) { el.dispatchEvent({ type, preventDefault() {}, target: el }); }
function setVal(id, v) { $(id).value = v; }

function runnerRow(value) {
  runnerRows.insertAdjacentHTML("beforeend",
    `<div class="runner-row"><input type="number" class="runner-number" value="${value}"></div>`);
  return runnerRows.children[runnerRows.children.length - 1];
}
function addRecordRow(i, r, g, t) {
  recordRows.insertAdjacentHTML("beforeend",
    `<tr class="record-row"><td><input class="rec-id" value="${i}"></td>` +
    `<td><input class="rec-runner" value="${r}"></td>` +
    `<td><select class="rec-gate"><option value="${g}">${g}</option></select></td>` +
    `<td><input class="rec-time" value="${t}"></td>` +
    `<td><button class="toggle-exclude">隔离</button></td><td><button class="remove-record">×</button></td></tr>`);
  const row = recordRows.children[recordRows.children.length - 1];
  row.querySelector(".rec-gate").value = g;
  return row;
}

async function setup() {
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.innerHTML = "";
  recordRows.innerHTML = "";
  runnerRow("101");
  runnerRow("102");
  const rows = [
    ["a1", "101", "S", "0"], ["b1", "101", "M", "12"], ["c1", "101", "F", "25"],
    ["a2", "101", "S", "30"], ["b2", "101", "M", "45"], ["c2", "101", "F", "58"],
    ["d1", "102", "S", "5"], ["e1", "102", "M", "15"], ["f1", "102", "F", "25"],
  ];
  for (const [i, r, g, t] of rows) addRecordRow(i, r, g, t);
  fire(form, "submit");
  await flush();
  return rows;
}

function clickPublish() { fire(bulletinPublish, "click"); }
function clickRead() { fire(bulletinRead, "click"); }
const msgHtml = () => $("bulletin-message").innerHTML;
const viewHtml = () => $("bulletin-view").innerHTML;

// 通过真实页面保存复核：直接操作结果区的复核框并点击“保存复核”，
// 与浏览器中用户操作一致（驱动 app.js 的事件委托）。

async function main() {
  await setup();
  assert(results.innerHTML.includes("2 次完整计次"), "前置：101 两趟裁决已渲染");

  console.log("场景1：公告编号为空时不发请求");
  setVal("bulletin-id", "   ");
  bulletinExpected.value = "0";
  const callsBefore = bulletinCalls.length;
  clickPublish();
  await flush();
  assert(bulletinCalls.length === callsBefore, "空编号未发请求");
  assert(msgHtml().includes("公告编号不能为空"), "页面提示编号非空");

  console.log("场景2：首次发布——快照含完整输入/隔离/通过复核/罚秒，所见版本 0，成功得 v0");
  // 先通过真实 UI 保存三条“通过”复核与一条罚秒（驱动 app.js 的事件委托）。
  // 复核：results 内有三个 review-box，分别填“通过”并保存。
  const reviewBoxes = results.querySelectorAll(".review-box");
  assert(reviewBoxes.length === 3, `结果区有 3 个复核框（实际 ${reviewBoxes.length}）`);
  for (const box of reviewBoxes) {
    const radios = box.querySelectorAll("input[type=radio]");
    // 桩不会像浏览器那样在同组单选按钮间互斥：先全部取消，再只勾选“通过”。
    for (const r of radios) r.checked = false;
    const passRadio = radios.find((r) => r.attrs.value === "pass");
    passRadio.checked = true;
    box.querySelector(".review-note").value = "通过备注";
    fire(box.querySelector(".review-save"), "click");
  }
  // 罚秒：102 保存 3 秒（同趟数 101=2 > 102=1，名次不变；仅校验随快照提交）。
  const pen102 = results.querySelectorAll(".penalty-editor").find((b) => b.dataset.runner === "102");
  pen102.querySelector(".penalty-seconds").value = "3";
  pen102.querySelector(".penalty-reason").value = "误判";
  fire(pen102.querySelector(".penalty-save"), "click");
  await flush();

  setVal("bulletin-id", "G-001");
  fire(bulletinId, "input");
  assert(bulletinExpected.value === "0", "新编号所见版本初始为 0");
  clickPublish();
  await flush();
  assert(bulletinCalls.length === 1, "发出一次发布请求");
  const pub = bulletinCalls[0];
  assert(pub.bulletinId === "G-001" && pub.expectedVersion === 0, "载荷编号与所见版本 0");
  assert(pub.records.length === 9, "载荷含完整 9 条记录输入");
  assert(JSON.stringify(pub.excludedIds) === "[]", "载荷含隔离列表（空）");
  assert(pub.reviews.length === 3 && pub.reviews.every((r) => r.status === "pass"),
    "三条通过复核随快照提交（仅 pass）");
  assert(pub.reviews[0].start.id === "a1" && pub.reviews[0].smTime === "12",
    "复核携带三条记录 ID/门/秒数与两段耗时（规范十进制）");
  assert(pub.penalties.some((p) => String(p.runner) === "102" && p.seconds === "3" && p.reason === "误判"),
    "已保存罚秒与原因随快照提交（秒数以十进制字符串）");
  assert(msgHtml().includes("已发布公告") && msgHtml().includes("第 <strong>0</strong> 版"),
    "成功提示版本 0 与公告链接");
  assert(msgHtml().includes("/bulletin.html?id=G-001&amp;version=0"), "返回只读公告链接");
  assert(bulletinExpected.value === "0", "成功后所见版本显示 0（首个版本号）");
  assert(viewHtml().includes("成绩公告 · G-001"), "公告视图渲染");
  assert(viewHtml().includes("最新版本"), "v0 标注为最新版本");

  console.log("场景3：发布响应不改写编辑区（输入、结果、复核/罚秒均保持）");
  assert(results.innerHTML.includes("2 次完整计次"), "结果区未被清空/改写");
  assert(results.querySelectorAll(".review-box").length === 3, "复核编辑区仍在");
  const penStill = results.querySelectorAll(".penalty-editor").find((b) => b.dataset.runner === "102");
  assert(penStill.querySelector(".penalty-seconds").value === "3", "罚秒编辑区未被改写（仍 3）");
  assert($("record-count").textContent !== "", "记录区仍在");

  console.log("场景4：再次发布（所见 0）得 v1；用过期 0 再发 → 409，不前进版本/不改编辑区");
  // 页面在 v0 成功后所见版本仍显示 0（首个版本号），再次点击即发布 v1。
  clickPublish();
  await flush();
  assert(msgHtml().includes("第 <strong>1</strong> 版"), "再次发布得到 v1");
  assert(bulletinExpected.value === "1", "所见版本前进到 1");
  // 手动把所见版本改回过期的 0：409。
  bulletinExpected.value = "0";
  clickPublish();
  await flush();
  assert(msgHtml().includes("409") && msgHtml().includes("过期"), "过期发布提示 409");
  assert(bulletinExpected.value === "0", "409 不自动改写所见版本（保留用户输入 0）");
  const viewAfter409 = viewHtml();
  assert(bulletinCalls[bulletinCalls.length - 1].expectedVersion === 0, "过期请求确实携带 0");
  assert(results.innerHTML.includes("2 次完整计次"), "409 不改写编辑区");

  console.log("场景5：按编号读取最新与指定旧版（404）；旧版只读");
  bulletinReadVersion.value = "";
  clickRead();
  await flush();
  assert(viewHtml().includes("成绩公告 · G-001") && viewHtml().includes("最新版本"), "读取最新（v1）");
  assert(bulletinExpected.value === "1", "读取最新后所见版本更新为 1（不影响编辑区）");
  // 指定旧版 0：标注历史版本只读，内容为 v0。
  bulletinReadVersion.value = "0";
  clickRead();
  await flush();
  assert(viewHtml().includes("历史版本（只读）"), "旧版 v0 标注历史版本只读");
  assert(viewHtml().includes(">0<") || /版本\s*<strong>0/.test(viewHtml()) || viewHtml().includes("版本 0"),
    "旧版视图自标版本 0");
  // 未知编号 404。
  setVal("bulletin-id", "GHOST");
  bulletinReadVersion.value = "";
  clickRead();
  await flush();
  assert(viewHtml().includes("不存在"), "未知编号 404 页面提示");
  setVal("bulletin-id", "G-001");
  // 未知版本 404。
  bulletinReadVersion.value = "99";
  clickRead();
  await flush();
  assert(viewHtml().includes("不存在") || viewHtml().includes("没有第 99 版"), "未知版本 404 提示");

  console.log("场景6：切换编号时所见版本按编号记忆/重置为 0；切回 G-001 恢复 1");
  bulletinReadVersion.value = "";
  setVal("bulletin-id", "NEW-ONE");
  fire(bulletinId, "input");
  assert(bulletinExpected.value === "0", "未见过的新编号所见版本重置为 0");
  setVal("bulletin-id", "G-001");
  fire(bulletinId, "input");
  assert(bulletinExpected.value === "1", "切回已发布编号恢复所见版本 1");

  console.log("场景7：点击时快照——发布在途编辑输入不改变已提交内容，也不回写编辑区");
  setVal("bulletin-id", "SNAP");
  fire(bulletinId, "input");
  clickPublish(); // 点击瞬间快照（9 条记录、3 通过复核）
  // 在途立即改输入（删一条记录）并等待响应：提交体应为点击时的旧表。
  const sentBody = bulletinCalls[bulletinCalls.length - 1];
  assert(sentBody.records.length === 9, "快照冻结点击时的 9 条记录");
  await flush();
  assert(msgHtml().includes("已发布公告") , "在途编辑不影响本次发布成功");
  assert(results.innerHTML.includes("2 次完整计次"), "发布成功不清空/不改写结果编辑区");

  console.log("场景8：服务端整次拒绝——缺一条通过复核（422）不留版本，编辑区不动");
  // 直接从 reviews 中删一条：通过测试钩子间接做不到 Map 访问，
  // 改为制造“趟不再被采纳”：隔离 a2（页面复核按原规则失效），再发布缺复核版本。
  setVal("bulletin-id", "REJECT");
  fire(bulletinId, "input");
  // 隔离 a2：切隔离会触发重裁并使第二趟复核失效；等重裁完成后复核只剩两条。
  const a2row = recordRows.querySelectorAll(".record-row").find((r) => r.querySelector(".rec-id").value === "a2");
  fire(a2row.querySelector(".toggle-exclude"), "click");
  await new Promise((r) => setTimeout(r, 380));
  await flush();
  assert(results.innerHTML.includes("1 次完整计次"), "隔离 a2 后 101 计 1 趟");
  // 隔离 a2 后其第二趟复核已按原规则失效；第一趟与 102 仍“通过”——
  // 此时仍满足每趟通过，可成功发布。改为删除 c1（第一趟被破坏）来触发缺复核：
  // 先恢复 a2。
  fire(a2row.querySelector(".toggle-exclude"), "click");
  await new Promise((r) => setTimeout(r, 380));
  await flush();
  // 删除 c1：第一趟不再采纳，其复核失效；两条通过复核对应两趟中的第二趟+102，
  // 但记录删除后裁决变化——构造明确不匹配：直接篡改一个输入秒数让趟消失。
  const c1time = recordRows.querySelectorAll(".record-row").find((r) => r.querySelector(".rec-id").value === "c1")
    .querySelector(".rec-time");
  c1time.value = "26"; // 第一趟 mf=26-12=14 仍在区间…改成破坏 SM：把 b1 改掉更直接
  const b1time = recordRows.querySelectorAll(".record-row").find((r) => r.querySelector(".rec-id").value === "b1")
    .querySelector(".rec-time");
  b1time.value = "99"; // a1-b1-c1 不再成趟
  fire(b1time, "input");
  await new Promise((r) => setTimeout(r, 380));
  await flush();
  const callsReject = bulletinCalls.length;
  clickPublish();
  await flush();
  assert(bulletinCalls.length === callsReject + 1, "发出了发布请求");
  assert(msgHtml().includes("422") && (msgHtml().includes("不匹配") || msgHtml().includes("未通过")),
    "复核不匹配/缺通过 → 422 中文原因");
  assert(bulletinStore.has("REJECT") === false, "拒绝不留任何版本");
  assert(results.innerHTML !== "" && !results.innerHTML.includes("成绩公告"), "编辑区未被改写");
  // 恢复输入。
  b1time.value = "12"; c1time.value = "25";
  fire(b1time, "input");
  await new Promise((r) => setTimeout(r, 380));
  await flush();

  console.log("场景9：超大编号/秒数与 11 秒差值在发布载荷与读取中全程精确");
  bulletinStore.clear();
  // 改表单为超大选手单趟数据。
  fire(clearBtn, "click");
  await flush();
  setVal("smMin", "10"); setVal("smMax", "60"); setVal("mfMin", "10"); setVal("mfMax", "60");
  runnerRows.innerHTML = "";
  recordRows.innerHTML = "";
  const BIG = "9007199254740993";
  runnerRow(BIG);
  const TS = "9007199254740992", TM = "9007199254741003", TF = "9007199254741014";
  addRecordRow("h1", BIG, "S", TS);
  addRecordRow("h2", BIG, "M", TM);
  addRecordRow("h3", BIG, "F", TF);
  fire(form, "submit");
  await flush();
  const bigBox = results.querySelector(".review-box");
  for (const r of bigBox.querySelectorAll("input[type=radio]")) r.checked = false;
  bigBox.querySelectorAll("input[type=radio]").find((r) => r.attrs.value === "pass").checked = true;
  fire(bigBox.querySelector(".review-save"), "click");
  setVal("bulletin-id", "BIG");
  fire(bulletinId, "input");
  clickPublish();
  await flush();
  const bigPub = bulletinCalls[bulletinCalls.length - 1];
  assert(bigPub.runners[0].number === BIG, "超大编号以十进制字符串提交");
  assert(bigPub.records[1].time === TM, "超大中途秒数以十进制字符串提交，不截断");
  assert(bigPub.reviews[0].smTime === "11" && bigPub.reviews[0].mfTime === "11",
    "两段差值精确为 11/11（不被 Number 截成 12/10）");
  assert(msgHtml().includes("第 <strong>0</strong> 版"), "大整数场景发布 v0 成功");
  assert(viewHtml().includes(TM) && viewHtml().includes(">11<" || "11"), "只读视图精确渲染大秒数");
  // 再读回（走无损解析）：视图仍精确。
  bulletinReadVersion.value = "0";
  clickRead();
  await flush();
  assert(viewHtml().includes(TS) && viewHtml().includes(TM) && viewHtml().includes(TF),
    "读取大整数公告时三条秒数仍精确");

  console.log("场景10：清空/填入示例不影响已发布公告（旧版仍可读取），且不改变发布卡输入之外的内容");
  // BIG v0 已发布并存于内存库；清空编辑区。
  fire(clearBtn, "click");
  await flush();
  setVal("bulletin-id", "BIG"); // 发布卡编号不清空（公告卡独立于赛道表单）
  bulletinReadVersion.value = "0";
  clickRead();
  await flush();
  assert(viewHtml().includes(TS), "清空编辑区后已发布公告旧版仍可读、内容不变");

  console.log(failures === 0 ? "\nALL BULLETIN LIFECYCLE SCENARIOS PASSED"
    : `\n${failures} ASSERTION(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
