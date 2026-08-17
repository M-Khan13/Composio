import 'dotenv/config';
import { getCatalogue, getResearchTools, composio, toolkitExists } from './composio.js';
import { loadApps } from './research.js';

/**
 * Diagnostic, not part of the pipeline.
 *
 * Prints what this Composio account can actually see: how big the catalogue is,
 * which search/scrape tools were resolved, and how many of our 100 apps already
 * have a Composio toolkit. Run this first when something looks wrong.
 */
async function main(): Promise<void> {
  const catalogue = await getCatalogue(true);
  console.log(`catalogue: ${catalogue.length} toolkits\n`);

  const SEARCHY = /search|exa|tavily|perplexity|serp|brave|firecrawl|scrape|crawl|browser|apify|spider/i;
  console.log('search/scrape-capable toolkits visible to this account:');
  for (const t of catalogue.filter((c) => SEARCHY.test(c.slug) || SEARCHY.test(c.name))) {
    console.log(`  ${t.slug.padEnd(24)} ${t.name}  (${t.toolsCount ?? '?'} tools)`);
  }

  const { search, scrape } = await getResearchTools();
  console.log('\nresolved tools:');
  console.log(`  search  ${search ? `${search.slug}  arg="${search.argName}"${search.argIsArray ? '[]' : ''}` : 'NONE'}`);
  console.log(`  scrape  ${scrape ? `${scrape.slug}  arg="${scrape.argName}"${scrape.argIsArray ? '[]' : ''}` : 'NONE — will use native fetch'}`);

  if (search) {
    const tools = await composio().tools.getRawComposioTools({ toolkits: [search.toolkit], limit: 100 });
    console.log(`\n  tools in "${search.toolkit}": ${tools.map((t) => t.slug).join(', ')}`);
  }

  // Authoritative per-app lookup. Slower than scanning the cached list, but the
  // list endpoint is capped at 1000 and would invent false negatives.
  const apps = loadApps();
  const hits: Array<{ app: (typeof apps)[number]; look: Awaited<ReturnType<typeof toolkitExists>> }> = [];
  for (const a of apps) hits.push({ app: a, look: await toolkitExists(a.id, a.name) });

  const found = hits.filter((h) => h.look.exists === true);
  console.log(`\ncomposio toolkit coverage of our 100 apps: ${found.length}/${apps.length}`);
  console.log('\nno toolkit (candidates for "needs outreach"):');
  for (const h of hits.filter((x) => x.look.exists === false)) console.log(`  ${h.app.name}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
