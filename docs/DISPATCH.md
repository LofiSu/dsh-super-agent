# Dispatch RSI slice

This change lands the #177 structured-gap ingest and bounded RSI scheduler tick on current `main`.

## Structured gap ingest

The ingest reads rows from `docs/INSTINCT_CAPABILITIES.md` when they have at least six cells, a non-header capability title, and a `missing` or `environment-blocked` status. It reads competitive scorecard rows whose Verdict is Behind, Missing, or Partial. Entries carry their local document `sourceUrl`, `fetchedAt`, `manusCue: 'unknown'`, and a stable `dedupeKey`: `instinct-cap:<title>` or `competitive-gap:<dimension>`.

Repeated rows update an existing gap by dedupe key. An `implemented` or `dismissed` gap is not revived. High-risk items, including environment-blocked capabilities and connector, messaging, vault, and payment patterns, remain proposals. They do not enter the implement queue.

Instinct acceptance is extracted by `acceptanceFromInstinctEvidenceColumn` only when the evidence names a test file. The extractor fails closed: disclaimer text such as “名称数量不是验收标准” or “不是验收标准” produces empty acceptance. Competitive-gap rows always have empty acceptance and remain proposals.

## Research fetch and bounded tick

`trusted-fetch` accepts HTTPS URLs on the configured host allowlist, rejects private or blocked resolved addresses, and validates every redirect hop. It follows at most three redirects. Allowlisted homepage fetches and configured `rsi.sourceUrls` update `rsi_research_cache` with success or failure records. Fetched HTML is research cache only; it does not enqueue an implementation job.

`runRsiSchedulerTick` observes the configured interval, records its tick time, fetches research pages, ingests the two local structured documents, then considers at most one low-risk open gap with non-empty testable acceptance. It stays idle when no such gap exists, when that gap already has a queued, running, or completed implementation job, when an implementation is already queued or running, or when an equivalent open Peanut PR exists or its check fails.

## Configuration

The file is `<DS_AGENT_HOME>/github-dispatch.json`. This slice loads the same `github` and `rsi` schema used by #177; RSI can be enabled while GitHub dispatch is disabled. RSI defaults to a 6 hour interval with a 30 minute minimum floor.

```json
{
  "github": {
    "enabled": false,
    "repo": "LofiSu/deepseek-super-agent"
  },
  "rsi": {
    "enabled": true,
    "intervalMs": 21600000,
    "fetchAllowlist": ["docs.github.com", "github.com"],
    "sourceUrls": ["https://docs.github.com/en"]
  }
}
```

This PR does not include the GitHub issue poll, implementer, holdout publish, webhook ingress, or `serve` wiring. Those remain historical in #177. It does not claim that a product RSI candidate was published.
