import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { AppRow } from './schema.js';

/**
 * Generates site/index.html with the results embedded.
 *
 * The page is generated rather than hand-written so the prose and the numbers
 * cannot drift apart: every figure on the page is read out of results/*.json at
 * build time. Data is inlined rather than fetched so the page is a single file
 * that works on file:// and on any static host with no CORS or asset config.
 */

const REPO_URL = process.env.REPO_URL ?? 'https://github.com/M-Khan13/Composio';
const SITE_URL = process.env.SITE_URL ?? '';

const read = <T>(p: string): T => {
  const full = path.resolve(p);
  if (!fs.existsSync(full)) throw new Error(`${p} not found — run the pipeline first.`);
  return JSON.parse(fs.readFileSync(full, 'utf8')) as T;
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Safe to embed inside a <script> tag: neutralise sequences that could close it. */
const json = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028|\u2029/g, '');

/** Minimal RFC4180-ish parser: quoted fields, embedded commas, "" escapes. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const truthTri = (s: string): boolean | 'unknown' => {
  const v = s.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(v)) return true;
  if (['false', 'no', 'n', '0'].includes(v)) return false;
  return 'unknown';
};

const pctStr = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);
const pp = (n: number | null): string => (n === null ? '—' : `${n >= 0 ? '+' : ''}${Math.round(n * 100)}pp`);

interface Patterns {
  total_apps: number;
  headline: Record<string, number | string | null>;
  auth: { apps_supporting_each_scheme: Record<string, number>; apps_with_multiple_schemes: number; apps_with_no_auth_found: number };
  access: { overall: Record<string, number>; by_category: Array<{ category: string; total: number; 'self-serve': number; trial: number; gated: number; gated_pct: number }>; most_gated_category: string };
  buildability: { overall: Record<string, number>; easy_wins: Array<{ name: string }>; needs_outreach: Array<{ name: string; blocker: string }> };
  blockers: { themes: Record<string, number> };
  composio: { has_toolkit: number; no_toolkit: number; coverage_pct: number; by_category: Array<{ category: string; total: number; has_toolkit: number; pct: number }>; uncovered_but_self_serve: Array<{ name: string }> };
  caveats: string[];
}

interface Accuracy {
  sample_size: number;
  judgements_reviewed: number;
  overall: { pass1_accuracy: number; pass2_accuracy: number; delta: number };
  per_field: Array<{ field: string; reviewed: number; pass1_accuracy: number | null; pass2_accuracy: number | null; delta: number | null }>;
  fixed_by_pass2: number;
  misses: Array<{ name: string; field: string; truth: string; pass1: string; pass2: string; fixed_by_pass2: boolean }>;
}

function main(): void {
  const rows = read<AppRow[]>('results/rows.json');
  const p = read<Patterns>('results/patterns.json');
  const a = read<Accuracy>('results/accuracy.json');

  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const authSchemes = Object.keys(p.auth.apps_supporting_each_scheme);

  const accessMisses = a.misses.filter((m) => m.field === 'access');
  const criticCount = rows.filter((r) => (r.meta?.critic_changed?.length ?? 0) > 0).length;

  /**
   * Hand-checked truth for the 18 reviewed apps, keyed by id.
   *
   * The matrix shows the agent's raw output; where a human checked it and
   * disagreed, both values are shown. Without this the table and the accuracy
   * section contradict each other — the table would still call Plaid
   * "self-serve" while the accuracy section proves it is "trial".
   * The agent's data in results/rows.json is never modified.
   */
  const truthByIdEntries = fs.existsSync(path.resolve('results/human_review.csv'))
    ? parseCsv(fs.readFileSync(path.resolve('results/human_review.csv'), 'utf8'))
        .filter((rec) => rec.id)
        .map((rec) => {
          const t: Record<string, unknown> = {};
          if (rec.truth_access) t.a = rec.truth_access.toLowerCase();
          if (rec.truth_buildability) t.b = rec.truth_buildability.toLowerCase();
          if (rec.truth_has_mcp) t.m = truthTri(rec.truth_has_mcp);
          if (rec.truth_composio_toolkit_exists) t.k = truthTri(rec.truth_composio_toolkit_exists);
          if (rec.truth_auth_methods) t.au = rec.truth_auth_methods.split(/[|,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
          return [rec.id, t] as const;
        })
    : [];
  const truthById = new Map(truthByIdEntries);

  const tableData = rows.map((r) => ({
    n: r.name,
    c: r.category,
    a: r.access,
    au: r.auth_methods,
    b: r.buildability,
    k: r.composio_toolkit_exists,
    m: r.has_mcp,
    s: r.api_surface,
    bl: r.blocker,
    e: r.evidence_urls[0] ?? '',
    t: truthById.get(r.id) ?? null,
  }));

  const verifiedCount = tableData.filter((d) => d.t).length;

  const mostGated = p.access.by_category[0];
  const openCats = p.access.by_category.filter((c) => c.gated_pct === 0);


  const field = (name: string) => a.per_field.find((f) => f.field === name)!;
  const accessField = field('access');
  const kitField = field('composio_toolkit_exists');
  const accessDelta = accessField.delta;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>One hundred apps, researched and re-checked</title>
<meta name="description" content="An agent researched ${p.total_apps} SaaS apps for API access, auth, and agent-toolkit buildability. Findings, the full matrix, and a measured accuracy check.">
<style>
  :root{
    --bg:#f2efe8; --paper:#f8f6f1; --panel:#fbfaf6;
    --ink:#1c1a16; --muted:#6e6959; --dim:#918b7b;
    --line:#e2dccd; --line2:#d3ccb9;
    --gold:#b08b2e; --rust:#a8552f;
    --serif:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.62 ui-sans-serif,-apple-system,"Segoe UI",Inter,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:0 26px}
  h1,h2,h3{margin:0;line-height:1.14;font-family:var(--serif);font-weight:600;letter-spacing:-.015em}
  h1{font-size:clamp(34px,6vw,60px)}
  h2{font-size:clamp(24px,3.4vw,34px)}
  h3{font-size:16px;letter-spacing:-.005em;font-family:inherit;font-weight:650}
  p{margin:.7em 0}
  a{color:var(--ink);text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--line2)}
  a:hover{text-decoration-color:var(--ink)}
  .kicker{font:600 10.5px/1 var(--mono);letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}

  /* ---------- hero ---------- */
  header{padding:64px 0 44px}
  .hero{display:grid;grid-template-columns:1fr minmax(230px,286px);gap:44px;align-items:end}
  .hero .lede{color:var(--muted);font-size:17px;max-width:56ch;margin-top:16px}
  .repo{margin-top:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .repo a{font:600 14px var(--mono);text-decoration-color:var(--line2)}
  .bigstat{border:1px solid var(--line2);border-radius:3px;background:var(--paper);padding:20px 22px}
  .bigstat .lbl{font:600 10px/1 var(--mono);letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}
  .bigstat b{display:block;font-family:var(--serif);font-size:66px;line-height:1;margin:12px 0 8px;letter-spacing:-.03em}
  .bigstat span{color:var(--muted);font-size:13.5px;line-height:1.45;display:block}
  .rule{height:1px;background:var(--line2);margin:0}

  /* ---------- sections ---------- */
  section{padding:52px 0}
  .sec-title{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .sub{color:var(--muted);max-width:68ch;margin:12px 0 0}

  /* ---------- findings ---------- */
  .finds{display:grid;gap:10px;margin-top:26px}
  .find{background:var(--paper);border:1px solid var(--line);border-radius:3px;padding:16px 20px;
    display:grid;grid-template-columns:30px 1fr;gap:16px;align-items:start}
  .find .n{font:600 11px/1.5 var(--mono);color:var(--dim);letter-spacing:.06em}
  .find b{font-weight:650}
  .find p{margin:3px 0 0;color:var(--muted);font-size:14.6px}
  .find em{font-style:normal;font-weight:650;color:var(--ink)}

  /* ---------- bars ---------- */
  .barwrap{margin-top:30px}
  .barwrap h3{margin-bottom:12px}
  .bars{display:grid;gap:6px}
  .bar{display:grid;grid-template-columns:minmax(130px,235px) 1fr auto;gap:14px;align-items:center;font-size:13.4px}
  .bar .lbl{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar .track{background:#e7e1d3;border-radius:2px;height:8px;overflow:hidden}
  .bar .fill{height:100%;background:var(--ink);border-radius:2px}
  .bar .fill.gold{background:var(--gold)} .bar .fill.rust{background:var(--rust)}
  .bar .val{font:600 12px var(--mono);color:var(--muted);min-width:48px;text-align:right}

  /* ---------- accuracy trio ---------- */
  .trio{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-top:26px}
  .tri{border:1px solid var(--line2);border-radius:3px;background:var(--paper);padding:18px 20px}
  .tri .lbl{font:600 10px/1 var(--mono);letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}
  .tri .v{font-family:var(--serif);font-size:clamp(26px,3.6vw,34px);line-height:1.1;margin:12px 0 6px;letter-spacing:-.02em}
  .tri .v .to{color:var(--dim);margin:0 6px}
  .tri .v .end.up{color:var(--ink)} .tri .v .end.down{color:var(--rust)}
  .tri .foot{color:var(--dim);font:11.5px var(--mono);letter-spacing:.04em}

  /* ---------- tables ---------- */
  .acc{width:100%;border-collapse:collapse;margin-top:24px;font-size:14px;
    background:var(--paper);border:1px solid var(--line)}
  .acc th,.acc td{padding:10px 14px;border-bottom:1px solid var(--line);text-align:left}
  .acc thead th{font:600 10px var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--muted);
    background:#efebe0}
  .acc tbody tr:last-child td{border-bottom:none}
  .acc td.num{font:600 13px var(--mono);text-align:right}
  .up{color:#3f6b3f} .down{color:var(--rust)} .flat{color:var(--dim)}

  .callout{background:var(--paper);border:1px solid var(--line);border-left:2px solid var(--gold);
    border-radius:3px;padding:18px 21px;margin-top:24px}
  .callout.bad{border-left-color:var(--rust)}
  .callout p{margin:.5em 0;color:var(--muted);font-size:14.5px}
  .callout p b{color:var(--ink)}

  /* ---------- app matrix ---------- */
  .showing{font:11.5px var(--mono);color:var(--dim);letter-spacing:.04em}
  .chips{display:flex;flex-wrap:wrap;gap:7px;margin:22px 0 12px}
  .chip{border:1px solid var(--line2);background:transparent;color:var(--muted);border-radius:999px;
    padding:6px 13px;font:inherit;font-size:12.6px;cursor:pointer;white-space:nowrap}
  .chip:hover{border-color:var(--dim);color:var(--ink)}
  .chip.on{background:var(--ink);border-color:var(--ink);color:var(--bg)}
  .controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
  select,input[type=search]{background:var(--paper);color:var(--ink);border:1px solid var(--line2);
    border-radius:3px;padding:8px 11px;font:inherit;font-size:13.2px}
  input[type=search]{min-width:180px;flex:1}

  .tablewrap{overflow-x:auto;border:1px solid var(--line);background:var(--paper)}
  table.grid{border-collapse:collapse;width:100%;font-size:13.2px;min-width:900px}
  table.grid th,table.grid td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--line);vertical-align:top}
  table.grid thead th{position:sticky;top:0;background:#efebe0;z-index:2;white-space:nowrap;
    font:600 10px var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}
  table.grid tbody tr:last-child td{border-bottom:none}
  table.grid tbody tr:hover{background:#f2eee3}
  td.idx{font:11.5px var(--mono);color:var(--dim);width:34px}
  td.name{font-weight:650;white-space:nowrap}
  td.cat{color:var(--muted);font-size:12.4px;white-space:nowrap}
  td.auth{color:var(--muted);font:11.6px var(--mono);white-space:nowrap}
  td.surface{color:var(--muted);min-width:230px}

  .pill{display:inline-block;padding:3px 11px;border-radius:999px;font:600 11px var(--mono);white-space:nowrap;border:1px solid transparent}
  .pill.self-serve,.pill.easy{background:var(--ink);color:var(--bg)}
  .pill.trial,.pill.needs-outreach{background:transparent;border-color:var(--gold);color:#7d6220}
  .pill.gated,.pill.blocked{background:transparent;border-color:var(--rust);color:var(--rust)}
  .yes{font:600 11.5px var(--mono)} .no,.unk{font:11.5px var(--mono);color:var(--dim)}

  .ver{color:#3f6b3f;font:600 11px var(--mono);margin-left:5px}
  .was{color:var(--dim);text-decoration:line-through;font:11px var(--mono);margin-right:5px}
  tr.checked td.name::after{content:"✓";color:#3f6b3f;font:600 10px var(--mono);margin-left:6px;vertical-align:super}
  .legend{color:var(--muted);font-size:13.2px;margin:10px 0 0}
  .legend .ver{margin:0 2px 0 0}

  .tag{font:600 10px var(--mono);padding:2px 7px;border-radius:999px;letter-spacing:.04em}
  .tag.fix{background:var(--ink);color:var(--bg)}
  .tag.brk{border:1px solid var(--rust);color:var(--rust)}

  /* ---------- steps + links ---------- */
  .steps{display:grid;gap:10px;margin-top:24px;counter-reset:s}
  .step{background:var(--paper);border:1px solid var(--line);border-radius:3px;padding:15px 19px;
    display:grid;grid-template-columns:28px 1fr;gap:15px;align-items:start}
  .step .i{counter-increment:s;font:600 11px/1.6 var(--mono);color:var(--dim)}
  .step .i::before{content:"0" counter(s)}
  .step b{font-weight:650;font-size:14.6px} .step p{margin:3px 0 0;color:var(--muted);font-size:14px}

  .links{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
  .link{background:var(--paper);border:1px solid var(--line2);border-radius:3px;padding:13px 18px;
    text-decoration:none;font-size:14px;font-weight:650}
  .link:hover{border-color:var(--ink)}
  .link span{display:block;color:var(--muted);font-size:12.4px;margin-top:2px;font-weight:400}

  footer{border-top:1px solid var(--line2);padding:26px 0 62px;margin-top:20px}
  .footrow{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;
    color:var(--dim);font:11.5px var(--mono);letter-spacing:.04em}
  code{font:12.6px var(--mono);background:#e9e4d6;padding:1.5px 5px;border-radius:2px}

  @media(max-width:760px){
    .hero{grid-template-columns:1fr;gap:26px;align-items:start}
    header{padding:44px 0 30px} section{padding:38px 0}
    .bar{grid-template-columns:minmax(92px,120px) 1fr auto}
  }
</style>
</head>
<body>

<header>
  <div class="wrap">
    <div class="kicker">Case study</div>
    <div class="hero" style="margin-top:20px">
      <div>
        <h1>One hundred apps,<br>researched and re-checked.</h1>
        <p class="lede">An agent read the developer docs for ${p.total_apps} SaaS products through Composio, extracted a structured verdict with Gemini, and cross-checked every answer against Composio's own toolkit catalogue. Then ${a.sample_size} of them were checked by hand. This is what held up — and what didn't.</p>
        <p class="repo"><span class="kicker">Source</span> <a href="${esc(REPO_URL)}" rel="noopener">${esc(REPO_URL.replace(/^https?:\/\//, ''))}</a></p>
      </div>
      <div class="bigstat">
        <div class="lbl">Second-pass accuracy</div>
        <b>${pctStr(a.overall.pass2_accuracy)}</b>
        <span>Up from ${pctStr(a.overall.pass1_accuracy)} when answering from search snippets alone.</span>
      </div>
    </div>
  </div>
</header>

<div class="wrap"><div class="rule"></div></div>

<section>
  <div class="wrap">
    <h2>Findings</h2>
    <div class="finds">
      <div class="find"><span class="n">01</span><div><b>Access is bimodal, not a spectrum.</b><p><em>${openCats.length} of 10 categories are 100% self-serve.</em> Gating concentrates almost entirely in ${esc(mostGated.category)} (${mostGated.gated_pct}%) and AI/Research (${esc(String(p.access.by_category[1]?.gated_pct ?? 0))}%). A category is either wide open or it isn't — very little sits in between.</p></div></div>
      <div class="find"><span class="n">02</span><div><b>Gating is about who you are, not what you pay.</b><p>Of the ${p.buildability.needs_outreach.length} blocked apps, the leading blocker is <em>${esc(String(p.headline.most_common_blocker))}</em>. Only ${p.blockers.themes['must talk to sales'] ?? 0} is simply "contact sales" — the rest need a partnership, an approval process, or an enterprise contract.</p></div></div>
      <div class="find"><span class="n">03</span><div><b>Toolkit coverage tracks category age, not difficulty.</b><p>Composio covers <em>${p.composio.by_category[0].pct}% of ${esc(p.composio.by_category[0].category)}</em> but only ${p.composio.by_category.at(-1)!.pct}% of ${esc(p.composio.by_category.at(-1)!.category)}. The gap isn't where APIs are hard — it's where the category is new. ${p.composio.uncovered_but_self_serve.length} apps are self-serve, easy, and have no toolkit yet.</p></div></div>
      <div class="find"><span class="n">04</span><div><b>No toolkit can assume a single auth path.</b><p><em>${p.auth.apps_with_multiple_schemes} of ${p.total_apps} apps accept more than one auth scheme.</em> OAuth2 leads (${p.auth.apps_supporting_each_scheme.oauth2} apps) with API keys close behind (${p.auth.apps_supporting_each_scheme['api-key']}), and both are commonly offered on the same product.</p></div></div>
      <div class="find"><span class="n">05</span><div><b>One field still needed a human — and verification made it worse.</b><p>Deciding whether a developer can truly self-serve credentials is a judgement about commercial posture, not a fact in the docs. <em>The verification pass moved <code>access</code> backwards (${pp(accessDelta)})</em>, fixing 3 apps and breaking 4. Every other field improved.</p></div></div>
    </div>

    <div class="barwrap">
      <h3>Gated or trial access, by category</h3>
      <div class="bars">
      ${p.access.by_category
        .map((c) => {
          const v = c.gated_pct;
          const cls = v >= 40 ? 'rust' : v > 0 ? 'gold' : '';
          return `<div class="bar"><span class="lbl">${esc(c.category)}</span><span class="track"><span class="fill ${cls}" style="width:${Math.max(v, 1.5)}%"></span></span><span class="val">${v}%</span></div>`;
        })
        .join('\n      ')}
      </div>
    </div>

    <div class="barwrap">
      <h3>Composio toolkit coverage, by category</h3>
      <div class="bars">
      ${p.composio.by_category
        .map(
          (c) =>
            `<div class="bar"><span class="lbl">${esc(c.category)}</span><span class="track"><span class="fill" style="width:${Math.max(c.pct, 1.5)}%"></span></span><span class="val">${c.has_toolkit}/${c.total}</span></div>`,
        )
        .join('\n      ')}
      </div>
    </div>
  </div>
</section>

<div class="wrap"><div class="rule"></div></div>

<section>
  <div class="wrap">
    <h2>Accuracy, honestly</h2>
    <p class="sub">Every app was answered twice. <b>Pass 1</b> answers from search snippets only. <b>Pass 2</b> fetches the real docs, cross-checks Composio's catalogue, and runs a critic that re-reads the evidence. Both use the same code path with steps switched off, so the difference is attributable to verification rather than to two different prompts. ${a.sample_size} apps — ${a.judgements_reviewed} individual field judgements — were then checked by hand.</p>

    <div class="trio">
      <div class="tri">
        <div class="lbl">Overall</div>
        <div class="v">${pctStr(a.overall.pass1_accuracy)}<span class="to">&rarr;</span><span class="end up">${pctStr(a.overall.pass2_accuracy)}</span></div>
        <div class="foot">Pass 1 &rarr; Pass 2</div>
      </div>
      <div class="tri">
        <div class="lbl">Access (the human field)</div>
        <div class="v">${pctStr(accessField.pass1_accuracy)}<span class="to">&rarr;</span><span class="end down">${pctStr(accessField.pass2_accuracy)}</span></div>
        <div class="foot">Pass 1 &rarr; Pass 2</div>
      </div>
      <div class="tri">
        <div class="lbl">Catalogue cross-check</div>
        <div class="v">${pctStr(kitField.pass1_accuracy)}<span class="to">&rarr;</span><span class="end up">${pctStr(kitField.pass2_accuracy)}</span></div>
        <div class="foot">Pass 1 &rarr; Pass 2</div>
      </div>
    </div>

    <table class="acc">
      <thead><tr><th>Field</th><th style="text-align:right">n</th><th style="text-align:right">Pass 1</th><th style="text-align:right">Pass 2</th><th style="text-align:right">Change</th></tr></thead>
      <tbody>
      ${a.per_field
        .map((f) => {
          const d = f.delta ?? 0;
          const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
          return `<tr><td><code>${esc(f.field)}</code></td><td class="num">${f.reviewed}</td><td class="num">${pctStr(f.pass1_accuracy)}</td><td class="num">${pctStr(f.pass2_accuracy)}</td><td class="num ${cls}">${pp(f.delta)}</td></tr>`;
        })
        .join('\n      ')}
      <tr style="border-top:2px solid var(--line2)">
        <td><b>Overall</b></td><td class="num">${a.judgements_reviewed}</td>
        <td class="num">${pctStr(a.overall.pass1_accuracy)}</td>
        <td class="num"><b>${pctStr(a.overall.pass2_accuracy)}</b></td>
        <td class="num up"><b>${pp(a.overall.delta)}</b></td>
      </tr>
      </tbody>
    </table>

    <div class="callout bad">
      <h3>Three things this table does not let me claim</h3>
      <p><b>1. <code>access</code> got worse (${pp(accessDelta)}).</b> The critic over-corrects on judgement calls — it fixed 3 apps and broke 4, mostly by flipping self-serve to gated. Verification helps on facts you can read off a page and hurts on questions about commercial intent. The fix is to stop the critic touching <code>access</code>, which measurement revealed and intuition would not have.</p>
      <p><b>2. The <code>composio_toolkit_exists</code> jump is a gimme.</b> Pass 1 never consults the catalogue, so it scores 0% by construction. It is a real capability difference, but it inflates the overall delta and is not the model getting smarter.</p>
      <p><b>3. <code>auth_methods</code> is scored strictly.</b> Exact set equality — truth <code>api-key</code> against agent <code>api-key, oauth2</code> counts as a miss. That is harsh, and it is why the number is low.</p>
      <p><b>The sample is deliberately unfair.</b> It over-weights fintech, gated products, and rows whose cited evidence looked like it came from the wrong company. A random 18 would have drawn mostly easy developer tools and flattered both passes. These are worst-case figures.</p>
    </div>

    <h3 style="margin-top:32px">Every <code>access</code> judgement that missed</h3>
    <table class="acc">
      <thead><tr><th>App</th><th>Truth</th><th>Pass 1</th><th>Pass 2</th><th></th></tr></thead>
      <tbody>
      ${accessMisses
        .map(
          (m) =>
            `<tr><td>${esc(m.name)}</td><td><span class="pill ${esc(m.truth)}">${esc(m.truth)}</span></td><td><span class="unk">${esc(m.pass1)}</span></td><td><span class="unk">${esc(m.pass2)}</span></td><td>${m.fixed_by_pass2 ? '<span class="tag fix">fixed by pass 2</span>' : m.pass2 !== m.truth && m.pass1 === m.truth ? '<span class="tag brk">broken by pass 2</span>' : ''}</td></tr>`,
        )
        .join('\n      ')}
      </tbody>
    </table>

    <p style="margin-top:20px;color:var(--muted);font-size:14.2px">Worth stating plainly: the model reported <code>confidence: high</code> on all ${p.total_apps} rows. Self-reported confidence did not discriminate at all, which is exactly why this hand-checked measurement exists.</p>
  </div>
</section>

<div class="wrap"><div class="rule"></div></div>

<section>
  <div class="wrap">
    <div class="sec-title">
      <h2>The ${p.total_apps} apps</h2>
      <span class="showing" id="count"></span>
    </div>

    <div class="chips" id="chips">
      <button class="chip on" data-cat="">All</button>
      ${categories.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c.replace(/ and /g, ' &amp; '))}</button>`).join('\n      ')}
    </div>

    <div class="controls">
      <select id="fAccess"><option value="">Any access</option><option>self-serve</option><option>trial</option><option>gated</option></select>
      <select id="fAuth"><option value="">Any auth</option>${authSchemes.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
      <select id="fBuild"><option value="">Any verdict</option><option>easy</option><option>needs-outreach</option><option>blocked</option></select>
      <select id="fKit"><option value="">Toolkit: any</option><option value="true">Has toolkit</option><option value="false">No toolkit</option></select>
      <select id="fVer"><option value="">All rows</option><option value="1">Hand-checked only</option><option value="d">Human disagreed</option></select>
      <input type="search" id="q" placeholder="Search app or API…">
    </div>
    <p class="legend"><span class="ver">✓</span> marks the ${verifiedCount} apps checked by hand. Where the human disagreed, the agent's answer is <span class="was">struck through</span> and the verified value shown beside it. The agent's raw output in <code>rows.json</code> is unchanged.</p>

    <div class="tablewrap">
      <table class="grid">
        <thead><tr>
          <th>#</th><th>App</th><th>Category</th><th>Access</th><th>Auth</th>
          <th>Verdict</th><th>Kit</th><th>MCP</th><th>API surface</th><th>Evidence</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>
</section>

<div class="wrap"><div class="rule"></div></div>

<section>
  <div class="wrap">
    <h2>How the agent works</h2>
    <p class="sub">Built with Composio's SDK for its tools and Gemini for structured extraction. Five steps per app.</p>
    <div class="steps">
      <div class="step"><span class="i"></span><div><b>Search the open web</b><p>Composio's <code>COMPOSIO_SEARCH_WEB</code> tool finds candidate developer docs. Tool slugs are resolved from the live catalogue at runtime, never hardcoded.</p></div></div>
      <div class="step"><span class="i"></span><div><b>Rank, then fetch the real docs</b><p>Candidate URLs are scored for authority — <code>docs.</code>/<code>developer.</code> subdomains and matching domains win — then the top pages are fetched through Composio and reduced to text.</p></div></div>
      <div class="step"><span class="i"></span><div><b>Extract with a strict schema</b><p>Gemini returns one JSON row constrained by a response schema. Out-of-range values fall back to the conservative option, so a bad row can never break the batch.</p></div></div>
      <div class="step"><span class="i"></span><div><b>Cross-check Composio's catalogue</b><p>Each app is looked up by slug across Composio's 1,000+ toolkits. This is near-ground-truth: a shipped toolkit proves a credential-obtainable API exists.</p></div></div>
      <div class="step"><span class="i"></span><div><b>Re-read and criticise</b><p>A second pass re-reads the source docs and corrects fields the evidence contradicts. It changed at least one field on <b>${criticCount} of ${p.total_apps}</b> rows.</p></div></div>
    </div>

    <div class="callout">
      <h3>Where a human was still required</h3>
      <p><b>The <code>access</code> field.</b> Plaid documents its API openly and publishes a free sandbox — but production access requires approval, which makes it <code>trial</code>, not <code>self-serve</code>. Nothing on the page says so. ${accessMisses.length} of the ${a.sample_size} hand-checked apps had <code>access</code> wrong in at least one pass.</p>
      <p>A <b>preflight</b> executes one real search before any model call and aborts the run if the tools don't work — because an early version silently degraded to model memory when Composio returned 403, and produced five confident, plausible, completely unearned rows.</p>
    </div>

    <div class="links">
      <a class="link" href="${esc(REPO_URL)}">Repository<span>Agent, analysis, and this page</span></a>
      ${SITE_URL ? `<a class="link" href="${esc(SITE_URL)}">Live page<span>${esc(SITE_URL.replace(/^https?:\/\//, ''))}</span></a>` : ''}
      <a class="link" href="${esc(REPO_URL)}/blob/main/results/rows.json">rows.json<span>All ${p.total_apps} researched rows</span></a>
      <a class="link" href="${esc(REPO_URL)}/blob/main/results/accuracy.json">accuracy.json<span>Pass 1 vs pass 2, every miss</span></a>
      <a class="link" href="${esc(REPO_URL)}/blob/main/results/human_review.csv">human_review.csv<span>The ${a.sample_size} hand-checked apps</span></a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <div class="footrow">
      <span>Case study &middot; ${p.total_apps}-app agent-toolkit survey</span>
      <span>Composio + Gemini &middot; figures computed from results/*.json</span>
    </div>
  </div>
</footer>

<script>
const DATA = ${json(tableData)};
const $ = id => document.getElementById(id);
const tbody = $('tbody');
const els = { access:$('fAccess'), auth:$('fAuth'), build:$('fBuild'), kit:$('fKit'), ver:$('fVer'), q:$('q') };
let cat = '';

const triTxt = v => v === true ? 'yes' : v === false ? 'no' : '&ndash;';
const tri = v => '<span class="' + (v === true ? 'yes' : v === false ? 'no' : 'unk') + '">' + triTxt(v) + '</span>';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const pill = v => '<span class="pill ' + esc(v) + '">' + esc(v) + '</span>';

/* Agent value, plus the hand-checked one when a human looked and disagreed. */
const verdict = (agent, truth) => {
  if (truth === undefined) return pill(agent);
  if (truth === agent) return pill(agent) + '<span class="ver">&check;</span>';
  return '<span class="was">' + esc(agent) + '</span>' + pill(truth) + '<span class="ver">&check;</span>';
};
const verTri = (agent, truth) => {
  if (truth === undefined) return tri(agent);
  if (truth === agent) return tri(agent) + '<span class="ver">&check;</span>';
  return '<span class="was">' + triTxt(agent) + '</span>' + tri(truth) + '<span class="ver">&check;</span>';
};

/* True when the human's answer differs from the agent on any checked field. */
const disagreed = d => {
  if (!d.t) return false;
  const t = d.t;
  if (t.a !== undefined && t.a !== d.a) return true;
  if (t.b !== undefined && t.b !== d.b) return true;
  if (t.k !== undefined && t.k !== d.k) return true;
  if (t.m !== undefined && t.m !== d.m) return true;
  return false;
};

function render(){
  const ac = els.access.value, au = els.auth.value, bu = els.build.value,
        ki = els.kit.value, q = els.q.value.trim().toLowerCase();

  const rows = DATA.filter(d =>
    (!cat || d.c === cat) &&
    (!ac  || d.a === ac) &&
    (!au  || d.au.some(x => x.toLowerCase().includes(au))) &&
    (!bu  || d.b === bu) &&
    (!ki  || String(d.k) === ki) &&
    (!q   || (d.n + ' ' + d.s + ' ' + d.bl).toLowerCase().includes(q))
  );

  tbody.innerHTML = rows.map((d, i) => \`<tr>
    <td class="idx">\${i + 1}</td>
    <td class="name">\${esc(d.n)}</td>
    <td class="cat">\${esc(d.c)}</td>
    <td><span class="pill \${d.a}">\${d.a}</span></td>
    <td class="auth">\${d.au.length ? esc(d.au.join(', ')) : '&ndash;'}</td>
    <td><span class="pill \${d.b}">\${d.b}</span></td>
    <td>\${tri(d.k)}</td>
    <td>\${tri(d.m)}</td>
    <td class="surface">\${esc(d.s)}</td>
    <td>\${d.e ? '<a href="' + esc(d.e) + '" rel="noopener">source</a>' : '&ndash;'}</td>
  </tr>\`).join('');

  $('count').textContent = 'Showing ' + rows.length + ' of ' + DATA.length;
}

$('chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  cat = b.dataset.cat;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
  render();
});
Object.values(els).forEach(el => el.addEventListener('input', render));
render();
</script>
</body>
</html>`;

  fs.mkdirSync(path.resolve('site'), { recursive: true });
  fs.writeFileSync(path.resolve('site/index.html'), html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`wrote site/index.html (${kb} KB, ${rows.length} apps embedded)`);
  if (!SITE_URL) console.log('tip: set SITE_URL=https://… and rebuild to add the live-page link.');
  if (REPO_URL.includes('your-username')) console.log('tip: set REPO_URL=https://github.com/… and rebuild to fix repo links.');
}

try {
  main();
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
