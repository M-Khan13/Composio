import { Type, type Schema } from '@google/genai';

/**
 * One researched app. This is the unit of the whole project: one row per app,
 * 100 rows total, written to results/rows.json and rendered by site/index.html.
 */
export interface AppRow {
  /** Stable slug from data/apps.json. Join key across passes, never model-generated. */
  id: string;
  /** Display name from data/apps.json, not model-generated. */
  name: string;
  /** Pre-assigned in data/apps.json so category counts can't drift between passes. */
  category: string;

  /** One sentence, what the product is. */
  one_liner: string;
  /** e.g. ["oauth2", "api-key"]. Free-form strings, normalised in analysis. */
  auth_methods: string[];
  /** Can a solo dev get working credentials today? The judgement field. */
  access: Access;
  /** Shape + rough breadth of the public API, one sentence. */
  api_surface: string;
  /** Is there a documented MCP server (first- or notable third-party)? */
  has_mcp: Tristate;
  /** Does Composio already ship a toolkit for this app? Filled by SDK, not the model. */
  composio_toolkit_exists: Tristate;
  /** Could this become an agent toolkit today? */
  buildability: Buildability;
  /** The single main thing standing in the way. "" when nothing does. */
  blocker: string;
  /** URLs the answer is actually grounded in. First one is the primary citation. */
  evidence_urls: string[];
  /** How much the row should be trusted. Downgraded on retries/failures. */
  confidence: Confidence;

  /** Run metadata — not part of the model's output. */
  meta?: RowMeta;
}

export const ACCESS = ['self-serve', 'trial', 'gated'] as const;
export type Access = (typeof ACCESS)[number];

export const BUILDABILITY = ['easy', 'needs-outreach', 'blocked'] as const;
export type Buildability = (typeof BUILDABILITY)[number];

export const CONFIDENCE = ['high', 'med', 'low'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** Booleans are three-valued on purpose: "we looked and found nothing" != false. */
export type Tristate = boolean | 'unknown';

export interface RowMeta {
  /** 1 = search-snippets only (cheap), 2 = full fetch + catalogue + critic. */
  pass: 1 | 2;
  /** Non-fatal problems: "no-docs-found", "scrape-failed", "bad-json-retried". */
  issues: string[];
  /** Whether the critic step changed any field, and which. */
  critic_changed?: string[];
  fetched_at: string;
  model: string;
}

/** The input list in data/apps.json. */
export interface AppSeed {
  id: string;
  name: string;
  hint_url: string;
  category: string;
}

/**
 * Structured-output schema handed to Gemini. Deliberately narrower than AppRow:
 * the model is only asked for the fields it can actually read off a page.
 * id / name / category / composio_toolkit_exists are filled by us, not by it.
 */
export const EXTRACTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    one_liner: {
      type: Type.STRING,
      description: 'One sentence describing what this product does. No marketing language.',
    },
    auth_methods: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Auth mechanisms the public API accepts, lowercase, e.g. "oauth2", "api-key", "personal-access-token", "basic", "jwt", "mtls", "none". Empty array if there is no public API.',
    },
    access: {
      type: Type.STRING,
      enum: [...ACCESS],
      description:
        '"self-serve" if a developer can sign up and get working API credentials alone, today, for free or on a normal paid plan. "trial" if only a time-limited sandbox or dev account is self-serve and production needs approval. "gated" if credentials require sales contact, partnership, an application, or an enterprise-only tier.',
    },
    api_surface: {
      type: Type.STRING,
      description:
        'One sentence: protocol (REST/GraphQL/SOAP/SDK-only/none) and rough breadth (e.g. "broad REST API, ~40 resources"). Say "no public API" if there is none.',
    },
    has_mcp: {
      type: Type.STRING,
      enum: ['true', 'false', 'unknown'],
      description:
        'true only if a Model Context Protocol server for this app is documented by the vendor or a well-known project. "unknown" if the evidence does not say.',
    },
    buildability: {
      type: Type.STRING,
      enum: [...BUILDABILITY],
      description:
        '"easy" = a usable agent toolkit could be built today with self-serve credentials. "needs-outreach" = the API exists but access requires a partnership, approval, or a sales conversation. "blocked" = no usable public API at all.',
    },
    blocker: {
      type: Type.STRING,
      description:
        'The single main obstacle, under 15 words. Empty string if there is none.',
    },
    evidence_urls: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Up to 3 URLs actually seen in the provided evidence that support this answer. Most authoritative (official developer docs) first. Never invent a URL.',
    },
    confidence: {
      type: Type.STRING,
      enum: [...CONFIDENCE],
      description:
        '"high" only if official developer docs were read. "med" if inferred from partial or third-party evidence. "low" if guessing.',
    },
  },
  required: [
    'one_liner',
    'auth_methods',
    'access',
    'api_surface',
    'has_mcp',
    'buildability',
    'blocker',
    'evidence_urls',
    'confidence',
  ],
  propertyOrdering: [
    'one_liner',
    'auth_methods',
    'access',
    'api_surface',
    'has_mcp',
    'buildability',
    'blocker',
    'evidence_urls',
    'confidence',
  ],
};

/** What Gemini returns, before we merge in the fields we own. */
export interface Extraction {
  one_liner: string;
  auth_methods: string[];
  access: Access;
  api_surface: string;
  has_mcp: 'true' | 'false' | 'unknown';
  buildability: Buildability;
  blocker: string;
  evidence_urls: string[];
  confidence: Confidence;
}

export function toTristate(v: string | boolean | undefined): Tristate {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return 'unknown';
}

/**
 * Guards against a model that returns valid JSON with out-of-range values.
 * Anything unrecognised falls back to the most conservative option rather
 * than throwing, so one bad row can never kill a 100-app run.
 */
export function coerceExtraction(raw: unknown): Extraction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()) : [];

  if (typeof r.one_liner !== 'string' || r.one_liner.trim() === '') return null;

  return {
    one_liner: r.one_liner.trim(),
    auth_methods: strArray(r.auth_methods).map((s) => s.toLowerCase()),
    access: oneOf(r.access, ACCESS, 'gated'),
    api_surface: typeof r.api_surface === 'string' ? r.api_surface.trim() : 'unknown',
    has_mcp: oneOf(r.has_mcp, ['true', 'false', 'unknown'] as const, 'unknown'),
    buildability: oneOf(r.buildability, BUILDABILITY, 'needs-outreach'),
    blocker: typeof r.blocker === 'string' ? r.blocker.trim() : '',
    evidence_urls: strArray(r.evidence_urls).filter((u) => /^https?:\/\//i.test(u)).slice(0, 3),
    confidence: oneOf(r.confidence, CONFIDENCE, 'low'),
  };
}

/** Fields scored in the accuracy report (Phase 3). Order is the report order. */
export const SCORED_FIELDS = [
  'access',
  'auth_methods',
  'has_mcp',
  'buildability',
  'composio_toolkit_exists',
] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];
