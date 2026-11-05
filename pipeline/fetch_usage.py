"""Downloads from the places S2F weights actually live.

The scFM tracker could read usage off Hugging Face alone. This field cannot:
Enformer ships through Kaggle, the Kelley- and Zhou-lineage models through
Zenodo or cloud buckets, and the most-used tools of all (SpliceAI, the
AlphaGenome client) through PyPI. Reading only Hugging Face would score most of
the field's workhorses as unused.

Three sources, each reported in its own unit and converted to one -- downloads
per month -- before anything is added up:

  pypi    last-month downloads from pypistats.org, for the package
          fetch_runnable.py verified links back to the model's repo (or the
          one named in registry.json). Already monthly.
  zenodo  all-time downloads of the record's concept DOI (every version).
          Converted to a lifetime monthly average: downloads / months since
          the record was created. Zenodo exposes no windowed count, and a
          lifetime average is the same measure every week, which a delta
          against last week's snapshot would not be until history is deep.
  kaggle  the public API reports votes, not downloads. Recorded and shown,
          never added to the download total -- a vote is not a pull.

Hugging Face downloads are already 30-day and come from fetch_hf.py; build_data
adds them in. Cloud-bucket and website hosts report nothing and are listed only.

Must run after fetch_runnable.py, which decides which PyPI package (if any)
belongs to each model. A package is never guessed here.

A failed call leaves that source absent, never zero: the previous run's value
is carried forward and marked stale, the same rule every other fetcher follows.
"""
import datetime
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config


def get(url, params=None, attempts=4):
    delay = 3.0
    for attempt in range(attempts):
        try:
            resp = requests.get(url, params=params, timeout=40,
                                headers={"User-Agent": config.USER_AGENT})
        except requests.RequestException:
            resp = None
        if resp is not None and resp.status_code == 200:
            try:
                return resp.json(), 200
            except ValueError:
                return None, "unparseable"
        status = resp.status_code if resp is not None else 0
        if status == 404:
            return None, 404
        if attempt < attempts - 1 and status in (0, 429, 500, 502, 503, 504):
            time.sleep(delay)
            delay *= 2
            continue
        return None, status
    return None, 0


def months_since(iso, today):
    start = datetime.date(*[int(x) for x in iso[:10].split("-")])
    return max(1.0, (today - start).days / 30.44)


def zenodo(record_id, today):
    data, status = get("{}/{}".format(config.ZENODO_API, record_id))
    time.sleep(config.USAGE_DELAY)
    if data is None:
        return None, status
    stats = data.get("stats") or {}
    downloads = stats.get("downloads")
    created = data.get("created") or (data.get("metadata") or {}).get("publication_date")
    # Concept-level count covers every version; the record date of the latest
    # version would overstate the monthly rate, so date from the concept's
    # oldest known stamp -- publication_date when present.
    pub = (data.get("metadata") or {}).get("publication_date") or created
    out = {
        "id": str(record_id),
        "url": "https://zenodo.org/records/{}".format(data.get("id")),
        "title": (data.get("metadata") or {}).get("title"),
        "downloads_all_time": downloads,
        "views_all_time": stats.get("views"),
        "since": pub[:10] if pub else None,
    }
    if downloads is not None and pub:
        out["downloads_per_month"] = round(downloads / months_since(pub, today), 1)
    return out, 200


def kaggle(ref):
    data, status = get("{}/{}/get".format(config.KAGGLE_API, ref))
    time.sleep(config.USAGE_DELAY)
    if data is None:
        return None, status
    return {"id": ref, "url": data.get("url") or "https://www.kaggle.com/models/" + ref,
            "votes": data.get("voteCount"), "published": (data.get("publishTime") or "")[:10]}, 200


def pypistats(package):
    data, status = get("{}/{}/recent".format(config.PYPISTATS_API, package.lower()))
    time.sleep(config.USAGE_DELAY)
    if data is None:
        return None, status
    recent = data.get("data") or {}
    return {"package": package, "url": "https://pypi.org/project/{}/".format(package),
            "downloads_last_month": recent.get("last_month")}, 200


def main():
    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)
    runnable = {}
    if os.path.exists(config.RUNNABLE_FILE):
        with open(config.RUNNABLE_FILE) as fh:
            runnable = json.load(fh)
    else:
        print("note: no {} -- PyPI downloads need fetch_runnable.py first".format(
            os.path.basename(config.RUNNABLE_FILE)))

    previous = {}
    if os.path.exists(config.USAGE_FILE):
        with open(config.USAGE_FILE) as fh:
            previous = json.load(fh)

    today = datetime.date.today()
    out = {}
    failures = []
    for model in registry["models"]:
        mid = model["id"]
        rec = {"zenodo": [], "kaggle": [], "pypi": None, "listed": []}
        old = previous.get(mid) or {}

        for host in model.get("weights") or []:
            kind = host.get("host")
            if kind == "zenodo":
                got, status = zenodo(host["id"], today)
                if got is None:
                    failures.append((mid, "zenodo " + str(host["id"]), status))
                    carried = [z for z in old.get("zenodo", [])
                               if z.get("id") == str(host["id"])]
                    rec["zenodo"].extend(dict(z, stale=True) for z in carried)
                    continue
                rec["zenodo"].append(got)
            elif kind == "kaggle":
                got, status = kaggle(host["id"])
                if got is None:
                    failures.append((mid, "kaggle " + host["id"], status))
                    rec["kaggle"].extend(dict(k, stale=True) for k in old.get("kaggle", [])
                                         if k.get("id") == host["id"])
                    continue
                rec["kaggle"].append(got)
            else:
                rec["listed"].append({"host": kind, "url": host.get("url") or host.get("id")})

        package = (runnable.get(mid) or {}).get("pypi")
        if package:
            got, status = pypistats(package)
            if got is None:
                failures.append((mid, "pypistats " + package, status))
                if old.get("pypi"):
                    rec["pypi"] = dict(old["pypi"], stale=True)
            else:
                rec["pypi"] = got

        monthly = 0.0
        known = False
        for z in rec["zenodo"]:
            if z.get("downloads_per_month") is not None:
                monthly += z["downloads_per_month"]
                known = True
        if rec["pypi"] and rec["pypi"].get("downloads_last_month") is not None:
            monthly += rec["pypi"]["downloads_last_month"]
            known = True
        rec["downloads_per_month"] = round(monthly, 1) if known else None

        if known or rec["kaggle"] or rec["listed"]:
            out[mid] = rec
            print("{:<24} {:>9}/mo  zenodo {}  pypi {}  kaggle votes {}".format(
                mid, "-" if rec["downloads_per_month"] is None else int(rec["downloads_per_month"]),
                len(rec["zenodo"]),
                (rec["pypi"] or {}).get("downloads_last_month", "-"),
                ",".join(str(k.get("votes")) for k in rec["kaggle"]) or "-"))

    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)
    with open(config.USAGE_FILE, "w") as fh:
        json.dump(out, fh, indent=2)
    if failures:
        print("\n{} call(s) failed; previous values carried where known:".format(len(failures)))
        for mid, what, status in failures:
            print("  [{}] {} (http {})".format(mid, what, status))
    print("Wrote {}".format(config.USAGE_FILE))


if __name__ == "__main__":
    main()
