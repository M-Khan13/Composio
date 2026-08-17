import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { getCatalogue, preflight, getResearchTools } from './composio.js';
import { QuotaExhaustedError, MODEL } from './gemini.js';
import { loadApps, researchApp } from './research.js';
import type { AppRow, AppSeed } from './schema.js';

/**
 * Batch runner for all 100 apps.
 *
 * Three properties matter more than speed here:
 *   1. Resumable — a run takes ~45-60 minutes at the rate limits we're pinned
 *      to, so it checkpoints after every single app and skips completed work on
 *      restart. Losing 50 minutes to a transient network error is not acceptable.
 *   2. Lossless — an app that fails to resolve stays in the output marked
 *      confidence:low. A missing row would quietly shrink the denominator and
 *      flatter every percentage in the analysis.
 *   3. Honest about stopping — a Gemini daily cap aborts immediately rather than
 *      writing 60 fake low-confidence rows that look like findings.
 */

const RESULTS_DIR = path.resolve('results');

interface Options {
  pass: 1 | 2;
  force: boolean;
  only: string[] | null;
  limit: number | null;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

  const pass = get('pass') === '1' ? 1 : 2;
  const only = get('only');
  const limit = get('limit');

  return {
    pass,
    force: argv.includes('--force'),
    only: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null,
    limit: limit ? Number(limit) : null,
    // Pass 1 does no scraping, so it can afford a little more parallelism; the
    // Gemini throttle serialises model calls either way.
    concurrency: Number(get('concurrency') ?? process.env.CONCURRENCY ?? (pass === 1 ? 3 : 2)),
  };
}

const outputPath = (pass: 1 | 2): string =>
  path.join(RESULTS_DIR, pass === 1 ? 'rows_pass1.json' : 'rows.json');

function loadExisting(file: string): Map<string, AppRow> {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as AppRow[];
    return new Map(rows.map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
}

/**
 * Write via a temp file and rename so an interrupt mid-write can't leave a
 * truncated JSON file behind — the checkpoint is worthless if it can corrupt.
 */
function saveRows(file: string, apps: AppSeed[], done: Map<string, AppRow>): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  // Preserve dataset order rather than completion order, so diffs stay readable.
  const ordered = apps.map((a) => done.get(a.id)).filter((r): r is AppRow => Boolean(r));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ordered, null, 2));
  fs.renameSync(tmp, file);
}

function summarise(rows: AppRow[]): void {
  const by = <T extends string>(pick: (r: AppRow) => T): Record<string, number> =>
    rows.reduce<Record<string, number>>((acc, r) => ((acc[pick(r)] = (acc[pick(r)] ?? 0) + 1), acc), {});

  const unresolved = rows.filter((r) => r.meta?.issues.includes('unresolved'));
  const low = rows.filter((r) => r.confidence === 'low');
  const noDocs = rows.filter((r) => r.meta?.issues.some((i) => i === 'no-docs-fetched'));
  const fellBack = rows.filter((r) => r.meta?.issues.some((i) => i.includes('native-fetch')));
  const critiqued = rows.filter((r) => (r.meta?.critic_changed?.length ?? 0) > 0);

  const line = (label: string, n: number) => console.log(`  ${label.padEnd(34)} ${n}`);

  console.log(`\n${'='.repeat(70)}\nSUMMARY  (${rows.length} rows)\n${'='.repeat(70)}`);
  line('resolved cleanly (no issues)', rows.filter((r) => (r.meta?.issues.length ?? 0) === 0).length);
  line('low confidence', low.length);
  line('fully unresolved', unresolved.length);
  line('no docs fetched', noDocs.length);
  line('fell back to native fetch', fellBack.length);
  line('rows the critic corrected', critiqued.length);

  console.log('\n  confidence:  ', JSON.stringify(by((r) => r.confidence)));
  console.log('  access:      ', JSON.stringify(by((r) => r.access)));
  console.log('  buildability:', JSON.stringify(by((r) => r.buildability)));
  console.log('  composio kit:', JSON.stringify(by((r) => String(r.composio_toolkit_exists))));

  if (critiqued.length) {
    console.log('\n  fields the critic changed:');
    const fields: Record<string, number> = {};
    for (const r of critiqued) for (const f of r.meta!.critic_changed!) fields[f] = (fields[f] ?? 0) + 1;
    for (const [f, n] of Object.entries(fields).sort((a, b) => b[1] - a[1])) console.log(`    ${f.padEnd(16)} ${n}`);
  }

  if (unresolved.length) {
    console.log('\n  UNRESOLVED (kept in the data, marked low confidence):');
    for (const r of unresolved) console.log(`    ${r.name}`);
  }
  if (low.length) {
    console.log('\n  LOW CONFIDENCE:');
    for (const r of low) console.log(`    ${r.name.padEnd(26)} ${r.meta?.issues.slice(0, 2).join('; ') || ''}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const file = outputPath(opts.pass);

  let apps = loadApps();
  if (opts.only) apps = apps.filter((a) => opts.only!.includes(a.id));
  if (opts.limit) apps = apps.slice(0, opts.limit);

  const done = opts.force ? new Map<string, AppRow>() : loadExisting(file);
  const todo = apps.filter((a) => !done.has(a.id));

  const tools = await getResearchTools();
  console.log(`pass ${opts.pass}  |  model ${MODEL}  |  concurrency ${opts.concurrency}`);
  console.log(`search ${tools.search?.slug ?? 'NONE'}  |  scrape ${tools.scrape?.slug ?? 'native fetch'}`);

  // Prove the tools work before spending an hour discovering they don't.
  await preflight();
  console.log('preflight OK');

  const catalogue = await getCatalogue().catch(() => null);
  console.log(`catalogue ${catalogue?.length ?? 0} toolkits`);
  console.log(`${apps.length} apps  |  ${done.size} already done  |  ${todo.length} to research`);
  if (todo.length === 0) {
    console.log('nothing to do — pass --force to re-research everything.');
    summarise(apps.map((a) => done.get(a.id)!).filter(Boolean));
    return;
  }
  console.log('');

  let completed = 0;
  let stopping = false;

  // Ctrl-C keeps whatever is already on disk rather than discarding the run.
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\n\ninterrupted — finishing in-flight apps, checkpoint is already saved.');
  });

  const limit = pLimit(Math.max(1, opts.concurrency));
  const t0 = Date.now();

  const tasks = todo.map((app) =>
    limit(async () => {
      if (stopping) return;

      // researchApp swallows its own failures; an outer retry only exists for
      // hard throws such as a dropped connection.
      let row: AppRow | null = null;
      for (let attempt = 0; attempt < 2 && !row; attempt++) {
        try {
          row = await researchApp(app, { pass: opts.pass, catalogue });
        } catch (err) {
          if (err instanceof QuotaExhaustedError) throw err;
          if (attempt === 1) {
            console.warn(`  ! ${app.name}: ${(err as Error).message.slice(0, 90)}`);
            row = {
              id: app.id,
              name: app.name,
              category: app.category,
              one_liner: '',
              auth_methods: [],
              access: 'gated',
              api_surface: 'unresolved',
              has_mcp: 'unknown',
              composio_toolkit_exists: 'unknown',
              buildability: 'blocked',
              blocker: 'research threw an unrecoverable error',
              evidence_urls: [app.hint_url],
              confidence: 'low',
              meta: {
                pass: opts.pass,
                issues: ['unresolved', `threw: ${(err as Error).message.slice(0, 80)}`],
                fetched_at: new Date().toISOString(),
                model: MODEL,
              },
            };
          } else {
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }

      done.set(app.id, row!);
      saveRows(file, apps, done); // checkpoint after every app

      completed++;
      const elapsed = (Date.now() - t0) / 1000;
      const eta = Math.round((elapsed / completed) * (todo.length - completed));
      const flag = row!.confidence === 'low' ? ' [LOW]' : '';
      console.log(
        `  [${String(completed).padStart(3)}/${todo.length}] ${app.name.padEnd(26)} ` +
          `${row!.access.padEnd(11)} ${row!.buildability.padEnd(15)}${flag}  eta ${Math.floor(eta / 60)}m${eta % 60}s`,
      );
    }),
  );

  try {
    await Promise.all(tasks);
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      console.error(`\nSTOPPED: ${err.message}`);
      console.error(`Progress is saved in ${path.relative(process.cwd(), file)} — rerun to resume where it left off.`);
      summarise([...done.values()]);
      process.exit(2);
    }
    throw err;
  }

  saveRows(file, apps, done);
  const finalRows = apps.map((a) => done.get(a.id)).filter((r): r is AppRow => Boolean(r));
  summarise(finalRows);
  console.log(`\nwrote ${path.relative(process.cwd(), file)} (${finalRows.length} rows) in ${Math.round((Date.now() - t0) / 60000)}m`);
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
