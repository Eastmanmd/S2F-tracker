"""Assemble the cached API pulls into the JSON the site reads.

Writes:
  data/models.json     one row per model: specs, metrics, score breakdown
  data/citations.json  index of recent citing articles per model, both axes
  data/headtohead.json which models are jointly evaluated by the same benchmark paper
  data/citations/<id>.json  every citing article for one model, lazily fetched
  data/history.json    append-only weekly snapshot (drives week-over-week deltas)
  data/changelog.json  append-only week-over-week diff, read by the site and feed.xml
  data/meta.json       provenance and corpus-level summary
"""
import datetime
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import changelog as changelog_mod
import config

PERMISSIVE = {"MIT", "APACHE-2.0", "BSD-2-CLAUSE", "BSD-3-CLAUSE", "ISC",
              "CC-BY-4.0"}
COPYLEFT = {"GPL-3.0", "GPL-2.0", "AGPL-3.0", "LGPL-3.0"}


def load(path, default=None):
    if os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    return default if default is not None else {}


def normalize(values):
    """Scale a dict of raw numbers to 0-1. Flat input maps to 0."""
    if not values:
        return {}
    lo, hi = min(values.values()), max(values.values())
    if hi - lo < 1e-9:
        return dict((k, 0.0) for k in values)
    return dict((k, (v - lo) / (hi - lo)) for k, v in values.items())


def biology_share(domain_counts):
    """Share of *classified* citations that are biology work.

    "unclear" is excluded from the denominator rather than counted against
    biology. Papers the classifier abstained on are unknown, not non-biology,
    and burying them in the denominator would understate the number by however
    much the classifier happens to be hedging that week. The count of
    abstentions travels alongside so the reader can see what was set aside.
    """
    method = domain_counts.get("method", 0)
    bio = domain_counts.get("biology", 0)
    decided = method + bio
    if not decided:
        return None
    return round(bio / float(decided), 3)


def license_score(licence):
    """Licence of the code. Restricted licences (academic-only, PolyForm,
    CC-BY-NC) score like an unstated one: usable for research, legally
    unclear or closed for anything else. The access tier already carries the
    weights' restriction, so this does not punish it twice."""
    key = (licence or "").upper()
    if key in PERMISSIVE:
        return 1.0
    if key in COPYLEFT:
        return 0.7
    return 0.3


def openness_score(access, licence, upkeep, upkeep_label):
    """Access tier, licence and upkeep, 0-1.

    Upkeep is dropped and the rest renormalized when no host could date the
    model -- DeepSEA and DeepBind are served from lab websites, and "no
    repository to date" is unknown, not abandoned."""
    parts = [(config.ACCESS_SCORE.get(access or "none", 0.0), 0.40),
             (license_score(licence), 0.25)]
    if upkeep_label != "unknown":
        parts.append((upkeep, 0.35))
    return sum(v * w for v, w in parts) / sum(w for _, w in parts)


def upkeep_score(gh, hfd, today):
    """Days since the model was last touched, from GitHub or Hugging Face.

    Geneformer and friends ship weights through Hugging Face with no GitHub
    repo; without the HF fallback they would read as unmaintained purely for
    choosing a different host.
    """
    stamps = []
    if gh and gh.get("pushed_at"):
        stamps.append(gh["pushed_at"][:10])
    for repo in (hfd or {}).get("repos", []):
        if repo.get("last_modified"):
            stamps.append(repo["last_modified"][:10])
    if not stamps:
        return 0.0, None, "unknown"
    pushed = max(datetime.date(*[int(x) for x in s.split("-")]) for s in stamps)
    days = (today - pushed).days
    if gh and gh.get("archived"):
        return 0.0, days, "archived"
    if days <= config.STALE_DAYS:
        return 1.0, days, "active"
    if days <= 365:
        return 0.6, days, "slowing"
    return 0.2, days, "dormant"


def runnable_score(rd):
    """How practical the model is to actually run, 0-1.

    Scored only on the signals fetch_runnable.py could observe, with the
    remaining weights renormalized. A signal that could not be read is dropped
    rather than failed, so a throttled request never quietly reads as "no
    notebooks, no releases" -- the same reasoning as upkeep_score's Hugging
    Face fallback.

    Returns (value, detail); value is None only when nothing at all was
    observable, which now means a model published on neither GitHub nor
    Hugging Face.
    """
    if not rd:
        return None, None
    signals = rd.get("signals") or {}
    seen = {}
    for key in ("installable", "env", "release", "responsive"):
        if signals.get(key) is not None:
            seen[key] = 1.0 if signals[key] else 0.0
    if signals.get("tutorials") is not None:
        seen["tutorials"] = min(
            1.0, signals["tutorials"] / float(config.TUTORIALS_FULL_CREDIT))

    if not seen:
        return None, None
    observed = sum(config.RUNNABLE_WEIGHTS[k] for k in seen)
    value = sum(config.RUNNABLE_WEIGHTS[k] * v for k, v in seen.items()) / observed
    detail = {
        "signals": dict((k, round(v, 3)) for k, v in seen.items()),
        "observed_weight": round(observed, 3),
        "sources": rd.get("sources") or [],
        "pypi": rd.get("pypi"),
        "pypi_version": rd.get("pypi_version"),
        "release": rd.get("release") or rd.get("hf_tag"),
        "env_files": sorted(set((rd.get("env_files") or []) +
                                (rd.get("hf_env_files") or []))) or None,
        "dockerfile": rd.get("dockerfile"),
        "notebooks": signals.get("tutorials"),
        "closed_issues_90d": rd.get("closed_issues_90d"),
        "hf_resolved_90d": rd.get("hf_resolved_90d"),
    }
    return round(value, 4), detail


def trailing_citations(records, window_start):
    """Citing papers published on or after window_start.

    Counted from the publication date on each citing record rather than from
    the difference between two weekly snapshots. Snapshot arithmetic cannot
    report anything until two snapshots exist and needs a full window before
    the number means what it says; the dates are already on every record, so
    this is exact on the first run and identical for a model added tomorrow.

    No upper bound: journals routinely stamp a record with a future issue date,
    and those citations are real and recent. Records with no date at all are
    skipped, which is currently none of the 4,665 in the corpus.
    """
    return sum(1 for rec in records
               if (rec.get("date") or "") >= window_start)


MIN_PRIOR_FOR_VELOCITY = 10


def velocity(counts_by_year, this_year):
    """Compare the last 3 years of citations against the 3 before them.

    Models younger than about six years have a prior window that mostly
    predates their own publication, which yields nonsense ratios (scGPT read as
    32x). Below a usable baseline the model is simply 'new'.
    """
    counts = dict((int(k), v) for k, v in counts_by_year.items())
    recent = sum(counts.get(y, 0) for y in range(this_year - 2, this_year + 1))
    prior = sum(counts.get(y, 0) for y in range(this_year - 5, this_year - 2))
    if prior < MIN_PRIOR_FOR_VELOCITY:
        return ("new" if recent else "quiet"), None
    ratio = recent / float(prior)
    if ratio >= 1.5:
        label = "surging"
    elif ratio >= 0.7:
        label = "steady"
    else:
        label = "declining"
    return label, round(ratio, 2)


def previous_first_seen(mid):
    """When each citing record for one model was first seen by the tracker.

    Read from the committed data/citations/<id>.json of the previous run --
    the citing files are versioned output, so this survives a cold CI cache in
    a way anything kept under cache/ would not.

    Returns None when there is no previous file at all, which the caller reads
    as "cannot tell what is new here" rather than "everything is new".
    """
    path = os.path.join(config.CITING_DIR, mid + ".json")
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            records = json.load(fh)
    except ValueError:
        return None
    stamps = dict((r["id"], r["first_seen"]) for r in records
                  if r.get("id") and r.get("first_seen"))
    return stamps if stamps else None


def head_to_head(citations_full, order):
    """Which models the field actually evaluates against each other.

    A citing paper labelled "benchmark" that cites two tracked models is an
    independent evaluation covering that pair. The label belongs to the citing
    paper, not to the pairing -- classify.py reads only its title, abstract and
    topics -- so it can never disagree between the two models, and the count is
    symmetric.

    Nothing here costs an API call: it is the citing corpus already on disk,
    intersected. What it cannot see is which models a benchmark paper actually
    put in the same table. A paper that evaluates one model and cites another
    only in its introduction is counted, so the claim is co-citation by an
    evaluating paper, not a verified head-to-head result. The page says so.

    A zero cell means no such paper was found, which is an absence of evidence
    about the pair -- not evidence that one of them lost.
    """
    models_by_work = {}
    record_by_work = {}
    tracked = set(order)
    for mid, records in citations_full.items():
        if mid not in tracked:
            continue
        for rec in records:
            wid = rec.get("id")
            if not wid:
                continue
            models_by_work.setdefault(wid, set()).add(mid)
            record_by_work[wid] = rec

    totals = dict((mid, {"bench": 0, "any": len(citations_full.get(mid, []))})
                  for mid in order)
    pairs = {}
    papers = []

    for wid, mids in models_by_work.items():
        rec = record_by_work[wid]
        is_bench = rec.get("use") == "benchmark"
        mids = sorted(mids)
        if is_bench:
            for mid in mids:
                totals[mid]["bench"] += 1
        for i in range(len(mids)):
            for j in range(i + 1, len(mids)):
                cell = pairs.setdefault(mids[i] + "|" + mids[j],
                                        {"bench": 0, "any": 0})
                cell["any"] += 1
                if is_bench:
                    cell["bench"] += 1
        if is_bench and len(mids) > 1:
            papers.append({
                "id": wid,
                "title": rec.get("title"),
                "doi": rec.get("doi"),
                "venue": rec.get("venue"),
                "date": rec.get("date"),
                "year": rec.get("year"),
                "cited_by_count": rec.get("cited_by_count"),
                "first_author": rec.get("first_author"),
                "n_authors": rec.get("n_authors"),
                "models": mids,
            })

    # Newest first, matching every other article list on the site. Each paper
    # is stored once with the models it covers rather than once per pair, so
    # the file stays small however many models a benchmark sweeps up.
    papers.sort(key=lambda p: (p.get("date") or ""), reverse=True)

    # Pairs no benchmark paper covers are dropped: the matrix renders a blank
    # cell for a missing key, and keeping 100+ zeroed entries only inflates the
    # file. Pairs with co-citations but no benchmark paper are kept, because
    # "cited together 658 times, never jointly evaluated" is the finding.
    pairs = dict((k, v) for k, v in pairs.items() if v["bench"] or v["any"])

    return {
        "order": order,
        "totals": totals,
        "pairs": pairs,
        "papers": papers,
        "benchmark_papers": sum(1 for wid in models_by_work
                                if record_by_work[wid].get("use") == "benchmark"),
        "comparison_papers": len(papers),
    }


def main():
    registry = load(config.REGISTRY_FILE)
    openalex = load(config.OPENALEX_FILE)
    github = load(config.GITHUB_FILE)
    hf = load(config.HF_FILE)
    runnable_cache = load(config.RUNNABLE_FILE)
    usage_cache = load(config.USAGE_FILE)
    history = load(config.HISTORY_FILE, {"snapshots": []})

    today = datetime.date.today()
    this_year = today.year
    today_iso = today.isoformat()

    # ---- previous snapshot, for weekly deltas -------------------------------
    snapshots = history.get("snapshots", [])
    previous = None
    for snap in reversed(snapshots):
        if snap["date"] != today_iso:
            previous = snap
            break
    # Momentum reads the citing records' own dates, so it needs no baseline
    # snapshot. History still drives the week-over-week deltas on the table.
    window_start = (today - datetime.timedelta(
        days=config.MOMENTUM_WINDOW_DAYS)).isoformat()

    rows = []
    arrivals = []          # citing records first seen in this run, one per model hit
    citations_out = {}     # index: top N per model, loaded upfront
    citations_full = {}    # every citing article, one file per model

    for model in registry["models"]:
        mid = model["id"]
        oa = openalex.get(mid, {})
        gh = github.get(mid)
        hfd = hf.get(mid)
        usd = usage_cache.get(mid)

        has_paper = bool(model.get("papers"))
        citations = oa.get("citations_total", 0) if has_paper else None
        counts_by_year = oa.get("counts_by_year", {})
        # None, not 0, when nothing could be read: a model whose code is one
        # folder of a monorepo has no stars of its own, and a model with no
        # download host has no download count. usage is then scored on what
        # exists, or dropped and renormalized when neither does.
        stars = gh.get("stars") if gh else None
        monthly = []
        if hfd and hfd.get("downloads") is not None:
            monthly.append(hfd["downloads"])            # already 30-day
        if usd and usd.get("downloads_per_month") is not None:
            monthly.append(usd["downloads_per_month"])  # Zenodo + PyPI, per month
        downloads = round(sum(monthly), 1) if monthly else None
        upkeep, days_since_push, upkeep_label = upkeep_score(gh, hfd, today)
        runnable, runnable_detail = runnable_score(runnable_cache.get(mid))
        # "Could not observe" and "nothing exists to observe" are different
        # answers, and only the first may be dropped and renormalized. A model
        # with no public repository and no weights on any tracked host (DeepSEA
        # and DeepBind, served from lab websites) has no code to install and no
        # download count anywhere -- dropping those components would rank it on
        # citations alone and put it at #1 for having nothing to fail at, the
        # exact failure the scFM tracker hit with Geneformer.
        has_code = bool(model.get("github") or model.get("hf"))
        has_usage_host = bool(
            (model.get("github") and not model.get("github_path"))
            or model.get("github_also") or model.get("hf")
            or any(w.get("host") in ("zenodo",) for w in model.get("weights") or [])
            or (runnable_cache.get(mid) or {}).get("pypi"))
        if runnable is None and not has_code:
            runnable = 0.0
            runnable_detail = {"note": "no public code repository"}
        vel_label, vel_ratio = velocity(counts_by_year, this_year)

        prev_row = (previous or {}).get("models", {}).get(mid, {})
        citations_12m = trailing_citations(oa.get("citing", []), window_start) if has_paper else None

        rows.append({
            "id": mid,
            "name": model["name"],
            "class": model["class"],
            "parent": model.get("parent"),
            "org": model["org"],
            "year": model["year"],
            "notes": model.get("notes"),
            "source_url": model.get("source_url"),
            "code_url": "https://github.com/" + model["github"] if model.get("github") else None,
            "weights_urls": ["https://huggingface.co/" + name for name in model.get("hf", [])],
            "training_data": model.get("training_data"),
            "context_bp": model.get("context_bp"),
            "output": model.get("output"),
            "resolution_bp": model.get("resolution_bp"),
            "n_tracks": model.get("n_tracks"),
            "readouts": model.get("readouts", []),
            "species": model.get("species", []),
            "access": model.get("access"),
            # The curated licence wins: GitHub reports NOASSERTION for every
            # custom academic licence, which is most of the Zhou and Princeton
            # lineage, and that string says nothing a reader can use.
            "license": model.get("license") or (gh or {}).get("license"),
            "papers": oa.get("versions", []),
            "citations": citations,
            "citations_naive_sum": oa.get("citations_naive_sum", 0),
            "citations_12m": citations_12m,
            "counts_by_year": counts_by_year,
            "use_counts": oa.get("use_counts", {}),
            "domain_counts": oa.get("domain_counts", {}),
            "biology_share": biology_share(oa.get("domain_counts", {})),
            "abstract_coverage": oa.get("abstract_coverage", 0.0),
            "velocity": vel_label,
            "velocity_ratio": vel_ratio,
            "github": gh,
            "stars": stars,
            "usage_detail": usd,
            "upkeep": upkeep_label,
            "days_since_push": days_since_push,
            "hf": hfd,
            "runnable": runnable,
            "runnable_detail": runnable_detail,
            "downloads_per_month": downloads,
            "citations_delta": (citations - prev_row["citations"]
                                if citations is not None and prev_row.get("citations") is not None else None),
            "stars_delta": (stars - prev_row["stars"]
                            if stars is not None and prev_row.get("stars") is not None
                            else None),
            "_upkeep_raw": upkeep,
            "_upkeep_label": upkeep_label,
            "_usage_untracked": not has_usage_host,
        })
        # Drop the classifier's raw inputs before they reach the browser --
        # abstracts alone would multiply the payload several times over for
        # text nothing on the page renders.
        full = [
            dict((k, v) for k, v in rec.items()
                 if k not in ("abstract", "topic_names", "has_abstract"))
            for rec in oa.get("citing", [])
        ]
        # Stamp when the tracker first saw each record, carrying forward what
        # the previous run knew. This is what makes "new this week" answerable:
        # a 2024 paper OpenAlex indexed last Tuesday is new to the site now,
        # and its publication date would file it under a week long past.
        seen = previous_first_seen(mid)
        for rec in full:
            rec["first_seen"] = (seen or {}).get(rec["id"], today_iso)
        if seen is not None:
            # "Not in the previous run's file", not "stamped today". The two
            # agree on every normal run and disagree exactly once: a rerun on
            # the same day as the backfill, where every carried-forward record
            # still reads as today's and the feed would announce the entire
            # corpus. Comparing identities cannot drift with the calendar.
            for rec in full:
                if rec["id"] not in seen:
                    arrivals.append(dict(rec, model=mid))
        # The whole list goes in the model's own file, fetched only when its
        # page is opened. The index keeps the most recent few, which is what
        # the leaderboard and the cross-model feed read on first load.
        citations_full[mid] = full
        citations_out[mid] = full[:config.CITING_PER_MODEL]

    # ---- score components ---------------------------------------------------
    attention = normalize(dict((r["id"], math.log1p(r["citations"])) for r in rows if r["citations"] is not None))
    usage = normalize(dict(
        (r["id"], math.log1p(r["stars"] or 0) + math.log1p(r["downloads_per_month"] or 0))
        for r in rows
        if r["stars"] is not None or r["downloads_per_month"] is not None
        or r["_usage_untracked"]))

    # Momentum is the count of citations arriving in the trailing window, read
    # off the citing papers' own publication dates. This replaces a two-branch
    # scheme that measured different things depending on how much history had
    # accumulated -- an absolute delta once snapshots were deep enough, and the
    # *share* of citations from the last two years before that. A count and a
    # ratio rank models differently, so the leaderboard would have reshuffled
    # on the week the branch flipped, for no reason a reader could see.
    momentum_raw = dict((r["id"], math.log1p(r["citations_12m"])) for r in rows if r["citations_12m"] is not None)
    momentum_basis = "citations dated in the trailing {} days".format(
        config.MOMENTUM_WINDOW_DAYS)
    momentum = normalize(momentum_raw)

    openness = {}
    for row in rows:
        openness[row["id"]] = openness_score(
            row["access"], row["license"], row["_upkeep_raw"], row["_upkeep_label"])

    weights = config.SCORE_WEIGHTS
    for row in rows:
        parts = {
            "attention": attention.get(row["id"]),
            "momentum": momentum.get(row["id"]),
            "usage": usage.get(row["id"]),
            "openness": openness.get(row["id"], 0.0),
            "runnable": row["runnable"],
        }
        # A component with no data is dropped and the rest are renormalized, so
        # a model distributed without a repository is scored on what can be
        # measured for it instead of carrying a zero for a question nobody
        # asked it. With every component present this is the plain weighted
        # sum it has always been.
        known = dict((k, v) for k, v in parts.items() if v is not None)
        observed = sum(weights[k] for k in known) or 1.0
        row["components"] = dict((k, round(v, 4)) for k, v in known.items())
        row["components_missing"] = sorted(k for k in weights if k not in known)
        row["score"] = round(
            100 * sum(known[k] * weights[k] for k in known) / observed, 1)
        if row["citations"] is None:
            row["score"] = None
        row["usage_untracked"] = row.pop("_usage_untracked")
        del row["_upkeep_raw"]
        del row["_upkeep_label"]

    rows.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0)))
    # Two ranks. "rank" is across every tracked model, so a number never
    # changes when the gray-zone toggle does; "view_rank" is the position in
    # the default view (core + derivative), which is what the page shows first.
    view_pos = 0
    rank = 0
    for row in rows:
        if row["score"] is None:
            row["rank"] = row["view_rank"] = None
            continue
        rank += 1
        row["rank"] = rank
        if row["class"] in config.CORE_CLASSES:
            view_pos += 1
            row["view_rank"] = view_pos
        else:
            row["view_rank"] = None

    # ---- append today's snapshot -------------------------------------------
    # Everything the changelog compares week over week has to be in here: a
    # field that is not snapshotted has no previous value to diff against, and
    # rank, licence and upkeep are exactly the changes worth reporting.
    snapshot = {
        "date": today_iso,
        "models": dict((r["id"], {"citations": r["citations"],
                                  "stars": r["stars"],
                                  "downloads_per_month": r["downloads_per_month"],
                                  "access": r["access"],
                                  "biology_share": r["biology_share"],
                                  "rank": r["rank"],
                                  "score": r["score"],
                                  "license": r["license"],
                                  "upkeep": r["upkeep"],
                                  "benchmark": r["use_counts"].get("benchmark", 0),
                                  "runnable": r["runnable"]})
                       for r in rows),
    }
    snapshots = [s for s in snapshots if s["date"] != today_iso] + [snapshot]
    snapshots.sort(key=lambda s: s["date"])

    if not os.path.isdir(config.DATA_DIR):
        os.makedirs(config.DATA_DIR)

    with open(config.HISTORY_FILE, "w") as fh:
        json.dump({"snapshots": snapshots}, fh, indent=1)
    with open(os.path.join(config.DATA_DIR, "models.json"), "w") as fh:
        json.dump({"models": rows}, fh)
    with open(os.path.join(config.DATA_DIR, "citations.json"), "w") as fh:
        json.dump(citations_out, fh)

    h2h_path = os.path.join(config.DATA_DIR, "headtohead.json")
    prev_h2h = load(h2h_path, None)      # read before it is overwritten below
    h2h = head_to_head(citations_full, [r["id"] for r in rows])
    with open(h2h_path, "w") as fh:
        json.dump(h2h, fh)

    # ---- what changed since the previous run --------------------------------
    # One record per work, carrying every model it cites, so a benchmark
    # sweeping up ten models is one line in the feed rather than ten.
    by_work = {}
    for rec in arrivals:
        entry = by_work.setdefault(rec["id"], dict(rec, models=[]))
        entry["models"].append(rec["model"])
    new_records = sorted(by_work.values(),
                         key=lambda r: (r.get("date") or ""), reverse=True)

    existing_log = load(config.CHANGELOG_FILE, {"entries": []})
    # The first run after this feature lands has no previous state to diff, so
    # it publishes a baseline rather than announcing the entire corpus as new.
    # Baseline is decided by earlier *days*, not by whether any entry exists:
    # a same-day rerun of the very first run still has no previous snapshot,
    # and without this it would announce every model as newly added.
    earlier = [e for e in existing_log.get("entries", []) if e.get("date") != today_iso]
    entry = changelog_mod.build(rows, previous, h2h, prev_h2h, new_records,
                                today_iso, not earlier)
    with open(config.CHANGELOG_FILE, "w") as fh:
        json.dump(changelog_mod.append(existing_log, entry), fh, indent=1)

    # One file per model. Stale files are removed rather than left behind: a
    # model dropped from the registry would otherwise keep serving a citing
    # list that nothing on the site can reach or refresh.
    if not os.path.isdir(config.CITING_DIR):
        os.makedirs(config.CITING_DIR)
    for name in os.listdir(config.CITING_DIR):
        if name.endswith(".json") and name[:-5] not in citations_full:
            os.remove(os.path.join(config.CITING_DIR, name))
    for mid, records in citations_full.items():
        with open(os.path.join(config.CITING_DIR, mid + ".json"), "w") as fh:
            json.dump(records, fh)

    total_citations = sum(r["citations"] or 0 for r in rows)
    use_totals = {}
    for row in rows:
        for key, count in row["use_counts"].items():
            use_totals[key] = use_totals.get(key, 0) + count
    # Per-model tallies double-count any paper citing more than one model, so
    # the corpus figure comes from the deduped count the fetcher writes.
    corpus = openalex.get("_corpus", {})
    domain_totals = corpus.get("domain_counts", {})

    meta = {
        "updated": today_iso,
        "models_tracked": len(rows),
        "total_citations": total_citations,
        "open_weights": sum(1 for r in rows if r["access"] == "open"),
        "class_counts": dict((c, sum(1 for r in rows if r["class"] == c))
                             for c in config.CORE_CLASSES + config.GRAY_CLASSES),
        "actively_maintained": sum(1 for r in rows if r["upkeep"] == "active"),
        "weights": weights,
        "momentum_basis": momentum_basis,
        "momentum_window_days": config.MOMENTUM_WINDOW_DAYS,
        "history_depth": len(snapshots),
        "use_totals": use_totals,
        "domain_totals": domain_totals,
        "biology_share": biology_share(domain_totals),
        "unique_citing_works": corpus.get("unique_citing_works", 0),
        "citing_index_per_model": config.CITING_PER_MODEL,
        "citing_records_total": sum(len(v) for v in citations_full.values()),
        "sources": ["OpenAlex", "GitHub", "Hugging Face Hub", "PyPI (pypistats.org)",
                    "Zenodo", "Kaggle"],
        "usage_basis": ("GitHub stars plus downloads per month: Hugging Face 30-day, "
                        "PyPI last month, Zenodo lifetime monthly average"),
    }
    with open(os.path.join(config.DATA_DIR, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)

    print("{:<4}{:<24}{:>7}{:>8}{:>7}{:>9}{:>9}{:>7}  {}".format(
        "#", "model", "score", "cites", "12mo", "stars", "dl/mo", "run", "upkeep"))
    for row in rows:
        print("{:<4}{:<24}{:>7}{:>8}{:>7}{:>9}{:>9}{:>7}  {} / {}".format(
            row["rank"] or "-", row["name"][:23], row["score"] if row["score"] is not None else "-", row["citations"] if row["citations"] is not None else "-",
            row["citations_12m"] if row["citations_12m"] is not None else "-",
            "-" if row["stars"] is None else row["stars"],
            "-" if row["downloads_per_month"] is None else int(row["downloads_per_month"]),
            "-" if row["runnable"] is None else int(round(row["runnable"] * 100)),
            row["upkeep"], row["velocity"]))
    print("\nhead-to-head: {} benchmark papers, {} of them citing 2+ models".format(
        h2h["benchmark_papers"], h2h["comparison_papers"]))
    print("changelog: {} event(s) for {}".format(len(entry["events"]), today_iso))
    print("\nmomentum basis: {}".format(momentum_basis))
    print("history depth: {} snapshot(s)".format(len(snapshots)))


if __name__ == "__main__":
    main()
