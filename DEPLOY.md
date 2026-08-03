# TravelSense — deployment & beta guide

AI travel advisor. Static front end plus one Netlify serverless function that
calls the Anthropic API with a server-side key.

---

## The files

All six sit at the **root** of the repository. There are no folders — GitHub's
browser and mobile uploaders can't create them, and a missing folder is what
caused the earlier 404s.

| File           | Purpose                                          |
|----------------|--------------------------------------------------|
| `index.html`   | The entire app. Served at `/`                    |
| `netlify.toml` | Netlify configuration. Must be at the repo root  |
| `chat.js`      | Serverless function → `/.netlify/functions/chat` |
| `hello.js`     | Diagnostic function → `/.netlify/functions/hello`|
| `health.txt`   | Diagnostic file → `/health.txt`                  |
| `DEPLOY.md`    | This guide                                       |

---

## Deploying

1. **GitHub** → new repository → upload all six files at once → commit.
   Confirm the repo shows six files and no folders.
2. **Netlify** → Add new site → Import an existing project → GitHub → your repo.
   **Leave every build setting blank.** `netlify.toml` supplies them.
   In particular **Base directory must be empty** — anything there breaks it.
3. **Site configuration → Environment variables** → add `ANTHROPIC_API_KEY`.
4. **Trigger a new deploy.** Netlify does not apply new environment variables
   to a deploy that already ran.

### Verify in this order

| URL | Expected | If it fails |
|---|---|---|
| `/health.txt` | plain text | publishing is wrong — check Base directory is empty |
| `/.netlify/functions/hello` | JSON | functions aren't deploying |
| `/.netlify/functions/chat` | **405** | 405 is correct; 404 means not deployed |
| `/` | the app | — |

`hello` reports whether the API key is detected, showing only its length —
never the key itself.

Once it works, delete `health.txt` and `hello.js`. Nothing depends on them.

A new Netlify site may be private ("Only project members can view this site").
That's separate from a 404 — use **Go live or manage access** before sending
the link to testers.

---

## Analytics setup (Priority 5)

Open `index.html` and find this block near the top of `<head>`:

```js
window.__TS_GA4_ID     = "";   // e.g. "G-XXXXXXXXXX"
window.__TS_CLARITY_ID = "";   // e.g. "abcdefghij"
```

- **GA4 ID**: Google Analytics → Admin → Data streams → Measurement ID
- **Clarity ID**: clarity.microsoft.com → Settings → Project ID

Leave either empty to disable that tool. Neither loads until an ID is present,
so the app works fine with both blank.

### Events tracked

`session_start`, `sign_in`, `interests_selected`, `history_completed`,
`mode_selected` (voice vs text), `conversation_completed`, `confirm_edited`,
`recommendations_requested`, `recommendations_generated`,
`recommendations_failed`, `refinement_opened`, `refinement_reason`,
`refinement_applied`, `destination_opened`, `destination_saved`,
`affiliate_click`, `profile_saved`, `search_restarted`, plus
`api_success` / `api_retry` / `api_error`.

Drop-off analysis comes from comparing `session_start` →
`interests_selected` → `conversation_completed` → `recommendations_generated`.

### AI cost and performance metrics

`chat.js` writes one structured line per request to the Netlify function log.
Find them in **Netlify → Logs → Functions**, filtering on `ts_metrics`:

```
ts_metrics {"ok":true,"kind":"conversation","model":"...","ms":3120,
"retries":0,"input_tokens":1240,"output_tokens":310,"total_tokens":1550,
"est_cost_usd":0.008,"truncated":false}
```

Covers tokens, estimated cost, response time, retry count, error type, and
whether a response was truncated. `kind` separates conversation turns from
recommendation reasoning, which have very different cost profiles. **None of
this is ever returned to the browser.**

Cost figures are directional estimates from the pricing table at the top of
`chat.js` — update those numbers if your rates differ.

---

## Founder dashboard

Visit **`/?dashboard=1`**.

Shows searches, recommendation sets, average diversity score, voice/text split,
a most-recommended table with engagement rates, and which destinations have
never been surfaced.

**Important limitation:** it reads from *your* browser's local storage only.
It's useful for checking the engine's behaviour during your own testing, but it
does not aggregate across testers. Cross-user analytics need a database — see
"What's still outstanding" below. GA4 and Clarity cover session-level data
across all users in the meantime.

---

## What changed in this sprint

**Recommendation intelligence.** The pool went from 16 to 32 destinations, all
scored on every search across region, vibe, pace, weighted interests, budget,
group size, children's ages, accessibility, seasonality, travel history and
popularity. Picks are drawn from a quality band using a seeded weighted draw
rather than always taking the top score — that's what fixed the repetition.
Measured: 10 distinct destinations across 10 similar searches, versus 4 before.
Budget is now a hard gate; nothing wildly over budget can be recommended.

**Interests.** 41 specific options across 7 categories, then a Top 3 selection
that scores three times heavier than the rest and drives one or two targeted
follow-up questions in the conversation.

**Accessibility.** Now a required slot the conversation cannot skip, and it is
never auto-filled by the stuck-question fallback. Free text is parsed
("I use a wheelchair" → mobility).

**Confirmation screen.** Travelers, dates, budget, region, style, setting,
accessibility and interests, each editable inline. Nothing is generated until
you tap through.

**Refinement.** Ten reasons, each with its own follow-up question, its own
adjustment to the profile and scoring, and a plain-language explanation of what
changed. Previously shown destinations are excluded outright.

---

## What's still outstanding

Two items from the brief are partially done, deliberately.

**Real Google/Apple sign-in.** The buttons work and profiles persist locally,
but genuine OAuth needs client IDs registered to your Google Cloud and Apple
Developer accounts (Apple requires the paid tier), plus somewhere server-side
to store user records. Guest mode is fully functional, profiles persist across
visits, and returning users are recognised and greeted differently.

**Cross-user analytics.** The dashboard reads one browser. Aggregating across
testers needs a database — Netlify Blobs is the natural fit.

Both were held back because they add an npm dependency and a build step, which
is the exact class of change that broke earlier deploys. Everything the
dashboard would need is already being recorded, so wiring in storage later is
mostly a matter of changing where it writes.

---

## Running locally

```bash
npm install -g netlify-cli
netlify login
ANTHROPIC_API_KEY=sk-ant-... netlify dev
```

Netlify **Drop** (drag-and-drop) cannot deploy this app — Drop skips the build
step where functions are bundled, so the site would load but the chat function
would 404. Use GitHub or the CLI.
