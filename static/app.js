"use strict";

const MAX_RUNNERS = 3;
const MAX_RECORDS = 40;
const GATE_LABELS = { S: "起点 S", M: "中途门 M", F: "终点 F" };

/* ---------- 选手行编号追踪与罚秒归属（须先于所有事件监听与行创建声明） ---------- */

// 罚秒只绑定选手编号，仅用于名次表：不改变采纳记录、裁决用时或人工复核。
// 仅保存在页面内存中，刷新页面即全部清除。
// 键是规范十进制字符串（见 parseRunnerNumber）：任意大的编号都精确区分，
// 9007199254740992 与 9007199254740993 的罚秒互不混同。
const penalties = new Map(); // runnerNumberText -> { seconds: number, reason: string }
const MAX_PENALTY_REASON = 200;

// 按“行”追踪每行当前登记的编号（规范十进制字符串，空/非法为 null）。罚秒虽按编号保存，
// 但编号的归属跟随行：一行离开旧编号（改号、清空、删行）的那一刻，旧编号的
// 罚秒必须立即释放——即使另一行仍占用该编号（临时重号），也不等重算、不看合法性。
const runnerRowNumbers = new WeakMap();

// 选手编号在页面内一律表示为“规范十进制字符串”（去掉前导零），不经过 Number：
// 后端接受任意大的正整数编号，而 JS 的 Number 会把 9007199254740993 截断成
// 9007199254740992，直接用数字会把不同编号混同。
// 前导零等值写法（如 "007" 与 "7"）归一为同一编号，不算改号。
function parseRunnerNumber(value) {
  return /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, "") : null;
}

/* ---------- 任意精度秒数：页面内一律使用规范十进制字符串，绝不经过 Number ---------- */

// 后端按任意精度 int 接收秒数并在响应里以 JSON 数字原样返回，秒数同样可以超过
// JS 安全整数范围（如 9007199254741003）。Number 会把它截断成 9007199254741004：
// 三条相差均为 11 秒的秒数会被算成 12、10，导致页面展示错误，并让复核绑定的
// 秒数/两段耗时核对在无关编辑后误判失效。因此响应处理、页面展示、复核绑定与
// 名次计算中的秒数及差值全部使用规范十进制字符串（去掉前导零），不缩小取值范围。
function intToText(value) {
  if (typeof value === "number") {
    // 无损解析器只对安全整数返回 number；其余一律视为不可信，不静默截断。
    if (!Number.isSafeInteger(value)) return null;
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value.replace(/^0+(?=\d)/, ""); // "0011" 与 "11" 等值，按数值归一
  }
  return null;
}

function isIntText(value) {
  return typeof value === "string" && /^\d+$/.test(value);
}

// 两个非负十进制整数精确相减（约定 a >= b），返回规范十进制字符串。
function subtractIntText(a, b) {
  return (BigInt(a) - BigInt(b)).toString();
}

// 非负十进制整数字符串的数值比较，任意精度：-1 / 0 / 1。
function cmpIntText(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function releaseRunnerPenalty(number) {
  if (number !== null) penalties.delete(number);
}

const runnerRows = document.getElementById("runner-rows");
const recordRows = document.getElementById("record-rows");
const addRunnerBtn = document.getElementById("add-runner");
const addRecordBtn = document.getElementById("add-record");
const recordCount = document.getElementById("record-count");
const form = document.getElementById("judge-form");
const errorBox = document.getElementById("error-box");
const pendingHint = document.getElementById("pending-hint");
const resultsBox = document.getElementById("results");
const diagnosisBox = document.getElementById("diagnosis-box");
const missingBox = document.getElementById("missing-box");

/* ---------- 可疑记录隔离（暂时退出计算；原始读数始终留在记录表中） ---------- */

// 隔离是页面会话状态，只绑定具体记录，不上传持久化、刷新即清除。
// 绑定键 = [ID（去首尾空白）, 选手编号（规范十进制文本）, 门, 秒数（规范十进制文本）]，
// 与服务端“ID 去空白、编号/秒数按整数等值、门精确比较”的规则一致：
// 前导零等值写法（0101 与 101、070 与 70）不算改变，隔离保留。
// 任一绑定值改变、或记录被删除（含同 ID 出现多行无法唯一定位）即解除；改回不恢复。
// 重排行与无关编辑不影响隔离；“清空 / 填入示例 / 刷新”清除全部隔离。
const exclusions = new Set(); // exclusionKey -> presence（值即键本身）
if (typeof globalThis !== "undefined") {
  globalThis.__exclusionsForTest = exclusions;
}

function recordRowExclusionKey(row) {
  const id = row.querySelector(".rec-id").value.trim();
  const runner = parseRunnerNumber(row.querySelector(".rec-runner").value.trim());
  const gate = row.querySelector(".rec-gate").value;
  const time = intToText(row.querySelector(".rec-time").value.trim());
  if (id === "" || runner === null || !(gate in GATE_LABELS) || time === null) {
    return null; // 不完整/非法行不可隔离
  }
  return JSON.stringify([id, runner, gate, time]);
}

// 每次输入变更后按当前记录表剪枝：ID 缺失、同 ID 多行、任一绑定值变化都解除隔离。
function pruneExclusions() {
  const keyCount = new Map();
  for (const row of recordRows.querySelectorAll(".record-row")) {
    const key = recordRowExclusionKey(row);
    if (key === null) continue;
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }
  for (const key of [...exclusions]) {
    if (keyCount.get(key) !== 1) exclusions.delete(key);
  }
}

// 当前仍有效隔离的记录 ID，按记录行顺序（天然不重复）。
function collectExcludedIds() {
  const ids = [];
  for (const row of recordRows.querySelectorAll(".record-row")) {
    const key = recordRowExclusionKey(row);
    if (key !== null && exclusions.has(key)) {
      ids.push(row.querySelector(".rec-id").value.trim());
    }
  }
  return ids;
}

// 按 exclusions 同步每行的隔离按钮与行样式（不完整行的按钮禁用）。
function syncExclusionButtons() {
  for (const row of recordRows.querySelectorAll(".record-row")) {
    const key = recordRowExclusionKey(row);
    const on = key !== null && exclusions.has(key);
    const btn = row.querySelector(".toggle-exclude");
    if (btn) {
      btn.textContent = on ? "重新纳入" : "隔离";
      btn.disabled = key === null;
      if (on) btn.classList.add("is-excluded");
      else btn.classList.remove("is-excluded");
      if (typeof btn.setAttribute === "function") {
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    if (on) row.classList.add("excluded");
    else row.classList.remove("excluded");
  }
}

/* ---------- 行管理 ---------- */

function runnerRowHtml(index, value = "") {
  return `
    <div class="runner-row" data-index="${index}">
      <span class="row-index">选手 ${index}</span>
      <input type="number" min="1" step="1" class="runner-number" value="${escapeAttr(value)}" placeholder="正整数编号" />
      <button type="button" class="btn danger remove-runner" ${index === 1 ? "hidden" : ""}>删除</button>
    </div>`;
}

function recordRowHtml() {
  return `
    <tr class="record-row">
      <td><input type="text" class="rec-id" placeholder="唯一 ID" /></td>
      <td><input type="number" min="1" step="1" class="rec-runner" placeholder="选手编号" /></td>
      <td>
        <select class="rec-gate">
          <option value="">选择门</option>
          <option value="S">S 起点</option>
          <option value="M">M 中途门</option>
          <option value="F">F 终点</option>
        </select>
      </td>
      <td><input type="number" min="0" step="1" class="rec-time" placeholder="非负秒" /></td>
      <td class="exclude-cell"><button type="button" class="btn ghost tiny toggle-exclude" disabled>隔离</button></td>
      <td><button type="button" class="btn danger remove-record">×</button></td>
    </tr>`;
}

function addRunnerRow(value) {
  if (runnerRows.children.length >= MAX_RUNNERS) return;
  runnerRows.insertAdjacentHTML("beforeend", runnerRowHtml(runnerRows.children.length + 1, value));
  // 新行从诞生起登记当前编号（载入示例时即为示例编号）：此后该行改号时，
  // 才能按“行”识别出它离开的旧编号并立即释放对应罚秒。
  const row = runnerRows.children[runnerRows.children.length - 1];
  runnerRowNumbers.set(row, parseRunnerNumber(row.querySelector(".runner-number").value));
  refreshRunnerButtons();
}

function refreshRunnerButtons() {
  [...runnerRows.children].forEach((row, i) => {
    row.dataset.index = i + 1;
    row.querySelector(".row-index").textContent = `选手 ${i + 1}`;
    const btn = row.querySelector(".remove-runner");
    btn.hidden = runnerRows.children.length === 1;
  });
  addRunnerBtn.disabled = runnerRows.children.length >= MAX_RUNNERS;
}

function addRecordRow() {
  if (recordRows.children.length >= MAX_RECORDS) return;
  recordRows.insertAdjacentHTML("beforeend", recordRowHtml());
  refreshRecordCount();
  syncExclusionButtons();
}

function refreshRecordCount() {
  recordCount.textContent = `${recordRows.children.length} / ${MAX_RECORDS}`;
  addRecordBtn.disabled = recordRows.children.length >= MAX_RECORDS;
}

addRunnerBtn.addEventListener("click", () => {
  addRunnerRow();
  onInputChanged();
});
addRecordBtn.addEventListener("click", () => {
  addRecordRow();
  onInputChanged();
});

runnerRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-runner")) {
    const row = e.target.closest(".runner-row");
    // 行删除先于 remove() 执行：此刻立即释放该行原编号的罚秒，
    // 即使另一行仍占用同一编号、输入非法或尚未重算。
    releasePenaltyForRemovedRunner(row);
    row.remove();
    refreshRunnerButtons();
    onInputChanged();
  }
});
recordRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-record")) {
    // 删除记录行：绑定该 ID 的隔离与复核都按“绑定记录被删除”立即解除，改回不恢复。
    e.target.closest(".record-row").remove();
    refreshRecordCount();
    onInputChanged();
    return;
  }
  if (e.target.classList.contains("toggle-exclude")) {
    onExclusionToggled(e.target.closest(".record-row"));
  }
});

/* ---------- 输入修改后自动重算 ---------- */

// 每次修改递增版本号：只有版本仍最新的响应才允许更新结果或错误，
// 过期的成功与失败一律丢弃，不得覆盖较新状态。
let inputVersion = 0;
// 裁决序号：每次发起裁决（防抖自动重算或手动点击“裁决 / 重新计算”）递增。
// 输入未变的手动重算不会改变版本号，但同样是新一次裁决：只有序号仍最新的
// 裁决响应才允许更新界面并恢复诊断入口；序号变化前发出的诊断响应一律作废。
let adjudicationSeq = 0;
let debounceTimer = null;
const DEBOUNCE_MS = 350; // 合并连续编辑为一次重算

function clearOutcome() {
  // 每次修改立即清掉旧结果与旧错误。
  resultsBox.innerHTML = "";
  errorBox.hidden = true;
  renderedLapKeys = []; // 结果区已清空，旧的趟键索引全部失效
  latestResult = null; // 名次表随之隐藏，等待最新合法结果
  closeDiagnosis(); // 诊断附属于当前裁决结果：输入一改即清除，非法/重算期间不可检查
  closeMissing(); // 漏读窗口同样附属于当前裁决结果：输入一改即清除，期间不可查询
}

/* ---------- 未采纳记录替代性诊断（HTTP 只读分析，不改变采纳/复核/罚秒/名次） ---------- */

// 诊断状态机（status）：
//   idle     存在最新合法裁决，可点击“检查替代性”
//   loading  诊断请求在途：禁用按钮，不再发起新诊断
//   done     诊断成功并展示（可能含各档分类与同优替代方案）
//   error    诊断请求失败（服务报错或无法连接），可重试
// 诊断不写入裁决结果区：只渲染独立的 #diagnosis-box。
// 入口开关（diagnosisOpen）：仅“最新一次裁决已完成且合法”时打开；
// 每次裁决开始（含输入未变的手动重算）立即关闭并清除旧诊断，裁决失败保持关闭；
// 输入变更/清空同样关闭。inputVersion 与 adjudicationSeq 双重守卫保证：
// 重算前发出的诊断无论何时结束（成功、服务报错或断网）都不会重新显示结果或错误，
// 也不会改写重算后新诊断的在途、成功、失败状态。
let diagnosisState = { status: "idle" };
let diagnosisOpen = false;
// 仅供无浏览器生命周期测试直接读取/驱动诊断状态。
if (typeof globalThis !== "undefined") {
  globalThis.__getDiagnosisStateForTest = () => diagnosisState;
  globalThis.__runDiagnosisForTest = () => runDiagnosis();
}

/* ---------- 查找漏读（HTTP 只读提示：不追加记录，不改变裁决/复核/罚秒/名次/诊断） ---------- */

// 漏读窗口状态机（missingState.status）：idle / loading / done / error，与诊断同款。
// 入口开关（missingOpen）：仅“最新一次裁决已完成且合法”时打开；每次裁决开始
// （含输入未变的手动重算）与输入变更/清空都立即关闭并清除旧窗口，期间不可查询；
// inputVersion 与 adjudicationSeq 双重守卫：清除前发出的查询无论何时结束
// （成功、服务报错或断网）都不回写界面。虚拟读数只是推测，不占 40 条录入名额。
let missingState = { status: "idle" };
let missingOpen = false;
// 仅供无浏览器生命周期测试直接读取/驱动漏读查询。
if (typeof globalThis !== "undefined") {
  globalThis.__getMissingStateForTest = () => missingState;
  globalThis.__runMissingForTest = () => runMissing();
}

function onInputChanged() {
  inputVersion += 1;
  // 先按当前输入即时丢弃绑定已失效的复核：不必、也不能等到合法裁决返回。
  pruneReviewsByBindings();
  // 隔离绑定（ID、编号、门、秒数）也在输入变化的当下即时核对：
  // 任一绑定值改变或记录删除即解除，改回不恢复；重排与无关编辑保留。
  pruneExclusions();
  syncExclusionButtons();
  // 选手编号被修改或选手被删除时，对应罚秒也在此刻立即清除（改回不恢复）。
  prunePenaltiesByRunners();
  // 任何赛道输入变化（区间、选手、记录，含增删行、示例、清空）都使导入预览失效：
  // 旧预览的确认入口此刻消失，随后迟到的预览/确认响应也无法恢复它。
  invalidateImportPreview();
  clearOutcome();
  pendingHint.hidden = false;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runAdjudication();
  }, DEBOUNCE_MS);
}

// 隔离/重新纳入切换：只改变隔离集合，不触碰记录行的原始读数。
// 切换后与输入变化同生命周期：立即清除旧结果、诊断、漏读窗口与导入预览，
// 随后按防抖自动裁决；迟到的成功或失败都不会回写。
function onExclusionToggled(row) {
  const key = recordRowExclusionKey(row);
  if (key === null) return; // 不完整行不允许隔离
  if (exclusions.has(key)) exclusions.delete(key);
  else exclusions.add(key);
  syncExclusionButtons();
  onInputChanged();
}

// 合并成功后的自动重算：与输入变化一样重跑裁决，但保留“已合并 N 条”的成功提示。
function rerunAfterMerge() {
  inputVersion += 1;
  pruneReviewsByBindings();
  pruneExclusions();
  syncExclusionButtons();
  prunePenaltiesByRunners();
  clearOutcome();
  pendingHint.hidden = false;
  if (debounceTimer) clearTimeout(debounceTimer);
  runAdjudication();
}

form.addEventListener("input", (e) => {
  // 文件选择与导入卡内按钮不属于赛道输入，不触发重算/预览失效。
  if (eventTargetsImport(e)) return;
  onInputChanged();
});
form.addEventListener("change", (e) => {
  if (eventTargetsImport(e)) return;
  onInputChanged();
});

/* ---------- 收集与提交 ---------- */

function collectPayload() {
  const runners = [...runnerRows.querySelectorAll(".runner-row")]
    .map((row) => row.querySelector(".runner-number").value.trim())
    .filter((v) => v !== "")
    .map((v) => ({ number: v }));

  const records = [...recordRows.querySelectorAll(".record-row")].map((row) => ({
    id: row.querySelector(".rec-id").value.trim(),
    runner: row.querySelector(".rec-runner").value.trim(),
    gate: row.querySelector(".rec-gate").value,
    time: row.querySelector(".rec-time").value.trim(),
  }));

  return {
    standards: {
      smMin: document.getElementById("smMin").value.trim(),
      smMax: document.getElementById("smMax").value.trim(),
      mfMin: document.getElementById("mfMin").value.trim(),
      mfMax: document.getElementById("mfMax").value.trim(),
    },
    runners,
    records,
    // 当前仍有效隔离的记录 ID（行顺序、不重复）；无隔离时为空数组。
    // 裁决、替代性诊断与漏读查询都只用未隔离记录计算；原始读数仍在 records 中。
    excludedIds: collectExcludedIds(),
  };
}

/* ---------- 大整数无损 JSON 解析与结果规范化 ---------- */

// 后端接受任意精度的编号与秒数，响应里的 runner 与各 time/耗时字段都可能超出
// JS 安全整数范围（如编号 9007199254740993、秒数 9007199254741003）。直接
// JSON.parse 会把编号截断成 9007199254740992（不同编号混同），也会把秒数
// 9007199254741003 截断成 9007199254741004（11 秒差值被算成 12/10）。这里用
// 一个小型解析器代替 JSON.parse：行为与 JSON.parse 一致，唯一区别是超出安全
// 整数范围的整数字面量解析为规范十进制字符串（去掉前导零），不丢失任何精度；
// 之后编号与秒数分别在 normalizeResult 中按字符串保留，不回退为 Number。
function parseJsonLossless(text) {
  let pos = 0;
  const fail = () => {
    throw new SyntaxError("裁决服务返回了无法解析的响应");
  };
  const skipWs = () => {
    while (pos < text.length && " \t\n\r".indexOf(text[pos]) !== -1) pos += 1;
  };
  const parseString = () => {
    // 调用时 text[pos] 为起始双引号
    let out = "";
    pos += 1;
    while (pos < text.length) {
      const c = text[pos];
      pos += 1;
      if (c === '"') return out;
      if (c === "\\") {
        if (pos >= text.length) fail();
        const esc = text[pos];
        pos += 1;
        if (esc === "u") {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
        } else {
          const simple = {
            '"': '"', "\\": "\\", "/": "/",
            b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
          };
          if (!(esc in simple)) fail();
          out += simple[esc];
        }
      } else {
        out += c;
      }
    }
    fail();
  };
  const parseNumber = () => {
    const start = pos;
    if (text[pos] === "-") pos += 1;
    while (pos < text.length && text[pos] >= "0" && text[pos] <= "9") pos += 1;
    let isInteger = true;
    if (text[pos] === ".") {
      isInteger = false;
      pos += 1;
      while (pos < text.length && text[pos] >= "0" && text[pos] <= "9") pos += 1;
    }
    if (text[pos] === "e" || text[pos] === "E") {
      isInteger = false;
      pos += 1;
      if (text[pos] === "+" || text[pos] === "-") pos += 1;
      while (pos < text.length && text[pos] >= "0" && text[pos] <= "9") pos += 1;
    }
    const raw = text.slice(start, pos);
    if (raw === "" || raw === "-") fail();
    const num = Number(raw);
    // 超出安全整数范围的整数字面量：保留规范十进制字符串，精度无损。
    if (isInteger && !Number.isSafeInteger(num)) {
      return raw.replace(/^(-?)0+(?=\d)/, "$1");
    }
    return num;
  };
  const parseLiteral = (word, value) => {
    if (text.slice(pos, pos + word.length) !== word) fail();
    pos += word.length;
    return value;
  };
  function parseValue() {
    skipWs();
    if (pos >= text.length) fail();
    const c = text[pos];
    if (c === '"') return parseString();
    if (c === "{") {
      pos += 1;
      const obj = {};
      skipWs();
      if (text[pos] === "}") {
        pos += 1;
        return obj;
      }
      for (;;) {
        skipWs();
        if (text[pos] !== '"') fail();
        const key = parseString();
        skipWs();
        if (text[pos] !== ":") fail();
        pos += 1;
        obj[key] = parseValue();
        skipWs();
        if (text[pos] === ",") {
          pos += 1;
          continue;
        }
        if (text[pos] === "}") {
          pos += 1;
          return obj;
        }
        fail();
      }
    }
    if (c === "[") {
      pos += 1;
      const arr = [];
      skipWs();
      if (text[pos] === "]") {
        pos += 1;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skipWs();
        if (text[pos] === ",") {
          pos += 1;
          continue;
        }
        if (text[pos] === "]") {
          pos += 1;
          return arr;
        }
        fail();
      }
    }
    if (c === "t") return parseLiteral("true", true);
    if (c === "f") return parseLiteral("false", false);
    if (c === "n") return parseLiteral("null", null);
    return parseNumber();
  }
  const value = parseValue();
  skipWs();
  if (pos !== text.length) fail();
  return value;
}

// 裁决结果规范化：
// - 选手编号统一为规范十进制字符串（任意大都无损）；
// - 所有秒数与耗时（记录秒数、两段耗时、总用时、未采纳记录秒数）统一为规范
//   十进制字符串：不经过 Number，超过 2^53 的值与 11 秒这类差值都保持精确；
// - 只有计次数（至多 40）还原为 Number。
function normalizeResult(result) {
  const asText = (v) => intToText(v);
  for (const r of result.runners) {
    r.runner = typeof r.runner === "string" ? r.runner : String(r.runner);
    r.lapCount = typeof r.lapCount === "string" ? Number(r.lapCount) : r.lapCount;
    r.totalTime = asText(r.totalTime);
    for (const lap of r.laps) {
      lap.start.time = asText(lap.start.time);
      lap.middle.time = asText(lap.middle.time);
      lap.finish.time = asText(lap.finish.time);
      lap.smTime = asText(lap.smTime);
      lap.mfTime = asText(lap.mfTime);
      lap.totalTime = asText(lap.totalTime);
    }
    for (const u of r.unused) {
      u.time = asText(u.time);
    }
    // 隔离记录是裁决结果的独立一列：后端只在携带 excludedIds 时返回，
    // 兼容旧响应/桩：缺省时视为空列。
    if (!Array.isArray(r.excluded)) r.excluded = [];
    for (const x of r.excluded) {
      x.time = asText(x.time);
    }
  }
  return result;
}

async function runAdjudication() {
  const version = inputVersion;
  const seq = ++adjudicationSeq;
  // 每次裁决开始（含输入未变的手动重算）：立即清除旧诊断与旧漏读窗口并禁止查询；
  // 只有本次（最新）合法裁决完成才由 renderResults 恢复入口，裁决失败保持关闭。
  closeDiagnosis();
  closeMissing();
  let resp;
  let data;
  try {
    resp = await fetch("/api/adjudicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload()),
    });
    // 用无损解析代替 resp.json()：大整数编号不会被浮点精度截断。
    data = parseJsonLossless(await resp.text());
  } catch (err) {
    if (version !== inputVersion || seq !== adjudicationSeq) return; // 过期的失败不得覆盖较新状态
    pendingHint.hidden = true;
    resultsBox.innerHTML = "";
    latestResult = null;
    showError(`无法连接裁决服务：${err.message}`);
    return;
  }
  if (version !== inputVersion || seq !== adjudicationSeq) return; // 过期的成功同样丢弃
  pendingHint.hidden = true;
  if (!resp.ok || !data.ok) {
    // 非法输入：清空结果区，只显示错误（不展示部分结果）。
    resultsBox.innerHTML = "";
    latestResult = null;
    showError(data.error || "裁决失败");
  } else {
    errorBox.hidden = true;
    renderResults(normalizeResult(data.result));
  }
}

// 手动裁决按钮仍然可用：跳过防抖立即重算，等待期间不锁定任何输入。
// 输入未变的手动重算同样是新一次裁决：runAdjudication 内会立即清除旧诊断
// 并禁止检查，只有最新合法裁决完成才恢复诊断入口。
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingHint.hidden = false;
  runAdjudication();
});

function showError(msg) {
  errorBox.textContent = `⚠ ${msg}`;
  errorBox.hidden = false;
}

/* ---------- 人工复核（仅本次页面会话，不上传、不影响裁决） ---------- */

// 复核绑定具体的“趟”：选手编号 + 三条记录的 ID/门/秒数 + 该趟两段耗时 + 两段耗时区间，
// 不按趟序号或记录行号定位。仅保存在页面内存中，刷新页面即全部清除。
const reviews = new Map(); // key -> { status: "pending"|"pass"|"doubt", note: string }
const REVIEW_STATUSES = { pending: "未复核", pass: "通过", doubt: "存疑" };
const MAX_REVIEW_NOTE = 200;
// 最近一次渲染的趟绑定键（与 DOM 中 data-key-index 一一对应），仅供保存时回查。
let renderedLapKeys = [];

// 区间绑定值同样是任意精度的非负整数：以规范十进制字符串参与键的生成与核对，
// 不经过 Number（非法/清空为 null，与所有规范文本都不相等，绑定随即失效）。
function currentStandards() {
  return ["smMin", "smMax", "mfMin", "mfMax"].map((id) =>
    intToText(document.getElementById(id).value.trim())
  );
}

function lapReviewKey(runner, lap, standards) {
  return JSON.stringify([
    runner,
    [lap.start.id, "S", lap.start.time],
    [lap.middle.id, "M", lap.middle.time],
    [lap.finish.id, "F", lap.finish.time],
    lap.smTime,
    lap.mfTime,
    standards,
  ]);
}

// 即时剪枝：任一绑定值改变、绑定记录或选手被删除（含当前输入非法、尚在防抖、
// 请求在途的情形），对应复核此刻就丢弃；之后改回或过期响应返回也不会恢复。
// 只逐条核对绑定本身：重排记录、增删改无关记录的趟不受影响，保留原状态与备注。
function pruneReviewsByBindings() {
  const standards = currentStandards();

  const runnerNumbers = new Set(
    [...runnerRows.querySelectorAll(".runner-number")]
      .map((el) => parseRunnerNumber(el.value.trim()))
      .filter((v) => v !== null)
  );

  // 以记录 ID 为索引：绑定按 ID 定位，ID 缺失即记录被删除；
  // 同一 ID 出现多行时无法唯一定位原记录，同样视为绑定失效。
  const recordsById = new Map();
  const duplicatedIds = new Set();
  for (const row of recordRows.querySelectorAll(".record-row")) {
    const id = row.querySelector(".rec-id").value.trim();
    if (id === "") continue;
    if (recordsById.has(id)) {
      duplicatedIds.add(id);
      continue;
    }
    recordsById.set(id, {
      runner: row.querySelector(".rec-runner").value.trim(),
      gate: row.querySelector(".rec-gate").value,
      time: row.querySelector(".rec-time").value.trim(),
    });
  }

  // 输入行的秒数也规范为十进制字符串：与绑定键中的规范秒数按文本精确比较，
  // 前导零等值写法不算改变，超过 2^53 的秒数同样逐位精确，不经过 Number。
  const recordMatches = (rec, gate, time) =>
    rec !== undefined &&
    rec.gate === gate &&
    intToText(rec.time) === time;

  for (const key of [...reviews.keys()]) {
    let parts;
    try {
      parts = JSON.parse(key);
    } catch (err) {
      reviews.delete(key); // 结构不符的键一律视为失效
      continue;
    }
    const [
      runner,
      [sId, sGate, sTime],
      [mId, mGate, mTime],
      [fId, fGate, fTime],
      smTime,
      mfTime,
      boundStandards,
    ] = parts;

    // 结构与类型守卫：绑定值必须是规范十进制字符串（由规范化后的响应生成），
    // 任何历史/损坏键都立即丢弃，不参与任何 Number 运算。
    const structurallyOk =
      typeof runner === "string" &&
      [sId, mId, fId].every((v) => typeof v === "string") &&
      [sGate, mGate, fGate].every((v) => typeof v === "string") &&
      [sTime, mTime, fTime, smTime, mfTime].every(isIntText) &&
      Array.isArray(boundStandards);
    if (!structurallyOk) {
      reviews.delete(key);
      continue;
    }

    let valid =
      JSON.stringify(boundStandards) === JSON.stringify(standards) &&
      runnerNumbers.has(runner) &&
      !duplicatedIds.has(sId) &&
      !duplicatedIds.has(mId) &&
      !duplicatedIds.has(fId) &&
      sId !== mId &&
      sId !== fId &&
      mId !== fId &&
      recordMatches(recordsById.get(sId), sGate, sTime) &&
      recordMatches(recordsById.get(mId), mGate, mTime) &&
      recordMatches(recordsById.get(fId), fGate, fTime);

    if (valid) {
      // 绑定记录的选手编号必须仍是该选手（按规范十进制精确比较，大编号不混同）；
      // 门/秒数不变时两段耗时自然不变，这里仍用十进制字符串精确核对一次：
      // 差值按 BigInt 计算，超过 2^53 的秒数与 11 秒这类差值都不会被浮点改写。
      const sRec = recordsById.get(sId);
      const mRec = recordsById.get(mId);
      const fRec = recordsById.get(fId);
      valid =
        parseRunnerNumber(sRec.runner.trim()) === runner &&
        parseRunnerNumber(mRec.runner.trim()) === runner &&
        parseRunnerNumber(fRec.runner.trim()) === runner &&
        subtractIntText(mTime, sTime) === smTime &&
        subtractIntText(fTime, mTime) === mfTime;
    }

    if (!valid) reviews.delete(key);
  }
}

function reviewCurrentText(saved) {
  const status = saved ? saved.status : "pending";
  const note = saved ? saved.note : "";
  const base = `当前：${REVIEW_STATUSES[status]}`;
  return note ? `${base}（备注：${escapeHtml(note)}）` : base;
}

function reviewBoxHtml(keyIndex, saved) {
  const status = saved ? saved.status : "pending";
  const note = saved ? saved.note : "";
  const options = Object.entries(REVIEW_STATUSES)
    .map(
      ([value, label]) => `
      <label class="review-option">
        <input type="radio" name="review-status-${keyIndex}" value="${value}" ${
        value === status ? "checked" : ""
      } /> ${label}
      </label>`
    )
    .join("");
  return `
  <div class="review-box" data-key-index="${keyIndex}">
    <div class="review-head">
      <span class="review-label">人工复核</span>
      <span class="review-current">${reviewCurrentText(saved)}</span>
      <span class="review-scope">仅本次页面会话保留，刷新即清除</span>
    </div>
    <div class="review-status-row">${options}</div>
    <textarea class="review-note" rows="2" maxlength="${MAX_REVIEW_NOTE}" placeholder="备注（至多 ${MAX_REVIEW_NOTE} 字；选择“存疑”时必填）">${escapeHtml(note)}</textarea>
    <div class="review-actions">
      <button type="button" class="btn secondary review-save">保存复核</button>
      <span class="review-error" hidden></span>
    </div>
  </div>`;
}

// 保存复核：校验失败时不写入，保持原复核内容不变。
resultsBox.addEventListener("click", (e) => {
  if (!e.target.classList.contains("review-save")) return;
  const box = e.target.closest(".review-box");
  const key = renderedLapKeys[Number(box.dataset.keyIndex)];
  if (key === undefined) return; // 结果区已被更新的渲染替换
  const checked = box.querySelector("input[type=radio]:checked");
  const status = checked ? checked.value : "pending";
  const note = box.querySelector(".review-note").value;
  const errEl = box.querySelector(".review-error");

  const fail = (msg) => {
    errEl.textContent = `⚠ ${msg}；已保留原复核内容`;
    errEl.hidden = false;
  };
  if (note.length > MAX_REVIEW_NOTE) {
    fail(`备注至多 ${MAX_REVIEW_NOTE} 字`);
    return;
  }
  if (status === "doubt" && note.trim() === "") {
    fail("选择“存疑”必须填写非空备注");
    return;
  }
  reviews.set(key, { status, note });
  errEl.hidden = true;
  box.querySelector(".review-current").innerHTML = reviewCurrentText({ status, note });
});

/* ---------- 比赛名次与罚秒（仅本次页面会话，不上传、不影响裁决与复核） ---------- */

// 最近一次展示的合法裁决结果：保存罚秒后据此立即重排名次，无需重新请求。
let latestResult = null;

// 仅供无浏览器生命周期测试（test_ranking_lifecycle.js）直接断言内存中的罚秒。
if (typeof globalThis !== "undefined") globalThis.__penaltiesForTest = penalties;

// 删行时（在 DOM remove 之前调用）：该行已不在表单中，直接释放其原编号罚秒。
function releasePenaltyForRemovedRunner(row) {
  releaseRunnerPenalty(
    runnerRowNumbers.has(row)
      ? runnerRowNumbers.get(row)
      : parseRunnerNumber(row.querySelector(".runner-number").value)
  );
  runnerRowNumbers.delete(row);
}

// 每次输入变更：逐行比对当前编号与该行上一次登记的编号。
// 任一行改号——旧编号变成新编号（含另一行仍占用旧编号的临时重号、重号非法、
// 清空或非法输入）——旧编号的罚秒与原因此刻立即清除；之后改回同编号或重新
// 添加同编号，行的登记已是新值，旧罚秒不会再被任何后续响应恢复。
// 未改号的行（记录、区间等编辑）不受影响。
function prunePenaltiesByRunners() {
  for (const row of runnerRows.querySelectorAll(".runner-row")) {
    const input = row.querySelector(".runner-number");
    const next = parseRunnerNumber(input.value.trim());
    const prev = runnerRowNumbers.has(row) ? runnerRowNumbers.get(row) : next;
    if (prev !== next) releaseRunnerPenalty(prev);
    runnerRowNumbers.set(row, next);
  }
  // 防御性兜底：编号已不在任何行中的残余罚秒同样清除。
  const numbers = new Set(
    [...runnerRows.querySelectorAll(".runner-number")]
      .map((el) => parseRunnerNumber(el.value.trim()))
      .filter((v) => v !== null)
  );
  for (const runner of [...penalties.keys()]) {
    if (!numbers.has(runner)) penalties.delete(runner);
  }
}

// 名次：有完整计次者按计次数降序、调整后用时（原总用时 + 罚秒）升序，
// 同值共享名次并跳号（1、1、3），并列按编号升序展示；
// 零次者排末尾、按编号升序且无名次。
// 编号是规范十进制字符串：先比长度、再按字典序即数值升序，任意大都精确。
function cmpRunnerNumbers(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function computeRanking(runners) {
  const rows = runners.map((r) => {
    const saved = penalties.get(r.runner);
    const penalty = saved ? saved.seconds : 0;
    // 原总用时是规范十进制字符串（任意精度）；调整后用时按十进制精确相加，
    // 不经过 Number，避免超过 2^53 的总用时在名次比较中被截断。
    const adjustedText = (BigInt(r.totalTime) + BigInt(penalty)).toString();
    return {
      runner: r.runner,
      lapCount: r.lapCount,
      totalTime: r.totalTime,
      penalty,
      adjusted: adjustedText,
      rank: null,
    };
  });
  const ranked = rows
    .filter((row) => row.lapCount > 0)
    .sort(
      (a, b) =>
        b.lapCount - a.lapCount ||
        cmpIntText(a.adjusted, b.adjusted) ||
        cmpRunnerNumbers(a.runner, b.runner)
    );
  ranked.forEach((row, i) => {
    row.rank =
      i > 0 &&
      row.lapCount === ranked[i - 1].lapCount &&
      row.adjusted === ranked[i - 1].adjusted
        ? ranked[i - 1].rank
        : i + 1;
  });
  const zeros = rows
    .filter((row) => row.lapCount === 0)
    .sort((a, b) => cmpRunnerNumbers(a.runner, b.runner));
  return ranked.concat(zeros);
}

function rankingTableHtml(result) {
  const body = computeRanking(result.runners)
    .map(
      (row) =>
        `<tr><td>${row.runner}</td><td>${row.lapCount}</td><td>${row.totalTime} 秒</td><td>${row.penalty} 秒</td><td>${row.adjusted} 秒</td><td>${
          row.rank === null ? "—" : `第 ${row.rank} 名`
        }</td></tr>`
    )
    .join("");
  return `<table class="ranking-table">
    <thead><tr><th>选手编号</th><th>计次数</th><th>原总用时</th><th>罚秒</th><th>调整后用时</th><th>名次</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function penaltyCurrentText(saved) {
  const seconds = saved ? saved.seconds : 0;
  const reason = saved ? saved.reason : "";
  const base = `当前已保存：${seconds} 秒`;
  return reason ? `${base}（原因：${escapeHtml(reason)}）` : base;
}

function penaltyEditorHtml(runner) {
  const saved = penalties.get(runner);
  const seconds = saved ? saved.seconds : 0;
  const reason = saved ? saved.reason : "";
  return `
  <div class="penalty-editor" data-runner="${runner}">
    <div class="penalty-head">
      <span class="penalty-label">选手 ${runner} · 罚秒</span>
      <span class="penalty-current">${penaltyCurrentText(saved)}</span>
    </div>
    <div class="penalty-controls">
      <input type="number" min="0" step="1" class="penalty-seconds" value="${seconds}" />
      <span class="penalty-unit">秒</span>
      <input type="text" class="penalty-reason" maxlength="${MAX_PENALTY_REASON}" placeholder="原因（至多 ${MAX_PENALTY_REASON} 字；罚秒大于 0 时必填）" value="${escapeAttr(reason)}" />
      <button type="button" class="btn secondary penalty-save">保存罚秒</button>
      <span class="penalty-error" hidden></span>
    </div>
  </div>`;
}

function rankingCardHtml(result) {
  return `
  <section class="result-card ranking-card">
    <div class="result-head">
      <h3>比赛名次</h3>
      <span class="review-scope">罚秒仅影响名次表，不改变采纳记录、裁决用时与人工复核；仅本次页面会话保留，刷新即清除</span>
    </div>
    <div class="ranking-table-slot">${rankingTableHtml(result)}</div>
    ${result.runners.map((r) => penaltyEditorHtml(r.runner)).join("")}
  </section>`;
}

// 保存罚秒：非负整数、原因至多 200 字、罚秒大于 0 时原因必填；
// 校验失败不写入，保留原已保存的罚秒与原因；成功后立即重排名次表，无需重算。
resultsBox.addEventListener("click", (e) => {
  if (!e.target.classList.contains("penalty-save")) return;
  const box = e.target.closest(".penalty-editor");
  if (!box) return;
  const runner = box.dataset.runner; // 规范十进制字符串：任意大编号都精确归属
  const secondsText = box.querySelector(".penalty-seconds").value.trim();
  const reason = box.querySelector(".penalty-reason").value;
  const errEl = box.querySelector(".penalty-error");

  const fail = (msg) => {
    errEl.textContent = `⚠ ${msg}；已保留原罚秒和原因`;
    errEl.hidden = false;
  };
  if (!/^\d+$/.test(secondsText)) {
    fail("罚秒必须是非负整数");
    return;
  }
  if (reason.length > MAX_PENALTY_REASON) {
    fail(`原因至多 ${MAX_PENALTY_REASON} 字`);
    return;
  }
  const seconds = Number(secondsText);
  if (seconds > 0 && reason.trim() === "") {
    fail("罚秒大于 0 时必须填写原因");
    return;
  }
  penalties.set(runner, { seconds, reason });
  errEl.hidden = true;
  box.querySelector(".penalty-current").innerHTML = penaltyCurrentText({ seconds, reason });
  // 罚秒只影响名次表：立即按当前已保存的罚秒重排名次，不触发重新裁决。
  const slot = resultsBox.querySelector(".ranking-table-slot");
  if (slot && latestResult) slot.innerHTML = rankingTableHtml(latestResult);
});

/* ---------- 结果渲染 ---------- */

function gateChip(gate, id, time) {
  return `<span class="chip ${gate}">
    <span class="chip-id">${escapeHtml(id)}</span>
    <span class="chip-t">${GATE_LABELS[gate]} · ${time} 秒</span>
  </span>`;
}

function renderResults(result) {
  latestResult = result; // 名次表与罚秒保存都以这份最新合法结果为准
  const standards = currentStandards();
  const keyOf = (runner, lap) => lapReviewKey(runner, lap, standards);

  // 合法裁决到达后再按最新采纳集合剪枝：处理“绑定本身没变、但该趟不再被最新
  // 合法裁决采纳”的情形；绑定值改变/记录或选手删除已在输入变更瞬间即时丢弃，
  // 过期响应因版本号守卫根本到不了这里，无法恢复被丢弃的复核。
  const adopted = new Set();
  for (const r of result.runners) {
    for (const lap of r.laps) adopted.add(keyOf(r.runner, lap));
  }
  for (const key of [...reviews.keys()]) {
    if (!adopted.has(key)) reviews.delete(key);
  }

  renderedLapKeys = [];
  const runnerCards = result.runners
    .map((r) => {
      const badge =
        r.lapCount === 0
          ? `<span class="badge zero">0 次完整计次</span>`
          : `<span class="badge ok">${r.lapCount} 次完整计次</span>`;
      const meta =
        r.lapCount === 0
          ? `<span class="result-meta">无完整计次</span>`
          : `<span class="result-meta">各趟用时之和：${r.totalTime} 秒</span>`;

      const lapsHtml =
        r.lapCount === 0
          ? `<div class="zero-note">该选手没有符合两段耗时区间的完整一趟，计 0 次；全部感应记录列入未采纳。</div>`
          : r.laps
              .map((lap, i) => {
                renderedLapKeys.push(keyOf(r.runner, lap));
                const reviewHtml = reviewBoxHtml(
                  renderedLapKeys.length - 1,
                  reviews.get(renderedLapKeys[renderedLapKeys.length - 1])
                );
                return `
                <div class="lap-item">
                  <div class="lap-title">第 ${i + 1} 趟 · 总用时 ${lap.totalTime} 秒</div>
                  <div class="lap-chain">
                    ${gateChip("S", lap.start.id, lap.start.time)}
                    <span class="arrow">— ${lap.smTime} 秒 →</span>
                    ${gateChip("M", lap.middle.id, lap.middle.time)}
                    <span class="arrow">— ${lap.mfTime} 秒 →</span>
                    ${gateChip("F", lap.finish.id, lap.finish.time)}
                  </div>
                  <div class="seg-times">
                    起点→中途门 <strong>${lap.smTime}</strong> 秒，
                    中途门→终点 <strong>${lap.mfTime}</strong> 秒
                  </div>
                  ${reviewHtml}
                </div>`;
              })
              .join("");

      const unusedHtml =
        r.unused.length === 0
          ? `<span class="empty-line">（无未采纳记录）</span>`
          : r.unused
              .map(
                (u) =>
                  `<span class="chip-mini ${u.gate}">${GATE_LABELS[u.gate]} · ${escapeHtml(
                    u.id
                  )} · ${u.time} 秒</span>`
              )
              .join("");

      // 隔离记录单列：它们保留原始读数但暂时退出本次计算，不计入未采纳记录；
      // 全部隔离时选手按零次处理。
      const excludedHtml =
        r.excluded.length === 0
          ? ""
          : `<div class="subsection excluded-subsection">
              <h4>隔离记录（暂时退出计算，原始读数仍保留在记录表）</h4>
              ${r.excluded
                .map(
                  (x) =>
                    `<span class="chip-mini excluded-chip ${x.gate}">${GATE_LABELS[x.gate]} · ${escapeHtml(
                      x.id
                    )} · ${x.time} 秒</span>`
                )
                .join("")}
            </div>`;

      return `
      <section class="result-card">
        <div class="result-head">
          <h3>选手 ${r.runner}</h3>
          ${badge}
          ${meta}
        </div>
        <div>${lapsHtml}</div>
        <div class="subsection">
          <h4>未采纳记录（该选手输入但未进入任何一趟；不含隔离记录）</h4>
          ${unusedHtml}
        </div>
        ${excludedHtml}
      </section>`;
    })
    .join("");
  // 名次表排在最前，使用渲染这一刻已保存的罚秒。
  resultsBox.innerHTML = rankingCardHtml(result) + runnerCards;
  // 最新合法裁决到达：诊断入口恢复为可检查的初始态
  // （每次裁决开始时已在 runAdjudication 清除旧诊断并关闭入口）。
  openDiagnosis();
  // 漏读查询入口同步恢复（旧窗口已在裁决开始/输入变更时清除）。
  openMissing();
}

/* ---------- 替代性诊断 ---------- */

const DIAG_LABELS = {
  equal: "同优可替代",
  inferior: "仅次优可用",
  unusable: "无法成趟",
};
const DIAG_HINTS = {
  equal: "存在包含该记录、且计次数与原总用时都与现方案相同的合法完整方案（仅 ID 决胜不同；与罚秒无关）",
  inferior: "该记录能组成合格趟，但任何完整方案的计次数或原总用时都达不到现方案",
  unusable: "该选手的任何合格趟都不包含这条记录",
};

function clearDiagnosis() {
  diagnosisState = { status: "idle" };
  diagnosisBox.hidden = true;
  diagnosisBox.innerHTML = "";
}

// 每次裁决开始（含输入未变的手动重算）与输入变更/清空：清除旧诊断并关闭检查入口。
function closeDiagnosis() {
  diagnosisOpen = false;
  clearDiagnosis();
}

// 最新合法裁决到达后进入可检查状态（卡片显示、按钮可点，入口重新打开）。
function openDiagnosis() {
  diagnosisOpen = true;
  diagnosisState = { status: "idle" };
  paintDiagnosis();
}

// 诊断响应规范化：编号/秒数/总用时一律规范十进制字符串，计次数为 Number；
// 分类代码只接受三档白名单，其余视为异常响应，避免展示脏数据。
function normalizeDiagnosis(result) {
  for (const r of result.runners) {
    r.runner = typeof r.runner === "string" ? r.runner : String(r.runner);
    r.lapCount = typeof r.lapCount === "string" ? Number(r.lapCount) : r.lapCount;
    r.totalTime = intToText(r.totalTime);
    for (const d of r.diagnoses) {
      d.time = intToText(d.time);
      if (!(d.classification in DIAG_LABELS)) {
        throw new Error("诊断服务返回了无法识别的分类");
      }
      if (d.classification === "equal") {
        const a = d.alternative;
        if (!a || !Array.isArray(a.recordIds)) throw new Error("同优诊断缺少替代方案");
        a.lapCount = typeof a.lapCount === "string" ? Number(a.lapCount) : a.lapCount;
        a.totalTime = intToText(a.totalTime);
      }
    }
  }
  return result;
}

async function runDiagnosis() {
  // 入口关闭（重算在途、非法、清空）、无合法结果、已有诊断在途时都不可检查。
  if (!diagnosisOpen || diagnosisState.status === "loading" || !latestResult) return;
  const version = inputVersion;
  const adjSeq = adjudicationSeq; // 重算一开始（序号递增），本次诊断的响应即作废
  diagnosisState = { status: "loading" };
  paintDiagnosis();

  let resp;
  let data;
  try {
    resp = await fetch("/api/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 以当前完整裁决输入发起诊断（与裁决请求同一份载荷）。
      body: JSON.stringify(collectPayload()),
    });
    data = parseJsonLossless(await resp.text());
  } catch (err) {
    // 迟到的失败不得覆盖较新状态（含重算后新诊断的在途/成功/失败状态）。
    if (version !== inputVersion || adjSeq !== adjudicationSeq) return;
    diagnosisState = { status: "error", message: `无法连接诊断服务：${err.message}` };
    paintDiagnosis();
    return;
  }
  // 迟到的成功同样丢弃：重算前发出的诊断无论何时结束都不得重新显示，
  // 也不得改写重算后新诊断的在途、成功、失败状态。
  if (version !== inputVersion || adjSeq !== adjudicationSeq) return;
  if (!resp.ok || !data.ok) {
    // 当前输入本应与已展示的合法裁决一致；服务报错只在诊断卡内呈现，不动采纳结果。
    diagnosisState = {
      status: "error",
      message: (data && data.error) || `诊断失败（HTTP ${resp.status}）`,
    };
    paintDiagnosis();
    return;
  }
  try {
    normalizeDiagnosis(data.result);
  } catch (err) {
    diagnosisState = { status: "error", message: err.message };
    paintDiagnosis();
    return;
  }
  diagnosisState = { status: "done", result: data.result };
  paintDiagnosis();
}

function diagnosisHeadHtml() {
  return `
    <div class="result-head">
      <h3>未采纳记录替代性诊断</h3>
      <span class="review-scope">只读分析：不替换采纳结果，不改变计次、复核、罚秒或名次</span>
    </div>`;
}

function diagnosisIdleHtml() {
  return `
    ${diagnosisHeadHtml()}
    <p class="diag-intro">
      以当前完整裁决输入经 HTTP 诊断每名选手的<strong>未采纳记录</strong>：
      同优判断只比“计次数 + 原总用时”，不考虑 ID 决胜和罚秒，并给出包含目标记录的整套替代方案。
    </p>
    <div class="diag-actions">
      <button type="button" class="btn primary diagnose-run">🔎 检查替代性</button>
      <span class="diag-action-hint">仅在当前输入合法且未在重算时可检查；输入一改或重新计算即清除本诊断。</span>
    </div>`;
}

function diagnosisLoadingHtml() {
  return `
    ${diagnosisHeadHtml()}
    <div class="diag-loading">
      <span class="diag-spinner" aria-hidden="true"></span>
      正在经 HTTP 诊断未采纳记录的替代性…
    </div>`;
}

function diagnosisErrorHtml(message) {
  return `
    ${diagnosisHeadHtml()}
    <div class="diag-error">⚠ ${escapeHtml(message)}</div>
    <div class="diag-actions">
      <button type="button" class="btn secondary diagnose-run">重试诊断</button>
    </div>`;
}

function alternativeHtml(alt, targetId) {
  // 整套方案的 ID 序列按计次时间顺序排列（每 3 条一趟），目标记录高亮，不只展示单趟。
  const groups = [];
  for (let i = 0; i < alt.recordIds.length; i += 3) {
    const ids = alt.recordIds.slice(i, i + 3);
    groups.push(
      `<span class="diag-lap">第 ${i / 3 + 1} 趟：` +
        ids
          .map((id) =>
            id === targetId
              ? `<strong class="diag-target-id">${escapeHtml(id)}</strong>`
              : escapeHtml(id)
          )
          .join(" → ") +
        "</span>"
    );
  }
  return `
    <div class="diag-alt">
      <div class="diag-alt-meta">
        整套替代方案：<strong>${alt.lapCount}</strong> 次 · 原总用时
        <strong>${alt.totalTime}</strong> 秒（与现方案计次数、原总用时相同）
      </div>
      <div class="diag-alt-laps">${groups.join("")}</div>
    </div>`;
}

function diagnosisItemHtml(item) {
  return `
    <div class="diag-item diag-${item.classification}">
      <div class="diag-item-line">
        <span class="chip-mini ${item.gate}">${GATE_LABELS[item.gate]} · ${escapeHtml(
    item.id
  )} · ${item.time} 秒</span>
        <span class="diag-badge diag-badge-${item.classification}">${
    DIAG_LABELS[item.classification]
  }</span>
      </div>
      <div class="diag-hint">${DIAG_HINTS[item.classification]}</div>
      ${item.classification === "equal" ? alternativeHtml(item.alternative, item.id) : ""}
    </div>`;
}

function diagnosisRunnerHtml(r) {
  const head =
    r.lapCount === 0
      ? `选手 ${r.runner} · 现方案 0 次（无完整计次）`
      : `选手 ${r.runner} · 现方案 ${r.lapCount} 次 · 原总用时 ${r.totalTime} 秒`;
  const counts = { equal: 0, inferior: 0, unusable: 0 };
  for (const d of r.diagnoses) counts[d.classification] += 1;
  const summary =
    r.diagnoses.length === 0
      ? ""
      : `<div class="diag-summary">同优可替代 ${counts.equal} · 仅次优可用 ${counts.inferior} · 无法成趟 ${counts.unusable}</div>`;
  const body =
    r.diagnoses.length === 0
      ? `<div class="empty-line">（无未采纳记录）</div>`
      : r.diagnoses.map(diagnosisItemHtml).join("");
  return `
    <div class="diag-runner">
      <div class="diag-runner-head">${head}</div>
      ${summary}
      ${body}
    </div>`;
}

function diagnosisDoneHtml(result) {
  return `
    ${diagnosisHeadHtml()}
    <p class="diag-intro">
      下列诊断针对当前未采纳记录；诊断为只读结果，采纳方案、人工复核、罚秒与名次均保持不变。
    </p>
    ${result.runners.map(diagnosisRunnerHtml).join("")}
    <div class="diag-actions">
      <button type="button" class="btn ghost diagnose-rerun">重新诊断</button>
      <span class="diag-action-hint">修改任意输入或点击重新计算后本诊断立即清除，需在新结果上重新检查。</span>
    </div>`;
}

function paintDiagnosis() {
  // 入口关闭（重算在途、非法、清空）或无合法结果时诊断卡整体隐藏，不可检查。
  if (!diagnosisOpen || !latestResult) {
    diagnosisBox.hidden = true;
    return;
  }
  switch (diagnosisState.status) {
    case "idle":
      diagnosisBox.innerHTML = diagnosisIdleHtml();
      break;
    case "loading":
      diagnosisBox.innerHTML = diagnosisLoadingHtml();
      break;
    case "error":
      diagnosisBox.innerHTML = diagnosisErrorHtml(diagnosisState.message);
      break;
    case "done":
      diagnosisBox.innerHTML = diagnosisDoneHtml(diagnosisState.result);
      break;
  }
  diagnosisBox.hidden = false;
}

// 诊断按钮事件委托：loading 态按钮不存在/禁用，入口关闭（重算在途、非法、清空）时
// 卡片隐藏，皆不可点。
diagnosisBox.addEventListener("click", (e) => {
  if (!e.target.classList.contains("diagnose-run") &&
      !e.target.classList.contains("diagnose-rerun")) {
    return;
  }
  if (!diagnosisOpen || diagnosisState.status === "loading" || !latestResult) return;
  runDiagnosis();
});

/* ---------- 查找漏读（只读提示的具体实现） ---------- */

function clearMissing() {
  missingState = { status: "idle" };
  if (missingBox) {
    missingBox.hidden = true;
    missingBox.innerHTML = "";
  }
}

// 每次裁决开始（含输入未变的手动重算）与输入变更/清空：清除旧窗口并关闭查询入口。
function closeMissing() {
  missingOpen = false;
  clearMissing();
}

// 最新合法裁决到达后进入可查询状态（卡片显示、按钮可点，入口重新打开）。
function openMissing() {
  missingOpen = true;
  missingState = { status: "idle" };
  paintMissing();
}

// 漏读响应规范化：编号与区间端点一律规范十进制字符串（任意大整数无损），
// 缺失门只接受 S/M/F 白名单，其余视为异常响应，避免展示脏数据。
function normalizeMissing(result) {
  for (const r of result.runners) {
    r.runner = typeof r.runner === "string" ? r.runner : String(r.runner);
    r.lapCount = typeof r.lapCount === "string" ? Number(r.lapCount) : r.lapCount;
    if (!Array.isArray(r.windows)) throw new Error("漏读服务返回了无法识别的结果");
    for (const w of r.windows) {
      if (!(w.missingGate in GATE_LABELS)) {
        throw new Error("漏读服务返回了无法识别的缺失门");
      }
      if (!Array.isArray(w.ids) || w.ids.length !== 2) {
        throw new Error("漏读窗口缺少两条记录 ID");
      }
      w.timeMin = intToText(w.timeMin);
      w.timeMax = intToText(w.timeMax);
      if (w.timeMin === null || w.timeMax === null) {
        throw new Error("漏读服务返回了无法识别的秒数");
      }
    }
  }
  return result;
}

async function runMissing() {
  // 入口关闭（重算在途、非法、清空）、无合法结果、已有查询在途时都不可查询。
  if (!missingOpen || missingState.status === "loading" || !latestResult) return;
  const version = inputVersion;
  const adjSeq = adjudicationSeq; // 重算一开始（序号递增），本次查询的响应即作废
  missingState = { status: "loading" };
  paintMissing();

  let resp;
  let data;
  try {
    resp = await fetch("/api/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 以当前完整裁决输入发起查询（与裁决请求同一份载荷）。
      body: JSON.stringify(collectPayload()),
    });
    data = parseJsonLossless(await resp.text());
  } catch (err) {
    // 迟到的失败不得覆盖较新状态（含重算后新查询的在途/成功/失败状态）。
    if (version !== inputVersion || adjSeq !== adjudicationSeq) return;
    missingState = { status: "error", message: `无法连接漏读服务：${err.message}` };
    paintMissing();
    return;
  }
  // 迟到的成功同样丢弃：重算前发出的查询无论何时结束都不得重新显示，
  // 也不得改写重算后新查询的在途、成功、失败状态。
  if (version !== inputVersion || adjSeq !== adjudicationSeq) return;
  if (!resp.ok || !data.ok) {
    // 当前输入本应与已展示的合法裁决一致；服务报错只在漏读卡内呈现，不动采纳结果。
    missingState = {
      status: "error",
      message: (data && data.error) || `查找漏读失败（HTTP ${resp.status}）`,
    };
    paintMissing();
    return;
  }
  try {
    normalizeMissing(data.result);
  } catch (err) {
    missingState = { status: "error", message: err.message };
    paintMissing();
    return;
  }
  missingState = { status: "done", result: data.result };
  paintMissing();
}

function missingHeadHtml() {
  return `
    <div class="result-head">
      <h3>查找漏读（只补一条读数即可多完成一趟）</h3>
      <span class="review-scope">只读提示：不追加记录，不改变裁决、复核、罚秒、名次与诊断</span>
    </div>`;
}

function missingIdleHtml() {
  return `
    ${missingHeadHtml()}
    <p class="diag-intro">
      以当前完整裁决输入经 HTTP 推测：对每名选手枚举任意两条不同门记录与缺失门 S/M/F，
      给出“只补一条该门读数就能让最大计次数较现在增加 1”的秒数闭区间（覆盖全部可行秒数；
      只比计次数，不比用时、ID 决胜或罚秒）。
    </p>
    <div class="diag-actions">
      <button type="button" class="btn primary missing-run">🧭 查找漏读</button>
      <span class="diag-action-hint">仅在当前输入合法且未在重算时可查询；输入一改或重新计算即清除本窗口。</span>
    </div>`;
}

function missingLoadingHtml() {
  return `
    ${missingHeadHtml()}
    <div class="diag-loading">
      <span class="diag-spinner" aria-hidden="true"></span>
      正在经 HTTP 推测漏读时间窗…
    </div>`;
}

function missingErrorHtml(message) {
  return `
    ${missingHeadHtml()}
    <div class="diag-error">⚠ ${escapeHtml(message)}</div>
    <div class="diag-actions">
      <button type="button" class="btn secondary missing-run">重试查找</button>
    </div>`;
}

// 单个窗口：两条已有记录（依门序 S→M→F）+ 缺失门 + 秒数闭区间。
function missingWindowHtml(w) {
  const presentGates = Object.keys(GATE_LABELS).filter((g) => g !== w.missingGate);
  const chips = presentGates
    .map(
      (g, i) =>
        `<span class="chip-mini ${g}">${GATE_LABELS[g]} · ${escapeHtml(w.ids[i])}</span>`
    )
    .join("");
  return `
    <div class="missing-item">
      <div class="missing-item-line">
        ${chips}
        <span class="missing-lead">→ 补 ${GATE_LABELS[w.missingGate]} 读数：</span>
        <span class="missing-range">${w.timeMin} ～ ${w.timeMax} 秒</span>
      </div>
      <div class="diag-hint">闭区间内任取一个整数秒补一条${GATE_LABELS[w.missingGate]}读数，即可与这两条记录成趟，并使该选手最大计次数增加 1；虚拟读数不占 40 条录入名额。</div>
    </div>`;
}

function missingRunnerHtml(r) {
  const head =
    r.windows.length === 0
      ? `选手 ${r.runner} · 当前 ${r.lapCount} 次 · 无漏读窗口`
      : `选手 ${r.runner} · 当前 ${r.lapCount} 次 · 补 1 条即可 ${r.lapCount + 1} 次`;
  const body =
    r.windows.length === 0
      ? `<div class="empty-line">（该选手没有能多完成一趟的漏读窗口）</div>`
      : r.windows.map(missingWindowHtml).join("");
  return `
    <div class="diag-runner">
      <div class="diag-runner-head">${head}</div>
      ${body}
    </div>`;
}

function missingDoneHtml(result) {
  const total = result.runners.reduce((n, r) => n + r.windows.length, 0);
  const rerun = `
    <div class="diag-actions">
      <button type="button" class="btn ghost missing-rerun">重新查找</button>
      <span class="diag-action-hint">修改任意输入或点击重新计算后本窗口立即清除，需在新结果上重新查询。</span>
    </div>`;
  if (total === 0) {
    // 无解明确提示：不逐选手展开，直接给出结论。
    return `
      ${missingHeadHtml()}
      <p class="diag-intro"><strong>无解：</strong>当前输入下，任何两条不同门记录都无法通过只补一条读数（缺失门 S/M/F 任一）再多完成一趟。</p>
      ${rerun}`;
  }
  return `
    ${missingHeadHtml()}
    <p class="diag-intro">
      共找到 <strong>${total}</strong> 个漏读窗口：在每个闭区间内任取一个整数秒补一条对应门的读数，
      该选手即可多完成一趟。仅作提示：不会追加记录，也不改变裁决、复核、罚秒、名次与诊断。
    </p>
    ${result.runners.map(missingRunnerHtml).join("")}
    ${rerun}`;
}

function paintMissing() {
  if (!missingBox) return; // 旧生命周期测试的 DOM 桩没有漏读卡：不重绘
  // 入口关闭（重算在途、非法、清空）或无合法结果时漏读卡整体隐藏，不可查询。
  if (!missingOpen || !latestResult) {
    missingBox.hidden = true;
    return;
  }
  switch (missingState.status) {
    case "idle":
      missingBox.innerHTML = missingIdleHtml();
      break;
    case "loading":
      missingBox.innerHTML = missingLoadingHtml();
      break;
    case "error":
      missingBox.innerHTML = missingErrorHtml(missingState.message);
      break;
    case "done":
      missingBox.innerHTML = missingDoneHtml(missingState.result);
      break;
  }
  missingBox.hidden = false;
}

// 漏读按钮事件委托：loading 态按钮不存在，入口关闭（重算在途、非法、清空）时
// 卡片隐藏，皆不可点。旧 DOM 桩没有漏读卡时不挂载监听。
if (missingBox) {
  missingBox.addEventListener("click", (e) => {
    if (
      !e.target.classList.contains("missing-run") &&
      !e.target.classList.contains("missing-rerun")
    ) {
      return;
    }
    if (!missingOpen || missingState.status === "loading" || !latestResult) return;
    runMissing();
  });
}

/* ---------- 成绩公告（发布为独立的只读公告；服务端持久化，跨重启保留） ---------- */

// 公告卡独立于裁决生命周期：不按输入变化清除，发布响应也不改写编辑区、结果区、
// 复核、罚秒、诊断与漏读。点击“发布”时取当下完整快照（完整裁决输入含隔离、
// 已保存复核、已保存罚秒、所见公告版本）经 HTTP 提交；服务端重新裁决并逐趟
// 核对复核（每趟均须“通过”，零次无需复核）、按原校验检查罚秒与原因、按原
// 规则生成名次，版本匹配才保存为下一版本并返回公告链接。
// 公告状态机（bulletinState.status）：idle / loading / done / error。
const bulletinBox = document.getElementById("bulletin-box");
let bulletinState = { status: "idle" };
// 每个公告编号各自追踪“所见公告版本”：首次发布为 0；发布成功后更新为已发布
// 版本，409 冲突时采用服务端返回的当前最新版本。仅页面内存，刷新后回到 0。
const bulletinVersions = new Map(); // number -> version
let bulletinNumber = ""; // 公告编号输入框的原文（重绘时恢复）

// 仅供无浏览器生命周期测试直接读取/驱动发布。
if (typeof globalThis !== "undefined") {
  globalThis.__getBulletinStateForTest = () => bulletinState;
  globalThis.__runBulletinPublishForTest = () => runBulletinPublish();
  globalThis.__bulletinVersionsForTest = bulletinVersions;
}

// 已保存复核的快照：从绑定键还原 选手 + 三条记录的 ID/门/秒数（规范十进制
// 字符串，任意大的编号与秒数全程无损），服务端按同一四元组核对采纳趟。
function collectBulletinReviews() {
  const out = [];
  for (const [key, saved] of reviews) {
    let parts;
    try {
      parts = JSON.parse(key);
    } catch (err) {
      continue; // 结构不符的键不参与发布（正常不会出现）
    }
    const [runner, s, m, f] = parts;
    out.push({
      runner,
      records: [
        { id: s[0], gate: s[1], time: s[2] },
        { id: m[0], gate: m[1], time: m[2] },
        { id: f[0], gate: f[1], time: f[2] },
      ],
      status: saved.status,
      note: saved.note,
    });
  }
  return out;
}

// 已保存罚秒的快照：编号为规范十进制字符串，罚秒与原因原样提交，服务端按
// 原校验复核（非负整数、原因至多 200 字、罚秒大于 0 时原因必填）。
function collectBulletinPenalties() {
  return [...penalties.entries()].map(([runner, saved]) => ({
    runner,
    seconds: saved.seconds,
    reason: saved.reason,
  }));
}

async function runBulletinPublish() {
  if (!bulletinBox || bulletinState.status === "loading") return;
  const inputEl = bulletinBox.querySelector(".bulletin-number");
  if (inputEl) bulletinNumber = inputEl.value;
  const number = bulletinNumber.trim();
  if (number === "") {
    bulletinState = { status: "error", message: "公告编号不能为空" };
    paintBulletin();
    return;
  }
  // 点击时快照：完整裁决输入（含隔离 ID 列表）、已保存复核、已保存罚秒与
  // 该编号当前所见公告版本（首次为 0）。
  const snapshot = {
    number,
    baseVersion: bulletinVersions.get(number) || 0,
    input: collectPayload(),
    reviews: collectBulletinReviews(),
    penalties: collectBulletinPenalties(),
  };
  bulletinState = { status: "loading" };
  paintBulletin();

  let resp;
  let data;
  try {
    resp = await fetch("/api/bulletins/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    data = parseJsonLossless(await resp.text());
  } catch (err) {
    bulletinState = { status: "error", message: `无法连接公告服务：${err.message}` };
    paintBulletin();
    return;
  }
  if (resp.status === 409) {
    // 过期发布：采用服务端返回的当前最新版本作为新的所见版本，便于再次发布。
    if (data && typeof data.currentVersion === "number") {
      bulletinVersions.set(number, data.currentVersion);
    }
    bulletinState = {
      status: "error",
      message: (data && data.error) || "公告版本已变化，本次未发布；请重新发布",
    };
    paintBulletin();
    return;
  }
  if (!resp.ok || !data.ok) {
    bulletinState = {
      status: "error",
      message: (data && data.error) || `发布失败（HTTP ${resp.status}）`,
    };
    paintBulletin();
    return;
  }
  const result = data.result || {};
  const version =
    typeof result.version === "string" ? Number(result.version) : result.version;
  bulletinVersions.set(number, version);
  bulletinState = {
    status: "done",
    number: typeof result.number === "string" ? result.number : number,
    version,
    url: typeof result.url === "string" ? result.url : "",
  };
  paintBulletin();
}

function bulletinStatusHtml() {
  switch (bulletinState.status) {
    case "loading":
      return `
        <div class="diag-loading bulletin-status">
          <span class="diag-spinner" aria-hidden="true"></span>
          正在经 HTTP 发布成绩公告…（服务端重新裁决并核对复核与罚秒）
        </div>`;
    case "error":
      return `<div class="diag-error bulletin-status">⚠ ${escapeHtml(bulletinState.message)}</div>`;
    case "done":
      return `
        <div class="import-done bulletin-status">
          ✓ 公告 ${escapeHtml(bulletinState.number)} 已发布为版本 ${bulletinState.version}（只读，跨重启保留）：
          <a class="bulletin-link" href="${escapeAttr(bulletinState.url)}" target="_blank" rel="noopener">${escapeHtml(bulletinState.url)}</a>
        </div>`;
    default:
      return "";
  }
}

function paintBulletin() {
  if (!bulletinBox) return; // 旧生命周期测试的 DOM 桩没有公告卡：不重绘
  const loading = bulletinState.status === "loading";
  bulletinBox.innerHTML = `
    <section class="result-card bulletin-card">
      <div class="result-head">
        <h3>成绩公告（发布为只读公告）</h3>
        <span class="review-scope">发布后只读并跨重启保留；后续编辑、清空与刷新不影响已发布的公告</span>
      </div>
      <p class="diag-intro">
        以点击时的完整裁决输入（含隔离）、已保存复核与罚秒为快照发布；服务端重新裁决并逐趟核对复核
        （每趟均须“通过”，零次无需复核），罚秒与原因沿用原校验，名次按原规则在服务端生成。
        同一编号首次发布为版本 1；再次发布须基于最新版本，过期将被拒绝（409）。
      </p>
      <div class="bulletin-controls">
        <input type="text" class="bulletin-number" value="${escapeAttr(bulletinNumber)}"
          placeholder="公告编号（非空，如 2026-001）" ${loading ? "disabled" : ""} />
        <button type="button" class="btn primary bulletin-publish" ${loading ? "disabled" : ""}>📣 发布成绩公告</button>
      </div>
      ${bulletinStatusHtml()}
    </section>`;
  bulletinBox.hidden = false;
}

// 公告卡事件委托：编号输入只登记原文（不触发任何重算），点击按钮发起发布。
// 公告卡位于表单之外，输入编号不会引起自动重算；发布响应也不改写编辑区。
if (bulletinBox) {
  bulletinBox.addEventListener("input", (e) => {
    if (e.target.classList && e.target.classList.contains("bulletin-number")) {
      bulletinNumber = e.target.value;
    }
  });
  bulletinBox.addEventListener("click", (e) => {
    if (!e.target.classList.contains("bulletin-publish")) return;
    if (bulletinState.status === "loading") return;
    runBulletinPublish();
  });
  paintBulletin();
}

/* ---------- 设备感应日志 CSV 并入（HTTP 预览 → 确认后才追加） ---------- */

// 导入状态机（importState）：
//   null                      尚无预览 / 预览已失效（确认入口不存在）
//   {status:"loading-preview"} 预览请求在途
//   {status:"preview", result, token, snapshot, fileMeta}
//                             预览成功：显示新增/重复清单与“确认追加”入口
//   {status:"loading-confirm"} 确认请求在途
//   {status:"error", message}  预览或确认被服务拒绝/断网（原表不动），可重新预览
//   {status:"merged", message} 追加成功后的一次性提示（保留至下一次输入/文件变化）
//
// 失效规则：任何赛道输入变化（区间、选手、记录，含增删行、示例、清空）或上传文件
// 变化（重新选择、清空）都立即让预览失效：token 递增、状态清空、确认入口消失；
// 变化前发出的预览/确认响应无论何时返回（成功、422 或断网）都因 token 守卫被丢弃，
// 不能恢复确认入口。确认时还会再次核对输入、文件与服务端清单均与预览一致。
let importState = null;
let importToken = 0;
let importFileMeta = null; // 当前选中文件的身份快照（name/size/lastModified）
let suppressImportFileChange = false; // 合并成功后程序化清空文件时不触发失效

const importFileEl = document.getElementById("import-file");
const importPreviewBtn = document.getElementById("import-preview-btn");
const importFileNameEl = document.getElementById("import-file-name");
const importBox = document.getElementById("import-box");

if (typeof globalThis !== "undefined") {
  globalThis.__getImportStateForTest = () => importState;
  globalThis.__importPreviewForTest = () => runImportPreview();
  globalThis.__importConfirmForTest = () => runImportConfirm();
}

function currentImportFile() {
  const files = importFileEl && importFileEl.files;
  return files && files.length > 0 ? files[0] : null;
}

function setImportFileMeta() {
  const f = currentImportFile();
  importFileMeta = f
    ? { name: f.name, size: f.size, lastModified: f.lastModified }
    : null;
  if (importFileNameEl) {
    importFileNameEl.textContent = f ? `已选择：${f.name}` : "未选择文件";
  }
  if (importPreviewBtn) importPreviewBtn.disabled = !f;
}

function invalidateImportPreview(keepMessage = false) {
  importToken += 1;
  const message =
    keepMessage && importState && importState.status === "merged"
      ? importState.message
      : null;
  importState = message ? { status: "merged", message } : null;
  paintImport();
}

// 预览/确认结果规范化：编号、秒数一律规范十进制字符串（大整数无损解析器已保证
// 不截断），行号与计数还原为 Number。
function normalizeImportResult(result) {
  const normEntry = (e) => ({
    id: String(e.id),
    runner:
      typeof e.runner === "string"
        ? e.runner.replace(/^0+(?=\d)/, "")
        : String(e.runner),
    gate: e.gate,
    time: intToText(e.time),
    line: typeof e.line === "string" ? Number(e.line) : e.line,
  });
  return {
    added: (result.added || []).map(normEntry),
    duplicates: (result.duplicates || []).map(normEntry),
    existingCount: Number(result.existingCount),
    mergedCount: Number(result.mergedCount),
  };
}

function collectPayloadSnapshot() {
  // 快照即当前完整裁决载荷（collectPayload 已对 ID 等字段去空白）：
  // 规范化后的 JSON 文本逐项相等，才视为“输入仍与预览一致”。
  return JSON.stringify(collectPayload());
}

function collectImportContext() {
  // 设备日志合并始终对“完整原表”去重、计数与限额：隔离不能跳过冲突或绕过
  // 40 条上限，故导入 context 刻意不含 excludedIds（context 形状同 runners+records）。
  const payload = collectPayload();
  return { runners: payload.runners, records: payload.records };
}

async function postImport(endpoint) {
  const fd = new FormData();
  fd.set("context", JSON.stringify(collectImportContext()));
  fd.set("file", currentImportFile());
  let resp;
  let data;
  try {
    resp = await fetch(endpoint, { method: "POST", body: fd });
    data = parseJsonLossless(await resp.text());
  } catch (err) {
    return { networkError: `无法连接导入服务：${err.message}` };
  }
  return { resp, data };
}

async function runImportPreview() {
  const file = currentImportFile();
  if (!file) return;
  const token = ++importToken;
  importState = { status: "loading-preview", token };
  paintImport();
  const outcome = await postImport("/api/import/preview");
  // 迟到响应：状态已不是本次 loading（输入/文件变化已使其失效），直接丢弃，
  // 不得渲染错误，更不能恢复确认入口。
  if (
    token !== importToken ||
    !importState ||
    importState.status !== "loading-preview"
  ) {
    return;
  }
  if (outcome.networkError) {
    importState = { status: "error", message: outcome.networkError };
    paintImport();
    return;
  }
  const { resp, data } = outcome;
  if (!resp.ok || !data.ok) {
    // 整批拒绝：展示中文原因，记录表未被改动。
    importState = {
      status: "error",
      message: (data && data.error) || `预览失败（HTTP ${resp.status}）`,
    };
    paintImport();
    return;
  }
  importState = {
    status: "preview",
    token,
    result: normalizeImportResult(data.result),
    snapshot: collectPayloadSnapshot(),
    fileMeta: { ...importFileMeta },
  };
  paintImport();
}

function isBlankRecordRow(row) {
  return ["rec-id", "rec-runner", "rec-gate", "rec-time"].every((cls) =>
    row.querySelector("." + cls).value.trim() === ""
  );
}

// 把确认后的新增条目追加到记录表末尾（先复用全空占位行）；
// 不改动任何旧行与选手、区间，顺序按文件首次出现顺序（服务端已排序）。
function appendImportedRecords(added) {
  for (const e of added) {
    let row = [...recordRows.querySelectorAll(".record-row")].find(isBlankRecordRow);
    if (!row) {
      if (recordRows.children.length >= MAX_RECORDS) {
        throw new Error("记录表没有可容纳新记录的空行");
      }
      addRecordRow();
      row = recordRows.children[recordRows.children.length - 1];
    }
    row.querySelector(".rec-id").value = e.id;
    row.querySelector(".rec-runner").value = e.runner;
    row.querySelector(".rec-gate").value = e.gate;
    row.querySelector(".rec-time").value = e.time;
  }
  refreshRecordCount();
}

async function runImportConfirm() {
  if (!importState || importState.status !== "preview") return;
  const token = ++importToken;
  const preview = importState;
  importState = { status: "loading-confirm", token };
  paintImport();
  const outcome = await postImport("/api/import/confirm");
  // 确认在途时输入/文件变化同样立即使预览失效；迟到的确认响应一律丢弃。
  if (
    token !== importToken ||
    !importState ||
    importState.status !== "loading-confirm"
  ) {
    return;
  }
  if (outcome.networkError) {
    importState = { status: "error", message: outcome.networkError };
    paintImport();
    return;
  }
  const { resp, data } = outcome;
  if (!resp.ok || !data.ok) {
    importState = {
      status: "error",
      message: (data && data.error) || `确认失败（HTTP ${resp.status}）`,
    };
    paintImport();
    return;
  }
  const result = normalizeImportResult(data.result);
  // 确认时输入、上传文件与服务端清单都必须仍与预览完全一致；
  // 任一不一致（含防抖期尚未重算的编辑）都拒绝追加并令预览失效。
  const file = currentImportFile();
  const fileUnchanged =
    file &&
    preview.fileMeta &&
    file.name === preview.fileMeta.name &&
    file.size === preview.fileMeta.size &&
    file.lastModified === preview.fileMeta.lastModified;
  const inputUnchanged =
    preview.snapshot !== undefined &&
    preview.snapshot === collectPayloadSnapshot();
  const resultUnchanged =
    JSON.stringify(result) === JSON.stringify(preview.result);
  if (!fileUnchanged || !inputUnchanged || !resultUnchanged) {
    importState = {
      status: "error",
      message: "确认时的赛道输入或上传文件已与预览不一致，本次未追加；请重新预览",
    };
    paintImport();
    return;
  }
  try {
    appendImportedRecords(result.added);
  } catch (err) {
    importState = { status: "error", message: err.message };
    paintImport();
    return;
  }
  const nAdd = result.added.length;
  const nDup = result.duplicates.length;
  importState = {
    status: "merged",
    message:
      `已追加 ${nAdd} 条新记录（跳过 ${nDup} 条重复），合并后共 ${result.mergedCount} 条；` +
      "已按合并后的记录自动裁决，选手与区间未改动",
  };
  paintImport();
  // 追加完成：程序化清空文件选择（抑制其 change 事件，避免清掉成功提示）。
  if (importFileEl) {
    suppressImportFileChange = true;
    importFileEl.value = "";
    suppressImportFileChange = false;
  }
  setImportFileMeta();
  // 成功合并触发自动裁决：复核、罚秒与诊断沿用原失效规则
  // （rerunAfterMerge 不触碰 merged 成功提示）。
  rerunAfterMerge();
}

function importEntriesTableHtml(entries, emptyText) {
  if (entries.length === 0) return `<div class="empty-line">${emptyText}</div>`;
  const body = entries
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.id)}</td><td>${e.runner}</td>` +
        `<td>${GATE_LABELS[e.gate]}</td><td>${e.time} 秒</td><td>第 ${e.line} 行</td></tr>`
    )
    .join("");
  return `<table class="import-table">
    <thead><tr><th>记录 ID</th><th>选手编号</th><th>门</th><th>秒数</th><th>文件位置</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function importDuplicatesHtml(entries) {
  if (entries.length === 0) return "";
  const lines = entries
    .map(
      (e) =>
        `<div class="dup-line">第 ${e.line} 行 · ${escapeHtml(e.id)} · 选手 ${e.runner} · ` +
        `${GATE_LABELS[e.gate]} · ${e.time} 秒</div>`
    )
    .join("");
  return `<details class="import-dups"><summary>跳过的重复条目 ${entries.length} 条（同 ID 且内容一致）</summary>${lines}</details>`;
}

function paintImport() {
  if (!importBox) return;
  if (!importState) {
    importBox.hidden = true;
    importBox.innerHTML = "";
    return;
  }
  switch (importState.status) {
    case "loading-preview":
      importBox.innerHTML = `
        <div class="import-loading">
          <span class="diag-spinner" aria-hidden="true"></span>
          正在经 HTTP 预览新增与重复条目…（预览不改动记录表）
        </div>`;
      break;
    case "preview": {
      const r = importState.result;
      importBox.innerHTML = `
        <div class="import-summary">
          现有 <strong>${r.existingCount}</strong> 条，文件新增
          <strong>${r.added.length}</strong> 条，重复跳过
          <strong>${r.duplicates.length}</strong> 条，合并后
          <strong>${r.mergedCount}</strong> 条（上限 ${MAX_RECORDS} 条）。
        </div>
        <div class="subsection"><h4>确认后将新增（按文件首次出现顺序追加到末尾）</h4>
          ${importEntriesTableHtml(r.added, "（没有新增记录，文件条目与现有记录全部一致）")}
        </div>
        ${importDuplicatesHtml(r.duplicates)}
        <div class="import-actions">
          <button type="button" class="btn primary import-confirm">✓ 确认追加 ${r.added.length} 条并自动裁决</button>
          <button type="button" class="btn ghost import-cancel">取消预览</button>
          <span class="import-action-hint">预览期间仍可编辑；任一赛道输入或上传文件变化立即使本预览失效，确认时还会再次核对。</span>
        </div>`;
      break;
    }
    case "loading-confirm":
      importBox.innerHTML = `
        <div class="import-loading">
          <span class="diag-spinner" aria-hidden="true"></span>
          正在经 HTTP 复核并追加…等待期间仍可编辑，编辑即令本次确认失效。
        </div>`;
      break;
    case "error":
      importBox.innerHTML = `
        <div class="import-error">⚠ ${escapeHtml(importState.message)}</div>
        <div class="import-actions">
          <button type="button" class="btn secondary import-retry">重新预览</button>
          <span class="import-action-hint">整批拒绝：记录表、复核与罚秒均保持原样未改动。</span>
        </div>`;
      break;
    case "merged":
      importBox.innerHTML = `<div class="import-done">✓ ${escapeHtml(importState.message)}</div>`;
      break;
  }
  importBox.hidden = false;
}

// 旧生命周期测试的 DOM 桩没有导入控件：元素缺失时整个导入交互不挂载，
// 但 invalidateImportPreview 等函数仍可被安全调用（no-op 重绘）。
if (importFileEl) {
  setImportFileMeta();
  importFileEl.addEventListener("change", () => {
    // 上传文件变化（重新选择、清空选择）：立即登记新身份并令旧预览失效，
    // 迟到响应无法恢复确认入口。程序化清空（合并成功后）除外。
    setImportFileMeta();
    if (!suppressImportFileChange) invalidateImportPreview();
  });
  importPreviewBtn.addEventListener("click", runImportPreview);
  importBox.addEventListener("click", (e) => {
    if (e.target.classList.contains("import-confirm")) runImportConfirm();
    else if (e.target.classList.contains("import-cancel")) invalidateImportPreview();
    else if (e.target.classList.contains("import-retry")) runImportPreview();
  });
  paintImport();
}

// 表单的 input/change 监听不得把文件选择与导入卡内的操作误判为赛道输入变化。
function eventTargetsImport(e) {
  return (
    (importFileEl && e.target === importFileEl) ||
    (importPreviewBtn && e.target === importPreviewBtn) ||
    (importBox &&
      typeof importBox.contains === "function" &&
      importBox.contains(e.target))
  );
}

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}

/* ---------- 示例 / 清空 ---------- */

const SAMPLE = {
  smMin: "10",
  smMax: "60",
  mfMin: "10",
  mfMax: "60",
  runners: [{ number: "101" }, { number: "102" }],
  records: [
    { id: "a1", runner: "101", gate: "S", time: "0" },
    { id: "b1", runner: "101", gate: "M", time: "12" },
    { id: "c1", runner: "101", gate: "F", time: "25" },
    { id: "a2", runner: "101", gate: "S", time: "30" },
    { id: "b2", runner: "101", gate: "M", time: "45" },
    { id: "c2", runner: "101", gate: "F", time: "58" },
    { id: "x1", runner: "101", gate: "M", time: "200" },
    { id: "x2", runner: "101", gate: "S", time: "31" },
    { id: "d1", runner: "102", gate: "S", time: "5" },
    { id: "e1", runner: "102", gate: "M", time: "15" },
    { id: "f1", runner: "102", gate: "F", time: "25" },
  ],
};

function resetImportUi() {
  // 清空/载入示例：上传文件与合并预览一并清除（不恢复旧预览）。
  if (importFileEl) {
    suppressImportFileChange = true;
    importFileEl.value = "";
    suppressImportFileChange = false;
  }
  importFileMeta = null;
  if (importFileNameEl) importFileNameEl.textContent = "未选择文件";
  if (importPreviewBtn) importPreviewBtn.disabled = true;
  importState = null;
  importToken += 1;
  paintImport();
}

function loadSample() {
  reviews.clear(); // 载入示例同时清掉全部复核记录
  penalties.clear(); // 同时清掉全部罚秒
  exclusions.clear(); // 隔离仅绑定本次记录表：载入示例一并清除
  resetImportUi(); // 同时清除上传文件与导入预览
  document.getElementById("smMin").value = SAMPLE.smMin;
  document.getElementById("smMax").value = SAMPLE.smMax;
  document.getElementById("mfMin").value = SAMPLE.mfMin;
  document.getElementById("mfMax").value = SAMPLE.mfMax;

  runnerRows.innerHTML = "";
  SAMPLE.runners.forEach((r) => addRunnerRow(r.number));
  refreshRunnerButtons();

  recordRows.innerHTML = "";
  SAMPLE.records.forEach(() => addRecordRow());
  [...recordRows.querySelectorAll(".record-row")].forEach((row, i) => {
    const rec = SAMPLE.records[i];
    row.querySelector(".rec-id").value = rec.id;
    row.querySelector(".rec-runner").value = rec.runner;
    row.querySelector(".rec-gate").value = rec.gate;
    row.querySelector(".rec-time").value = rec.time;
  });
  refreshRecordCount();
  syncExclusionButtons(); // 示例行默认全部“重新纳入”（无隔离）

  onInputChanged(); // 载入示例后按当前完整输入自动重算
}

function clearAll() {
  // 递增版本号并取消待发的重算：之后在途请求返回也不得恢复结果或错误。
  inputVersion += 1;
  reviews.clear(); // 清空同时清掉全部复核记录
  penalties.clear(); // 同时清掉全部罚秒
  exclusions.clear(); // 同时清掉全部隔离
  resetImportUi(); // 同时清除上传文件与导入预览
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  document.getElementById("smMin").value = "";
  document.getElementById("smMax").value = "";
  document.getElementById("mfMin").value = "";
  document.getElementById("mfMax").value = "";
  runnerRows.innerHTML = "";
  addRunnerRow();
  recordRows.innerHTML = "";
  addRecordRow();
  syncExclusionButtons();
  clearOutcome(); // 同时清掉结果与错误
  pendingHint.hidden = true;
}

document.getElementById("sample-btn").addEventListener("click", loadSample);
document.getElementById("clear-btn").addEventListener("click", clearAll);

/* ---------- 初始行 ---------- */
addRunnerRow();
addRecordRow();
addRecordRow();
refreshRunnerButtons();
refreshRecordCount();
