# 10 Dream Jobs

A workflow for discovering which marketing jobs you want, separate from which you are qualified for.

## How it fits together
| Piece | What it is | Status |
|---|---|---|
| Review app (`app/`, built to `app/dist/10dreamjobs.html`) | Clickable roles table, full-description record view, 1–10 Interest/Qualification ratings, active-time timer, analysis, exports, restore | Built and tested in headless Chromium against a mock of the database capability |
| System of record | The published Artifact's `db` (documents: `jobs`, `companies`, `reviews`, `batches`, `policies`, `reports`, `targets`, `settings`) | Works once the artifact is published (see "Status" below) |
| Git backups (`data/backups/`) | Dated JSON snapshots of the whole database, committed by Claude on request | Manual, on "Export my data" |
| Sourcing | Claude, using web search and fetch, writes verified roles into the database | **Blocked in this environment, see "What needs setup"** |
| Daily reminder | A Claude Code routine (scheduler) | **Not created yet**: needs your time, timezone, delivery method |
| Tools (`tools/`) | `build_app.py`, `analyze.py` (offline high-vs-low term analysis on a backup) | Working |

## Commands (say these to Claude, or use the in-app buttons)
- **10 more** – Claude sources 10 new unique, verified postings and appends them (never replaces).
- **Review next 10** – in-app button on Roles; opens the oldest 10 unreviewed roles as a queue. Reminder link: open the artifact URL with `#review` to start the queue.
- **Analyze my ratings** – in-app Analysis (live, labeled preliminary below 100) and a full narrative report from Claude (resume versions, skill priorities, role clusters), saved under Saved reports.
- **Refine sourcing** – records a new versioned sourcing policy (Settings), then Claude applies it to the next batch.
- **Build my target company list** – Claude writes `targets` documents (50–100 companies, core list + labeled exploratory extension, with LinkedIn / McCombs-MSM connection leads).
- **Export my data** – Settings: CSV (standardized) and JSON (full descriptions, sessions, rating history). Claude can also commit a backup to `data/backups/`.

## Rules the system follows
- Role Interest, Company Interest and Qualification are three separate 1–10 ratings, none preselected, saved together, and all three required before a role counts as reviewed (a re-rate may carry the earlier Qualification forward, clearly labeled).
- Ratings are append-only: revisions add a dated entry; the original ratings, date and review time stay intact. Reports state whether they use original or latest ratings.
- Skip is not a rating. Skipped roles are excluded from counts and from interest analysis.
- Active review time starts when an unreviewed role opens; pauses on tab hidden, leaving the record, manual pause, or inactivity (default 120 s, configurable; trailing idle time is not counted); resumes on activity; stops at submit. It approximates reading time and is never treated as interest. An interrupted session is recovered from a local checkpoint on the next load.
- Missing values show as "Unknown" / "Not disclosed". Estimated salaries are never mixed with published ones.
- No predicted interest or fit score appears before you rate.
- Dedup: employer requisition ID, then canonical URL (tracking parameters removed), then company + title + location. A changed repost of an unreviewed role is attached as an update; your reviewed snapshot is never overwritten.

## Development
```
node --test tests/lib.test.js        # pure-logic unit tests (dedup, timer, ratings history, stats, CSV, timezone)
python3 tools/build_app.py           # inline CSS + JS into app/dist/10dreamjobs.html
npm i -D playwright-core && node tests/e2e.mjs   # browser end-to-end test with a mocked database
python3 tools/analyze.py data/backups/<backup>.json --mode latest
```
Docs: `docs/data_model.md`, `docs/resume_profile.md`, `docs/sourcing_policy_v1.md`.
