import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Composio } from '@composio/core';
import type { Tristate } from './schema.js';

/**
 * Everything that talks to Composio lives here.
 *
 * Two jobs:
 *   1. Give the research agent its hands — a web search tool and a page-scrape
 *      tool, both executed through Composio.
 *   2. Answer "does Composio already ship a toolkit for this app?", which is our
 *      near-ground-truth signal for buildability.
 *
 * Nothing here hardcodes a tool slug. The Composio catalogue changes; the SDK
 * ships a stub for its generated toolkit enum, so the honest move is to list
 * what the account can actually see at runtime and pick from it.
 */

const CACHE_DIR = path.resolve('.cache'); // gitignored
const CATALOGUE_CACHE = path.join(CACHE_DIR, 'toolkits.json');
const LOOKUP_CACHE = path.join(CACHE_DIR, 'toolkit-lookups.json');
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The list endpoint hard-caps at 1000 toolkits no matter what limit you pass,
 * and returns a bare array with no cursor, so there is no way to page past it.
 * Composio publishes more than that, so the list is a *sample*, not the
 * catalogue. Verified empirically: `telegram` and `front` both exist but are
 * absent from the first 1000. Hence per-app lookups go through
 * `toolkitExists()` below, which asks about one slug at a time and is exact.
 */
const CATALOGUE_LIST_CAP = 1000;

export const USER_ID = process.env.COMPOSIO_USER_ID ?? 'default';

let _composio: Composio | null = null;

export function composio(): Composio {
  if (_composio) return _composio;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error('COMPOSIO_API_KEY is missing. Copy .env.example to .env and fill it in.');
  _composio = new Composio({ apiKey });
  return _composio;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogueEntry {
  slug: string;
  name: string;
  description?: string;
  toolsCount?: number;
}

/**
 * A large sample of the Composio catalogue, cached to disk for a day. Used for
 * discovery and diagnostics only — see CATALOGUE_LIST_CAP for why this cannot
 * be trusted as a complete list.
 */
export async function getCatalogue(force = false): Promise<CatalogueEntry[]> {
  if (!force && fs.existsSync(CATALOGUE_CACHE)) {
    const stat = fs.statSync(CATALOGUE_CACHE);
    if (Date.now() - stat.mtimeMs < CATALOGUE_TTL_MS) {
      return JSON.parse(fs.readFileSync(CATALOGUE_CACHE, 'utf8')) as CatalogueEntry[];
    }
  }

  const out: CatalogueEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  // The SDK types the response as a bare array, but the wire format may still
  // carry a cursor. Handle both rather than assuming.
  for (let page = 0; page < 40; page++) {
    const raw: unknown = await composio().toolkits.get({
      limit: CATALOGUE_LIST_CAP,
      ...(cursor ? { cursor } : {}),
    });
    const asObj = raw as { items?: unknown[]; nextCursor?: string | null };
    const items = (Array.isArray(raw) ? raw : (asObj.items ?? [])) as Array<{
      slug?: string;
      name?: string;
      meta?: { description?: string; toolsCount?: number };
    }>;

    for (const it of items) {
      if (!it?.slug || seen.has(it.slug)) continue;
      seen.add(it.slug);
      out.push({
        slug: it.slug,
        name: it.name ?? it.slug,
        description: it.meta?.description,
        toolsCount: it.meta?.toolsCount,
      });
    }

    const next = Array.isArray(raw) ? undefined : (asObj.nextCursor ?? undefined);
    if (!next || items.length === 0) break;
    cursor = next;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CATALOGUE_CACHE, JSON.stringify(out, null, 2));
  return out;
}

/** "Monday.com" -> "mondaycom", "zoho_crm" -> "zohocrm". Slugs and names into one keyspace. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Slug spellings to try for one app, in order.
 *
 * The dataset name rarely equals the Composio slug: "Help Scout" -> "helpscout",
 * "Zoho CRM" -> "zoho_crm" or "zoho", "Lark (Larksuite)" -> "lark". Rather than
 * guess one transformation, try the plausible ones and let the API adjudicate.
 */
function candidateSlugs(id: string, name: string): string[] {
  const parts = [id, name];
  const paren = name.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (paren) parts.push(paren[1], paren[2]);

  const out: string[] = [];
  for (const p of parts) {
    const words = p.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    out.push(words.join('_'), words.join(''), words[0]);
  }
  return [...new Set(out)];
}

export interface ToolkitLookup {
  exists: Tristate;
  /** The matching Composio slug, when there is one. Kept for the evidence trail. */
  slug?: string;
  toolsCount?: number;
}

type LookupCache = Record<string, ToolkitLookup>;

function readLookupCache(): LookupCache {
  try {
    return JSON.parse(fs.readFileSync(LOOKUP_CACHE, 'utf8')) as LookupCache;
  } catch {
    return {};
  }
}

function writeLookupCache(cache: LookupCache): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(LOOKUP_CACHE, JSON.stringify(cache, null, 2));
}

/**
 * Does Composio already ship a toolkit for this app?
 *
 * Asks the API about one slug at a time, because the list endpoint is capped and
 * would report false negatives for anything past its cut-off. A miss on every
 * candidate spelling is a real `false`; only a transport failure yields
 * 'unknown', so a network blip never masquerades as "no toolkit exists".
 */
export async function toolkitExists(id: string, name: string): Promise<ToolkitLookup> {
  const cacheKey = `${id}::${name}`;
  const cache = readLookupCache();
  if (cache[cacheKey]) return cache[cacheKey];

  let sawTransportError = false;
  let result: ToolkitLookup = { exists: false };

  for (const slug of candidateSlugs(id, name)) {
    try {
      const tk = (await composio().toolkits.get(slug)) as { slug?: string; meta?: { toolsCount?: number } };
      if (tk?.slug) {
        result = { exists: true, slug: tk.slug, toolsCount: tk.meta?.toolsCount };
        break;
      }
    } catch (err) {
      // The SDK collapses "no such toolkit" and "request failed" into one
      // ComposioToolkitFetchError ("Couldn't fetch Toolkit with slug: x"), so
      // the message is the only discriminator available. That code is treated as
      // a genuine absence; anything else (auth, network, rate limit) means we
      // never got an answer and must not be recorded as `false`.
      const e = err as { code?: string; message?: string };
      const isAbsence =
        e.code === 'TS-SDK::TOOLKIT_FETCH_ERROR' ||
        /couldn't fetch toolkit|not found|404|does not exist/i.test(e.message ?? '');
      if (!isAbsence) sawTransportError = true;
    }
  }

  if (result.exists === false && sawTransportError) result = { exists: 'unknown' };

  cache[cacheKey] = result;
  writeLookupCache(cache);
  return result;
}

/** Fuzzy match against the cached catalogue sample. Diagnostics only. */
export function lookupToolkitInCatalogue(catalogue: CatalogueEntry[] | null, id: string, name: string): ToolkitLookup {
  if (!catalogue?.length) return { exists: 'unknown' };
  const bySlug = new Map(catalogue.map((t) => [norm(t.slug), t]));
  const byName = new Map(catalogue.map((t) => [norm(t.name), t]));
  for (const key of candidateSlugs(id, name).map(norm)) {
    const hit = bySlug.get(key) ?? byName.get(key);
    if (hit) return { exists: true, slug: hit.slug, toolsCount: hit.toolsCount };
  }
  return { exists: false };
}

// ---------------------------------------------------------------------------
// Tool discovery — find a search tool and a scrape tool this account can run
// ---------------------------------------------------------------------------

/**
 * Exact tool slugs, best first.
 *
 * An earlier version matched tool slugs by regex and picked
 * COMPOSIO_SEARCH_AMAZON (product search) and FIRECRAWL_AGENT_CANCEL — both
 * matched the pattern, neither does the job. Naming a shortlist and verifying it
 * against the live catalogue beats pattern-matching; the regex below is only the
 * fallback for accounts that have none of these.
 */
const SEARCH_TOOL_PREFS = [
  'COMPOSIO_SEARCH_WEB',
  'COMPOSIO_SEARCH_TAVILY',
  'TAVILY_SEARCH',
  'EXA_SEARCH',
  'PERPLEXITYAI_PERPLEXITY_AI_SEARCH',
  'COMPOSIO_SEARCH_DUCK_DUCK_GO',
  'FIRECRAWL_SEARCH',
];
/**
 * Fetch-url-content comes first because `composio_search` is a managed toolkit
 * that runs without a connected account. Firecrawl needs one ("No connected
 * account found for user ID default for toolkit firecrawl"), so preferring it
 * silently pushed every page fetch onto the native-fetch fallback.
 */
const SCRAPE_TOOL_PREFS = [
  'COMPOSIO_SEARCH_FETCH_URL_CONTENT',
  'FIRECRAWL_SCRAPE',
  'FIRECRAWL_EXTRACT',
  'BROWSERLESS_SCRAPE',
];

/** Toolkits to sweep when none of the preferred slugs are available. */
const SEARCH_TOOLKITS = ['composio_search', 'exa', 'tavily', 'perplexityai', 'serpapi', 'firecrawl'];
const SCRAPE_TOOLKITS = ['firecrawl', 'composio_search', 'browserless', 'browserbase_tool', 'apify'];

export interface ResolvedTool {
  slug: string;
  toolkit: string;
  /** The input property this tool wants the query / url in. Read off its schema. */
  argName: string;
  /** True when the arg is an array (e.g. fetch-url-content takes `urls: string[]`). */
  argIsArray: boolean;
  /** Optional tuning args the tool advertises, e.g. `max_characters`. */
  extraArgs?: Record<string, unknown>;
}

interface RawTool {
  slug: string;
  description?: string;
  inputParameters?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

/** Pick the input property to put our value in, preferring named candidates. */
function pickArg(
  tool: RawTool,
  prefer: string[],
): { argName: string; argIsArray: boolean; extraArgs?: Record<string, unknown> } | null {
  const props = tool.inputParameters?.properties ?? {};
  const names = Object.keys(props);

  // Ask for a generous body when the tool lets us; the default can be ~2KB,
  // which is far too little to judge auth and access from.
  const extraArgs = names.includes('max_characters') ? { max_characters: 20000 } : undefined;

  for (const want of prefer) {
    const hit = names.find((n) => n.toLowerCase() === want);
    if (hit) return { argName: hit, argIsArray: props[hit]?.type === 'array', extraArgs };
  }
  // Fall back to the first required string/array property.
  for (const req of tool.inputParameters?.required ?? []) {
    const t = props[req]?.type;
    if (t === 'string' || t === 'array') return { argName: req, argIsArray: t === 'array', extraArgs };
  }
  return null;
}

/** Try the named tools directly; the API tells us which of them this account has. */
async function resolvePreferred(prefs: string[], argPrefs: string[]): Promise<ResolvedTool | null> {
  let tools: RawTool[];
  try {
    tools = (await composio().tools.getRawComposioTools({ tools: prefs })) as RawTool[];
  } catch {
    return null;
  }
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  for (const want of prefs) {
    const tool = bySlug.get(want);
    if (!tool) continue;
    const arg = pickArg(tool, argPrefs);
    if (arg) return { slug: tool.slug, toolkit: want.split('_')[0].toLowerCase(), ...arg };
  }
  return null;
}

async function resolveTool(
  toolkitPrefs: string[],
  catalogue: CatalogueEntry[],
  slugMatches: (slug: string) => boolean,
  argPrefs: string[],
): Promise<ResolvedTool | null> {
  const have = new Set(catalogue.map((t) => t.slug.toLowerCase()));
  for (const tk of toolkitPrefs) {
    if (!have.has(tk)) continue;
    let tools: RawTool[];
    try {
      tools = (await composio().tools.getRawComposioTools({ toolkits: [tk], limit: 100 })) as RawTool[];
    } catch {
      continue;
    }
    const match = tools.filter((t) => slugMatches(t.slug));
    for (const t of match) {
      const arg = pickArg(t, argPrefs);
      if (arg) return { slug: t.slug, toolkit: tk, ...arg };
    }
  }
  return null;
}

const isSearchTool = (slug: string) => {
  const s = slug.toUpperCase();
  if (!/SEARCH|ANSWER|QUERY/.test(s)) return false;
  // Skip the vertical searches — we want plain web results.
  return !/NEWS|IMAGE|SHOPPING|EVENT|FINANCE|SCHOLAR|TRENDS|JOB|MAP|VIDEO|LENS/.test(s);
};
const isScrapeTool = (slug: string) => /SCRAPE|EXTRACT|CRAWL|MARKDOWN|CONTENT/.test(slug.toUpperCase());

let _tools: { search: ResolvedTool | null; scrape: ResolvedTool | null } | null = null;

/** Resolve both tools once per process. Env vars override if you want to pin one. */
export async function getResearchTools(): Promise<{ search: ResolvedTool | null; scrape: ResolvedTool | null }> {
  if (_tools) return _tools;
  const catalogue = await getCatalogue();

  /**
   * An env override must name a full *action* slug (COMPOSIO_SEARCH_WEB), not an
   * app name (TAVILY). Rather than fail the whole run on a typo, verify the slug
   * against the API, read its real arg name, and fall through to auto-resolution
   * with a loud warning if it isn't a real tool.
   */
  const pinned = async (slug: string | undefined, argPrefs: string[]): Promise<ResolvedTool | null> => {
    if (!slug) return null;
    const resolved = await resolvePreferred([slug], argPrefs);
    if (resolved) return resolved;
    console.warn(
      `[warn] "${slug}" is not a runnable tool slug on this account — ignoring it and auto-resolving instead.\n` +
        `       Env overrides need the full action slug (e.g. COMPOSIO_SEARCH_WEB, FIRECRAWL_SCRAPE), not the app name.`,
    );
    return null;
  };

  const searchArgs = ['query', 'q', 'search_query', 'keyword'];
  const scrapeArgs = ['url', 'urls', 'link', 'website_url'];

  const search =
    (await pinned(process.env.SEARCH_TOOL_SLUG, searchArgs)) ??
    (await resolvePreferred(SEARCH_TOOL_PREFS, searchArgs)) ??
    (await resolveTool(SEARCH_TOOLKITS, catalogue, isSearchTool, searchArgs));

  const scrape =
    (await pinned(process.env.SCRAPE_TOOL_SLUG, scrapeArgs)) ??
    (await resolvePreferred(SCRAPE_TOOL_PREFS, scrapeArgs)) ??
    (await resolveTool(SCRAPE_TOOLKITS, catalogue, isScrapeTool, scrapeArgs));

  _tools = { search, scrape };
  return _tools;
}

// ---------------------------------------------------------------------------
// Toolkit versions
// ---------------------------------------------------------------------------

/**
 * `tools.execute` refuses to run without an explicit toolkit version — it does
 * not default to the newest one ("Toolkit version not specified. For manual
 * execution of the tool please pass a specific toolkit version"). So resolve the
 * newest published version per toolkit and pin it for the whole run: pinning
 * also means a mid-run release can't change what the agent sees.
 */
const versionCache = new Map<string, string | undefined>();

/**
 * A tool slug does not reveal its toolkit by simple truncation:
 * COMPOSIO_SEARCH_WEB belongs to `composio_search`, not `composio`, while
 * FIRECRAWL_SCRAPE belongs to `firecrawl`. The Tool object carries no toolkit
 * field, so try the longest prefix first and let the API confirm which exists.
 */
function toolkitCandidates(toolSlug: string): string[] {
  const parts = toolSlug.toLowerCase().split('_');
  const out: string[] = [];
  for (let n = parts.length - 1; n >= 1; n--) out.push(parts.slice(0, n).join('_'));
  return out;
}

async function toolkitVersion(tool: ResolvedTool): Promise<string | undefined> {
  const key = tool.slug;
  if (versionCache.has(key)) return versionCache.get(key);

  let version: string | undefined;
  for (const candidate of toolkitCandidates(tool.slug)) {
    try {
      const tk = (await composio().toolkits.get(candidate)) as { meta?: { availableVersions?: string[] } };
      // The API returns these newest-first.
      const versions = tk?.meta?.availableVersions;
      if (versions?.length) {
        version = versions[0];
        tool.toolkit = candidate; // remember the real toolkit for diagnostics
        break;
      }
    } catch {
      // candidate isn't a toolkit; try the next shorter prefix
    }
  }

  versionCache.set(key, version);
  return version;
}

/** Execute a Composio tool with its toolkit version pinned. */
async function runTool(tool: ResolvedTool, args: Record<string, unknown>) {
  const version = await toolkitVersion(tool);
  return composio().tools.execute(tool.slug, {
    userId: USER_ID,
    arguments: args,
    ...(version ? { version } : {}),
  });
}

/**
 * Fail fast if the agent's hands don't work.
 *
 * Without this, a permissions or connection problem degrades into "no search
 * results", and the model answers from prior knowledge instead — producing rows
 * that look plausible and cite nothing. That is the single most dangerous
 * failure mode in this project, so it aborts the run rather than continuing.
 */
export async function preflight(): Promise<void> {
  const { search, scrape } = await getResearchTools();
  if (!search) throw new Error('No Composio search tool could be resolved on this account.');

  try {
    const res = await runTool(search, { [search.argName]: search.argIsArray ? ['test query'] : 'test query' });
    if (!res.successful) throw new Error(res.error ?? 'unknown error');
  } catch (err) {
    const meta = (err as { meta?: { status?: number; error?: unknown } }).meta;
    // The useful text can sit on .meta, .cause, or only in the message, and some
    // of those properties are non-enumerable — so flatten everything we can see.
    const e = err as Record<string, unknown>;
    const detail = [
      (err as Error).message,
      JSON.stringify(meta ?? {}),
      JSON.stringify(e.cause ?? {}),
      JSON.stringify(e.response ?? {}),
      JSON.stringify(Object.getOwnPropertyNames(e).reduce<Record<string, unknown>>((a, k) => ((a[k] = e[k]), a), {})),
    ].join(' ');

    const hint = /tool_execution/.test(detail)
      ? '\n\n  FIX: your COMPOSIO_API_KEY lacks "tool_execution" write access.\n' +
        '       In app.composio.dev -> Settings -> API Keys, create a key with tool execution\n' +
        '       enabled (or enable it on the existing key), then update .env.'
      : /connected account|no connection|not connected/i.test(detail)
        ? `\n\n  FIX: no connected account for "${search.toolkit}". Connect it in app.composio.dev.`
        : '';
    throw new Error(
      `Composio search tool "${search.slug}" cannot execute — the agent has no working hands.` +
        `\n  ${(err as Error).message}` +
        (meta?.status ? `\n  HTTP ${meta.status}` : '') +
        hint +
        `\n\n  Refusing to continue: without search, results would come from model memory, not evidence.`,
    );
  }

  if (!scrape) console.warn('[warn] No Composio scrape tool resolved — falling back to native fetch for page content.');
}

// ---------------------------------------------------------------------------
// The two operations the agent actually uses
// ---------------------------------------------------------------------------

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Pull {title,url,snippet}-ish objects out of whatever shape the tool returned. */
function harvestHits(node: unknown, out: SearchHit[], depth = 0): void {
  if (depth > 6 || out.length >= 12 || node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) harvestHits(n, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const url = [o.url, o.link, o.href, o.source_url].find((v) => typeof v === 'string' && /^https?:\/\//.test(v));
  if (url) {
    const title = [o.title, o.name, o.heading].find((v) => typeof v === 'string') as string | undefined;
    const snippet = [o.snippet, o.description, o.content, o.text, o.summary].find(
      (v) => typeof v === 'string',
    ) as string | undefined;
    out.push({
      title: title ?? '',
      url: url as string,
      snippet: (snippet ?? '').replace(/\s+/g, ' ').slice(0, 600),
    });
  }
  for (const v of Object.values(o)) harvestHits(v, out, depth + 1);
}

export async function webSearch(query: string): Promise<SearchHit[]> {
  const { search } = await getResearchTools();
  if (!search) throw new Error('No Composio search tool available on this account. Run `npm run discover`.');

  const res = await runTool(search, { [search.argName]: search.argIsArray ? [query] : query });
  if (!res.successful) throw new Error(`search failed (${search.slug}): ${res.error ?? 'unknown error'}`);

  const hits: SearchHit[] = [];
  harvestHits(res.data, hits);
  // De-dupe by URL, keep first (highest ranked) occurrence.
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(h.url) && seen.add(h.url)).slice(0, 8);
}

/** Very small HTML -> text reducer for the native-fetch fallback path. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dig the longest text blob out of a scrape response of unknown shape. */
function harvestText(node: unknown, depth = 0): string {
  if (depth > 6 || node == null) return '';
  if (typeof node === 'string') return node.length > 200 ? node : '';
  if (Array.isArray(node)) return node.map((n) => harvestText(n, depth + 1)).sort((a, b) => b.length - a.length)[0] ?? '';
  if (typeof node !== 'object') return '';
  const o = node as Record<string, unknown>;
  for (const key of ['markdown', 'content', 'text', 'html', 'raw_content', 'body']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 200) return key === 'html' ? htmlToText(v) : v;
  }
  return Object.values(o)
    .map((v) => harvestText(v, depth + 1))
    .sort((a, b) => b.length - a.length)[0] ?? '';
}

export interface ScrapeResult {
  text: string;
  /** How we got it. Recorded on the row so the evidence trail stays honest. */
  via: 'composio' | 'fetch';
  /** Why Composio was bypassed, when it was. Never swallowed silently. */
  fallbackReason?: string;
}

/**
 * Fetch a page as text. Composio's scrape toolkit first; plain fetch as a
 * documented fallback so a missing/unconnected scrape toolkit degrades the run
 * instead of killing it. The route taken is recorded, never hidden.
 */
export async function scrapePage(url: string, maxChars = 18000): Promise<ScrapeResult> {
  const { scrape } = await getResearchTools();
  let fallbackReason: string | undefined;

  if (scrape) {
    try {
      const res = await runTool(scrape, {
        [scrape.argName]: scrape.argIsArray ? [url] : url,
        ...(scrape.extraArgs ?? {}),
      });
      if (res.successful) {
        const text = harvestText(res.data).replace(/\s+/g, ' ').trim();
        if (text.length > 200) return { text: text.slice(0, maxChars), via: 'composio' };
        fallbackReason = `composio returned ${text.length} chars`;
      } else {
        fallbackReason = res.error ?? 'composio tool reported failure';
      }
    } catch (err) {
      const cause = JSON.stringify((err as { cause?: unknown }).cause ?? {});
      fallbackReason = /ConnectedAccountNotFound|No connected account/.test(cause)
        ? `no connected account for toolkit "${scrape.toolkit}"`
        : (err as Error).message?.slice(0, 90);
    }
  } else {
    fallbackReason = 'no composio scrape tool resolved';
  }

  const ctrl = AbortSignal.timeout(20_000);
  const r = await fetch(url, {
    signal: ctrl,
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; api-research-agent/0.1)' },
  });
  if (!r.ok) throw new Error(`fetch ${r.status} for ${url}`);
  const text = htmlToText(await r.text());
  if (text.length < 200) throw new Error(`page too thin after extraction: ${url}`);
  return { text: text.slice(0, maxChars), via: 'fetch', fallbackReason };
}
