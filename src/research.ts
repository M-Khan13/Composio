import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  getCatalogue,
  toolkitExists,
  webSearch,
  scrapePage,
  getResearchTools,
  preflight,
  type CatalogueEntry,
  type SearchHit,
} from './composio.js';
import { extract, MODEL } from './gemini.js';
import { toTristate, type AppRow, type AppSeed } from './schema.js';

/**
 * The research agent: one app in, one AppRow out.
 *
 * Pass 1 (cheap)   search snippets only -> Gemini.
 * Pass 2 (verified) search -> scrape the best doc pages -> Composio catalogue
 *                   cross-check -> Gemini -> critic re-reads the evidence and
 *                   corrects fields.
 *
 * The two passes share this one function on purpose: the accuracy comparison in
 * Phase 3 is only meaningful if the only difference is the verification steps.
 */

export const SAMPLE_IDS = ['slack', 'stripe', 'plaid', 'twenty', 'pitchbook'];

export function loadApps(): AppSeed[] {
  return JSON.parse(fs.readFileSync(path.resolve('data/apps.json'), 'utf8')) as AppSeed[];
}

// ---------------------------------------------------------------------------
// Picking which pages are worth reading
// ---------------------------------------------------------------------------

const registrable = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
  } catch {
    return '';
  }
};

/** Rank search hits by how likely they are to be authoritative developer docs. */
function rankDocUrls(hits: SearchHit[], app: AppSeed): string[] {
  const hintDomain = registrable(app.hint_url);
  const scored = hits.map((h) => {
    const url = h.url.toLowerCase();
    let host = '';
    try {
      host = new URL(h.url).hostname.toLowerCase();
    } catch {
      return { url: h.url, score: -99 };
    }
    let score = 0;
    if (/^(docs|developer|developers|api|dev)\./.test(host)) score += 4;
    if (/\/(docs|developer|developers|api|reference)(\/|$)/.test(url)) score += 3;
    if (registrable(h.url) === hintDomain) score += 3;
    if (/\bapi\b|authentication|oauth|getting-started/.test(url)) score += 2;
    if (host.endsWith('github.com')) score += 1;
    if (/pricing|plans/.test(url)) score += 1; // pricing pages decide self-serve vs gated
    if (/blog|news|press|careers|status/.test(url)) score -= 3;
    if (/reddit|medium|quora|youtube|linkedin\.com\/posts/.test(host)) score -= 4;
    return { url: h.url, score };
  });

  const ordered = scored.sort((a, b) => b.score - a.score).map((s) => s.url);
  // Always keep the seeded hint as a candidate; it's the one URL we trust a priori.
  return [...new Set([...ordered.slice(0, 4), app.hint_url])];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(app: AppSeed, hits: SearchHit[], docs: Array<{ url: string; text: string }>): string {
  const snippets = hits
    .slice(0, 8)
    .map((h, i) => `[S${i + 1}] ${h.title}\n     ${h.url}\n     ${h.snippet}`)
    .join('\n');

  const pages = docs.length
    ? docs.map((d, i) => `[DOC${i + 1}] ${d.url}\n${d.text}`).join('\n\n---\n\n')
    : '(no pages were fetched — answer from the snippets alone and lower your confidence accordingly)';

  return `App: ${app.name}
Category (already assigned, do not change): ${app.category}
Known site: ${app.hint_url}

Decide, from the evidence below, whether a developer could build an agent toolkit
on top of this product today.

Key definitions:
- access = "self-serve" when a developer can sign up alone and obtain working API
  credentials today (free or normal paid plan, no human in the loop).
- access = "trial" when only a sandbox / limited dev account is self-serve and
  production credentials need review, approval, or a paid upgrade gate.
- access = "gated" when credentials require sales contact, an application, a
  partnership, or an enterprise-only tier.
- Some entries are not SaaS APIs at all (CLI tools, open-source scripts). For
  those, auth_methods is [], api_surface says "no public API", buildability is
  "blocked" unless the tool is itself directly runnable.

SEARCH RESULTS
${snippets || '(no search results)'}

FETCHED DOCUMENTATION
${pages}

Return the JSON object required by the schema. evidence_urls must only contain
URLs that appear above.`;
}

// ---------------------------------------------------------------------------
// Critic — pass 2 only
// ---------------------------------------------------------------------------

const CRITIC_FIELDS = ['access', 'auth_methods', 'has_mcp', 'buildability', 'api_surface'] as const;

/**
 * Re-reads the primary evidence and is asked to change its mind only where the
 * evidence contradicts the first answer. Returns the corrected row plus the list
 * of fields it actually moved, so the verification step is auditable rather than
 * a black box.
 */
async function critique(
  app: AppSeed,
  draft: NonNullable<Awaited<ReturnType<typeof extract>>['extraction']>,
  docs: Array<{ url: string; text: string }>,
  toolkitNote: string,
): Promise<{ corrected: typeof draft; changed: string[]; issues: string[] }> {
  if (docs.length === 0) return { corrected: draft, changed: [], issues: ['critic-skipped-no-docs'] };

  const prompt = `You are checking another analyst's answer about ${app.name} against the source documentation.

THEIR ANSWER
${JSON.stringify(draft, null, 2)}

INDEPENDENT SIGNAL
${toolkitNote}

SOURCE DOCUMENTATION
${docs.map((d) => `[${d.url}]\n${d.text}`).join('\n\n---\n\n')}

Check each field against the documentation. Common errors to look for:
- access marked "self-serve" when the docs actually require a partnership,
  an application, an approved app review, or a sales conversation.
- access marked "gated" when a free developer signup clearly exists.
- auth_methods listing schemes the docs do not mention, or missing one they do.
- has_mcp asserted true or false when the evidence is silent (should be "unknown").

Return the full JSON object. Keep every field that was already right exactly as
it was; change only what the documentation contradicts.`;

  const { extraction, issues } = await extract(prompt);
  if (!extraction) return { corrected: draft, changed: [], issues: [...issues, 'critic-failed'] };

  const changed = CRITIC_FIELDS.filter(
    (f) => JSON.stringify(extraction[f]) !== JSON.stringify(draft[f]),
  ) as string[];
  return { corrected: extraction, changed, issues };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface ResearchOptions {
  pass?: 1 | 2;
  catalogue?: CatalogueEntry[] | null;
}

export async function researchApp(app: AppSeed, opts: ResearchOptions = {}): Promise<AppRow> {
  const pass = opts.pass ?? 2;
  const issues: string[] = [];
  const fetched_at = new Date().toISOString();

  // --- 1. search -----------------------------------------------------------
  let hits: SearchHit[] = [];
  try {
    hits = await webSearch(`${app.name} API developer documentation authentication access`);
  } catch (err) {
    issues.push(`search-failed: ${(err as Error).message.slice(0, 100)}`);
  }
  if (hits.length === 0) issues.push('no-search-results');

  // --- 2. fetch docs (pass 2 only) ----------------------------------------
  const docs: Array<{ url: string; text: string }> = [];
  if (pass === 2) {
    for (const url of rankDocUrls(hits, app).slice(0, 2)) {
      try {
        const { text, via, fallbackReason } = await scrapePage(url);
        docs.push({ url, text });
        if (via === 'fetch') issues.push(`scrape-fallback-native-fetch(${fallbackReason ?? 'unknown'})`);
      } catch (err) {
        issues.push(`scrape-failed(${registrable(url)}): ${(err as Error).message.slice(0, 80)}`);
      }
    }
    if (docs.length === 0) issues.push('no-docs-fetched');
  }

  // --- 3. Composio catalogue cross-check (pass 2 only) ---------------------
  let toolkit = { exists: 'unknown' as AppRow['composio_toolkit_exists'], slug: undefined as string | undefined };
  let toolkitNote = 'Composio catalogue was not consulted for this pass.';
  if (pass === 2) {
    const look = await toolkitExists(app.id, app.name).catch(() => ({ exists: 'unknown' as const }));
    toolkit = { exists: look.exists, slug: 'slug' in look ? look.slug : undefined };
    toolkitNote =
      look.exists === true
        ? `Composio already ships a toolkit for this app (slug "${toolkit.slug}"). That is strong evidence a working, credential-obtainable API exists.`
        : look.exists === false
          ? 'Composio does not ship a toolkit for this app. Weak negative signal only — absence is not proof there is no API.'
          : 'Composio catalogue unavailable.';
  }

  // --- 4. extract ----------------------------------------------------------
  const prompt = buildPrompt(app, hits, docs) + (pass === 2 ? `\n\nINDEPENDENT SIGNAL\n${toolkitNote}` : '');
  const { extraction, issues: modelIssues } = await extract(prompt);
  issues.push(...modelIssues);

  if (!extraction) {
    // A total failure is still a row. Dropping it would hide the finding.
    return {
      id: app.id,
      name: app.name,
      category: app.category,
      one_liner: '',
      auth_methods: [],
      access: 'gated',
      api_surface: 'unresolved',
      has_mcp: 'unknown',
      composio_toolkit_exists: toolkit.exists,
      buildability: 'blocked',
      blocker: 'research failed — not verified',
      evidence_urls: hits.slice(0, 1).map((h) => h.url),
      confidence: 'low',
      meta: { pass, issues: [...issues, 'unresolved'], fetched_at, model: MODEL },
    };
  }

  // --- 5. critic (pass 2 only) --------------------------------------------
  let final = extraction;
  let criticChanged: string[] = [];
  if (pass === 2) {
    const { corrected, changed, issues: criticIssues } = await critique(app, extraction, docs, toolkitNote);
    final = corrected;
    criticChanged = changed;
    issues.push(...criticIssues);
  }

  // Evidence we actually read outranks whatever the model echoed back.
  const evidence = [...new Set([...docs.map((d) => d.url), ...final.evidence_urls])].slice(0, 3);

  // Confidence is ours to set, not the model's to inflate.
  let confidence = final.confidence;
  if (pass === 1) confidence = confidence === 'high' ? 'med' : confidence;
  if (docs.length === 0 && pass === 2) confidence = 'low';
  if (issues.some((i) => i.startsWith('model-error') || i === 'unusable-json')) confidence = 'low';

  return {
    id: app.id,
    name: app.name,
    category: app.category,
    one_liner: final.one_liner,
    auth_methods: final.auth_methods,
    access: final.access,
    api_surface: final.api_surface,
    has_mcp: toTristate(final.has_mcp),
    composio_toolkit_exists: toolkit.exists,
    buildability: final.buildability,
    blocker: final.blocker,
    evidence_urls: evidence.length ? evidence : [app.hint_url],
    confidence,
    meta: { pass, issues, critic_changed: criticChanged, fetched_at, model: MODEL },
  };
}

// ---------------------------------------------------------------------------
// CLI — `npm run research` runs the 5-app eyeball sample
// ---------------------------------------------------------------------------

function print(row: AppRow): void {
  const flag = row.confidence === 'low' ? '  [LOW CONFIDENCE]' : '';
  console.log(`\n${'='.repeat(78)}\n${row.name}  (${row.category})${flag}`);
  console.log(`  ${row.one_liner}`);
  console.log(`  access            ${row.access}`);
  console.log(`  auth              ${row.auth_methods.join(', ') || '(none)'}`);
  console.log(`  api_surface       ${row.api_surface}`);
  console.log(`  has_mcp           ${row.has_mcp}`);
  console.log(`  composio toolkit  ${row.composio_toolkit_exists}`);
  console.log(`  buildability      ${row.buildability}`);
  console.log(`  blocker           ${row.blocker || '(none)'}`);
  console.log(`  confidence        ${row.confidence}`);
  console.log(`  evidence          ${row.evidence_urls.join('\n                    ')}`);
  if (row.meta?.critic_changed?.length) console.log(`  critic corrected  ${row.meta.critic_changed.join(', ')}`);
  if (row.meta?.issues.length) console.log(`  issues            ${row.meta.issues.join('; ')}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const ids = args.length ? args : SAMPLE_IDS;
  const apps = loadApps().filter((a) => ids.includes(a.id));
  if (apps.length === 0) throw new Error(`No apps matched: ${ids.join(', ')}`);

  const tools = await getResearchTools();
  console.log(`model: ${MODEL}`);
  console.log(`search tool: ${tools.search?.slug ?? 'NONE'}   scrape tool: ${tools.scrape?.slug ?? 'NONE (native fetch)'}`);

  // Prove the tools actually run before spending a single model call.
  await preflight();
  console.log('preflight: composio search executes OK');

  const catalogue = await getCatalogue().catch(() => null);
  console.log(`composio catalogue: ${catalogue?.length ?? 0} toolkits\n`);

  const rows: AppRow[] = [];
  for (const app of apps) {
    process.stdout.write(`researching ${app.name}...`);
    const row = await researchApp(app, { catalogue });
    process.stdout.write(' done\n');
    rows.push(row);
  }

  rows.forEach(print);

  fs.mkdirSync(path.resolve('results'), { recursive: true });
  fs.writeFileSync(path.resolve('results/sample.json'), JSON.stringify(rows, null, 2));
  console.log(`\n${'='.repeat(78)}\nwrote results/sample.json (${rows.length} rows)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('\nFATAL:', err.message);
    process.exit(1);
  });
}
