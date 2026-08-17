import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadApps } from './research.js';
import type { AppRow, AppSeed } from './schema.js';

/**
 * Builds the human-review CSV for Phase 3.
 *
 * This is deliberately NOT a random sample. `access` is the field we expect the
 * agent to get wrong most, so the selection over-weights the cases where it is
 * hardest to judge — fintech, anything gated, and rows whose evidence looks like
 * it came from the wrong company. That means the resulting accuracy is a
 * worst-case number, not an average one, and the report says so.
 *
 * A few easy controls are included on purpose. A sample made only of hard cases
 * makes pass 1 and pass 2 both look terrible and hides the difference between
 * them, which is the thing we are actually trying to measure.
 */

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? 18);
const CONTROL_SLOTS = 3;

/**
 * Apps that must appear regardless of score — the judgement calls this project
 * exists to expose, plus the ones already suspected of being wrong.
 */
const MUST_INCLUDE = [
  'plaid', // self-serve sandbox, approval-gated production: the classic `trial`
  'amazon-sp-api', // developer registration + approval
  'pitchbook', // enterprise-only, no public signup
  'dealcloud', // enterprise-only despite public-looking docs
  'binance', // keys are self-serve for account holders; agent called it gated
  'mermaid-cli', // npm CLI with no API — agent found an unrelated project
  'sherlock', // python CLI with no API
  'ipayx', // agent's evidence points at a different company
];

const registrable = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
  } catch {
    return '';
  }
};

/**
 * Does the cited evidence even come from the company we asked about?
 *
 * This is the cheapest lie-detector in the project: when the agent researches
 * "Mermaid CLI" and cites a coral-reef database, the domains don't match. Not
 * conclusive on its own (plenty of apps document on a different domain), but a
 * strong hint that the row is about the wrong entity.
 */
function evidenceMismatch(row: AppRow, app: AppSeed): boolean {
  const hint = registrable(app.hint_url);
  if (!hint || row.evidence_urls.length === 0) return false;

  const firstSegment = (u: string): string => {
    try {
      return new URL(u).pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
    } catch {
      return '';
    }
  };

  // Same-domain evidence is usually fine — except on code forges, where the
  // first path segment is the owner and is what identifies the project.
  // "Mermaid CLI" citing github.com/data-mermaid/mermaid-api sits on the right
  // domain and is still an entirely different project.
  //
  // Match the exact hostname, not the registrable domain: docs.github.com is
  // GitHub's documentation site, where the first path segment is a locale
  // ("/en/rest/..."), not an owner. Treating it as a forge flags GitHub's own
  // docs as impostors.
  const FORGE_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
  const hostOf = (u: string): string => {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const hintHost = hostOf(app.hint_url);
  const hintIsForge = FORGE_HOSTS.includes(hintHost);
  const hintOwner = hintIsForge ? firstSegment(app.hint_url) : '';

  let wrongOwnerOnForge = false;

  for (const url of row.evidence_urls) {
    if (registrable(url) !== hint) continue;
    if (hintIsForge && FORGE_HOSTS.includes(hostOf(url)) && hintOwner && firstSegment(url) !== hintOwner) {
      wrongOwnerOnForge = true;
      continue;
    }
    return false; // evidence that genuinely belongs to this app
  }

  // Citing a *different owner's* repo on the same forge is decisive — the name
  // fallback below must not rescue it, since sibling projects share name
  // fragments ("mermaid-js/mermaid-cli" vs "data-mermaid/mermaid-api").
  if (wrongOwnerOnForge) return true;

  // Otherwise allow a name match, so apps that legitimately document on a
  // different domain aren't all flagged.
  const nameToken = app.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  return !row.evidence_urls.some((u) => {
    const flat = u.toLowerCase().replace(/[^a-z0-9]/g, '');
    return nameToken.length >= 4 && flat.includes(nameToken);
  });
}

interface Scored {
  app: AppSeed;
  row: AppRow;
  score: number;
  reasons: string[];
  mismatch: boolean;
}

function scoreHardness(row: AppRow, app: AppSeed): Scored {
  const reasons: string[] = [];
  let score = 0;

  if (app.category === 'Finance and Fintech') {
    score += 3;
    reasons.push('fintech');
  }
  if (row.access === 'gated' || row.access === 'trial') {
    score += 2;
    reasons.push(`access=${row.access}`);
  }
  const mismatch = evidenceMismatch(row, app);
  if (mismatch) {
    score += 4;
    reasons.push('evidence-domain-mismatch');
  }
  if (row.composio_toolkit_exists === false) {
    score += 2;
    reasons.push('no-composio-toolkit');
  }
  if (row.buildability === 'needs-outreach' || row.buildability === 'blocked') {
    score += 1;
    reasons.push(`buildability=${row.buildability}`);
  }
  if ((row.meta?.critic_changed?.length ?? 0) > 0) {
    score += 1;
    reasons.push(`critic-changed:${row.meta!.critic_changed!.join('/')}`);
  }
  if ((row.meta?.issues.length ?? 0) > 0) {
    score += 2;
    reasons.push('had-issues');
  }
  if (row.auth_methods.length === 0) {
    score += 2;
    reasons.push('no-auth-found');
  }

  return { app, row, score, reasons, mismatch };
}

const csvCell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join('|') : String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function main(): void {
  const rowsPath = path.resolve('results/rows.json');
  if (!fs.existsSync(rowsPath)) throw new Error('results/rows.json not found — run `npm run run:all` first.');

  const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8')) as AppRow[];
  const apps = loadApps();
  const byId = new Map(apps.map((a) => [a.id, a]));

  const scored = rows
    .map((r) => scoreHardness(r, byId.get(r.id)!))
    .sort((a, b) => b.score - a.score);

  const picked: Scored[] = [];
  const take = (s: Scored, why: string) => {
    if (picked.some((p) => p.app.id === s.app.id)) return;
    picked.push({ ...s, reasons: [why, ...s.reasons] });
  };

  for (const id of MUST_INCLUDE) {
    const s = scored.find((x) => x.app.id === id);
    if (s) take(s, 'must-include');
  }
  for (const s of scored) {
    if (picked.length >= SAMPLE_SIZE - CONTROL_SLOTS) break;
    take(s, 'high-hardness');
  }
  // Controls: the easiest, most obviously-correct rows, so the report can show
  // hits as well as misses.
  for (const s of [...scored].reverse()) {
    if (picked.length >= SAMPLE_SIZE) break;
    take(s, 'control');
  }

  const header = [
    'id',
    'name',
    'category',
    'why_sampled',
    'evidence_domain_mismatch',
    'agent_access',
    'agent_auth_methods',
    'agent_has_mcp',
    'agent_buildability',
    'agent_composio_toolkit_exists',
    'agent_api_surface',
    'evidence_url',
    // --- fill these in by hand; leave blank to skip a field ---
    'truth_access',
    'truth_auth_methods',
    'truth_has_mcp',
    'truth_buildability',
    'truth_composio_toolkit_exists',
    'notes',
  ];

  const lines = [header.join(',')];
  for (const p of picked) {
    lines.push(
      [
        p.app.id,
        p.app.name,
        p.app.category,
        p.reasons.slice(0, 4).join(' '),
        p.mismatch ? 'YES' : '',
        p.row.access,
        p.row.auth_methods,
        String(p.row.has_mcp),
        p.row.buildability,
        String(p.row.composio_toolkit_exists),
        p.row.api_surface,
        p.row.evidence_urls[0] ?? '',
        '',
        '',
        '',
        '',
        '',
        '',
      ]
        .map(csvCell)
        .join(','),
    );
  }

  const out = path.resolve('results/human_review.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');

  console.log(`wrote results/human_review.csv — ${picked.length} apps to review by hand\n`);
  console.log('  app                        score  why');
  for (const p of picked) {
    console.log(
      `  ${p.app.name.padEnd(26)} ${String(p.score).padStart(4)}   ${p.reasons.slice(0, 3).join(', ')}`,
    );
  }
  console.log(`\n  ${picked.filter((p) => p.mismatch).length} rows flagged: evidence domain does not match the app`);
  console.log('\nFill in the truth_* columns by hand, then run: npm run score');
}

main();
