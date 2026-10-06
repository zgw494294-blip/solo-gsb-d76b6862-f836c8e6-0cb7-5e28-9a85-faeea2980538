/* 成绩公告只读视图：独立页面 /bulletin.html 与主页面内联读取共用。
 *
 * 公告是服务端落库的不可变快照：编号、记录秒数及用时全程精确（后端任意精度
 * 整数，经下方无损解析器在超过 2^53 时保留为十进制字符串），本文件只渲染、
 * 不提供任何编辑/删除入口——旧版本永久只读，后续编辑、清空与刷新不影响公告。
 */
(function () {
  "use strict";

  const GATE_LABELS = { S: "起点 S", M: "中途门 M", F: "终点 F" };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  /* 与 static/app.js 中同款的大整数无损 JSON 解析：行为与 JSON.parse 一致，
   * 唯一区别是超出安全整数范围的整数字面量保留为规范十进制字符串。
   * （公告读取是独立只读页面，不能依赖 app.js；两处刻意保持一致。）*/
  function parseJsonLossless(text) {
    let pos = 0;
    const fail = () => { throw new SyntaxError("公告服务返回了无法解析的响应"); };
    const skipWs = () => {
      while (pos < text.length && " \t\n\r".indexOf(text[pos]) !== -1) pos += 1;
    };
    const parseString = () => {
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
        if (text[pos] === "}") { pos += 1; return obj; }
        for (;;) {
          skipWs();
          if (text[pos] !== '"') fail();
          const key = parseString();
          skipWs();
          if (text[pos] !== ":") fail();
          pos += 1;
          obj[key] = parseValue();
          skipWs();
          if (text[pos] === ",") { pos += 1; continue; }
          if (text[pos] === "}") { pos += 1; return obj; }
          fail();
        }
      }
      if (c === "[") {
        pos += 1;
        const arr = [];
        skipWs();
        if (text[pos] === "]") { pos += 1; return arr; }
        for (;;) {
          arr.push(parseValue());
          skipWs();
          if (text[pos] === ",") { pos += 1; continue; }
          if (text[pos] === "]") { pos += 1; return arr; }
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

  function asText(v) {
    if (typeof v === "number") return Number.isSafeInteger(v) ? String(v) : null;
    if (typeof v === "string" && /^\d+$/.test(v)) return v.replace(/^0+(?=\d)/, "");
    return null;
  }

  // 公告快照规范化：编号/各类秒数与用时一律规范十进制字符串（任意精度无损），
  // 计次数与版本还原为 Number。
  function normalizeSnapshot(snap) {
    const num = (v) => (typeof v === "string" ? Number(v) : v);
    snap.version = num(snap.version);
    snap.latestVersion = num(snap.latestVersion);
    snap.input = snap.input || {};
    // 合格耗时区间随完整输入一起落库（input.standards）。
    snap.standards = snap.standards || snap.input.standards || {};
    for (const k of ["smMin", "smMax", "mfMin", "mfMax"]) {
      snap.standards[k] = asText(snap.standards[k]);
    }
    const normRec = (r) => ({
      id: String(r.id),
      runner: typeof r.runner === "string" ? r.runner.replace(/^0+(?=\d)/, "") : String(r.runner),
      gate: r.gate,
      time: asText(r.time),
    });
    snap.input.runners = (snap.input.runners || []).map((r) => ({
      number: typeof r.number === "string" ? r.number.replace(/^0+(?=\d)/, "") : String(r.number),
    }));
    snap.input.records = (snap.input.records || []).map(normRec);
    snap.input.excludedIds = snap.input.excludedIds || [];
    for (const r of snap.adjudication.runners) {
      r.runner = typeof r.runner === "string" ? r.runner : String(r.runner);
      r.lapCount = num(r.lapCount);
      r.totalTime = asText(r.totalTime);
      for (const lap of r.laps || []) {
        lap.start.time = asText(lap.start.time);
        lap.middle.time = asText(lap.middle.time);
        lap.finish.time = asText(lap.finish.time);
        lap.smTime = asText(lap.smTime);
        lap.mfTime = asText(lap.mfTime);
        lap.totalTime = asText(lap.totalTime);
      }
      for (const u of r.unused || []) u.time = asText(u.time);
      for (const x of r.excluded || []) x.time = asText(x.time);
    }
    for (const rv of snap.reviews || []) {
      rv.runner = typeof rv.runner === "string" ? rv.runner : String(rv.runner);
      rv.lapIndex = num(rv.lapIndex);
      rv.smTime = asText(rv.smTime);
      rv.mfTime = asText(rv.mfTime);
      rv.totalTime = asText(rv.totalTime);
      rv.start.time = asText(rv.start.time);
      rv.middle.time = asText(rv.middle.time);
      rv.finish.time = asText(rv.finish.time);
    }
    for (const p of snap.penalties || []) {
      p.runner = typeof p.runner === "string" ? p.runner : String(p.runner);
      p.seconds = asText(p.seconds);
    }
    for (const row of snap.ranking || []) {
      row.runner = typeof row.runner === "string" ? row.runner : String(row.runner);
      row.lapCount = num(row.lapCount);
      row.totalTime = asText(row.totalTime);
      row.penaltySeconds = asText(row.penaltySeconds);
      row.adjustedTime = asText(row.adjustedTime);
      row.rank = row.rank === null || row.rank === undefined ? null : num(row.rank);
    }
    return snap;
  }

  function gateChip(gate, id, time) {
    return `<span class="chip ${gate}">
      <span class="chip-id">${escapeHtml(id)}</span>
      <span class="chip-t">${GATE_LABELS[gate]} · ${time} 秒</span>
    </span>`;
  }

  function rankingTableHtml(snap) {
    const body = (snap.ranking || [])
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.runner)}</td>
          <td>${row.lapCount}</td>
          <td>${row.totalTime} 秒</td>
          <td>${row.penaltySeconds} 秒</td>
          <td>${row.penaltySeconds !== "0" ? escapeHtml(row.penaltyReason || "") : "—"}</td>
          <td>${row.adjustedTime} 秒</td>
          <td>${row.rank === null ? "—" : `第 ${row.rank} 名`}</td>
        </tr>`
      )
      .join("");
    return `<table class="ranking-table">
      <thead><tr>
        <th>选手编号</th><th>计次数</th><th>原总用时</th><th>罚秒</th><th>原因</th>
        <th>调整后用时</th><th>名次</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function reviewsByRunner(snap) {
    const map = new Map();
    for (const rv of snap.reviews || []) {
      if (!map.has(rv.runner)) map.set(rv.runner, []);
      map.get(rv.runner).push(rv);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.lapIndex - b.lapIndex);
    }
    return map;
  }

  function runnerCardHtml(r, reviewList) {
    const badge =
      r.lapCount === 0
        ? `<span class="badge zero">0 次完整计次</span>`
        : `<span class="badge ok">${r.lapCount} 次完整计次</span>`;
    const lapsHtml =
      r.lapCount === 0
        ? `<div class="zero-note">该选手没有符合两段耗时区间的完整一趟，计 0 次；无需复核。</div>`
        : r.laps
            .map((lap, i) => {
              const rv = reviewList && reviewList[i];
              const review = rv
                ? `<div class="review-box readonly-review">
                     <div class="review-head">
                       <span class="review-label">人工复核</span>
                       <span class="review-current">当前：通过${rv.note ? `（备注：${escapeHtml(rv.note)}）` : ""}</span>
                     </div>
                   </div>`
                : "";
              return `<div class="lap-item">
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
                ${review}
              </div>`;
            })
            .join("");
    const unusedHtml = (r.unused || []).length
      ? r.unused
          .map((u) => `<span class="chip-mini ${u.gate}">${GATE_LABELS[u.gate]} · ${escapeHtml(u.id)} · ${u.time} 秒</span>`)
          .join("")
      : `<span class="empty-line">（无未采纳记录）</span>`;
    const excludedHtml = (r.excluded || []).length
      ? `<div class="subsection excluded-subsection">
          <h4>隔离记录（发布时已暂时退出计算，原始读数保留）</h4>
          ${r.excluded
            .map((x) => `<span class="chip-mini excluded-chip ${x.gate}">${GATE_LABELS[x.gate]} · ${escapeHtml(x.id)} · ${x.time} 秒</span>`)
            .join("")}
        </div>`
      : "";
    return `<section class="result-card">
      <div class="result-head"><h3>选手 ${escapeHtml(r.runner)}</h3>${badge}</div>
      <div>${lapsHtml}</div>
      <div class="subsection"><h4>未采纳记录（不含隔离记录）</h4>${unusedHtml}</div>
      ${excludedHtml}
    </section>`;
  }

  function inputTablesHtml(snap) {
    const excluded = new Set(snap.input.excludedIds || []);
    const recBody = snap.input.records
      .map(
        (r) => `<tr class="${excluded.has(r.id) ? "excluded-row" : ""}">
          <td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.runner)}</td>
          <td>${GATE_LABELS[r.gate] || escapeHtml(r.gate)}</td><td>${r.time} 秒</td>
          <td>${excluded.has(r.id) ? "已隔离" : ""}</td>
        </tr>`
      )
      .join("");
    return `<section class="card">
      <h3>发布时的完整裁决输入（快照，只读）</h3>
      <p class="hint">
        合格耗时区间：起点→中途门 ${snap.standards.smMin}～${snap.standards.smMax} 秒；
        中途门→终点 ${snap.standards.mfMin}～${snap.standards.mfMax} 秒。
        登记选手：${snap.input.runners.map((r) => escapeHtml(r.number)).join("、")}。
      </p>
      <div class="table-wrap">
        <table class="record-table">
          <thead><tr><th>记录 ID</th><th>选手编号</th><th>门</th><th>秒数</th><th>隔离</th></tr></thead>
          <tbody>${recBody}</tbody>
        </table>
      </div>
    </section>`;
  }

  function renderBulletinSnapshot(rawSnap) {
    const s = normalizeSnapshot(rawSnap);
    const reviewMap = reviewsByRunner(s);
    const isLatest = s.version === s.latestVersion;
    const createdAt = s.createdAt ? s.createdAt.replace("Z", " UTC").replace("T", " ") : "";
    return `
      <div class="bulletin-banner">
        <div class="bulletin-banner-head">
          <h2>成绩公告 · ${escapeHtml(s.bulletinId)}</h2>
          <span class="badge ${isLatest ? "ok" : ""}">${isLatest ? "最新版本" : "历史版本（只读）"}</span>
        </div>
        <p class="hint">
          版本 <strong>${s.version}</strong>${isLatest ? "" : ` / 最新 ${s.latestVersion}`}
          ${createdAt ? `· 发布时间 ${escapeHtml(createdAt)}` : ""}
          · 本页为服务端保存的不可变快照，后续编辑、清空与刷新均不影响。
        </p>
      </div>
      <section class="card">
        <div class="result-head"><h3>比赛名次（发布时由服务端重新计算）</h3></div>
        ${rankingTableHtml(s)}
      </section>
      ${s.adjudication.runners
        .slice()
        .sort((a, b) => a.runner.length - b.runner.length || (a.runner < b.runner ? -1 : 1))
        .map((r) => runnerCardHtml(r, reviewMap.get(r.runner)))
        .join("")}
      ${inputTablesHtml(s)}`;
  }

  async function fetchBulletin(id, version) {
    const base = `/api/bulletins/${encodeURIComponent(id)}`;
    const url = version === null || version === "" ? base : `${base}/versions/${version}`;
    const resp = await fetch(url, { method: "GET" });
    const data = parseJsonLossless(await resp.text());
    return { status: resp.status, data };
  }

  function loadingHtml() {
    return `<div class="diag-loading"><span class="diag-spinner" aria-hidden="true"></span>正在读取只读成绩公告…</div>`;
  }
  function errorHtml(msg) {
    return `<div class="diag-error">⚠ ${escapeHtml(msg)}</div>`;
  }

  async function mountStandalone() {
    const box = document.getElementById("bulletin-view");
    if (!box) return; // 仅独立页面 /bulletin.html 使用
    const params = new URLSearchParams(window.location.search);
    const id = (params.get("id") || "").trim();
    const vRaw = params.get("version");
    const version = vRaw !== null && /^\d+$/.test(vRaw.trim()) ? vRaw.trim() : "";
    if (!id) {
      box.innerHTML = errorHtml("缺少公告编号（在地址中附加 ?id=公告编号）。");
      return;
    }
    box.innerHTML = loadingHtml();
    let outcome;
    try {
      outcome = await fetchBulletin(id, version);
    } catch (err) {
      box.innerHTML = errorHtml(`无法连接公告服务：${err.message}`);
      return;
    }
    if (outcome.status === 404) {
      box.innerHTML = errorHtml(
        version === ""
          ? `公告“${id}”不存在（尚无任何版本）。`
          : `公告“${id}”不存在或没有第 ${version} 版。`
      );
      return;
    }
    if (outcome.status !== 200 || !outcome.data.ok) {
      box.innerHTML = errorHtml((outcome.data && outcome.data.error) || `读取失败（HTTP ${outcome.status}）`);
      return;
    }
    try {
      box.innerHTML = renderBulletinSnapshot(outcome.data.result);
    } catch (err) {
      box.innerHTML = errorHtml(err.message);
    }
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountStandalone);
    } else {
      mountStandalone();
    }
  }

  globalThis.BulletinView = {
    parseJsonLossless,
    fetchBulletin,
    renderBulletinSnapshot,
    loadingHtml,
    errorHtml,
    escapeHtml,
  };
})();
