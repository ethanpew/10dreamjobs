#!/usr/bin/env python3
"""Offline analysis of a full JSON backup (Settings > Export JSON, or a Claude-made data/backups/*.json).

Usage: python3 tools/analyze.py data/backups/<file>.json [--mode original|latest]

Prints completed-unique-job counts, high (8-10) vs low (1-3) group sizes, and which named tools/platforms/skills appear in
high-interest postings vs low-interest ones (share of postings, not raw counts). Descriptive only; no causal claims.
"""
import argparse, json, re, statistics, sys

TERMS = {
    "SQL": r"\bsql\b", "Python": r"\bpython\b", "R": r"\bR\b(?: programming|,| or | and )", "Tableau": r"tableau", "Power BI": r"power ?bi",
    "Qualtrics": r"qualtrics", "Survey design": r"survey", "Qualitative research": r"qualitative", "A/B testing": r"a/b test|experiment",
    "Marketing mix modeling": r"marketing mix|\bmmm\b", "Attribution": r"attribution|incrementality", "Salesforce": r"salesforce", "HubSpot": r"hubspot",
    "Marketo": r"marketo", "Braze": r"braze", "Google Analytics": r"google analytics|\bga4\b", "Segmentation": r"segmentation", "Go-to-market": r"go-to-market|\bgtm\b",
    "Positioning/messaging": r"positioning|messaging", "Pricing": r"\bpricing\b", "Brand strategy": r"brand strateg|brand positioning", "People management": r"direct reports|manage a team|lead a team",
}


def load(path, mode):
    d = json.load(open(path, encoding="utf8"))
    rows = []
    for jid, j in d.get("jobs", {}).items():
        r = d.get("reviews", {}).get(jid) or {}
        rt = r.get("ratings") or []
        if j.get("status") != "reviewed" or not rt:
            continue
        x = rt[0] if mode == "original" else rt[-1]
        rows.append({"id": jid, "company": j.get("company"), "title": j.get("title"), "interest": x["interest"], "qual": x["qualification"], "text": j.get("desc") or "", "family": j.get("roleFamily") or []})
    return d, rows


def share(rows, pat):
    return (sum(1 for r in rows if re.search(pat, r["text"], re.I)) / len(rows)) if rows else None


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("backup"); ap.add_argument("--mode", default="latest", choices=["original", "latest"])
    a = ap.parse_args(); d, rows = load(a.backup, a.mode)
    n = len(rows); print(f"Completed unique jobs: {n} ({a.mode} ratings){'  [PRELIMINARY: <100]' if n < 100 else ''}")
    if not n: return
    I = [r["interest"] for r in rows]; print(f"Mean interest {statistics.mean(I):.2f}; mean qualification {statistics.mean(r['qual'] for r in rows):.2f}")
    hi = [r for r in rows if r["interest"] >= 8]; lo = [r for r in rows if r["interest"] <= 3]; print(f"High (8-10): {len(hi)}   Low (1-3): {len(lo)}")
    print("\nTerm share of postings (high vs low) -- flag when fewer than 5 postings contain it")
    out = []
    for t, p in TERMS.items():
        h, l = share(hi, p), share(lo, p); nh = sum(1 for r in hi if re.search(p, r["text"], re.I)); nl = sum(1 for r in lo if re.search(p, r["text"], re.I))
        if nh + nl: out.append((abs((h or 0) - (l or 0)), t, h, l, nh + nl))
    for _, t, h, l, c in sorted(out, reverse=True):
        f = lambda v: "n/a" if v is None else f"{v:.0%}"
        print(f"  {t:26s} high {f(h):>4s}  low {f(l):>4s}  {'(tentative: <5 postings)' if c < 5 else ''}")


if __name__ == "__main__":
    sys.exit(main())
