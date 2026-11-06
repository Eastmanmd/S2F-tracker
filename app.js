/* S2F Tracker front end. Plain JS, no build step, no libraries.
   Reads the static JSON the weekly pipeline writes to data/. */
"use strict";

/* ---------------- constants ---------------- */
const READOUTS = {
  accessibility:  ["Accessibility", "access"],
  tf_binding:     ["TF binding", "tf"],
  histone:        ["Histone marks", "histone"],
  cage:           ["CAGE", "cage"],
  tss:            ["TSS / initiation", "tss"],
  rna_seq:        ["RNA-seq", "rna"],
  expression:     ["Expression", "expr"],
  splicing:       ["Splicing", "splice"],
  polyadenylation:["Polyadenylation", "polya"],
  contacts:       ["3D contacts", "contact"],
  mpra:           ["MPRA activity", "mpra"],
};
const CLASS_LABEL = { core: "Core S2F", derivative: "Derivative", "dna-lm": "DNA language model", splicing: "Splicing", mpra: "MPRA" };
const GRAY = new Set(["dna-lm", "splicing", "mpra"]);
const ACCESS_LABEL = { open: "open weights", "non-commercial": "non-commercial licence", gated: "gated (sign-up required)", "api-only": "API only", none: "no public weights" };
const OUTPUT_LABEL = { track: "base-resolved or binned tracks", window: "one value per input window", gene: "one value per gene", contact_map: "contact map", embedding: "sequence embeddings" };
const COMPONENTS = [
  ["attention", "Attention", "deduplicated citations, log-scaled"],
  ["momentum", "Momentum", "citations dated in the last 12 months"],
  ["usage", "Usage", "GitHub stars + downloads per month"],
  ["openness", "Openness", "access tier, licence and upkeep"],
  ["runnable", "Runnable", "package, env file, release, tutorials, issue response"],
];
const DEFAULT_W = { attention: 35, momentum: 25, usage: 20, openness: 10, runnable: 10 };
const USES = [["application", "application"], ["benchmark", "benchmark"], ["extension", "extension"], ["review", "review"]];
const USE_COLOR = { application: "var(--r-access)", benchmark: "var(--hi)", extension: "var(--r-tf)", review: "var(--r-rna)" };
const DOMAIN_COLOR = { biology: "var(--r-access)", method: "var(--r-tf)", unclear: "var(--dim)", offtopic: "var(--line)" };
const SIGNALS = [
  ["installable", "Installable", "a PyPI package that links back to the repo"],
  ["env", "Environment", "requirements, environment or Docker file"],
  ["release", "Release", "a tagged release to pin"],
  ["tutorials", "Tutorials", "notebooks in the repo"],
  ["responsive", "Responsive", "an issue closed in the last 90 days"],
];
const LMAX = Math.log10(3e8);
const VIEWS = ["tracks", "lineage", "pairs", "papers", "methods"];
const NARROW = window.matchMedia("(max-width: 860px)");
/* width of the track column in px, from the layout in styles.css */
function trackWidth() {
  const ax = document.getElementById("axis");
  if (ax && ax.offsetWidth) return ax.offsetWidth;
  const vw = document.documentElement.clientWidth;
  return NARROW.matches ? vw - 32 - 2 - 32 : Math.min(1320, vw) - 56 - 2 - 260 - 176 - 44;
}

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const xf = bp => Math.max(0, Math.min(1, Math.log10(Math.max(1, bp)) / LMAX));
const pct = v => (v * 100).toFixed(3) + "%";
const fmtN = n => n == null ? "—" : Math.round(n).toLocaleString("en-US");
function fmtBp(n) {
  if (n == null) return "—";
  if (n < 1000) return Math.round(n) + " bp";
  if (n < 1e6) { const k = n / 1000; return (k >= 10 ? Math.round(k) : +k.toFixed(1)) + " kb"; }
  const v = n / 1e6; return (v >= 10 ? Math.round(v) : +v.toFixed(1)) + " Mb";
}
function fmtK(n) {
  if (n == null) return "—";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00Z" : iso);
  return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
const plural = (n, w) => `${fmtN(n)} ${w}${n === 1 ? "" : "s"}`;
const roColor = k => `var(--r-${(READOUTS[k] || [, "mpra"])[1]})`;
const roLabel = k => (READOUTS[k] || [k])[0];
const doiUrl = d => !d ? null : d.startsWith("http") ? d : "https://doi.org/" + d;

/* ---------------- state ---------------- */
let MODELS = [], BY = {}, KIDS = {}, META = {}, H2H = null, CHANGELOG = null, CITE_INDEX = null;
const CITES = {};          // per-model citing papers, loaded on demand
const S = {
  view: "tracks", sel: null, gray: false, sp: "all", ro: new Set(), q: "", sort: "score", reverse: false,
  w: { ...DEFAULT_W }, pair: null, pmode: "bench",
  puse: "all", pdom: "all", pmodel: "all", psort: "new", pshow: 60,
  duse: "all", dshow: 25,
};

/* score under the current weights; missing components drop out and the
   remaining weights are renormalized, exactly as build_data.py does */
function scoreOf(m, w = S.w) {
  let num = 0, den = 0;
  const miss = new Set(m.components_missing || []);
  for (const [k] of COMPONENTS) {
    const c = (m.components || {})[k];
    if (c == null || miss.has(k)) continue;
    num += (w[k] || 0) * c; den += (w[k] || 0);
  }
  return den ? Math.round(1000 * num / den) / 10 : 0;
}
const weightsDefault = () => COMPONENTS.every(([k]) => S.w[k] === DEFAULT_W[k]);
const inUniverse = m => S.gray || !GRAY.has(m.class);
function universe() { return MODELS.filter(inUniverse); }
function rankMap() {
  const r = {};
  universe().sort((a, b) => b._s - a._s || a.name.localeCompare(b.name)).forEach((m, i) => { r[m.id] = i + 1; });
  return r;
}
const SORTS = {
  score: (a, b) => b._s - a._s || a.name.localeCompare(b.name),
  context: (a, b) => (b.context_bp ?? -1) - (a.context_bp ?? -1) || (a.resolution_bp ?? 1e12) - (b.resolution_bp ?? 1e12),
  resolution: (a, b) => (a.resolution_bp ?? 1e12) - (b.resolution_bp ?? 1e12) || (b.context_bp ?? -1) - (a.context_bp ?? -1),
  year: (a, b) => a.year - b.year || a.name.localeCompare(b.name),
  citations: (a, b) => (b.citations || 0) - (a.citations || 0),
};
function matchesQuery(m, q) {
  if (!q) return true;
  const hay = [m.id, m.name, m.org, CLASS_LABEL[m.class], m.output, ...(m.readouts || []).map(roLabel), ...(m.species || [])].join(" ").toLowerCase();
  return q.split(/\s+/).every(t => hay.includes(t));
}
function list() {
  const q = S.q.trim().toLowerCase();
  return universe().filter(m =>
    (S.sp === "all" || (m.species || []).includes(S.sp) || (m.species || []).includes("multi")) &&
    (!S.ro.size || (m.readouts || []).some(r => S.ro.has(r))) &&
    matchesQuery(m, q)
  ).sort((a, b) => (S.reverse ? -1 : 1) * (SORTS[S.sort] || SORTS.score)(a, b));
}
function sortDirection() {
  return (["year", "resolution"].includes(S.sort) !== S.reverse) ? "ascending" : "descending";
}

/* ---------------- URL state ---------------- */
function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  S.view = VIEWS.includes(p.get("v")) ? p.get("v") : "tracks";
  S.sel = p.get("m") && BY[p.get("m")] ? p.get("m") : null;
  S.gray = p.get("g") === "1";
  S.sp = ["human", "mouse"].includes(p.get("sp")) ? p.get("sp") : "all";
  S.ro = new Set((p.get("ro") || "").split(",").filter(k => READOUTS[k]));
  S.sort = SORTS[p.get("s")] ? p.get("s") : "score";
  S.reverse = p.get("rev") === "1";
  S.q = p.get("q") || "";
  S.pair = p.get("pair") || null;
  S.pmode = p.get("pm") === "any" ? "any" : "bench";
  S.w = { ...DEFAULT_W };
  const w = (p.get("w") || "").split(",").map(Number);
  if (w.length === COMPONENTS.length && w.every(x => Number.isFinite(x) && x >= 0 && x <= 100) && w.some(x => x > 0))
    COMPONENTS.forEach(([k], i) => { S.w[k] = Math.round(w[i]); });
}
function hashFor(over = {}) {
  const st = { ...S, ...over }, p = new URLSearchParams();
  if (st.view !== "tracks") p.set("v", st.view);
  if (st.sel) p.set("m", st.sel);
  if (st.gray) p.set("g", "1");
  if (st.sp !== "all") p.set("sp", st.sp);
  if (st.ro.size) p.set("ro", [...st.ro].join(","));
  if (st.sort !== "score") p.set("s", st.sort);
  if (st.reverse) p.set("rev", "1");
  if (st.q) p.set("q", st.q);
  if (st.view === "pairs" && st.pair) p.set("pair", st.pair);
  if (st.view === "pairs" && st.pmode !== "bench") p.set("pm", st.pmode);
  if (!COMPONENTS.every(([k]) => st.w[k] === DEFAULT_W[k])) p.set("w", COMPONENTS.map(([k]) => st.w[k]).join(","));
  const s = p.toString().replace(/%2C/g, ",").replace(/%7C/g, "|");
  return s ? "#" + s : "#";
}
function writeHash() {
  const h = hashFor();
  if (h !== (location.hash || "#")) {
    try { history.replaceState(null, "", h === "#" ? location.pathname + location.search : h); } catch (e) { /* file:// or sandboxed */ }
  }
}
function go(over) { location.hash = hashFor(over).slice(1) || "v=tracks"; }

/* ---------------- shared drawing ---------------- */
function axisTicks(withLabels, odd) {
  let h = "";
  for (let d = 0; d <= 8; d++) for (let k = 1; k <= 9; k++) {
    const bp = k * 10 ** d; if (bp > 3e8) break;
    const p = pct(xf(bp));
    h += `<span class="tk${k === 1 ? " maj" : ""}" style="left:${p}"></span>`;
    if (k === 1 && withLabels) h += `<span class="tl${odd && d % 2 ? " odd" : ""}" style="left:${p};${d === 0 ? "transform:none" : ""}">${fmtBp(bp)}</span>`;
  }
  return h;
}
const perWindow = m => m.output === "window" || m.output === "gene";
/* bar geometry: [mark html, label, label anchor x, flip?] */
function geom(m) {
  const ctx = m.context_bp, res = m.resolution_bp, ro = m.readouts || [];
  const c0 = roColor(ro[0] || "accessibility");
  if (perWindow(m)) {
    if (!ctx) return { mark: `<span class="unk" style="left:0"></span>`, label: "input length not fixed", x: 0, unk: true };
    return { mark: `<span class="dot" style="left:${pct(xf(ctx))};--c:${c0}"></span>`, label: `${fmtBp(ctx)} in · ${m.output === "gene" ? "1 value / gene" : "1 value / window"}`, short: `${fmtBp(ctx)} in`, x: xf(ctx), dot: true };
  }
  if (!ctx) {
    const x = res ? xf(res) : 0;
    return { mark: `<span class="unk" style="left:${pct(x)}"></span>`, label: res ? `${fmtBp(res)} → context not reported` : "geometry not reported", x, unk: true };
  }
  const lo = res || 1, x1 = xf(lo), x2 = xf(ctx);
  let mark;
  if (m.output === "embedding" || !ro.length) mark = `<span class="tbar lm" style="left:${pct(x1)};width:${pct(x2 - x1)}"></span>`;
  else mark = `<span class="tbar${m.output === "contact_map" ? " cm" : ""}" style="left:${pct(x1)};width:${pct(x2 - x1)}${res ? "" : ";-webkit-mask-image:linear-gradient(90deg,transparent,#000 40%);mask-image:linear-gradient(90deg,transparent,#000 40%)"}">${ro.map(k => `<span style="--c:${roColor(k)}"></span>`).join("")}</span>`;
  const short = `${res ? fmtBp(res) : "?"} → ${fmtBp(ctx)}`;
  return { mark, label: short + (m.output === "contact_map" ? " · contact map" : ""), short, x: x2, x1 };
}
function spark(cby, w, h) {
  const ys = Object.keys(cby || {}).map(Number).sort((a, b) => a - b);
  if (!ys.length) return `<svg width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const v = []; for (let y = ys[0]; y <= ys[ys.length - 1]; y++) v.push(cby[y] || 0);
  const mx = Math.max(...v, 1), n = v.length;
  const X = i => n === 1 ? w / 2 : 2 + i * (w - 6) / (n - 1), Y = val => h - 2 - (val / mx) * (h - 6);
  const line = "M" + v.map((val, i) => X(i).toFixed(1) + "," + Y(val).toFixed(1)).join("L");
  const area = line + "L" + X(n - 1).toFixed(1) + "," + (h - 1) + "L" + X(0).toFixed(1) + "," + (h - 1) + "Z";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${area}" fill="var(--hi-soft)"/><path d="${line}" fill="none" stroke="var(--hi)" stroke-width="1.4" stroke-linejoin="round"/><circle cx="${X(n - 1).toFixed(1)}" cy="${Y(v[n - 1]).toFixed(1)}" r="2.3" fill="var(--hi)"/></svg>`;
}
function classTag(m) {
  if (GRAY.has(m.class)) return `<b class="tag g">${esc(CLASS_LABEL[m.class])}</b>`;
  if (m.class === "derivative" && BY[m.parent]) return `<b class="tag">from ${esc(BY[m.parent].name)}</b>`;
  return "";
}

/* ---------------- controls ---------------- */
function buildControls() {
  const counts = {};
  MODELS.forEach(m => (m.readouts || []).forEach(r => { counts[r] = (counts[r] || 0) + 1; }));
  $("#chips").innerHTML = Object.keys(READOUTS).filter(k => counts[k]).map(k =>
    `<button class="chip" type="button" data-ro="${k}" style="--c:${roColor(k)}"><i></i>${esc(roLabel(k))} <small>${counts[k]}</small></button>`).join("")
    + `<button class="chip clear" type="button" data-ro-clear hidden>clear readouts</button>`;
  $("#gray-count").textContent = "+" + MODELS.filter(m => GRAY.has(m.class)).length;
  $("#weights").innerHTML = `<div class="w-grid">${COMPONENTS.map(([k, l, d]) =>
    `<div class="w-item"><label for="w-${k}">${l} <b id="wv-${k}"></b></label><input id="w-${k}" type="range" min="0" max="100" step="5" data-w="${k}"><small>${d}</small></div>`).join("")}</div>
    <div class="w-foot"><span id="w-sum"></span><button class="btn" type="button" data-w-reset>reset to default</button></div>`;

  $("#controls").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.sort) S.sort = b.dataset.sort;
    else if (b.id === "sort-direction") S.reverse = !S.reverse;
    else if (b.dataset.sp) S.sp = b.dataset.sp;
    else if ("gray" in b.dataset) S.gray = !S.gray;
    else if (b.dataset.ro) S.ro.has(b.dataset.ro) ? S.ro.delete(b.dataset.ro) : S.ro.add(b.dataset.ro);
    else if ("roClear" in b.dataset) S.ro.clear();
    else if (b.id === "weights-btn") { const open = $("#weights").hidden; $("#weights").hidden = !open; b.setAttribute("aria-expanded", open); return; }
    else if ("wReset" in b.dataset) S.w = { ...DEFAULT_W };
    else return;
    update();
  });
  $("#weights").addEventListener("input", e => {
    const k = e.target.dataset.w; if (!k) return;
    S.w[k] = +e.target.value;
    if (COMPONENTS.every(([c]) => !S.w[c])) S.w[k] = 5;
    update();
  });
  $("#q").addEventListener("input", e => { S.q = e.target.value; update(); });
  $("#q").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const L = list(); if (L.length === 1) openDrawer(L[0].id);
      else if (S.view !== "tracks" && S.view !== "lineage") { S.view = "tracks"; update(); }
    }
  });
}
function syncControls() {
  $$("[data-sort]").forEach(b => b.setAttribute("aria-pressed", b.dataset.sort === S.sort));
  const direction = sortDirection();
  $("#sort-direction").textContent = direction === "ascending" ? "↑ ascending" : "↓ descending";
  $("#sort-direction").setAttribute("aria-label", `Sort ${direction}; activate to reverse order`);
  $$("[data-sp]").forEach(b => b.setAttribute("aria-pressed", b.dataset.sp === S.sp));
  $$("[data-gray]").forEach(b => b.setAttribute("aria-pressed", S.gray));
  $$("#chips [data-ro]").forEach(b => b.setAttribute("aria-pressed", S.ro.has(b.dataset.ro)));
  $("[data-ro-clear]").hidden = !S.ro.size;
  const q = $("#q"); if (q !== document.activeElement) q.value = S.q;
  const tot = COMPONENTS.reduce((a, [k]) => a + S.w[k], 0) || 1;
  COMPONENTS.forEach(([k]) => {
    const inp = $("#w-" + k); if (+inp.value !== S.w[k]) inp.value = S.w[k];
    $("#wv-" + k).textContent = Math.round(100 * S.w[k] / tot) + "%";
  });
  $("#w-sum").textContent = weightsDefault() ? "default weights · same as the published score"
    : "custom weights · scores and ranks below are recomputed in your browser; the link keeps them";
  $("#weights-btn").innerHTML = `<i aria-hidden="true"></i>score weights${weightsDefault() ? "" : " · custom"}`;
  $("#controls").hidden = !(S.view === "tracks" || S.view === "lineage");
  $("#ctl-sort").hidden = S.view !== "tracks";
  $("#chips").hidden = false;
}

/* ---------------- view: tracks ---------------- */
function rowHTML(m, r, hot) {
  const g = geom(m), dflt = weightsDefault(), tw = trackWidth();
  const d = dflt ? 0 : Math.round(10 * (m._s - m.score)) / 10;
  /* label goes right of the mark if it fits, else left of it, else over the
     track's right end on a backing so it stays readable */
  const left0 = g.x1 != null ? g.x1 : g.x, fits = t => t.length * 6.7 + (g.unk ? 54 : 14);
  let flip = false, over = false, anchor = g.x, text = g.label;
  const place = t => {
    if ((1 - g.x) * tw >= fits(t)) { flip = false; anchor = g.x; return true; }
    if (left0 * tw >= fits(t)) { flip = true; anchor = left0; return true; }
    return false;
  };
  if (!place(text) && !(g.short && place(text = g.short))) { flip = true; over = true; anchor = 1; }
  return `<div class="row" role="button" tabindex="0" data-open="${m.id}" aria-selected="${S.sel === m.id}" aria-label="${esc(m.name)}${hot ? ", top three for citations in the past 12 months" : ""}, score ${m._s}, ${esc(g.label)}">
    <div class="lab"><span class="rank">${r}</span><span class="name-wrap"><span class="name">${esc(m.name)}</span>${hot ? `<span class="hot" aria-hidden="true" title="Top three for citations in the past 12 months">🌶️</span>` : ""}</span>
      <span class="score">${m._s.toFixed(1)}${d ? `<span class="delta" style="color:${d > 0 ? "var(--good)" : "var(--bad)"}">${d > 0 ? "+" : ""}${d.toFixed(1)}</span>` : ""}<span class="meter"><i style="width:${m._s}%"></i></span></span>
      <span class="meta">${m.year} · ${esc(m.org)}${classTag(m)}</span></div>
    <div class="trk"><div class="in">${g.mark}<span class="bl${flip ? " flip" : ""}${over ? " over" : ""}${g.dot && !flip ? " dl" : ""}${g.unk && !flip ? " ul" : ""}" style="left:${pct(anchor)}" title="${esc(g.label)}">${esc(text)}</span></div></div>
    <div class="sp">${spark(m.counts_by_year, 64, 26)}<span>${fmtN(m.citations)}<small>+${fmtN(m.citations_12m)} past 12 mo</small></span></div>
  </div>`;
}
function changesHTML() {
  const e = CHANGELOG && CHANGELOG.entries && CHANGELOG.entries[0];
  if (!e) return "";
  const evs = (e.events || []).slice(0, 6);
  const items = evs.map(ev => {
    const mods = (ev.models || []).filter(id => BY[id]);
    const btn = mods.length ? ` <a href="${hashFor({ sel: mods[0] })}" data-open-link="${mods[0]}">view</a>` : "";
    return `<li>${esc(ev.text)}${btn}</li>`;
  }).join("");
  return `<div class="changes" role="status"><b>${e.baseline ? "Tracking since" : "This week"} · ${esc(fmtDate(e.date))}</b><ul>${items}</ul>${(e.events || []).length > 6 ? `<a href="feed.xml">${e.events.length - 6} more in the feed</a>` : ""}</div>`;
}
function renderTracks() {
  const L = list(), R = rankMap(), n = universe().length, el = $("#view-tracks");
  // Rank all tracked models so the indicator does not change with filters.
  const recent = MODELS.map(m => m.citations_12m).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => b - a);
  const hotCutoff = recent.length ? recent[Math.min(2, recent.length - 1)] : Infinity;
  el.innerHTML = `
    <div class="view-head"><h1>Every S2F model on one ruler</h1>
      <p class="lede">Each model is a track on a log-scale base-pair ruler. Its bar runs from the finest detail it outputs to the full stretch of DNA it reads; the stripes are what it predicts. Hover the ruler to read across the field at any scale, click a track for its spec sheet. Ranked by a score built from citations, downloads, openness and upkeep (<a href="#v=methods">how</a>).</p></div>
    <div class="status"><span><b>${L.length}</b> of ${n} tracks${S.gray ? " incl. gray zone" : ""}</span><span>sorted by <b>${S.sort}</b> ${sortDirection()}</span><span>${fmtN(META.total_citations)} citations · ${fmtN(META.unique_citing_works)} citing works</span><span>data ${esc(fmtDate(META.updated))}</span></div>
    ${changesHTML()}
    <div class="grid" id="grid">
      <div class="head"><div class="hcell hl">Model · score</div><div class="trk"><div class="in ruler" id="axis">${axisTicks(true, true)}</div></div><div class="hcell hs">Citations · trend</div></div>
      ${L.length ? L.map(m => rowHTML(m, R[m.id], m.citations_12m >= hotCutoff)).join("") : `<div class="empty">No tracks match. Clear a readout, the species filter or the goto box${S.gray ? "" : ", or switch on the gray zone"}.</div>`}
      <div class="xh" id="xh" hidden></div><div class="tip" id="tip" hidden></div>
    </div>
    <div class="legend">
      <span><i class="lg-bar"></i>bin size → input length; stripes are readouts</span>
      <span><i class="lg-dot"></i>one prediction per window or gene, at its input length</span>
      <span><i class="lg-lm"></i>language model: embeddings, no assay readouts</span>
      <span><i class="lg-unk"></i>length not reported</span>
      <span>🌶️ top three models by citations in the past 12 months, including ties (among all tracked models)</span>
    </div>`;
  const grid = $("#grid");
  grid.addEventListener("mousemove", e => {
    const ax = $("#axis"), xh = $("#xh"), tip = $("#tip"); if (!ax) return;
    const r = ax.getBoundingClientRect(), gr = grid.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right) { xh.hidden = tip.hidden = true; return; }
    const f = (e.clientX - r.left) / r.width, bp = Number((10 ** (f * LMAX)).toPrecision(2)), LL = list();
    const known = LL.filter(m => m.context_bp), see = known.filter(m => m.context_bp >= bp).length;
    const fine = LL.filter(m => !perWindow(m) && m.resolution_bp && m.resolution_bp <= bp).length;
    const x = e.clientX - gr.left; xh.style.left = x + "px"; xh.hidden = false;
    tip.innerHTML = `<b>${fmtBp(bp)}</b><br>${see} of ${known.length} read at least this much DNA<br>${fine} output at this resolution or finer`;
    tip.hidden = false; const tw = tip.offsetWidth;
    tip.style.left = (x + tw + 16 > gr.width ? x - tw - 10 : x + 10) + "px";
    tip.style.top = Math.max(44, e.clientY - gr.top + 14) + "px";
  });
  grid.addEventListener("mouseleave", () => { $("#xh").hidden = true; $("#tip").hidden = true; });
}

/* ---------------- drawer ---------------- */
function compRows(m) {
  const miss = new Set(m.components_missing || []), tot = COMPONENTS.reduce((a, [k]) => a + S.w[k], 0) || 1;
  return COMPONENTS.map(([k, l]) => {
    const c = (m.components || {})[k];
    if (c == null || miss.has(k)) return `<div class="comp miss"><span>${l}</span><div></div><b>n/a</b></div>`;
    return `<div class="comp"><span>${l} <small class="dim">×${(S.w[k] / tot).toFixed(2)}</small></span><div><i style="width:${(c * 100).toFixed(0)}%"></i></div><b>${c.toFixed(2)}</b></div>`;
  }).join("");
}
function usageHTML(m) {
  const gh = m.github, u = m.usage_detail || {}, hf = m.hf, rows = [];
  if (gh) {
    let stars;
    if (gh.path) stars = `${fmtN(gh.repo_stars)} on the whole repo <small>· not credited: the model is one folder (<code>${esc(gh.path)}</code>) of a shared repo</small>`;
    else stars = fmtN(gh.stars) + (gh.also && gh.also.length ? ` <small>· summed over ${gh.also.length + 1} repos</small>` : "") + (gh.shared_with && gh.shared_with.length ? ` <small>· repo shared with ${gh.shared_with.map(id => esc((BY[id] || { name: id }).name)).join(", ")}</small>` : "");
    rows.push(["GitHub", `<a href="${esc(gh.url)}" rel="noopener">${esc(gh.repo)}${gh.path ? "/" + esc(gh.path) : ""}</a>`]);
    rows.push(["Stars", stars]);
    rows.push(["Last commit", `${esc(fmtDate(gh.pushed_at))} <small>· ${esc(m.upkeep || "unknown")}${gh.archived ? ", archived" : ""}${gh.path ? " (folder history)" : ""}</small>`]);
  } else rows.push(["Code", `<small>no public code repository</small>`]);
  if (hf && hf.repos && hf.repos.length) {
    rows.push(["Hugging Face", `${fmtN(hf.downloads)} downloads / 30 d <small>· ${hf.repos.length} repo${hf.repos.length > 1 ? "s" : ""}, ${fmtN(hf.likes)} likes</small><br>${hf.repos.map(r => `<a href="${esc(r.url)}" rel="noopener">${esc(r.id)}</a>`).join("<br>")}`]);
  }
  if (u.pypi) rows.push(["PyPI", `<a href="${esc(u.pypi.url)}" rel="noopener">${esc(u.pypi.package)}</a> · ${fmtN(u.pypi.downloads_last_month)} / month${u.pypi.stale ? " <small>(last week's value)</small>" : ""}`]);
  (u.zenodo || []).forEach(z => rows.push(["Zenodo", `<a href="${esc(z.url)}" rel="noopener">${esc(z.title || z.id)}</a><br>${fmtN(z.downloads_all_time)} downloads since ${esc(fmtDate(z.since))} <small>≈ ${fmtN(z.downloads_per_month)} / month</small>`]));
  (u.kaggle || []).forEach(k => rows.push(["Kaggle", `<a href="${esc(k.url)}" rel="noopener">${esc(k.id)}</a> · ${fmtN(k.votes)} votes <small>(Kaggle publishes no download counts)</small>`]));
  (u.listed || []).forEach(l => rows.push([esc(l.host), /^https?:/.test(l.url || "") ? `<a href="${esc(l.url)}" rel="noopener">${esc(l.url)}</a> <small>(no counts)</small>` : `${esc(l.url)} <small>(no counts)</small>`]));
  rows.push(["Downloads / month", m.downloads_per_month == null ? `<small>${m.usage_untracked ? "nothing public to count — usage scored 0" : "not measured on any tracked host"}</small>` : `<b>${fmtN(m.downloads_per_month)}</b> <small>all tracked hosts</small>`]);
  return `<dl class="dl">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>`;
}
function runnableHTML(m) {
  const rd = m.runnable_detail || {};
  if (!rd.signals) return `<p class="note">${esc(rd.note || "Not measured.")}</p>`;
  const s = rd.signals;
  const det = {
    installable: rd.pypi ? `${rd.pypi}${rd.pypi_version ? " " + rd.pypi_version : ""}` : "",
    env: rd.env_files && rd.env_files.length ? rd.env_files.join(", ") + (rd.dockerfile ? ", Dockerfile" : "") : "",
    release: !rd.release ? "" : typeof rd.release === "string" ? rd.release : (rd.release.tag || rd.release.name || "") + (rd.release.date ? " · " + fmtDate(rd.release.date) : ""),
    tutorials: rd.notebooks != null ? plural(rd.notebooks, "notebook") : "",
    responsive: rd.closed_issues_90d != null ? `${rd.closed_issues_90d} closed in 90 d` : "",
  };
  return SIGNALS.map(([k, l, d]) => {
    const v = s[k];
    const mark = v == null ? `<span class="na" title="not measured">·</span>` : v >= 0.5 ? `<span class="ok">✓</span>` : `<span class="no">✗</span>`;
    return `<div class="sig">${mark}<span>${l}</span><span>${esc(v == null ? "not measured" : det[k] || d)}</span></div>`;
  }).join("") + (rd.observed_weight != null && rd.observed_weight < 1 ? `<p class="note">${Math.round(rd.observed_weight * 100)}% of the signals could be measured; the rest are left out, not counted as zero.</p>` : "");
}
function stackHTML(counts, colors, order) {
  const keys = order.filter(k => counts && counts[k]), tot = keys.reduce((a, k) => a + counts[k], 0);
  if (!tot) return `<p class="note">No classified citing papers yet.</p>`;
  return `<div class="stack">${keys.map(k => `<i style="width:${(100 * counts[k] / tot).toFixed(2)}%;background:${colors[k]}" title="${k}: ${counts[k]}"></i>`).join("")}</div>
    <div class="keys">${keys.map(k => `<span><i style="background:${colors[k]}"></i>${k} ${fmtN(counts[k])}</span>`).join("")}</div>`;
}
function yearBars(cby) {
  const ys = Object.keys(cby || {}).map(Number).sort((a, b) => a - b);
  if (!ys.length) return "";
  const yb = []; for (let y = ys[0]; y <= ys[ys.length - 1]; y++) yb.push({ y, n: cby[y] || 0 });
  const mx = Math.max(...yb.map(d => d.n), 1), W = 440, H = 100, bw = (W - 10) / yb.length;
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Citations per year">${yb.map((d, i) => {
    const bh = Math.max(1, (d.n / mx) * (H - 30)), last = i === yb.length - 1, x = 5 + i * bw;
    return `<rect x="${(x + 2).toFixed(1)}" y="${(H - 16 - bh).toFixed(1)}" width="${Math.max(1, bw - 4).toFixed(1)}" height="${bh.toFixed(1)}" fill="${last ? "var(--hi)" : "var(--ink2)"}" opacity="${last ? 1 : .55}"><title>${d.y}: ${d.n}</title></rect>`
      + (i === 0 || last || yb.length <= 8 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" font-size="10" font-family="IBM Plex Mono, monospace" fill="var(--dim)">${d.y}</text>` : "")
      + (last ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(H - 20 - bh).toFixed(1)}" text-anchor="middle" font-size="10" font-family="IBM Plex Mono, monospace" fill="var(--hi)">${d.n}</text>` : "");
  }).join("")}</svg>`;
}
function ancestors(id) { const out = []; let p = BY[id] && BY[id].parent; while (p && BY[p] && !out.includes(p)) { out.unshift(p); p = BY[p].parent; } return out; }
function pairPartners(id) {
  if (!H2H) return [];
  return Object.entries(H2H.pairs).map(([k, v]) => { const [a, b] = k.split("|"); return a === id ? [b, v, k] : b === id ? [a, v, k] : null; })
    .filter(x => x && BY[x[0]] && x[1].bench > 0).sort((a, b) => b[1].bench - a[1].bench || b[1].any - a[1].any).slice(0, 8);
}
function drawerHTML(m) {
  const R = rankMap(), g = geom(m), kids = (KIDS[m.id] || []).map(id => BY[id]).sort((a, b) => a.year - b.year);
  const anc = ancestors(m.id), partners = pairPartners(m.id);
  const spec = [
    ["Input context", m.context_bp ? `${fmtN(m.context_bp)} bp <small>(${fmtBp(m.context_bp)})</small>` : `<small>not fixed / not reported</small>`],
    ["Output", esc(OUTPUT_LABEL[m.output] || m.output)],
    ["Resolution", perWindow(m) ? "one value per " + (m.output === "gene" ? "gene" : "window") : m.resolution_bp ? `${fmtN(m.resolution_bp)} bp` : `<small>not reported</small>`],
    ["Output tracks", m.n_tracks ? fmtN(m.n_tracks) : m.output === "embedding" ? "embeddings" : `<small>not reported</small>`],
    ["Species", esc((m.species || []).join(", "))],
    ["Access", esc(ACCESS_LABEL[m.access] || m.access)],
    ["Licence", esc(m.license || "none found")],
  ];
  const vel = m.velocity ? `${esc(m.velocity)}${m.velocity_ratio ? ` <small>(${m.velocity_ratio}× the prior rate)</small>` : ""}` : "";
  return `<button class="close" type="button" data-close>esc ✕</button>
  <p class="d-eye">${esc(CLASS_LABEL[m.class])} · ${m.year}${R[m.id] ? ` · #${R[m.id]} of ${universe().length}` : ""}</p>
  <h2 class="d-name" id="d-name">${esc(m.name)}</h2><p class="d-org">${esc(m.org)}</p>
  <p class="d-note">${esc(m.notes)}</p>
  <div class="mini" aria-hidden="true">${axisTicks(false)}${g.mark}${[0, 3, 6].map(d => `<span class="tl" style="left:${pct(xf(10 ** d))};${d === 0 ? "transform:none" : ""}">${fmtBp(10 ** d)}</span>`).join("")}</div>

  <p class="d-h">Spec sheet</p>
  <dl class="dl">${spec.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>
  <p class="d-h">Readouts</p>
  <div class="chips" style="padding:0">${(m.readouts || []).length ? m.readouts.map(k => `<span class="chip" aria-pressed="true" style="--c:${roColor(k)}"><i></i>${esc(roLabel(k))}</span>`).join("") : `<span class="note">none: sequence embeddings only</span>`}</div>

  <p class="d-h">Score ${m._s.toFixed(1)} / 100 ${weightsDefault() ? "" : `<span>published ${m.score.toFixed(1)}</span>`}</p>
  ${compRows(m)}
  ${(m.components_missing || []).length ? `<p class="note">Not measured: ${esc(m.components_missing.join(", "))}. Its weight is shared among the other components rather than scored as zero.</p>` : ""}
  ${m.usage_untracked ? `<p class="note">Nothing public to count usage on (no repository of its own, no tracked weights host or package), so usage scores 0 rather than being left out.${m.github ? "" : " With no code repository, runnability scores 0 too."}</p>` : ""}

  <p class="d-h">Usage and upkeep</p>
  ${usageHTML(m)}
  <p class="d-h">Can you run it?</p>
  ${runnableHTML(m)}

  <p class="d-h">Citations by year <span>${fmtN(m.citations)} total · ${fmtN(m.citations_12m)} in 12 mo${vel ? " · " + vel : ""}</span></p>
  ${yearBars(m.counts_by_year)}
  <p class="d-h">How citing papers use it</p>
  ${stackHTML(m.use_counts, USE_COLOR, ["application", "benchmark", "extension", "review"])}
  <p class="d-h">Field of citing papers</p>
  ${stackHTML(m.domain_counts, DOMAIN_COLOR, ["biology", "method", "unclear", "offtopic"])}
  <p class="note">Classified automatically from titles and abstracts; treat as a rough split.</p>

  <p class="d-h">Lineage</p>
  <div class="lin">${anc.map(id => `<button type="button" data-open="${id}">${esc(BY[id].name)}</button><span>→</span>`).join("")}<span class="cur">${esc(m.name)}</span>${kids.length ? `<span>→</span>${kids.map(k => `<button type="button" data-open="${k.id}">${esc(k.name)}</button>`).join("")}` : ""}${!anc.length && !kids.length ? `<span>no tracked parent or descendants</span>` : ""}</div>

  ${partners.length ? `<p class="d-h">Most often benchmarked with</p><div class="pairs-mini">${partners.map(([id, v, k]) => `<button type="button" data-pair="${esc(k)}">${esc(BY[id].name)} <small>${v.bench}</small></button>`).join("")}</div>` : ""}

  <p class="d-h">Paper${(m.papers || []).length > 1 ? "s" : ""}</p>
  <ul class="plist">${(m.papers || []).map(p => `<li><div class="ptitle">${doiUrl(p.doi) ? `<a href="${esc(doiUrl(p.doi))}" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</div><div class="pmeta">${esc(p.venue || "")} · ${p.year || ""} · ${fmtN(p.cited_by_count)} cites in OpenAlex</div></li>`).join("")}</ul>

  <p class="d-h">Citing papers <span id="cite-count"></span></p>
  <div class="seg" id="d-use" role="group" aria-label="Filter citing papers by use">${[["all", "all"], ...USES].map(([k, l]) => `<button type="button" data-duse="${k}" aria-pressed="${S.duse === k}">${l}</button>`).join("")}</div>
  <div id="d-cites"><p class="note">Loading…</p></div>`;
}
function citeItem(c, withModels) {
  const u = c.use || "unclassified";
  return `<li>${withModels ? `<span class="pdate">${esc(c.date || c.year || "")}</span><div>` : ""}<div class="ptitle">${doiUrl(c.doi) ? `<a href="${esc(doiUrl(c.doi))}" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</div>
    <div class="pmeta">${withModels ? "" : esc(c.date || c.year || "") + " · "}${esc(c.first_author || "")}${c.n_authors > 1 ? " et al." : ""}${c.venue ? " · " + esc(c.venue) : ""} · <span class="u u-${esc(u)}">${esc(u)}</span>${c.domain && c.domain !== "unclear" ? " · " + esc(c.domain) : ""}${c.cited_by_count ? " · " + fmtN(c.cited_by_count) + " cites" : ""}</div>
    ${withModels && c._models ? `<div class="pmods">${c._models.map(id => `<button type="button" data-open="${id}">${esc(BY[id].name)}</button>`).join("")}</div></div>` : ""}</li>`;
}
async function loadCites(id) {
  if (!CITES[id]) {
    CITES[id] = fetch(`data/citations/${encodeURIComponent(id)}.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(d => (Array.isArray(d) ? d : d.works || []).slice().sort((a, b) => String(b.date || b.year).localeCompare(String(a.date || a.year))))
      .catch(e => { delete CITES[id]; throw e; });
  }
  return CITES[id];
}
async function renderDrawerCites() {
  const id = S.sel, box = $("#d-cites"); if (!id || !box) return;
  try {
    const all = await loadCites(id);
    if (S.sel !== id || !$("#d-cites")) return;
    const L = S.duse === "all" ? all : all.filter(c => c.use === S.duse);
    $("#cite-count").textContent = `${fmtN(L.length)}${S.duse === "all" ? "" : " of " + fmtN(all.length)}, newest first`;
    $$("#d-use [data-duse]").forEach(b => b.setAttribute("aria-pressed", b.dataset.duse === S.duse));
    $("#d-cites").innerHTML = L.length ? `<ul class="plist">${L.slice(0, S.dshow).map(c => citeItem(c, false)).join("")}</ul>${L.length > S.dshow ? `<button class="btn more" type="button" data-dmore>show ${Math.min(50, L.length - S.dshow)} more</button>` : ""}`
      : `<p class="note">None classified as ${esc(S.duse)}.</p>`;
  } catch (e) {
    if ($("#d-cites")) $("#d-cites").innerHTML = `<p class="note">Couldn't load the citing papers (${esc(e.message)}).</p>`;
  }
}
const drawer = () => $("#drawer");
let lastFocus = null, drawerTimer = 0;
function openDrawer(id, push = true) {
  if (!BY[id]) return;
  if (!S.sel) lastFocus = document.activeElement;
  S.sel = id; S.duse = "all"; S.dshow = 25;
  const d = drawer();
  clearTimeout(drawerTimer);
  d.innerHTML = drawerHTML(BY[id]);
  if (d.hidden) { d.hidden = false; void d.offsetWidth; }  /* reflow so the slide-in runs */
  d.scrollTop = 0;
  d.classList.add("open"); d.setAttribute("aria-labelledby", "d-name");
  $("#scrim").hidden = false;
  $$(".row").forEach(r => r.setAttribute("aria-selected", r.dataset.open === id));
  $("[data-close]", d).focus({ preventScroll: true });
  if (push) writeHash();
  renderDrawerCites();
}
function closeDrawer() {
  const d = drawer(); if (!d.classList.contains("open")) return;
  d.classList.remove("open"); $("#scrim").hidden = true;
  /* take it out of layout once it has slid away: an off-screen fixed panel
     still widens the layout viewport on phones */
  drawerTimer = setTimeout(() => { if (!d.classList.contains("open")) d.hidden = true; }, 260);
  const id = S.sel; S.sel = null; writeHash();
  $$(".row").forEach(r => r.setAttribute("aria-selected", "false"));
  const back = $(`.row[data-open="${id}"]`) || $(`.node[data-open="${id}"]`) || lastFocus;
  if (back && back.focus) back.focus({ preventScroll: true });
}

/* ---------------- view: lineage ---------------- */
function renderLineage() {
  const L = universe().filter(m => (S.sp === "all" || (m.species || []).includes(S.sp) || (m.species || []).includes("multi")));
  const q = S.q.trim().toLowerCase(), hit = m => (!S.ro.size || (m.readouts || []).some(r => S.ro.has(r))) && matchesQuery(m, q);
  const vis = new Set(L.map(m => m.id));
  const kids = id => (KIDS[id] || []).filter(k => vis.has(k)).map(k => BY[k]);
  const desc = id => kids(id).reduce((a, k) => a + 1 + desc(k.id), 0);
  const roots = L.filter(m => !m.parent || !vis.has(m.parent))
    .sort((a, b) => (GRAY.has(a.class) - GRAY.has(b.class)) || (desc(b.id) > 0) - (desc(a.id) > 0) || a.year - b.year || a.name.localeCompare(b.name));
  const lane = {}; let next = 0;
  function walk(m, l) {
    lane[m.id] = l;
    const ks = kids(m.id).sort((a, b) => desc(b.id) - desc(a.id) || a.year - b.year);
    ks.forEach((k, i) => walk(k, i === 0 ? l : next++));
  }
  const y0 = Math.min(...L.map(m => m.year)) - 0.5, y1 = Math.max(...L.map(m => m.year)) + 0.8;
  const W = 1120, pl = 24, pr = 130, top = 54, lh = 42;
  const X = y => pl + (y - y0) / (y1 - y0) * (W - pl - pr);
  /* models with no tracked parent or child share rows when their labels can't collide */
  const solo = {}; // zone -> [{lane, lastX}]
  roots.forEach(r => {
    if (desc(r.id) > 0) { walk(r, next++); return; }
    const z = GRAY.has(r.class) ? "g" : "c", x = X(r.year), rows = solo[z] = solo[z] || [];
    const row = rows.find(o => x - o.lastX > 170);
    if (row) { lane[r.id] = row.lane; row.lastX = x; }
    else { lane[r.id] = next; rows.push({ lane: next++, lastX: x }); }
  });
  const H = top + Math.max(1, next) * lh + 10, Y = m => top + lane[m.id] * lh + lh / 2;
  const R = m => Math.min(18, 4 + Math.sqrt(m.citations || 0) / 4);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Lineage of sequence-to-function models by year of publication">`;
  for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) {
    const x = X(y);
    s += `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${H - 4}" stroke="var(--grid)"/><text x="${x}" y="${top - 18}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="var(--dim)">${y}</text>`;
  }
  const gl = Math.min(...L.filter(m => GRAY.has(m.class)).map(m => lane[m.id]));
  if (Number.isFinite(gl) && gl > 0) { const yl = top + gl * lh; s += `<line x1="${pl}" x2="${W - 10}" y1="${yl}" y2="${yl}" stroke="var(--line)" stroke-dasharray="4 4"/><text x="${W - 10}" y="${yl + 13}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="10" fill="var(--dim)">GRAY ZONE</text>`; }
  L.forEach(m => {
    if (!m.parent || !vis.has(m.parent)) return;
    const p = BY[m.parent], xa = X(p.year), ya = Y(p), xb = X(m.year), yb = Y(m), dx = Math.max(24, (xb - xa) * .5);
    const on = hit(m) && hit(p);
    s += `<path d="M${xa},${ya} C${xa + dx},${ya} ${xb - dx},${yb} ${xb},${yb}" fill="none" stroke="${on ? "var(--ink2)" : "var(--line)"}" stroke-width="1.4"/>`;
  });
  L.forEach(m => {
    const x = X(m.year), y = Y(m), r = R(m), gz = GRAY.has(m.class), on = hit(m);
    const fill = gz ? "var(--panel)" : m.class === "derivative" ? "var(--hi)" : "var(--ink)";
    s += `<g class="node" data-open="${m.id}" tabindex="0" role="button" aria-label="${esc(m.name)}, ${m.year}, ${fmtN(m.citations)} citations" opacity="${on ? 1 : .22}">
      <circle cx="${x.toFixed(1)}" cy="${y}" r="${r.toFixed(1)}" fill="${fill}" stroke="${gz ? "var(--ink2)" : "var(--panel)"}" stroke-width="${gz ? 1.3 : 2}"${gz ? ' stroke-dasharray="3 2"' : ""}${S.sel === m.id ? ' style="stroke:var(--hi);stroke-width:3"' : ""}/>
      <text x="${(x + r * 0.7 + 3).toFixed(1)}" y="${(y - Math.max(7, r * 0.75)).toFixed(1)}" font-family="IBM Plex Sans, sans-serif" font-size="13" font-weight="500" fill="var(--ink)" stroke="var(--panel)" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${esc(m.name)}</text></g>`;
  });
  s += "</svg>";
  $("#view-lineage").innerHTML = `
    <div class="view-head"><h1>Lineage</h1>
      <p class="lede">Who built on whom, by year of first publication. An edge means the later model reuses the earlier one's architecture, training set or weights, as stated in its paper. Dot area follows citations. Click a model for its spec sheet; the filters above dim models that don't match.</p></div>
    <div class="legend" style="padding-top:0"><span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="var(--ink)"/></svg>core S2F</span><span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="var(--hi)"/></svg>derivative (fine-tune or re-implementation)</span><span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--ink2)" stroke-dasharray="3 2"/></svg>gray zone</span></div>
    <div class="panel tree">${L.length ? s : `<p class="empty">Nothing to draw with these filters.</p>`}</div>`;
}

/* ---------------- view: pairs ---------------- */
function renderPairs() {
  const el = $("#view-pairs");
  if (!H2H) { el.innerHTML = `<p class="empty">No head-to-head data.</p>`; return; }
  const mode = S.pmode, key = mode === "bench" ? "bench" : "any";
  const ids = H2H.order.filter(id => BY[id] && inUniverse(BY[id]) && (H2H.totals[id] || {})[key] > 0)
    .sort((a, b) => H2H.totals[b][key] - H2H.totals[a][key]);
  const val = (a, b) => ((H2H.pairs[a < b ? a + "|" + b : b + "|" + a] || {})[key]) || 0;
  let mx = 1; ids.forEach(a => ids.forEach(b => { if (a !== b) mx = Math.max(mx, val(a, b)); }));
  const top = [];
  Object.entries(H2H.pairs).forEach(([k, v]) => { const [a, b] = k.split("|"); if (BY[a] && BY[b] && inUniverse(BY[a]) && inUniverse(BY[b]) && v[key] > 0) top.push([k, a, b, v[key]]); });
  top.sort((x, y) => y[3] - x[3]);
  const cell = (a, b) => {
    if (a === b) return `<td class="self"></td>`;
    const v = val(a, b), k = a < b ? a + "|" + b : b + "|" + a;
    if (!v) return `<td class="zero"></td>`;
    const t = Math.sqrt(v / mx), p = Math.round(18 + 82 * t);
    return `<td class="${S.pair === k ? "on" : ""}" style="background:color-mix(in srgb,var(--hi) ${p}%,var(--grid));color:${p > 55 ? "var(--on-hi)" : "var(--ink)"}"><button type="button" data-pair="${k}" title="${esc(BY[a].name)} × ${esc(BY[b].name)}: ${v}">${v}</button></td>`;
  };
  let detail = "";
  if (S.pair && S.pair.includes("|")) {
    const [a, b] = S.pair.split("|");
    if (BY[a] && BY[b]) {
      const v = H2H.pairs[S.pair] || { bench: 0, any: 0 };
      const ps = (H2H.papers || []).filter(p => p.models.includes(a) && p.models.includes(b)).sort((x, y) => String(y.date).localeCompare(String(x.date)));
      detail = `<div class="panel" style="margin-top:16px;padding:14px 16px" id="pair-detail">
        <h2 style="margin:0 0 4px;font:600 15px var(--sans)">${esc(BY[a].name)} × ${esc(BY[b].name)}</h2>
        <p class="note" style="margin-top:0">${plural(v.bench, "benchmark paper")} evaluate both · ${plural(v.any, "paper")} cite both.</p>
        ${ps.length ? `<ul class="plist">${ps.map(p => `<li><div class="ptitle">${doiUrl(p.doi) ? `<a href="${esc(doiUrl(p.doi))}" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</div><div class="pmeta">${esc(p.date || p.year)} · ${esc(p.first_author || "")}${p.n_authors > 1 ? " et al." : ""}${p.venue ? " · " + esc(p.venue) : ""} · also: ${p.models.filter(x => x !== a && x !== b && BY[x]).map(x => esc(BY[x].name)).join(", ") || "—"}</div></li>`).join("")}</ul>`
          : `<p class="note">No benchmark paper evaluates both; the count above is co-citation only, which isn't listed paper by paper.</p>`}</div>`;
    }
  }
  el.innerHTML = `
    <div class="view-head"><h1>Evaluated together</h1>
      <p class="lede">How often two models meet in the same paper. <b>Benchmarked</b> counts citing papers classified as benchmarks that cite both models (${fmtN(H2H.benchmark_papers)} benchmark papers, ${fmtN(H2H.comparison_papers)} of them covering two or more tracked models). <b>Cited</b> counts any paper citing both. Click a cell for the papers.</p></div>
    <div class="ctl-row" style="padding-bottom:12px"><div class="ctl"><span>count</span><div class="seg"><button type="button" data-pmode="bench" aria-pressed="${mode === "bench"}">benchmarked together</button><button type="button" data-pmode="any" aria-pressed="${mode === "any"}">cited together</button></div></div>
      <button class="toggle" type="button" data-gray aria-pressed="${S.gray}"><i aria-hidden="true"></i>gray zone</button></div>
    <div class="pairs-layout">
      <div>
        <div class="panel matrix-wrap"><table class="matrix"><thead><tr><th></th>${ids.map(id => `<th scope="col"><div>${esc(BY[id].name)}</div></th>`).join("")}</tr></thead>
          <tbody>${ids.map(a => `<tr><th scope="row"><button type="button" data-open="${a}">${esc(BY[a].name)}</button></th>${ids.map(b => cell(a, b)).join("")}</tr>`).join("")}</tbody></table></div>
        ${detail}
      </div>
      <aside class="side"><div class="panel"><h2>Most ${mode === "bench" ? "benchmarked" : "co-cited"} pairs</h2>
        <ol class="toplist">${top.slice(0, 15).map(([k, a, b, v]) => `<li><button type="button" data-pair="${k}">${esc(BY[a].name)} × ${esc(BY[b].name)}</button><b>${v}</b></li>`).join("")}</ol></div></aside>
    </div>`;
}

/* ---------------- view: papers ---------------- */
function paperIndex() {
  if (!CITE_INDEX) return [];
  if (CITE_INDEX._merged) return CITE_INDEX._merged;
  const by = new Map();
  Object.entries(CITE_INDEX).forEach(([mid, arr]) => {
    if (!BY[mid] || !Array.isArray(arr)) return;
    arr.forEach(c => {
      const e = by.get(c.id) || { ...c, _models: [] };
      if (!e._models.includes(mid)) e._models.push(mid);
      by.set(c.id, e);
    });
  });
  const out = [...by.values()];
  out.forEach(c => c._models.sort((a, b) => BY[b].citations - BY[a].citations));
  Object.defineProperty(CITE_INDEX, "_merged", { value: out });
  return out;
}
function renderPapers() {
  const el = $("#view-papers");
  if (!CITE_INDEX) { el.innerHTML = `<p class="loading">Loading the citing-paper index…</p>`; loadIndex(); return; }
  const all = paperIndex();
  let L = all.filter(c => (S.puse === "all" || c.use === S.puse) && (S.pdom === "all" || c.domain === S.pdom) &&
    (S.pmodel === "all" ? c._models.some(id => inUniverse(BY[id])) : c._models.includes(S.pmodel)));
  L.sort(S.psort === "cited" ? (a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0) : (a, b) => String(b.date || b.year).localeCompare(String(a.date || a.year)));
  const opts = universe().slice().sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `
    <div class="view-head"><h1>Citing papers</h1>
      <p class="lede">The newest papers citing each tracked model, pooled (${META.citing_index_per_model || 40} most recent per model; ${fmtN(META.unique_citing_works)} citing works exist in all). Every model's full list is in its spec sheet. Use and field are classified automatically from titles and abstracts.</p></div>
    <div class="pfilters">
      <div class="ctl"><span>use</span><div class="seg">${[["all", "all"], ...USES].map(([k, l]) => `<button type="button" data-puse="${k}" aria-pressed="${S.puse === k}">${l}</button>`).join("")}</div></div>
      <div class="ctl"><span>field</span><div class="seg">${["all", "biology", "method"].map(k => `<button type="button" data-pdom="${k}" aria-pressed="${S.pdom === k}">${k}</button>`).join("")}</div></div>
      <div class="ctl"><span>model</span><select id="pmodel" aria-label="Model"><option value="all">all${S.gray ? "" : " (core + derivative)"}</option>${opts.map(m => `<option value="${m.id}"${S.pmodel === m.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
      <div class="ctl"><span>sort</span><div class="seg">${[["new", "newest"], ["cited", "most cited"]].map(([k, l]) => `<button type="button" data-psort="${k}" aria-pressed="${S.psort === k}">${l}</button>`).join("")}</div></div>
      <button class="toggle" type="button" data-gray aria-pressed="${S.gray}"><i aria-hidden="true"></i>gray zone</button>
    </div>
    <div class="status" style="padding-top:0"><span><b>${fmtN(L.length)}</b> papers</span></div>
    <div class="panel papers">${L.length ? `<ul class="plist">${L.slice(0, S.pshow).map(c => citeItem(c, true)).join("")}</ul>` : `<p class="empty">No papers match.</p>`}</div>
    ${L.length > S.pshow ? `<p><button class="btn" type="button" data-pmore>show ${Math.min(60, L.length - S.pshow)} more</button></p>` : ""}`;
}
let indexLoading = null;
function loadIndex() {
  if (indexLoading) return;
  indexLoading = fetch("data/citations.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(d => { CITE_INDEX = d; if (S.view === "papers") renderPapers(); })
    .catch(e => { indexLoading = null; $("#view-papers").innerHTML = `<p class="load-error">Couldn't load data/citations.json (${esc(e.message)}).</p>`; });
}

/* ---------------- view: methods ---------------- */
function renderMethods() {
  const w = META.weights || {}, tot = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const cc = META.class_counts || {};
  $("#view-methods").innerHTML = `<div class="prose">
    <div class="view-head" style="padding-left:0"><h1>Methods</h1></div>
    <p>The tracker follows ${fmtN(META.models_tracked)} sequence-to-function (S2F) models: networks that read DNA sequence and predict a molecular readout such as accessibility, TF binding, histone marks, transcription or splicing. Data are refreshed every Monday by a GitHub Action and served as static JSON from <code>data/</code>. Last refresh: <strong>${esc(fmtDate(META.updated))}</strong>.</p>

    <h2>What counts as an S2F model</h2>
    <p><strong>Core</strong> (${cc.core || 0}) models predict assay readouts from sequence: Basset, Basenji, Enformer, Borzoi, BPNet, AlphaGenome and their peers. <strong>Derivatives</strong> (${cc.derivative || 0}) fine-tune or re-implement a core model (Flashzoi, Scooby, Decima). The <strong>gray zone</strong> is hidden by default and holds DNA language models (${cc["dna-lm"] || 0}), dedicated splicing models (${cc.splicing || 0}) and MPRA-activity models (${cc.mpra || 0}): sequence models that are routinely benchmarked against S2F models but either predict no assay track or cover one narrow readout. Ranks shown with the gray zone off are ranks among core and derivative models only.</p>
    <p>Species: human and mouse. Geometry (input context, output resolution, track count) is curated from each paper; where a paper reports no single number it is shown as not reported rather than guessed.</p>

    <h2>The ruler</h2>
    <p>Each model is a bar on a log₁₀ base-pair axis from 1 bp to 300 Mb. The left end is its output resolution (bin size), the right end its input context. Window- and gene-level models emit one number per input, so they appear as a diamond at their input length. Language models are hatched: they output embeddings, not assay tracks.</p>

    <h2>Score</h2>
    <p>Score = 100 × weighted mean of five components, each scaled 0–1 across the tracked models. A component that cannot be measured for a model is left out and the remaining weights renormalized, so a gap is not a penalty. The one exception: a model with no public code and no tracked weights host scores 0 on usage and runnability, because there is nothing to use.</p>
    <table><thead><tr><th>Component</th><th>Weight</th><th>Measures</th></tr></thead><tbody>
      ${COMPONENTS.map(([k, l, d]) => `<tr><td>${l}</td><td>${Math.round(100 * (w[k] || 0) / tot)}%</td><td>${d}</td></tr>`).join("")}
    </tbody></table>
    <p>Change the weights with <strong>score weights</strong> on the Tracks view; the page recomputes scores and ranks in your browser and keeps your weights in the link.</p>
    <ul>
      <li><strong>Attention</strong>: citations from OpenAlex, deduplicated across preprint and journal versions of the same paper, log-scaled.</li>
      <li><strong>Momentum</strong>: ${esc(META.momentum_basis || "citations dated in the trailing 12 months")}, log-scaled.</li>
      <li><strong>🌶️</strong>: models in the top three by citations in the past 12 months among all tracked models, including ties. The indicator does not change with filters.</li>
      <li><strong>Usage</strong>: GitHub stars plus downloads per month from every host that reports them: Hugging Face (30-day), PyPI (last month, via pypistats, only for packages that link back to the model's repository), and Zenodo (all-time downloads converted to a lifetime monthly average). Kaggle publishes votes, not downloads, so it is shown but not counted. Cloud buckets and lab websites report nothing and are listed only.</li>
      <li><strong>Openness</strong>: access tier 40% (open 1.0, non-commercial 0.6, gated 0.5, API only 0.2), licence 25%, upkeep 35% (from the last commit).</li>
      <li><strong>Runnable</strong>: an installable package, an environment file, a tagged release, tutorial notebooks and an issue closed in the last 90 days.</li>
    </ul>

    <h2>Shared repositories</h2>
    <p>Several models live as one folder of a large repository (Enformer in <code>deepmind-research</code>, Akita in <code>basenji</code>). They get no credit for the parent repository's stars; upkeep comes from the last commit touching their folder, and runnability is checked inside that folder only. Models with several repositories (AlphaGenome's client and research code) have their stars summed. Repositories shared by two tracked models (Basenji and Basenji2) are flagged on both.</p>

    <h2>Citing papers</h2>
    <p>Every citing work is classified on two axes from its title and abstract: <strong>use</strong> (application, benchmark, extension, review) and <strong>field</strong> (biology, method, unclear, off-topic). The rules are keyword tiers ported from the scFM tracker and extended with S2F vocabulary; they have not yet been validated against hand labels here, so treat the splits as approximate. The <strong>Evaluated together</strong> view counts benchmark papers citing two models; it measures how often models are compared, not which one wins.</p>

    <h2>Caveats</h2>
    <ul>
      <li>Citations measure attention, not quality or correctness.</li>
      <li>Downloads are partial: many S2F weights are fetched from cloud buckets that publish no counts.</li>
      <li>OpenAlex sometimes merges or splits paper versions; the deduplicated count can differ from Google Scholar.</li>
      <li>This is a research aid, not a recommendation.</li>
    </ul>

    <h2>Data and code</h2>
    <p>All data are static JSON: <a href="data/models.json">models.json</a>, <a href="data/meta.json">meta.json</a>, <a href="data/headtohead.json">headtohead.json</a>, <a href="data/history.json">history.json</a>, <a href="data/changelog.json">changelog.json</a>, and <code>data/citations/&lt;model&gt;.json</code> per model. Weekly changes are in the <a href="feed.xml">Atom feed</a>. Sources: ${esc((META.sources || []).join(", "))}.</p>
  </div>`;
}

/* ---------------- routing / update ---------------- */
function update() {
  MODELS.forEach(m => { m._s = scoreOf(m); });
  if (S.sel && !BY[S.sel]) S.sel = null;
  $$(".nav a").forEach(a => a.setAttribute("aria-current", a.dataset.view === S.view ? "page" : "false"));
  VIEWS.forEach(v => { $("#view-" + v).hidden = v !== S.view; });
  syncControls();
  ({ tracks: renderTracks, lineage: renderLineage, pairs: renderPairs, papers: renderPapers, methods: renderMethods })[S.view]();
  writeHash();
  document.title = S.view === "tracks" ? "S2F Tracker — sequence-to-function models, mapped" : `${$(`.nav a[data-view="${S.view}"]`).textContent} · S2F Tracker`;
}
function onHash() {
  const prevView = S.view, prevSel = S.sel;
  readHash();
  update();
  if (S.sel && (S.sel !== prevSel || !drawer().classList.contains("open"))) openDrawer(S.sel, false);
  else if (!S.sel && drawer().classList.contains("open")) closeDrawer();
  if (S.view !== prevView) window.scrollTo(0, 0);
  if (S.view === "pairs" && S.pair && $("#pair-detail")) $("#pair-detail").scrollIntoView({ block: "nearest" });
}

/* ---------------- global events ---------------- */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-open],[data-open-link],[data-close],[data-pair],[data-pmode],[data-puse],[data-pdom],[data-psort],[data-pmore],[data-duse],[data-dmore],#scrim");
  if (!t) return;
  if (t.closest("#controls")) return;
  if (t.id === "scrim" || "close" in t.dataset) { closeDrawer(); return; }
  if (t.dataset.openLink) { e.preventDefault(); openDrawer(t.dataset.openLink); return; }
  if (t.dataset.open) { openDrawer(t.dataset.open); return; }
  if (t.dataset.pair) { e.preventDefault(); if (S.sel) closeDrawer(); go({ view: "pairs", pair: t.dataset.pair, sel: null }); return; }
  if (t.dataset.pmode) { S.pmode = t.dataset.pmode; update(); return; }
  if (t.dataset.puse) { S.puse = t.dataset.puse; S.pshow = 60; update(); return; }
  if (t.dataset.pdom) { S.pdom = t.dataset.pdom; S.pshow = 60; update(); return; }
  if (t.dataset.psort) { S.psort = t.dataset.psort; update(); return; }
  if ("pmore" in t.dataset) { S.pshow += 60; renderPapers(); return; }
  if (t.dataset.duse) { S.duse = t.dataset.duse; S.dshow = 25; renderDrawerCites(); return; }
  if ("dmore" in t.dataset) { S.dshow += 50; renderDrawerCites(); return; }
});
document.addEventListener("click", e => {  /* gray toggles that live outside #controls */
  const b = e.target.closest("[data-gray]");
  if (b && !b.closest("#controls")) { S.gray = !S.gray; update(); }
});
document.addEventListener("change", e => { if (e.target.id === "pmodel") { S.pmodel = e.target.value; S.pshow = 60; renderPapers(); } });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && drawer().classList.contains("open")) { closeDrawer(); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".row,.node")) { e.preventDefault(); openDrawer(e.target.dataset.open); return; }
  if (e.key === "/" && !e.target.matches("input,select,textarea")) { e.preventDefault(); $("#q").focus(); }
});
window.addEventListener("hashchange", onHash);

/* ---------------- theme ---------------- */
function applyTheme(t) {
  if (t === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "light" ? "#ffffff" : "#0a0e14";
  const b = $("#theme-btn");
  if (b) {
    const next = t === "light" ? "dark" : "light";
    b.setAttribute("aria-label", `Switch to ${next} background`);
    b.title = `Switch to ${next} background`;
  }
}
$("#theme-btn").addEventListener("click", () => {
  const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  try { localStorage.setItem("s2f-theme", t); } catch (e) { /* private mode: choice lasts this visit */ }
  applyTheme(t);
});
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
let resizeTimer = 0, lastTW = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!MODELS.length || S.view !== "tracks") return;
    const tw = trackWidth();
    if (Math.abs(tw - lastTW) > 24) { lastTW = tw; renderTracks(); }
  }, 150);
});

/* ---------------- boot ---------------- */
async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
(async function boot() {
  try {
    const [models, meta] = await Promise.all([getJSON("data/models.json"), getJSON("data/meta.json")]);
    const [h2h, log] = await Promise.all([getJSON("data/headtohead.json").catch(() => null), getJSON("data/changelog.json").catch(() => null)]);
    MODELS = models.models || models; META = meta; H2H = h2h; CHANGELOG = log;
    MODELS.forEach(m => { BY[m.id] = m; });
    MODELS.forEach(m => { if (m.parent && BY[m.parent]) (KIDS[m.parent] = KIDS[m.parent] || []).push(m.id); });
    $("#loading").remove();
    buildControls();
    readHash();
    update();
    if (S.sel) openDrawer(S.sel, false);
  } catch (e) {
    $("#loading").hidden = true;
    const el = $("#load-error"); el.hidden = false;
    el.textContent = `Couldn't load the data (${e.message}). If you opened index.html from disk, serve the folder instead: python3 -m http.server`;
  }
})();
