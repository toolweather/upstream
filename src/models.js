// Structured model-lifecycle parser for provider deprecation pages.
// Rule: a model is only "deprecated"/"retired" when a table row or list on the page explicitly says so.
// Anything else stays "unknown" (or "active" when the page explicitly says active / no shutdown date announced).

export async function pageTokens(resp) {
  const tok = [], stack = []; let inTable = 0, row = null;
  const open = (b, e) => { stack.push(b); e.onEndTag(() => { const i = stack.lastIndexOf(b); if (i >= 0) stack.splice(i, 1); }); };
  const strip = new HTMLRewriter().on("script,style,noscript,svg,head,nav,footer,template", { element(e) { e.remove(); } }).transform(resp);
  await new HTMLRewriter()
    .on("h1,h2,h3,h4", { element(e) { if (inTable) return; const b = { t: "h", l: +e.tagName[1], s: "" }; tok.push(b); open(b, e); } })
    .on("table", { element(e) { inTable++; tok.push({ t: "table" }); e.onEndTag(() => { inTable--; tok.push({ t: "endtable" }); }); } })
    .on("tr", { element(e) { row = { t: "row", cells: [] }; tok.push(row); } })
    .on("td,th", { element(e) { if (!row) return; const b = { s: "", th: e.tagName === "th" }; row.cells.push(b); open(b, e); } })
    .on("li", { element(e) { if (inTable) return; const b = { t: "li", s: "" }; tok.push(b); open(b, e); } })
    .on("p", { element(e) { if (inTable || stack.length) return; const b = { t: "p", s: "" }; tok.push(b); open(b, e); } })
    .on("td *, th *, li *, h1 *, h2 *, h3 *, br", { element() { const b = stack[stack.length - 1]; if (b) b.s += " "; } })
    .onDocument({ text(t) { const b = stack[stack.length - 1]; if (b) b.s += t.text; } })
    .transform(strip).arrayBuffer();
  const clean = (s) => s.replace(/&nbsp;|&#160;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&").replace(/[\u2010-\u2013]/g, "-").replace(/\s+/g, " ").trim();
  for (const t of tok) { if (t.s !== undefined) t.s = clean(t.s); if (t.cells) t.cells.forEach((c) => (c.s = clean(c.s))); }
  return tok;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = (n) => String(n).padStart(2, "0");
export function parseDates(s) {
  const out = []; s = String(s || "");
  for (const m of s.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of s.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (20\d\d)\b/gi)) out.push(`${m[3]}-${p2(MON[m[1].toLowerCase()])}-${p2(m[2])}`);
  for (const m of s.matchAll(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (20\d\d)\b/gi)) out.push(`${m[3]}-${p2(MON[m[2].toLowerCase()])}-${p2(m[1])}`);
  for (const m of s.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(20\d\d|\d\d)(?![\d/])/g)) out.push(`${m[3].length === 2 ? "20" + m[3] : m[3]}-${p2(m[1])}-${p2(m[2])}`);
  return out;
}
const NO_DATE = /no (shutdown|retirement|deprecation) date|not (yet )?(scheduled|announced)|^n\/a$|^—$|^-$|^tbd$|not sooner than/i;
// API ids are lowercase in the source; display names ("GPT-4o", "Claude Sonnet 4") are skipped on purpose
export function modelIds(cell) {
  let s = cell; const par = s.match(/\(([^)]*)\)/g);
  if (par) { const inner = par.join(" "); if (idsIn(inner).length) s = inner; }
  return idsIn(s);
}
function idsIn(s) {
  return [...new Set(s.split(/[\s,;()*†]+/).map((x) => x.replace(/^[`'"]+|[`'".:]+$/g, "")).filter((x) =>
    /^[a-z][a-z0-9._/-]*[a-z0-9]$/.test(x) && x.length >= 3 && x.length <= 90 && (/[-/]/.test(x) || /^o\d/.test(x)) && /\d|\//.test(x) && !/^(https?|v\d+\/|\/)/.test(x)))];
}
const col = (hs, re) => hs.findIndex((h) => re.test(h));

export function parseModels(tok, pg, today) {
  const res = new Map(); const sec = { 1: "", 2: "", 3: "", 4: "" };
  const put = (id, rec) => { const o = res.get(id); if (!o || rec.rank > o.rank || (rec.rank === o.rank && rec.status !== "active" && o.status === "active")) res.set(id, rec); };
  const stateOf = (shut) => (shut ? (shut <= today ? "retired" : "deprecated") : "deprecated");
  let i = 0, lastP = "", pendingHeader = null;
  while (i < tok.length) {
    const t = tok[i];
    if (t.t === "h") { sec[t.l] = t.s; for (let l = t.l + 1; l <= 4; l++) sec[l] = ""; lastP = ""; i++; continue; }
    if (t.t === "p") { lastP = t.s; i++; continue; }
    if (t.t === "li") {
      const ctx = sec[2] + " " + sec[3];
      if (/deprecat|retire|sunset|shut ?down/i.test(ctx) && /\b(retired|deprecat|sunset|shut ?down|discontinu)/i.test(lastP) && !/alternative|recommend|instead|replacement|migrate to/i.test(lastP + " " + t.s)) {
        const shut = parseDates(lastP)[0] || null, ann = parseDates(sec[3])[0] || null;
        for (const id of modelIds(t.s)) put(id, { status: stateOf(shut), rank: 2, shutdown_date: shut, deprecated_on: ann, replacement: null, section: sec[3] || sec[2], evidence: (lastP + " → " + t.s).slice(0, 400) });
      }
      i++; continue;
    }
    if (t.t !== "table") { i++; continue; }
    const rows = []; i++;
    while (i < tok.length && tok[i].t !== "endtable") { if (tok[i].t === "row" && tok[i].cells.length) rows.push(tok[i]); i++; }
    i++;
    if (rows.length === 1 && rows[0].cells.every((c) => c.th)) { pendingHeader = rows[0]; continue; } // header split into its own table (Mistral)
    if (pendingHeader && !rows[0].cells.some((c) => c.th) && rows[0].cells.length === pendingHeader.cells.length) rows.unshift(pendingHeader);
    pendingHeader = null;
    if (rows.length < 2) continue;
    const hs = rows[0].cells.map((c) => c.s.toLowerCase());
    let mc = col(hs, /^(api|model id|api model name|model name)$/); if (mc < 0) mc = col(hs, /deprecated model|model snapshot|^model/); if (mc < 0) continue;
    const sc = col(hs, /current state|^status$/), dc = col(hs, /^deprecat/), xc = col(hs, /shutdown|retire/), rc = col(hs, /replacement|substitute|alternative/), relc = col(hs, /release/);
    const ctx = sec[1] + " " + sec[2] + " " + sec[3];
    const depTable = sc >= 0 || xc >= 0 || dc >= 0 || /deprecated model/.test(hs[mc]);
    if (!depTable && !/deprecat|retire|shutdown/i.test(ctx)) continue;
    const ann = parseDates(sec[3] || sec[2])[0] || null;
    for (const r of rows.slice(1)) {
      const cell = (k) => (k >= 0 && r.cells[k] ? r.cells[k].s : "");
      const ids = modelIds(cell(mc)); if (!ids.length) continue;
      const repl = rc >= 0 ? idsIn(cell(rc)).join(", ") || cell(rc).slice(0, 120) || null : null;
      const evidence = rows[0].cells.map((c, k) => `${c.s}: ${cell(k)}`).join(" | ").slice(0, 400);
      let rec = null;
      // Mistral-style merged "Deprecation / Retirement" column holds two dates
      const dcDates = parseDates(cell(dc)), xDates = parseDates(cell(xc));
      let shut, depOn;
      if (dc >= 0 && dc === xc) { depOn = dcDates[0] || null; shut = dcDates[1] || null; }
      else { shut = xDates[0] || null; depOn = dc >= 0 ? dcDates[0] || null : ann; }
      if (sc >= 0) {
        const st = cell(sc).toLowerCase();
        const status = /retired/.test(st) ? "retired" : /deprecat|legacy/.test(st) ? (shut && shut <= today ? "retired" : "deprecated") : /active|available|ga\b/.test(st) ? "active" : null;
        if (status) rec = { status, rank: 3, shutdown_date: status === "active" ? null : shut, deprecated_on: status === "active" ? null : depOn, tentative_retirement: status === "active" ? cell(xc) || null : undefined };
      } else if (xc >= 0 && xc !== dc) {
        const raw = cell(xc);
        if (shut) rec = { status: stateOf(shut), rank: 2, shutdown_date: shut, deprecated_on: depOn };
        else if (NO_DATE.test(raw) || (!raw && relc >= 0)) rec = relc >= 0 ? { status: "active", rank: 1, shutdown_date: null, deprecated_on: null, note: raw || "no shutdown date listed" } : null;
        else if (/deprecated model/.test(hs[mc])) rec = { status: "deprecated", rank: 2, shutdown_date: null, deprecated_on: depOn };
      } else if (dc >= 0 && dcDates.length) rec = { status: shut && shut <= today ? "retired" : "deprecated", rank: 2, shutdown_date: shut, deprecated_on: depOn };
      else if (/deprecated model/.test(hs[mc])) rec = { status: "deprecated", rank: 2, shutdown_date: null, deprecated_on: ann };
      if (!rec) continue;
      for (const id of ids) put(id, { ...rec, replacement: rec.status === "active" ? null : repl, section: sec[3] || sec[2], evidence });
    }
  }
  return res;
}
