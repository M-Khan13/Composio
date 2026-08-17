# Can you build an agent toolkit for it?

An agent that researches 100 SaaS apps and answers one question per app: **could a
developer turn this into an agent toolkit today, and if not, what's in the way?**

For each app it captures the category, a one-line description, auth method(s),
whether credentials are self-serve or gated, the API surface, whether a Composio
toolkit already exists, a buildability verdict with its main blocker, and an
evidence URL. Then it finds the patterns across all 100, and measures its own
accuracy against a hand-checked sample.

**The output is [`site/index.html`](site/index.html)** — one self-contained page
with the findings, the full matrix, and an honest accuracy report.

## What it found

- **85% are self-serve**, but access is bimodal: 4 of 10 categories are *entirely*
  open, while gating concentrates in Finance/Fintech and AI/Research (40% each).
- **Gating is relational, not commercial.** The leading blocker is *partnership
  required* — only 1 of 15 blocked apps is simply "contact sales."
- **Composio already covers 61%**, and coverage tracks how *new* a category is
  (Productivity 90%, AI/Research 30%) rather than how hard its APIs are.
- **31 apps are self-serve, easy, and have no toolkit yet** — Twilio, Netlify,
  Clay, Plaid, MongoDB Atlas among them.

## Honest caveats

- **`access` is the least reliable field**, and the verification pass made it
  *worse* (−6pp). Judging whether a company will really let you self-serve is not
  a fact printed in the docs. That field needs a human.
- **The model reported `confidence: high` on all 100 rows.** Self-reported
  confidence did not discriminate and should not be trusted.
- The accuracy sample is deliberately weighted toward hard cases, so the numbers
  are worst-case, not average.
- Composio toolkit visibility is scoped to the API key used — a strong signal,
  not a universal constant.

## Stack

| | |
|---|---|
| **Runtime** | Node 20+, TypeScript, `tsx` |
| **Agent tools** | [`@composio/core`](https://docs.composio.dev) — `COMPOSIO_SEARCH_WEB` for search, `COMPOSIO_SEARCH_FETCH_URL_CONTENT` for page fetch, and the toolkit catalogue as a ground-truth signal |
| **Extraction** | Gemini (`gemini-3.5-flash-lite`) with a strict `responseSchema` |
| **Output** | Static HTML, no framework, no external requests |

Tool slugs are **resolved from the live Composio catalogue at runtime**, never
hardcoded — the SDK ships its generated toolkit enum as an empty stub, so the
account's real catalogue is the only reliable source.

## Run it

**1. Install and configure**

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```
COMPOSIO_API_KEY=...    # app.composio.dev → Settings → API Keys
GEMINI_API_KEY=...      # aistudio.google.com/apikey
```

> The Composio key **must have `tool_execution` write access**, or the agent
> can't run its own tools. `npm run discover` will tell you if it doesn't.

**2. Check your account can actually do the work**

```bash
npm run discover        # what your key sees; which search/scrape tools resolve
npm run research        # 5-app sample (Slack, Stripe, Plaid, Twenty, PitchBook)
```

**3. Research all 100 apps** (~45–70 min, rate-limited; resumable — rerun to
continue, it checkpoints after every app)

```bash
npm run run:all                  # pass 2: fetch + catalogue + critic → results/rows.json
npm run run:all -- --pass=1      # pass 1: snippets only    → results/rows_pass1.json
```

**4. Verify accuracy** — generate the review sheet, fill in the `truth_*` columns
by hand, then score it

```bash
npm run sample          # → results/human_review.csv  (18 apps, blank truth columns)
npm run score           # → results/accuracy.json     (pass 1 vs pass 2, per field)
```

**5. Analyse and build the page**

```bash
npm run analyze         # → results/patterns.json
npm run build:site      # → site/index.html
npm run site            # serve it locally
```

To get the repo and live-site links right on the page:

```bash
REPO_URL=https://github.com/you/this-repo SITE_URL=https://your-site.vercel.app npm run build:site
```

## How the agent works

1. **Search** — Composio's search tool finds candidate developer docs.
2. **Rank** — URLs are scored for authority (`docs.`/`developer.` subdomains,
   matching domain, `/api` paths) before anything is fetched.
3. **Fetch** — the top pages are pulled through Composio and reduced to text.
4. **Extract** — Gemini returns one row constrained by a JSON schema. Bad values
   fall back to the conservative option; a bad row never breaks the batch.
5. **Cross-check** — each app is looked up by slug in Composio's catalogue.
   A shipped toolkit is near-proof that a credential-obtainable API exists.
6. **Criticise** — a second pass re-reads the docs and corrects contradicted
   fields. It changed at least one field on 22 of 100 rows.

A **preflight** executes one real search before any model call and aborts the run
if the tools don't work. This exists because an early version silently degraded to
model memory when Composio returned 403 and produced five confident, plausible,
completely unearned rows.

## Layout

```
data/apps.json          the 100 apps (id, name, hint_url, category)
src/schema.ts           row type + Gemini response schema
src/composio.ts         tool resolution, search, fetch, catalogue lookup
src/gemini.ts           structured extraction, backoff, quota handling
src/research.ts         one app → one row (both passes)
src/runAll.ts           batch runner, resumable
src/makeReviewSample.ts builds the human-review CSV
src/scoreAccuracy.ts    pass 1 vs pass 2 vs human truth
src/analyze.ts          patterns across all 100
src/buildSite.ts        renders site/index.html from results/
results/                rows.json, patterns.json, accuracy.json, human_review.csv
```

## Deploy

The page is one static file with no build step and no external requests.

```bash
npm i -g vercel
vercel            # preview
vercel --prod     # production
```

When prompted for the output directory, enter **`site`**. Framework preset:
**Other**. No build command needed.
