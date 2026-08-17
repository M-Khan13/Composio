# 100-app agent-toolkit survey

An agent that researches 100 SaaS apps for API surface, auth methods, and whether a developer could build an agent toolkit on them today — then measures its own accuracy against hand-checked truth.

## Stack

Node + TypeScript · Composio SDK (`COMPOSIO_SEARCH_WEB` for search, `COMPOSIO_SEARCH_FETCH_URL_CONTENT` for page fetch, toolkit catalogue as a ground-truth signal) · Gemini with structured JSON output.

## Setup

```bash
cp .env.example .env      # add COMPOSIO_API_KEY and GEMINI_API_KEY
npm install
```

The Composio key needs `tool_execution` write access, or the agent can't run its tools.

## Run

```bash
npm run run:all                # research all 100 (~1h, resumable) → results/rows.json
npm run run:all -- --pass=1    # weak baseline, snippets only     → results/rows_pass1.json
npm run score                  # accuracy vs hand-checked truth   → results/accuracy.json
```

Everything lands in `results/`.

## The page

Open [`site/index.html`](site/index.html) — self-contained, all data inlined, no external requests. Rebuild with `npm run build:site`.

## Verification

`results/human_review.csv` holds the hand-checked ground truth for 18 apps. Accuracy is measured, not asserted — including where the second pass made things worse.
