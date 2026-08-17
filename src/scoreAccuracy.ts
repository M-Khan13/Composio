import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { SCORED_FIELDS, type AppRow, type ScoredField } from './schema.js';

/**
 * Scores the agent against hand-checked truth, for pass 1 and pass 2 separately.
 *
 * Pass 1 = search snippets only, no page fetch, no catalogue check, no critic.
 * Pass 2 = full fetch + Composio catalogue cross-check + critic re-read.
 *
 * Both passes run the same `researchApp` function with steps switched off, so
 * the difference between the two numbers is attributable to the verification
 * steps rather than to two separately-written prompts.
 */

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Minimal RFC4180-ish parser: handles quoted fields, embedded commas, "" escapes. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const normList = (s: string): string[] =>
  s
    .split(/[|,;]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .sort();

/** Treat obvious synonyms as equal so trivial wording differences aren't scored as errors. */
const AUTH_SYNONYMS: Record<string, string> = {
  bearer: 'token',
  'bearer-token': 'token',
  'api-key': 'api-key',
  apikey: 'api-key',
  key: 'api-key',
  'personal-access-token': 'token',
  pat: 'token',
  jwt: 'token',
  oauth: 'oauth2',
  'oauth-2': 'oauth2',
  'oauth 2.0': 'oauth2',
};
const canonAuth = (a: string[]): string[] => [...new Set(a.map((x) => AUTH_SYNONYMS[x] ?? x))].sort();

const normTri = (s: string): string => {
  const v = s.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(v)) return 'true';
  if (['false', 'no', 'n', '0'].includes(v)) return 'false';
  return 'unknown';
};

function agentValue(row: AppRow, field: ScoredField): string[] | string {
  if (field === 'auth_methods') return canonAuth(row.auth_methods.map((a) => a.toLowerCase()));
  if (field === 'has_mcp') return normTri(String(row.has_mcp));
  if (field === 'composio_toolkit_exists') return normTri(String(row.composio_toolkit_exists));
  return String(row[field]).toLowerCase();
}

function truthValue(rec: Record<string, string>, field: ScoredField): string[] | string | null {
  const raw = rec[`truth_${field}`];
  if (!raw || raw.trim() === '') return null; // blank = not reviewed, skip
  if (field === 'auth_methods') return canonAuth(normList(raw));
  if (field === 'has_mcp' || field === 'composio_toolkit_exists') return normTri(raw);
  return raw.trim().toLowerCase();
}

const equal = (a: string[] | string, b: string[] | string): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

// ---------------------------------------------------------------------------

interface FieldScore {
  field: ScoredField;
  reviewed: number;
  pass1_correct: number;
  pass2_correct: number;
  pass1_accuracy: number | null;
  pass2_accuracy: number | null;
  delta: number | null;
}

interface Miss {
  id: string;
  name: string;
  field: ScoredField;
  truth: string;
  pass1: string;
  pass2: string;
  fixed_by_pass2: boolean;
}

const show = (v: string[] | string | null | undefined): string =>
  v == null ? '—' : Array.isArray(v) ? v.join('|') || '(none)' : v;

function main(): void {
  const csvPath = path.resolve('results/human_review.csv');
  const p2Path = path.resolve('results/rows.json');
  const p1Path = path.resolve('results/rows_pass1.json');

  if (!fs.existsSync(csvPath)) throw new Error('results/human_review.csv not found — run `npm run sample` first.');
  if (!fs.existsSync(p2Path)) throw new Error('results/rows.json not found — run `npm run run:all` first.');
  if (!fs.existsSync(p1Path))
    throw new Error('results/rows_pass1.json not found — run `npm run run:all -- --pass=1` first.');

  const review = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const pass2 = new Map((JSON.parse(fs.readFileSync(p2Path, 'utf8')) as AppRow[]).map((r) => [r.id, r]));
  const pass1 = new Map((JSON.parse(fs.readFileSync(p1Path, 'utf8')) as AppRow[]).map((r) => [r.id, r]));

  const scores: FieldScore[] = [];
  const misses: Miss[] = [];
  let anyTruth = 0;

  for (const field of SCORED_FIELDS) {
    let reviewed = 0;
    let c1 = 0;
    let c2 = 0;

    for (const rec of review) {
      const truth = truthValue(rec, field);
      if (truth === null) continue;
      const r1 = pass1.get(rec.id);
      const r2 = pass2.get(rec.id);
      if (!r1 || !r2) continue;

      reviewed++;
      const v1 = agentValue(r1, field);
      const v2 = agentValue(r2, field);
      const ok1 = equal(v1, truth);
      const ok2 = equal(v2, truth);
      if (ok1) c1++;
      if (ok2) c2++;

      if (!ok1 || !ok2) {
        misses.push({
          id: rec.id,
          name: rec.name,
          field,
          truth: show(truth),
          pass1: show(v1),
          pass2: show(v2),
          fixed_by_pass2: !ok1 && ok2,
        });
      }
    }

    anyTruth += reviewed;
    scores.push({
      field,
      reviewed,
      pass1_correct: c1,
      pass2_correct: c2,
      pass1_accuracy: reviewed ? +(c1 / reviewed).toFixed(3) : null,
      pass2_accuracy: reviewed ? +(c2 / reviewed).toFixed(3) : null,
      delta: reviewed ? +((c2 - c1) / reviewed).toFixed(3) : null,
    });
  }

  if (anyTruth === 0) {
    console.log('No truth_* columns are filled in yet in results/human_review.csv.');
    console.log('Fill them in by hand, then rerun `npm run score`.');
    return;
  }

  const totalReviewed = scores.reduce((a, s) => a + s.reviewed, 0);
  const total1 = scores.reduce((a, s) => a + s.pass1_correct, 0);
  const total2 = scores.reduce((a, s) => a + s.pass2_correct, 0);

  const weakest = [...scores].filter((s) => s.reviewed > 0).sort((a, b) => a.pass2_accuracy! - b.pass2_accuracy!)[0];

  const report = {
    generated_at: new Date().toISOString(),
    sample_size: review.length,
    sampling: 'deliberately over-weighted toward hard access cases; this is a worst-case accuracy, not an average',
    judgements_reviewed: totalReviewed,
    overall: {
      pass1_accuracy: +(total1 / totalReviewed).toFixed(3),
      pass2_accuracy: +(total2 / totalReviewed).toFixed(3),
      delta: +((total2 - total1) / totalReviewed).toFixed(3),
    },
    per_field: scores,
    weakest_field: weakest?.field ?? null,
    fixed_by_pass2: misses.filter((m) => m.fixed_by_pass2).length,
    still_wrong_after_pass2: misses.filter((m) => m.pass2 !== m.truth).length,
    misses,
  };

  fs.writeFileSync(path.resolve('results/accuracy.json'), JSON.stringify(report, null, 2));

  const pct = (n: number | null) => (n === null ? '   —' : `${(n * 100).toFixed(0).padStart(3)}%`);
  console.log(`\nACCURACY  (${review.length} apps, ${totalReviewed} field judgements checked by hand)\n`);
  console.log('  field                          n   pass1   pass2   delta');
  for (const s of scores) {
    const d = s.delta === null ? '    —' : `${s.delta >= 0 ? '+' : ''}${(s.delta * 100).toFixed(0)}pp`;
    console.log(`  ${s.field.padEnd(28)} ${String(s.reviewed).padStart(2)}   ${pct(s.pass1_accuracy)}   ${pct(s.pass2_accuracy)}   ${d.padStart(6)}`);
  }
  console.log(`\n  OVERALL                      ${String(totalReviewed).padStart(3)}   ${pct(report.overall.pass1_accuracy)}   ${pct(report.overall.pass2_accuracy)}   ${(report.overall.delta >= 0 ? '+' : '') + (report.overall.delta * 100).toFixed(0)}pp`);
  console.log(`\n  weakest field: ${report.weakest_field}`);
  console.log(`  corrected by pass 2: ${report.fixed_by_pass2}   still wrong after pass 2: ${report.still_wrong_after_pass2}`);

  if (misses.length) {
    console.log('\n  misses (truth / pass1 / pass2):');
    for (const m of misses.slice(0, 25)) {
      console.log(
        `    ${m.name.padEnd(22)} ${m.field.padEnd(24)} ${m.truth.padEnd(14)} ${m.pass1.padEnd(14)} ${m.pass2.padEnd(14)}${m.fixed_by_pass2 ? ' <- fixed by pass 2' : ''}`,
      );
    }
  }
  console.log('\nwrote results/accuracy.json');
}

try {
  main();
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
