# Terra admin and staff API

Unofficial notes on the staff side of `https://api.terra.hackclub.com`: the reviewer, fraud and admin endpoints behind the `/admin/*` pages on `https://terra.hackclub.com`.

> **How this was put together.** The container this was written in can't reach `api.terra.hackclub.com` (its network policy blocks the host), so nothing here was checked live. It is collected from public, community-written clients and research notes (see [Sources](#sources)), mainly the reviewer tool *terra-desk*, which uses these endpoints itself. Field names and bodies come from that code. Where a source only gives an endpoint's name and a one-line purpose, the doc says so. The API changes with the game, so read this as a snapshot from about October/November 2026, not a contract.

## Contents

- [Overview](#overview)
- [Authentication and roles](#authentication-and-roles)
- [Conventions, errors and rate limits](#conventions-errors-and-rate-limits)
- [Endpoint index](#endpoint-index)
- [Read endpoints](#read-endpoints)
- [Claims](#claims)
- [Decisions](#decisions)
- [Flags, videos, tags and evidence](#flags-videos-tags-and-evidence)
- [Staff notes](#staff-notes)
- [Admin-only actions](#admin-only-actions)
- [Fraud endpoints](#fraud-endpoints)
- [Review rules the page enforces](#review-rules-the-page-enforces)
- [Web routes](#web-routes)
- [Unknowns](#unknowns)
- [Sources](#sources)

## Overview

| | |
| --- | --- |
| REST API | `https://api.terra.hackclub.com` |
| Web client | `https://terra.hackclub.com` (staff pages under `/admin`) |
| Game server | `wss://game.terra.hackclub.com` (Colyseus, not covered here) |

The "admin API" is not a separate service. It is the same Express API the player client uses, with staff routes mostly under two prefixes:

- **`/review/*`**: the review queue, ship ("shipment") pages, claims, decisions, notes, and the fraud queue. Most of this is open to the `reviewer` role. A few actions are admin-only.
- **`/admin/*`**: admin tools. Only `GET /admin/search` is known from public sources.

Core objects:

| Object | What it is |
| --- | --- |
| **Project** | A player's project. Has `title`, `description`, `codeUrl`, `demoUrl`, `screenshotUrl`, `hackatimeProjects`, `branch`, `isUpdate`, `parent`, soft-delete `deletedAt`. |
| **Shipment** ("ship") | One submission of a project for review in a given week. This is what reviewers decide on. |
| **Evidence** | A server-built bundle for a shipment: Hackatime time, sessions, commits, files, cross-program URL matches. It is versioned; decisions must quote `evidenceVersion`. |
| **Decision** | approve / changes / reject, with a note to the maker and (for approvals) a payout. |
| **Flag** | An automated warning on a shipment, `severity` `danger` or `warn`. Danger flags must be acknowledged before approving. |
| **Claim** | A short-lived lock a reviewer holds on a shipment while reviewing it. One at a time per reviewer. |
| **Hold** | A shipment moved out of the normal queue to `fraud` or `admin`. |

## Authentication and roles

All requests use the player's own login token:

```
Authorization: Bearer <token>
Content-Type: application/json
```

- The token is an HS256 JWT (claims `userId`, `username`, `tv`, `iat`, `exp`), valid for 7 days. `tv` is a token version that `POST /auth/logout-all` bumps.
- Logging in goes through Hack Club Auth (OIDC). There are no separate staff credentials or API keys. Staff tools get the token from the web client: in the browser console on terra.hackclub.com, `localStorage.terra_auth_token`.
- Access is by role, read from the user record (`GET /auth/me`):

  ```ts
  {
    id, username, displayName, email, slackId, profilePictureUrl,
    roles: string[],      // e.g. ["reviewer"]
    isAdmin: boolean,
    bannedAt: string | null,
    ...
  }
  ```

  | Level | How you can tell | Can do |
  | --- | --- | --- |
  | Reviewer | `roles` contains `"reviewer"` | Review queue, claims, approve, request changes, reject, move, notes, flag dismissals |
  | Fraud | a fraud role (exact name not public) | Fraud queue, triage, fraud verdicts, bulk pass |
  | Admin | `isAdmin: true` | All of the above plus the admin-only actions and `/admin/*` |

- Every shipment response also has a `viewer` object with per-ship permissions: `canReview`, `isOwner`, `isAdmin`, `videoOptional`.
- Calling an endpoint your account can't use returns `403`.

## Conventions, errors and rate limits

- JSON in and out. IDs are UUIDs; timestamps are ISO 8601; durations are **seconds** (`seconds`, `creditedSeconds`, `deflationSeconds`, …).
- Errors: non-2xx with `{ "error": "<message>" }`, sometimes with a `code`. A claim conflict also includes `holder: { username }`.
  - `401 {"error":"No token provided"}` / `401 {"error":"Invalid token"}`
  - `403`: missing role
  - `404`: unknown id; unknown routes return Express's HTML `Cannot <METHOD> <path>` page
- CORS only allows `https://terra.hackclub.com`, so browser code on other origins can't read responses. Server-side and CLI clients are not affected.
- Rate limit: **100 requests/minute** across the API (stricter 5/15 min on some auth routes). Responses carry `RateLimit`/`RateLimit-Policy` headers, and terra-desk also reads `X-RateLimit-Remaining` / `X-RateLimit-Reset`. Back off on `429`.
- **Don't retry writes automatically.** A decision that timed out may still have gone through; re-read the shipment before sending anything again.

## Endpoint index

`{id}` is a shipment id unless the path says `project` or `note` or `decision`.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/auth/me` | any | Your account, `roles`, `isAdmin` |
| GET | `/review/counts` | reviewer | Queue sizes (sidebar badges) |
| GET | `/review/weeks` | reviewer | Week numbers, labels and dates |
| GET | `/review/stats` | reviewer | This week's reviewer leaderboard |
| GET | `/review/queue` | reviewer | The queue list (`?queue=&filter=`) |
| POST | `/review/queue/next` | reviewer | Next ship to open after a decision |
| GET | `/review/shipment/{id}` | reviewer | Everything the review page shows |
| GET | `/review/shipment/{id}/chain` | reviewer | Every version of an update project |
| GET | `/review/shipment/{id}/parent` | reviewer | The original project of an update |
| GET | `/review/shipment/{id}/unified-projects` | reviewer | Matching projects in other YSWS programs |
| GET | `/review/macros` | reviewer | Canned decision notes |
| GET | `/review/tag-options` | reviewer | Tag pick list and usage |
| POST | `/review/shipment/{id}/claim` | reviewer | Claim a ship |
| POST | `/review/shipment/{id}/claim/heartbeat` | reviewer | Keep a claim alive |
| DELETE | `/review/shipment/{id}/claim` | reviewer | Release a claim |
| POST | `/review/shipment/{id}/approve` | reviewer | Approve |
| POST | `/review/shipment/{id}/changes` | reviewer | Request changes |
| POST | `/review/shipment/{id}/reject` | reviewer | Reject (final) |
| POST | `/review/shipment/{id}/send` | reviewer | Move to fraud or an admin |
| POST | `/review/shipment/{id}/flags/{kind}/dismiss` | reviewer | Acknowledge/dismiss a flag |
| POST | `/review/shipment/{id}/video` | reviewer | Upload a review video |
| POST | `/review/shipment/{id}/video-rejected` | reviewer | Telemetry for a video over 100 MB |
| POST | `/review/decision/{id}/video` | reviewer | Attach a video to an approval |
| POST | `/review/shipment/{id}/resync` | reviewer | Rebuild the evidence |
| POST | `/review/shipment/{id}/tags` | reviewer | Set project tags |
| GET | `/review/project/{projectId}/notes` | reviewer | Staff notes on a project |
| POST | `/review/project/{projectId}/notes` | reviewer | Add a staff note |
| PATCH | `/review/note/{noteId}` | reviewer | Edit a note |
| DELETE | `/review/note/{noteId}` | reviewer | Delete a note |
| GET | `/review/deflation-checks` | **admin** | Approvals waiting on a deflation check |
| POST | `/review/shipment/{id}/deflation-check` | **admin** | Settle a deflation check |
| POST | `/review/shipment/{id}/justification` | **admin** | Rewrite a finished approval |
| POST | `/review/shipment/{id}/pending-approval` | **admin** | Correct a pending approval |
| POST | `/review/shipment/{id}/requeue` | **admin** | Send back to the queue |
| POST | `/review/shipment/{id}/revert` | **admin** | Revert a decision |
| GET | `/admin/search` | **admin** | Search users, projects and ships (`?q=`) |
| GET | `/review/fraud/triage` | fraud | Triage list (`?group=`) |
| POST | `/review/shipment/{id}/fraud` | fraud | Fraud verdict |
| POST | `/review/shipment/{id}/fraud-edit` | fraud | Edit a fraud verdict |
| POST | `/review/shipment/{id}/triage-flag` | fraud | Set a triage tier |
| DELETE | `/review/shipment/{id}/triage-flag` | fraud | Clear a triage tier |
| POST | `/review/fraud/pass-bulk` | fraud | Pass many ships at once |

## Read endpoints

### `GET /review/counts`

```json
{ "review": 42, "fraud": 7 }
```

`fraud` is only present when your account can see the fraud queue.

### `GET /review/weeks`

A list (or `{ "weeks": [...] }`) of:

```ts
{ number: number, label: string /* "Prep Week 3", "Week 1" */, startDate: string, endDate: string, rentRequired: boolean }
```

Barely changes; worth caching for a few hours.

### `GET /review/stats`

```ts
{
  week: { key: string, startDate: string, endDate: string },
  reviewers: { username: string, total: number, counts: { approved: number, changes: number, ... } }[]
}
```

### `GET /review/queue`

| Query | Values |
| --- | --- |
| `queue` | `review` (default) or `fraud` |
| `filter` | `waiting` (default), `approved`, `changes`, `rejected` |

```ts
{
  items: {
    id: string,              // shipment id
    title: string,
    username: string,
    weekNumber: number,
    seconds: number,         // hours on the ship
    platforms: ("web"|"windows"|"linux"|"macos"|"other")[],
    danger: number, warn: number,   // flag counts
    queuedAt: string,
    claimedBy: string | null, claimedByMe: boolean,
    hold: "fraud" | "admin" | null,
    decision: string | null
  }[]
}
```

The full list comes back in one response. There's no server-side week, platform or title filter, so filter on the client.

### `GET /review/shipment/{id}`

The review page's main call. Reading it does **not** claim the ship. (Opening the page in the browser does, because the page also sends `POST …/claim`.) Top-level keys:

```ts
{
  shipment: {
    id, projectId, title, notes /* ship notes */, aiDeclaration,
    platforms, weekNumber, submittedAt,
    stage: "review" | ...,
    reviewHold: "fraud" | "admin" | null, reviewHoldNote,
    fraudPending: boolean,       // fraud hasn't given a verdict yet
    changesRounds: number,       // times changes were requested before
    evidenceVersion: number,     // must be sent back with every decision
    hackatimeSeconds, aiSeconds
  },
  project: {
    title, description, codeUrl, demoUrl, screenshotUrl, branch,
    hackatimeProjects: string[], isUpdate: boolean,
    parent: { id, title, what, ships: { weekLabel, completedAt, seconds }[] } | null
  },
  maker: {
    username, displayName, githubLogin, createdAt,
    pastShips: { title, weekNumber, status, overrideSeconds }[]
  },
  viewer: { canReview, isOwner, isAdmin, videoOptional },
  claims: { review: { username, holder, mine: boolean, stale: boolean } | null },
  evidence: {
    version: number, builtAt: string,
    data: {
      time: { creditedSeconds, totalSeconds, aiSeconds },
      devloggedSeconds,
      sessions: { start, end, seconds }[],
      commits: { sha, message, committedAt, authorLogin, authorName, additions, deletions, devlogId }[],
      files: { path, seconds, status: "head" | "history" | ... }[],
      rows: { time: { creditedSeconds } }[],
      unifiedUrlMatches: [...]   // same repo submitted to another YSWS program
    } | null                      // null while evidence is still being built
  },
  devlogs: { id, title, body, creditedSeconds, hackatimeSeconds, createdAt, images: { url }[] }[],
  decisions: { decision, reviewer, createdAt, claimedAt, noteToMaker, justification, projectReview }[],  // newest first
  votes: { averageStars, round, suggestedMultiplier, list: { verdict, stars /* of 7 */, justification, createdAt }[] },
  flags: { kind, severity: "danger" | "warn", title, details, dismissedAt, dismissedBy, dismissReason }[],
  fraudSuggestion: { seconds: number, reason: string } | null,   // fraud team's suggested hours cut
  waterPaid: number
}
```

Credited time counts AI coding at 1/3.

### `GET /review/shipment/{id}/chain`, `/parent`, `/unified-projects`

- `chain`: every version (ship) of an update project, oldest first, each with its devlogs. Only useful when `project.parent` is set.
- `parent`: the original project an update builds on.
- `unified-projects`: projects in other Hack Club YSWS programs that match this one (double-dip checking).

### `GET /review/macros`, `GET /review/tag-options`

Canned decision notes, and the tag pick list with usage counts. Response shapes aren't public.

## Claims

A reviewer has to hold the claim on a ship before deciding it. **Terra allows one claim per reviewer at a time.**

```http
POST /review/shipment/{id}/claim
{ "queue": "review", "takeover": false }
```

```http
POST /review/shipment/{id}/claim/heartbeat
{ "queue": "review" }
```
→ `{ "held": true }`. `held: false` means you lost the claim.

```http
DELETE /review/shipment/{id}/claim?queue=review
```

A claim held by someone else returns an error with `holder.username`. A claim the page reports as `stale` (in `claims.review.stale`) can be taken over (presumably with `takeover: true`; not confirmed). For the fraud queue, use `queue: "fraud"`.

## Decisions

Each decision is: claim, (for approve) dismiss danger flags and upload a video, then the decision call. All decision bodies quote the shipment's current `evidenceVersion`.

### Approve

```http
POST /review/shipment/{id}/approve
```

```json
{
  "evidenceVersion": 3,
  "deflationSeconds": 3600,
  "cropDeflationSeconds": 3600,
  "deflationReason": "Fraud review: ...",
  "payoutMultiplier": 1.1,
  "noteToMaker": "Shown to the player.",
  "videoUrl": "<url returned by the video upload, or null>",
  "builtWhat": "Specific technical features (30–1000 chars)",
  "projectReview": "Airtable justification (80+ chars)",
  "updateJustification": "40+ chars when the repo was also submitted elsewhere, else empty"
}
```

| Field | Meaning |
| --- | --- |
| `deflationSeconds` | Hours cut from what's reported to Airtable (the YSWS hours). |
| `cropDeflationSeconds` | Hours cut from the in-game crop payout. The page defaults it to follow the Airtable deflation. |
| `deflationReason` | Required when either deflation is above 0. Pre-filled from `fraudSuggestion` (as `"Fraud review: <reason>"`). |
| `payoutMultiplier` | `0.8`–`1.5`. The page starts from the community vote's `suggestedMultiplier`. |
| `videoUrl` | A test video is required unless `viewer.videoOptional` is true. |

How the payout works out (from the page bundle): Airtable hours = credited − `deflationSeconds`. Crops = whole hours of `credited − cropDeflationSeconds`, rounded. Then the multiplier is applied.

### Request changes / Reject

```http
POST /review/shipment/{id}/changes
POST /review/shipment/{id}/reject
```

```json
{
  "evidenceVersion": 3,
  "noteToMaker": "What to change / why it's rejected",
  "videoUrl": null,
  "internalNote": "Staff only"
}
```

A **rejection is final**; the player can't reship. After 3 rounds of changes (`shipment.changesRounds >= 3`) only admins can request changes again, so non-admins have to approve or reject.

### Move to fraud or an admin

```http
POST /review/shipment/{id}/send
{ "hold": "fraud" | "admin", "note": "Why it needs fraud review or an admin" }
```

This sets `shipment.reviewHold`. A ship can go to `fraud` only while `shipment.fraudPending` is true. Admins can't send a ship to `admin`.

### `POST /review/queue/next`

Returns the next ship to open after a decision (the page's "next" button). Body and response aren't public.

## Flags, videos, tags and evidence

### Dismiss / acknowledge a flag

```http
POST /review/shipment/{id}/flags/{kind}/dismiss
{ "reason": "At least 10 characters" }
```

`{kind}` is the flag's `kind`, URL-encoded. Each undismissed `danger` flag needs one before an approval, except `double_dip`, which has no acknowledge box on the page.

### Upload a review video

```http
POST /review/shipment/{id}/video
Content-Type: multipart/form-data
```

Parts, in the order the page sends them: `outcome` (e.g. `small`), `detail`, `compressMs`, `sourceBytes`, `sourceType` (`video/mp4`, `video/webm`, `video/quicktime`), then `file`. Max **100 MiB** (104857600 bytes). The page compresses in the browser first, and files over the limit are reported with `POST …/video-rejected` instead. The response contains the URL to put in the approval's `videoUrl`.

`POST /review/decision/{decisionId}/video` attaches a video to an approval after it has been made.

### Others

- `POST /review/shipment/{id}/resync`: rebuild the evidence (e.g. after the player pushes more commits). Until it finishes, `evidence.data` is null or `evidence.version != shipment.evidenceVersion`, and the page won't allow decisions.
- `POST /review/shipment/{id}/tags`: set project tags (from `/review/tag-options`).

## Staff notes

Staff notes belong to the **project**, so they stay across every ship of it.

```http
GET  /review/project/{projectId}/notes
POST /review/project/{projectId}/notes   { "body": "text", "audience": "reviewer" | "fraud" }
PATCH  /review/note/{noteId}
DELETE /review/note/{noteId}
```

GET returns a list (or `{ notes: [...] }`) of `{ body, audience, authorName | author, createdAt }`. The PATCH body isn't public (probably `{ body }`).

## Admin-only actions

These need `isAdmin`. Public sources only give their names and purpose; request bodies aren't documented.

| Endpoint | Purpose |
| --- | --- |
| `GET /review/deflation-checks` | Approvals held for an admin to check the deflation |
| `POST /review/shipment/{id}/deflation-check` | Settle one of those checks |
| `POST /review/shipment/{id}/justification` | Rewrite the text of a finished approval |
| `POST /review/shipment/{id}/pending-approval` | Correct an approval that hasn't been finalised yet |
| `POST /review/shipment/{id}/requeue` | Send a decided ship back to the review queue |
| `POST /review/shipment/{id}/revert` | Revert a decision |
| `GET /admin/search?q=` | Search users, projects and ships |

Admins can also:

- request changes past the 3-round limit
- review their own ships (`viewer.isOwner && viewer.isAdmin`)
- handle ships moved to the `admin` hold
- excuse a player's missed week ("only an admin can excuse a missed week")
- edit a shipped project's locked title and update/parent fields ("ask an admin to change it")
- delete projects; there is no player delete route, and projects have a soft-delete `deletedAt`

The API routes for those last three aren't public.

The shop also has admin-created stock entries with ids `admin-<uuid>` (bonus seeds and prizes), which suggests an admin shop-management tool. Its routes aren't public either.

## Fraud endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /review/queue?queue=fraud` | Fraud queue |
| `GET /review/fraud/triage?group=` | Triage list |
| `POST /review/shipment/{id}/fraud` | Give a fraud verdict (sets `fraudSuggestion` and clears `fraudPending`) |
| `POST /review/shipment/{id}/fraud-edit` | Edit a fraud verdict |
| `POST` / `DELETE /review/shipment/{id}/triage-flag` | Set / clear a triage tier |
| `POST /review/fraud/pass-bulk` | Pass many ships at once |

The bodies aren't public. The fraud verdict's result appears to reviewers as `fraudSuggestion: { seconds, reason }`.

## Review rules the page enforces

The review page checks these before it lets you decide. A client should check them too:

1. `viewer.canReview` is true.
2. Not your own ship, unless you're an admin.
3. `shipment.stage === "review"` and no `reviewHold`.
4. Evidence is built: `evidence.data` present and `evidence.version === shipment.evidenceVersion`.
5. No live claim by someone else (`claims.review` is null, `mine`, or `stale`).
6. Changes: `changesRounds < 3` unless admin.
7. Approve: every undismissed danger flag (except `double_dip`) acknowledged with 10+ chars; multiplier 0.8–1.5; features 30–1000 chars; justification 80+ chars; update justification 40+ chars if `unifiedUrlMatches` is non-empty; deflation reason if any deflation; video unless `videoOptional`.
8. Move: `fraud` only while `fraudPending`; admins can't move to `admin`.

## Web routes

Staff pages on `https://terra.hackclub.com` that match these endpoints:

| Page | URL |
| --- | --- |
| Review a ship | `/admin/review/{shipmentId}` |
| Project | `/admin/projects/{projectId}` |
| Admin home | `/admin` |

## Unknowns

- Request bodies for the admin-only, fraud and tag endpoints, `queue/next`, and note PATCH.
- The fraud role's name, and whether there are other staff roles.
- Any `/admin/*` route other than `/admin/search` (user management, bans, shop stock, week excusals, project deletion).
- Whether the rate limit is per IP or per user.

To fill these in, someone with a staff account can record the browser's network traffic (a HAR export) on the `/admin` pages, or read the `Decision-*.js` / `ReviewPage-*.js` / admin chunks of the web bundle. The reviewer tools this doc is based on were built that way.

## Sources

- [Central3465/super-octo-spoon](https://github.com/Central3465/super-octo-spoon) (`terra-desk/tools/terra-api.py`, `terra-write.py`, `terra_desk/core.py`): a reviewer desktop tool. It has the endpoint list, the request bodies, claim handling, and validation limits ported from the review page bundle. It mentions a `TERRA-API.md` that isn't in the public repo.
- [jollyroger182/terra-api](https://github.com/jollyroger182/terra-api) (`docs/API.md`, `docs/openapi.yaml`): the player API, auth, conventions, rate limits, and the `/auth/me` user shape.
- [Cloveian/terra-calc](https://github.com/Cloveian/terra-calc) (`research/`): admin shop ids, admin-only rules (missed weeks), and the `/admin*` web routes.
