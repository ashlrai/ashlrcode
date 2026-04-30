---
name: build-artist
description: Run the 6-phase artist encyclopedia factory pipeline (ingest → enrich → assets → build → deploy → smoke) for a given artist slug
trigger: /build-artist
---

Drive the **Artist Encyclopedia Factory** pipeline for a single artist slug. The end state is a deployed Next.js site on its own domain, generated from a single JSON bundle, without human intervention.

## Input

A single artist slug (e.g. `drake`, `sabrina-carpenter`, `bad-bunny`).

The bundle must exist at:
```
../artist-encyclopedia-factory/artists/<slug>.json
```

**Before doing anything else:** verify that file exists (use `Read` or `LS`). If it does not, abort with a clear error — do not proceed to ingest. If the file exists but fails to parse as JSON, also abort.

## Load-Bearing Constraint

**Do NOT republish lyrics at any phase.** Genius and LyricFind are link-outs only. Track titles, album titles, writer credits, release dates, chart positions, producer names, sample relationships, and user-generated interpretations are all fine. Actual lyric text is not, ever. If any sub-agent in any phase appears to be about to fetch or store lyric content, stop that phase.

## The Six Phases

Each phase is a separate sub-agent invocation (see `src/agent/sub-agent.ts` `runSubAgent` / `runSubAgentsParallel`, and the DAG config at `ashlrcode-config/coordinator/build-artist.json`). Each phase is composed as a pure `bundle → bundle'` function where possible, so re-runs are idempotent and partial failures can resume.

### Phase 1: ingest  (dependsOn: none)

**Input:** `artists/<slug>.json` with at minimum `{ slug, name, spotifyId?, musicbrainzId?, wikidataId?, setlistfmId? }`.

**Work:**
- **Spotify Web API** → discography, track IDs, preview URLs, album art URLs, popularity, release dates. Auth via client-credentials flow.
- **MusicBrainz** → canonical metadata, relationships (CC0, commercial OK). Respect the 1 req/s rate limit.
- **Wikipedia + Wikidata** → bio prose, timeline events, infobox image URLs (CC-BY-SA — track licenses).
- **Setlist.fm** → tour history, per-show setlists.
- **Discogs** (optional, read-only) → credits, sample relationships. Non-commercial terms — use for research enrichment only.

**Output:** merge all fetched data into the bundle under `bundle.sources.{spotify,musicbrainz,wikipedia,setlistfm,discogs}`. Write back to `artists/<slug>.json`. Every external call stubbed behind `packages/ingest/` clients — this skill does not hardcode API keys, it reads them from env.

**Retryable:** yes. On partial failure, write what succeeded and mark missing sources in `bundle.sources.<name>.status = "failed"` with an error message. The next run picks up missing sources only.

### Phase 2: enrich  (dependsOn: [ingest])

**Input:** bundle with populated `sources`.

**Work (all pure `bundle → bundle'` so they compose and are idempotent):**
- `meanings` — LLM interpretation of each song: themes, reading, cultural context. No lyric quotation.
- `themes` — cross-catalog theme clustering.
- `songColorMap` — deterministic hash from theme vector to CSS color used by the template.
- `sampleGraph` — nodes/edges from sample relationships (MusicBrainz + Discogs + WhoSampled fallback).
- `producerNetwork` — producers ↔ tracks bipartite graph.

**Output:** `bundle.enrichment.{meanings,themes,songColorMap,sampleGraph,producerNetwork}`. Each enrichment function should check whether its output already exists and skip if so unless `--force`.

**Retryable:** yes, per-enrichment. A failed `sampleGraph` does not block `meanings`.

### Phase 3: assets  (dependsOn: [ingest], parallel with enrich)

**Input:** bundle with `sources.spotify.albums[].coverUrl`, `sources.wikipedia.images[]`, producer portraits.

**Work:**
- Download album covers, producer photos, feature-artist portraits.
- **Licensing discipline — mandatory:**
  - Prefer **Wikimedia Commons** (CC-BY-SA / CC0). Record license + attribution per image.
  - Fall back to **Spotify** official album art (covered under their developer terms for display in context).
  - Official press-kit URLs only when explicitly allowed by the artist's site.
  - Never scrape Getty / AP / generic web images.
- Optimize: resize to 3 breakpoints (400/800/1600), emit WebP + AVIF, write originals + derivatives into:
  ```
  ../artist-encyclopedia-factory/template/public/images/<slug>/
  ```
- Write an `assets-manifest.json` beside the images with `{ src, license, attribution, sourceUrl }` per file — the template renders attribution from this.

**Output:** populated image directory, `bundle.assets.manifest` pointing to the manifest file.

**Retryable:** yes. Resumes by skipping images already present on disk.

### Phase 4: build  (dependsOn: [enrich, assets])

**Input:** fully enriched bundle + all assets on disk.

**Work:**
- Clone or update the template repo at `../artist-encyclopedia-factory/template/`.
- Copy `artists/<slug>.json` and `public/images/<slug>/` into a per-artist build directory.
- Run `bun install` in the build dir (reuse `bun.lock` if unchanged).
- Run `bun run build`. Capture stdout + stderr.
- On failure: snapshot the failing build dir + bundle to `.ashlrcode/autopilot/failed/<slug>-<timestamp>/` so a human can debug.

**Output:** `.next/` production build inside the per-artist build dir. Record the build hash in `bundle.build.lastBuild`.

**Retryable:** yes, but not partially — re-runs do a clean build.

### Phase 5: deploy  (dependsOn: [build])

**Input:** green build dir.

**Work (all stubs — do NOT hit real APIs from this skill without explicit user approval):**
- **Vercel** → create project (`POST /v9/projects`), upload build, set env vars from `bundle.deploy.env`. Capture deployment URL.
- **Porkbun** → register/attach `{slug}verse.com` (or the configured pattern). Set DNS CNAME to Vercel.
- **Stripe** → create Product + Price for the "AI unlock" for this artist; stash `stripeProductId` in the bundle.
- **Supabase** → run migration with `artist_slug = <slug>` scoping (shared DB model — see plan: `artist_slug` column + RLS). No new project per artist.
- Write `bundle.deploy.{vercelProjectId,deploymentUrl,domain,stripeProductId,supabaseMigrationId,deployedAt}`.

**Retryable:** each resource independently. The deploy sub-agent checks each field in `bundle.deploy` and skips anything already set. If a deployment URL exists but returns non-200, nuke that field and retry.

### Phase 6: smoke  (dependsOn: [deploy])

**Input:** `bundle.deploy.deploymentUrl`.

**Work (headless Playwright via the `puppeteer` optional dep or a thin `playwright` binding):**
- Hit `/` — expect 200, non-empty `<main>`, no console errors.
- Hit 10 randomly-sampled song pages from `bundle.sources.spotify.tracks[].slug` — expect 200 + non-empty content.
- Run the auth flow (create disposable test user via Supabase) — expect sign-in success + session cookie.
- Run Stripe test-mode checkout for the AI unlock — expect successful redirect back to app with entitlement granted.
- Run Lighthouse against `/` — require performance score **≥ 85**. Below that fails the phase.

**Output:** `bundle.smoke.{homeOk,sampledPages,authOk,stripeOk,lighthouseScore,runAt}`. On any red signal, mark the deploy unhealthy and roll back the Vercel alias to the previous green build.

**Retryable:** yes; this is purely a verifier.

## Error Recovery Guidance

| Phase   | Retryable? | Partial-state location                                     |
|---------|------------|------------------------------------------------------------|
| ingest  | yes        | `artists/<slug>.json` with per-source `status` fields      |
| enrich  | yes        | `bundle.enrichment.*` — skip sections already present      |
| assets  | yes        | `template/public/images/<slug>/` — skip files on disk      |
| build   | yes (full) | `.ashlrcode/autopilot/failed/<slug>-<ts>/`                 |
| deploy  | per-resource | each field in `bundle.deploy` gates its own step         |
| smoke   | yes        | `bundle.smoke.*` — always re-runnable                       |

On any phase failure, park the work-queue item in `failed` (see `src/autopilot/queue.ts` `failItem(id, error)`) so it is not retried in the same autopilot sweep, and log the error to telemetry. The next autopilot loop (or a manual `ac autopilot run --artist <slug>`) will pick it up again.

## Sub-Agent Orchestration

Each phase is dispatched as its own sub-agent via the coordinator DAG (`ashlrcode-config/coordinator/build-artist.json`). `enrich` and `assets` both depend only on `ingest` and run in parallel in the same wave. `build` waits for both. `deploy` then `smoke` are serial. Use `runSubAgentsParallel` where the wave has more than one task; otherwise `runSubAgent`.

Agents for each phase should be read-only where possible (ingest, smoke) and are scoped to only the files they need via the `files` field on each `SubTask`.

## Verification Checklist

Before declaring an artist "shipped," confirm:

1. ✅ `artists/<slug>.json` exists, parses, and contains non-empty `sources.{spotify,musicbrainz,wikipedia,setlistfm}`.
2. ✅ `bundle.enrichment.{meanings,themes,songColorMap,sampleGraph,producerNetwork}` all populated.
3. ✅ `template/public/images/<slug>/assets-manifest.json` exists and every entry has `license` + `attribution`.
4. ✅ `bun run build` succeeds in the per-artist build dir.
5. ✅ `bundle.deploy.{vercelProjectId,deploymentUrl,domain,stripeProductId,supabaseMigrationId}` all populated.
6. ✅ `bundle.smoke`: home 200, 10 song pages 200, auth flow green, Stripe test-mode green, Lighthouse ≥ 85.
7. ✅ No lyric text appears in any output (grep the built site for a known lyric snippet — should miss).
8. ✅ Parity gate (trophy-tier only): for `kanye` and `swift`, the generated site passes pixelmatch diff against production `yeuniverse.com` / `theswiftyverse.com` under threshold.
9. ✅ In parallel-wave mode, 5 artists completed within a 2-hour window without human intervention.
10. ✅ Work-queue item for this slug marked `completed`.

{{args}}
