# Data model (artifact database collections)

All documents are JSON; IDs are stable. Original source text is stored beside standardized fields.

- `jobs/{j_…}` – id, companyId, company, division, title, roleFamily[], seniority, employmentType, location, arrangement (Remote/Hybrid/On-site/Unknown), remoteEligibility, travel, salary{text (as published), min, max, currency, period, basis (base|total comp), byLocation[]}, desc (full original text), descComplete, sections{responsibilities, required, preferred, skills, platforms, tools, certifications}, sourceUrl, reqId, postedDate, sourcedAt, verifiedAt, postingStatus, extraction{completeness, missing[], provenance{}}, batchId, policyVersion, status (unreviewed|reviewed|skipped), reviewedAt (original submit time), ratingOriginal, ratingLatest, updates[] (changed reposts of unreviewed roles).
- `companies/{c_…}` – name, industry, subsector, model (B2B|B2C|Mixed), ownership (Public|Private|Nonprofit|Government), hq, size{band,count,source,asOf}, stage, ticker, exchange, marketCap{value,currency,source,asOf}, parent{name,ownership,ticker,exchange}, careersUrl.
- `reviews/{jobId}` – ratings[] (append-only: {at, interest, qualification, note, kind original|revision, review_s}), sessions[] ({start,end,active_s,elapsed_s,pauses[],purpose,method}), active_s (initial review), extra_active_s (revisions), elapsed_s, timing_method.
- `batches/{b_…}` – date, policyVersion, requested, accepted, duplicatesSkipped, jobIds[], shortfall, coverage, criteria.
- `policies/{vN}` – version, createdAt, summary, alignedPct, basedOnReviews.
- `reports/{r_…}` – createdAt, mode, n, preliminary, cutoff, policyVersions, data or body.
- `targets/{…}` – name, tier, confidence, basis (rated|similar), industry, model, size, hq, roleFamilies, geo, why, evidence, openRole, openRoleVerified, careersUrl.
- `settings/main` – tz, idleSec, activePolicy, alignedPct, reminder{time, tz, method, scheduledId, paused}.

Currencies are stored as published. Any conversion must record rate and date alongside (not implemented until needed).
