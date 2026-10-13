# Sourcing policy v2 (2026-10-13)

Supersedes v1. Everything in `sourcing_policy_v1.md` still applies except as changed here.

## Hard geography rule (new)
Keep a role only if **either**
- New York (city or state office, "NYC", Brooklyn, Manhattan) is one of its listed location options, **or**
- it is remote with US-compatible eligibility.

Drop anything exclusively in another geography, including "Remote" roles tied to another country or region (for example Remote - Canada, Remote - India, EMEA). Remote roles that name no region are kept but flagged "region not specified". Remote roles that limit hiring to certain US states or a time zone are kept, with the restriction recorded in the role's remote-eligibility field so you can judge it.

Implemented in `tools/source.py` (`geo_ok`, on by default; `scan --no-geo` turns it off). The tool also skips postings already sourced.

## Unchanged
Exploratory breadth through 100–200 completed ratings, ≥5 role families and ≥5 industries per batch where supply permits, ≤2 roles per company, strong-fit plus stretch roles, official ATS postings, verification date per role.

## Effect on earlier batches
Batch b001 was sourced under v1. Two of its roles (Lyft, San Francisco hybrid only; Notion, San Francisco on-site) would not pass this rule. They stay in your dataset with their ratings; the batch's policy version (v1) lets analysis separate them.
