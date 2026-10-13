#!/usr/bin/env python3
"""Source real postings from official applicant-tracking-system APIs (Greenhouse, Ashby). Standard library only.

  python3 tools/source.py scan  [--boards data/boards.json] [--out FILE]   list marketing-related open postings across boards
  python3 tools/source.py build --pick gh:airbnb:12345 ash:ramp:<uuid> ... --policy v1 --out batch.json
                                                                           fetch full text, verify still open, emit batch JSON

Nothing is estimated: salary comes only from the posting's published pay fields; unknown fields stay absent (the app shows "Unknown").
Company-level facts are NOT produced here; they are added separately with explicit provenance.
"""
import argparse, html, json, re, sys, urllib.request, urllib.error, datetime
from html.parser import HTMLParser

UA = {"User-Agent": "10dreamjobs-sourcing/1.0 (personal job research)"}

FAMILIES = [
    ("Consumer Insights", r"consumer insight|customer insight|insights (manager|lead|director|analyst)|voice of (the )?customer|\binsights\b"),
    ("Marketing Research", r"market(ing)? research|research (manager|lead|director)|ux research|user research"),
    ("Marketing Analytics", r"marketing analytic|marketing (science|measurement)|measurement|attribution|marketing data|analytics (manager|lead|director)|decision science"),
    ("Product Marketing", r"product marketing|\bpmm\b"),
    ("Brand", r"\bbrand\b"),
    ("Lifecycle/CRM", r"lifecycle|\bcrm\b|retention marketing|email marketing|customer marketing|marketing automation"),
    ("Performance Marketing", r"performance marketing|paid (media|social|search)|acquisition marketing|\bsem\b|user acquisition"),
    ("Growth", r"\bgrowth\b"),
    ("Marketing Operations", r"marketing operations|marketing ops|martech|marketing technology"),
    ("Partnerships", r"partner(ship)?s? marketing|partnerships?|alliances"),
    ("Strategy", r"marketing strategy|strategy (&|and) (planning|operations)|go-to-market|\bgtm\b|strategic marketing"),
    ("Content/Communications", r"content (marketing|strategy)|communications|thought leadership|editorial"),
    ("Category/Channel Marketing", r"category marketing|channel marketing|field marketing|demand gen|segment marketing|industry marketing"),
]
MKT = re.compile(r"market|brand|growth|insight|lifecycle|\bcrm\b|demand gen|communications|go-to-market|content strategy|partnerships", re.I)
EXCL = re.compile(r"intern\b|internship|\bcoordinator\b|assistant|recruit|account executive|sales development|software engineer|\bengineer\b|counsel|attorney|accountant|payroll|designer\b", re.I)


# Geography rule (sourcing policy v2): keep a role only if New York is one of its location options, or it is remote with
# US-compatible eligibility. Anything exclusively in another geography is dropped. Unknown location text is NOT assumed eligible.
NY = re.compile(r"new york|\bnyc\b|\bny\b|brooklyn|manhattan", re.I)
REMOTE = re.compile(r"remote|anywhere|distributed|work from home|\bwfh\b", re.I)
US = re.compile(r"\b(us|usa|u\.s\.|united states|north america|americas)\b", re.I)
FOREIGN = re.compile(r"\b(india|canada|uk|u\.k\.|united kingdom|england|ireland|germany|france|spain|italy|japan|singapore|australia|brazil|mexico|emea|apac|latam|europe|china|korea|poland|netherlands|israel|dublin|london|berlin|toronto|bangalore|bengaluru|sydney|tokyo|paris|madrid|amsterdam|argentina|colombia|philippines|portugal|sweden|denmark|switzerland|uae|dubai)\b", re.I)


def geo_ok(loc, is_remote=False, country=None):
    """Return (ok, reason). loc may contain several locations."""
    t = loc or ""
    if NY.search(t): return True, "New York is a listed location"
    remote = is_remote or bool(REMOTE.search(t))
    if remote:
        if US.search(t) or (country or "").upper() in ("US", "USA", "UNITED STATES"): return True, "Remote, US-eligible"
        if FOREIGN.search(t) or (country and (country or "").upper() not in ("US", "USA", "UNITED STATES")): return False, "Remote but tied to another geography"
        return True, "Remote (region not specified)"
    return False, "Not New York and not remote"


def get(url, timeout=40):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf8", "replace")


class T(HTMLParser):
    """HTML -> text keeping headings, paragraphs and bullets."""
    def __init__(self):
        super().__init__(); self.o = []; self.list = []
    def handle_starttag(self, t, a):
        if t in ("ul", "ol"): self.list.append([t, 0]); self.o.append("\n")
        elif t == "li":
            if self.list and self.list[-1][0] == "ol": self.list[-1][1] += 1; self.o.append(f"\n{self.list[-1][1]}. ")
            else: self.o.append("\n• ")
        elif t in ("p", "div", "br", "tr"): self.o.append("\n")
        elif t in ("h1", "h2", "h3", "h4", "h5", "h6"): self.o.append("\n\n")
    def handle_endtag(self, t):
        if t in ("ul", "ol") and self.list: self.list.pop(); self.o.append("\n")
        elif t in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6"): self.o.append("\n")
    def handle_data(self, d): self.o.append(d)


def to_text(h):
    p = T(); p.feed(html.unescape(h) if "&lt;" in h else h)
    s = "".join(p.o).replace("\xa0", " ")
    s = re.sub(r"[ \t]+\n", "\n", s); s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def family(title):
    f = [n for n, p in FAMILIES if re.search(p, title, re.I)]
    return f or ["Adjacent: Other"]


def seniority(title):
    t = title.lower()
    if re.search(r"\b(vp|vice president|svp|evp|chief|head of)\b", t): return "VP+"
    if re.search(r"senior director|sr\.? director|group director|principal", t): return "Director"
    if "director" in t: return "Director"
    if re.search(r"senior manager|sr\.? manager|staff", t): return "Senior Manager"
    if "manager" in t or "lead" in t: return "Manager"
    if re.search(r"senior|sr\.", t): return "Senior"
    if re.search(r"associate|junior|entry", t): return "Associate"
    return "Unknown"


def arrangement(loc, text=""):
    s = (loc or "").lower()
    if "remote" in s: return "Remote"
    if "hybrid" in s: return "Hybrid"
    return "Unknown"


def pay_gh(job):
    r = job.get("pay_input_ranges") or []
    if not r: return None
    x = r[0]
    cur = x.get("currency_type"); lo = x.get("min_cents"); hi = x.get("max_cents")
    lo = lo / 100 if lo is not None else None; hi = hi / 100 if hi is not None else None
    txt = f"{cur} {lo:,.0f} - {hi:,.0f} (published pay range" + (f": {x.get('title')}" if x.get("title") else "") + ")" if lo is not None and hi is not None else None
    return {"text": txt, "min": lo, "max": hi, "currency": cur, "period": "year", "basis": "as published (base vs total comp not stated)",
            "byLocation": [{"min": (y.get("min_cents") or 0) / 100, "max": (y.get("max_cents") or 0) / 100, "currency": y.get("currency_type"), "label": y.get("title")} for y in r[1:]] or None}


def gh_list(slug):
    s, b = get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
    return json.loads(b).get("jobs", [])


def ash_list(slug):
    s, b = get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")
    return json.loads(b).get("jobs", [])


def already_sourced():
    import glob
    keys = set()
    for f in glob.glob("data/batch_b*.json"):
        for j in json.load(open(f)):
            keys.add((j.get("sourceUrl") or "").rstrip("/"))
    return keys


def cmd_scan(a):
    boards = json.load(open(a.boards))
    seen = already_sourced(); out = []
    for b in boards:
        try:
            jobs = gh_list(b["slug"]) if b["ats"] == "gh" else ash_list(b["slug"])
        except Exception as e:
            print(f"! {b['slug']}: {e}", file=sys.stderr); continue
        for j in jobs:
            title = j.get("title", ""); loc = (j.get("location") or {}).get("name") if b["ats"] == "gh" else j.get("location")
            if not MKT.search(title) or EXCL.search(title): continue
            jid = str(j["id"])
            if b["ats"] == "gh": locs, rem, ctry = loc, False, None
            else:
                sec = " ; ".join(x.get("location", "") if isinstance(x, dict) else str(x) for x in (j.get("secondaryLocations") or []))
                locs = " ; ".join(x for x in [loc, sec] if x); rem = bool(j.get("isRemote")) or (j.get("workplaceType") == "Remote")
                ctry = ((j.get("address") or {}).get("postalAddress") or {}).get("addressCountry")
            ok, why = geo_ok(locs, rem, ctry)
            if a.geo and not ok: continue
            url = f"https://job-boards.greenhouse.io/{b['slug']}/jobs/{jid}" if b["ats"] == "gh" else j.get("jobUrl", "")
            if url.rstrip("/") in seen: continue
            out.append({"key": f"{b['ats']}:{b['slug']}:{jid}", "company": b["name"], "title": title, "location": locs, "geo": why, "family": family(title), "seniority": seniority(title)})
    json.dump(out, open(a.out, "w"), indent=1)
    for o in out: print(f"{o['key']:40s} | {o['company'][:18]:18s} | {o['title'][:60]:60s} | {str(o['location'])[:28]:28s} | {','.join(o['family'])[:30]} | {o['seniority']}")
    print(f"\n{len(out)} candidate postings across {len(boards)} boards", file=sys.stderr)


def build_one(key, policy, batch):
    ats, slug, jid = key.split(":", 2)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(); wt = None
    if ats == "gh":
        s, b = get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}?pay_transparency=true")
        j = json.loads(b); loc = (j.get("location") or {}).get("name")
        desc = to_text(j.get("content", ""))
        dept = ", ".join(d.get("name") for d in (j.get("departments") or []) if d.get("name")) or None
        employer_url = j.get("absolute_url"); url = f"https://job-boards.greenhouse.io/{slug}/jobs/{jid}"; req = str(j.get("internal_job_id") or j.get("requisition_id") or "") or None
        posted = (j.get("first_published") or j.get("updated_at") or "")[:10] or None
        sal = pay_gh(j)
        # a closed posting returns 404 above, so reaching here means the API still serves it
        status = "Open (employer ATS API returned posting on verification date)"
    else:
        s, b = get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")
        j = next((x for x in json.loads(b).get("jobs", []) if str(x["id"]) == jid), None)
        if not j: raise RuntimeError(f"{key} no longer listed")
        loc = "; ".join(x for x in [j.get("location")] + [(y.get("location") if isinstance(y, dict) else str(y)) for y in (j.get("secondaryLocations") or [])] if x); wt = j.get("workplaceType"); desc = (j.get("descriptionPlain") or to_text(j.get("descriptionHtml", ""))).strip(); dept = j.get("department") or j.get("team")
        employer_url = j.get("jobUrl"); url = employer_url; req = None; posted = (j.get("publishedAt") or "")[:10] or None
        c = j.get("compensation") or {}
        sal = {"text": c.get("compensationTierSummary") or c.get("scrapeableCompensationSalarySummary"), "basis": "as published"} if (c.get("compensationTierSummary") or c.get("scrapeableCompensationSalarySummary")) else None
        status = "Open (employer ATS API listed posting on verification date)"
    if not desc or len(desc) < 400:
        raise RuntimeError(f"{key} description too short ({len(desc or '')} chars)")
    title = j.get("title") or j.get("name")
    # head-of-text provenance: location can be a list in some Ashby postings
    return {"company": None, "title": title, "division": dept, "location": loc, "arrangement": {"Remote": "Remote", "Hybrid": "Hybrid", "OnSite": "On-site"}.get(wt) or arrangement(loc),
            "sourceUrl": url, "employerUrl": employer_url, "reqId": req, "postedDate": posted, "verifiedAt": now, "postingStatus": status, "desc": desc, "descComplete": True,
            "roleFamily": family(title), "seniority": seniority(title), "salary": sal, "atsPlatform": "Greenhouse" if ats == "gh" else "Ashby",
            "extraction": {"completeness": "Full description retrieved from official ATS API", "missing": [k for k, v in {"salary": sal, "division": dept, "reqId": req}.items() if not v], "provenance": {"description": "ATS API", "salary": "ATS API pay fields" if sal else "not published"}}}


def cmd_build(a):
    boards = {(b["ats"], b["slug"]): b for b in json.load(open(a.boards))}
    out = []
    for key in a.pick:
        ats, slug, _ = key.split(":", 2)
        try:
            j = build_one(key, a.policy, a.batch); j["company"] = boards[(ats, slug)]["name"]; j["companyData"] = boards[(ats, slug)].get("companyData", {}); out.append(j)
            print(f"ok   {key}  {len(j['desc'])} chars", file=sys.stderr)
        except Exception as e:
            print(f"FAIL {key}: {e}", file=sys.stderr)
    json.dump(out, open(a.out, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="c", required=True)
    s = sp.add_parser("scan"); s.add_argument("--boards", default="data/boards.json"); s.add_argument("--out", default="/dev/null"); s.add_argument("--geo", action=argparse.BooleanOptionalAction, default=True, help="apply the New York-or-remote rule (policy v2)"); s.set_defaults(f=cmd_scan)
    b = sp.add_parser("build"); b.add_argument("--boards", default="data/boards.json"); b.add_argument("--pick", nargs="+", required=True); b.add_argument("--policy", default="v1"); b.add_argument("--batch", default=""); b.add_argument("--out", required=True); b.set_defaults(f=cmd_build)
    a = ap.parse_args(); a.f(a)
