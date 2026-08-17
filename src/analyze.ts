import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadApps } from './research.js';
import type { AppRow } from './schema.js';

/**
 * Turns 100 rows into the handful of numbers worth putting on a page.
 *
 * Everything here is counted from results/rows.json — nothing is asserted that
 * isn't derived from the data, and every list is emitted in full so a reader can
 * check the claim rather than take it on trust.
 */

const AUTH_CANON: Array<[RegExp, string]> = [
  [/oauth\s*-?2|oauth2|oauth 2\.0/i, 'oauth2'],
  [/oauth\s*-?1/i, 'oauth1'],
  [/api[-_ ]?key|apikey/i, 'api-key'],
  [/personal[-_ ]access|^pat$|bearer|token|jwt/i, 'token'],
  [/basic/i, 'basic'],
  [/mtls|client[-_ ]cert/i, 'mtls'],
  [/cookie|session/i, 'session'],
  [/saml|sso/i, 'sso'],
  [/none|no auth|public/i, 'none'],
];

const canonAuth = (raw: string): string => {
  for (const [re, name] of AUTH_CANON) if (re.test(raw)) return name;
  return 'other';
};

/**
 * Group free-text blockers into themes so "most common blocker" is a real number.
 *
 * Order is significant and deliberate: most blockers mention several conditions
 * at once ("requires a seat-based license and sales outreach"), so the list runs
 * from the hardest gate to the softest. Partnership beats enterprise-tier, which
 * beats being an existing customer, which beats an approval step, which beats
 * simply having to email someone. First match wins.
 */
const BLOCKER_THEMES: Array<[RegExp, string]> = [
  [/partner/i, 'partnership required'],
  [/enterprise|business plan|paid (tier|plan)|premium|subscription|seat|licen[cs]e|contract/i, 'enterprise or paid tier only'],
  [/existing .*(account|customer)|are a .* customer|assumes you are/i, 'must already be a customer'],
  [/approval|review|appl(y|ication)|vetting|onboarding|verification|request(ed|s)?\b/i, 'application or approval required'],
  [/sales|contact us|talk to|account manager|demo|outreach|contacting/i, 'must talk to sales'],
  [/waitlist|invite|beta|early access/i, 'waitlist or invite only'],
  [/no public api|not public|undocumented|unofficial|no api/i, 'no public API'],
  [/rate limit|quota/i, 'restrictive rate limits'],
];

const blockerTheme = (raw: string): string | null => {
  if (!raw || !raw.trim()) return null;
  for (const [re, name] of BLOCKER_THEMES) if (re.test(raw)) return name;
  return 'other';
};

const tally = <T>(items: T[], key: (t: T) => string | null): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

const pct = (n: number, d: number): number => (d === 0 ? 0 : +((n / d) * 100).toFixed(1));

function main(): void {
  const rowsPath = path.resolve('results/rows.json');
  if (!fs.existsSync(rowsPath)) throw new Error('results/rows.json not found — run `npm run run:all` first.');

  const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8')) as AppRow[];
  const apps = loadApps();
  const categories = [...new Set(apps.map((a) => a.category))];
  const n = rows.length;

  // --- auth ---------------------------------------------------------------
  // Counted per app-mention, then also as "how many apps support this at all",
  // because most apps accept more than one scheme.
  const authMentions: string[] = [];
  for (const r of rows) for (const a of r.auth_methods) authMentions.push(canonAuth(a));
  const authByApp = tally(rows, () => null);
  for (const scheme of new Set(authMentions)) {
    authByApp[scheme] = rows.filter((r) => r.auth_methods.some((a) => canonAuth(a) === scheme)).length;
  }
  const authSorted = Object.fromEntries(Object.entries(authByApp).sort((a, b) => b[1] - a[1]));

  const multiAuth = rows.filter((r) => new Set(r.auth_methods.map(canonAuth)).size > 1).length;
  const noAuth = rows.filter((r) => r.auth_methods.length === 0).length;

  // --- access by category -------------------------------------------------
  const accessByCategory = categories.map((cat) => {
    const inCat = rows.filter((r) => r.category === cat);
    const selfServe = inCat.filter((r) => r.access === 'self-serve').length;
    const trial = inCat.filter((r) => r.access === 'trial').length;
    const gated = inCat.filter((r) => r.access === 'gated').length;
    return {
      category: cat,
      total: inCat.length,
      'self-serve': selfServe,
      trial,
      gated,
      self_serve_pct: pct(selfServe, inCat.length),
      gated_pct: pct(gated + trial, inCat.length),
    };
  });
  accessByCategory.sort((a, b) => b.gated_pct - a.gated_pct);

  // --- buildability -------------------------------------------------------
  const buildability = tally(rows, (r) => r.buildability);
  const easyWins = rows
    .filter((r) => r.buildability === 'easy' && r.access === 'self-serve')
    .map((r) => ({ id: r.id, name: r.name, category: r.category, auth: r.auth_methods, toolkit: r.composio_toolkit_exists }));
  const needsOutreach = rows
    .filter((r) => r.buildability !== 'easy')
    .map((r) => ({ id: r.id, name: r.name, category: r.category, access: r.access, blocker: r.blocker }));

  // --- blockers -----------------------------------------------------------
  const blockers = tally(rows, (r) => blockerTheme(r.blocker));
  const blockerExamples: Record<string, string[]> = {};
  for (const r of rows) {
    const theme = blockerTheme(r.blocker);
    if (!theme) continue;
    (blockerExamples[theme] ??= []).push(`${r.name}: ${r.blocker}`);
  }

  // --- composio coverage --------------------------------------------------
  const hasToolkit = rows.filter((r) => r.composio_toolkit_exists === true);
  const noToolkit = rows.filter((r) => r.composio_toolkit_exists === false);
  const coverageByCategory = categories
    .map((cat) => {
      const inCat = rows.filter((r) => r.category === cat);
      const have = inCat.filter((r) => r.composio_toolkit_exists === true).length;
      return { category: cat, total: inCat.length, has_toolkit: have, pct: pct(have, inCat.length) };
    })
    .sort((a, b) => b.pct - a.pct);

  // The interesting cross-tab: self-serve APIs Composio has not covered yet.
  const uncoveredSelfServe = noToolkit
    .filter((r) => r.access === 'self-serve' && r.buildability === 'easy')
    .map((r) => ({ id: r.id, name: r.name, category: r.category }));

  // --- mcp ----------------------------------------------------------------
  const mcp = tally(rows, (r) => String(r.has_mcp));

  const patterns = {
    generated_at: new Date().toISOString(),
    total_apps: n,
    source: 'results/rows.json (pass 2: fetch + catalogue cross-check + critic)',

    headline: {
      self_serve_pct: pct(rows.filter((r) => r.access === 'self-serve').length, n),
      gated_or_trial_pct: pct(rows.filter((r) => r.access !== 'self-serve').length, n),
      easy_pct: pct(rows.filter((r) => r.buildability === 'easy').length, n),
      composio_coverage_pct: pct(hasToolkit.length, n),
      most_common_auth: Object.keys(authSorted)[0] ?? null,
      // "other" is a bucketing failure, not a finding — never report it as the headline.
      most_common_blocker: Object.keys(blockers).find((k) => k !== 'other') ?? null,
      apps_with_known_mcp: rows.filter((r) => r.has_mcp === true).length,
    },

    auth: {
      apps_supporting_each_scheme: authSorted,
      apps_with_multiple_schemes: multiAuth,
      apps_with_no_auth_found: noAuth,
    },

    access: {
      overall: tally(rows, (r) => r.access),
      by_category: accessByCategory,
      most_gated_category: accessByCategory[0]?.category ?? null,
      least_gated_category: accessByCategory.at(-1)?.category ?? null,
    },

    buildability: {
      overall: buildability,
      easy_wins: easyWins,
      needs_outreach: needsOutreach,
    },

    blockers: {
      themes: blockers,
      examples: Object.fromEntries(Object.entries(blockerExamples).map(([k, v]) => [k, v.slice(0, 5)])),
    },

    composio: {
      has_toolkit: hasToolkit.length,
      no_toolkit: noToolkit.length,
      coverage_pct: pct(hasToolkit.length, n),
      by_category: coverageByCategory,
      uncovered_but_self_serve: uncoveredSelfServe,
      note: 'Toolkit visibility is scoped to the API key used; this is a strong signal, not a universal constant.',
    },

    mcp: { distribution: mcp, known_mcp: rows.filter((r) => r.has_mcp === true).map((r) => r.name) },

    caveats: [
      `Every row is confidence:"${rows[0]?.confidence}" — the model's self-reported confidence did not discriminate, so it should not be read as reliability.`,
      'access is the least accurate field (see results/accuracy.json); treat self-serve vs gated counts as approximate.',
      `${rows.filter((r) => (r.meta?.critic_changed?.length ?? 0) > 0).length} of ${n} rows were corrected by the critic step.`,
    ],
  };

  fs.writeFileSync(path.resolve('results/patterns.json'), JSON.stringify(patterns, null, 2));

  // --- console report -----------------------------------------------------
  const h = patterns.headline;
  console.log(`\nPATTERNS ACROSS ${n} APPS\n${'='.repeat(64)}`);
  console.log(`  self-serve                 ${h.self_serve_pct}%`);
  console.log(`  gated or trial             ${h.gated_or_trial_pct}%`);
  console.log(`  buildable today ("easy")   ${h.easy_pct}%`);
  console.log(`  already in Composio        ${h.composio_coverage_pct}%`);
  console.log(`  most common auth           ${h.most_common_auth}`);
  console.log(`  most common blocker        ${h.most_common_blocker}`);
  console.log(`  apps with a known MCP      ${h.apps_with_known_mcp}`);

  console.log(`\nAUTH (apps supporting each scheme)`);
  for (const [k, v] of Object.entries(authSorted)) console.log(`  ${k.padEnd(12)} ${String(v).padStart(3)}  ${'#'.repeat(Math.round(v / 2))}`);
  console.log(`  apps accepting >1 scheme: ${multiAuth}   apps with no auth found: ${noAuth}`);

  console.log(`\nACCESS BY CATEGORY (most gated first)`);
  console.log(`  ${'category'.padEnd(38)} n   self-serve  gated/trial`);
  for (const c of accessByCategory)
    console.log(`  ${c.category.padEnd(38)}${String(c.total).padStart(2)}   ${String(c['self-serve']).padStart(6)}      ${String(c.gated + c.trial).padStart(6)}   ${c.gated_pct}%`);

  console.log(`\nBUILDABILITY`);
  for (const [k, v] of Object.entries(buildability)) console.log(`  ${k.padEnd(16)} ${v}`);

  console.log(`\nBLOCKER THEMES`);
  for (const [k, v] of Object.entries(blockers)) console.log(`  ${k.padEnd(32)} ${v}`);

  console.log(`\nCOMPOSIO COVERAGE BY CATEGORY`);
  for (const c of coverageByCategory) console.log(`  ${c.category.padEnd(38)} ${String(c.has_toolkit).padStart(2)}/${c.total}  ${c.pct}%`);
  console.log(`\n  self-serve + easy but NOT in Composio (${uncoveredSelfServe.length}):`);
  console.log(`    ${uncoveredSelfServe.map((u) => u.name).join(', ') || '(none)'}`);

  console.log(`\nwrote results/patterns.json`);
}

try {
  main();
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
