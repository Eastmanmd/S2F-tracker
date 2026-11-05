"""Repo stats: stars, forks, license, and how recently anyone touched the code.

Last-commit date is the point of this step. Citations measure attention paid to
a model; commit recency measures whether it is still maintained.

Two registry fields change what a repo is allowed to say about a model:

  github_path   The model is one folder of a shared repository -- Enformer is
                enformer/ inside google-deepmind/deepmind-research (15k stars,
                hundreds of unrelated projects), Akita is manuscripts/akita in
                calico/basenji. Crediting the repo's stars would hand Enformer
                the whole DeepMind research back catalogue. So stars are NOT
                credited (recorded as repo_stars for display only), and upkeep
                reads the last commit touching that folder instead of the
                repo-wide push date.
  github_also   Extra repositories of the same model -- AlphaGenome's API
                client beside its research code. Stars are summed and the most
                recent push wins.

A repo listed by more than one model WITHOUT a path (calico/basenji is both
Basenji and Basenji2) is shared honestly: both models are that codebase. The
row is flagged shared_with so the site can say so rather than hide it.
"""
import json
import os
import sys
import time
try:
    from urllib.parse import quote
except ImportError:                      # pragma: no cover
    from urllib import quote

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config


def headers():
    head = {"Accept": "application/vnd.github+json", "User-Agent": config.USER_AGENT}
    if config.GITHUB_TOKEN:
        head["Authorization"] = "Bearer {}".format(config.GITHUB_TOKEN)
    return head


def get(url, attempts=4):
    delay = 2.0
    for attempt in range(attempts):
        try:
            resp = requests.get(url, headers=headers(), timeout=30)
        except requests.RequestException:
            if attempt < attempts - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return None, 0
        if resp.status_code == 200:
            return resp.json(), 200
        if resp.status_code == 404:
            return None, 404
        if attempt < attempts - 1 and resp.status_code in (403, 429, 500, 502, 503):
            time.sleep(delay)
            delay *= 2
            continue
        return None, resp.status_code
    return None, 0


def repo_info(slug):
    data, status = get("{}/repos/{}".format(config.GITHUB_API, slug))
    time.sleep(config.GITHUB_DELAY)
    return data, status


def last_commit_on_path(slug, path):
    """ISO timestamp of the newest commit touching `path`, or None if unknown."""
    data, status = get("{}/repos/{}/commits?path={}&per_page=1".format(
        config.GITHUB_API, slug, quote(path)))
    time.sleep(config.GITHUB_DELAY)
    if not data:
        return None, status
    commit = (data[0].get("commit") or {})
    stamp = ((commit.get("committer") or {}).get("date")
             or (commit.get("author") or {}).get("date"))
    return stamp, status


def main():
    with open(config.REGISTRY_FILE) as fh:
        registry = json.load(fh)

    # Which models list each repo without a path, to flag honest sharing.
    sharers = {}
    for model in registry["models"]:
        if model.get("github") and not model.get("github_path"):
            sharers.setdefault(model["github"].lower(), []).append(model["id"])

    cache = {}                       # one API call per repo, however many models use it
    out = {}
    failures = []
    for model in registry["models"]:
        slug = model.get("github")
        if not slug:
            continue
        mid = model["id"]
        if slug.lower() not in cache:
            cache[slug.lower()] = repo_info(slug)
        repo, status = cache[slug.lower()]
        if repo is None:
            failures.append((mid, slug, status))
            print("{:<24} FAILED http {}".format(mid, status))
            continue

        path = model.get("github_path")
        record = {
            "repo": repo["full_name"],
            "url": repo["html_url"] + ("/tree/HEAD/" + path if path else ""),
            "path": path,
            "repo_stars": repo["stargazers_count"],
            "stars": None if path else repo["stargazers_count"],
            "forks": None if path else repo["forks_count"],
            "open_issues": None if path else repo["open_issues_count"],
            "pushed_at": repo["pushed_at"],
            "created_at": repo["created_at"],
            "archived": repo["archived"],
            "license": (repo.get("license") or {}).get("spdx_id"),
            "also": [],
        }
        if path:
            stamp, pstatus = last_commit_on_path(repo["full_name"], path)
            # Unknown when the call failed: upkeep then falls back to "unknown"
            # rather than borrowing the monorepo's push date, which would call
            # a four-year-old folder actively maintained.
            record["pushed_at"] = stamp
            record["path_commit_status"] = pstatus

        for extra in model.get("github_also") or []:
            if extra.lower() not in cache:
                cache[extra.lower()] = repo_info(extra)
            info, xstatus = cache[extra.lower()]
            if info is None:
                failures.append((mid, extra, xstatus))
                record["also_incomplete"] = True
                continue
            record["also"].append({"repo": info["full_name"],
                                   "stars": info["stargazers_count"],
                                   "pushed_at": info["pushed_at"]})
            if record["stars"] is not None:
                record["stars"] += info["stargazers_count"]
            if info["pushed_at"] and (record["pushed_at"] or "") < info["pushed_at"]:
                record["pushed_at"] = info["pushed_at"]

        shared = [m for m in sharers.get(slug.lower(), []) if m != mid]
        if shared and not path:
            record["shared_with"] = shared

        out[mid] = record
        print("{:<24} {:>6} stars  last change {}  {}{}{}".format(
            mid, "-" if record["stars"] is None else record["stars"],
            (record["pushed_at"] or "unknown")[:10],
            "path " + path if path else "",
            "  ARCHIVED" if repo["archived"] else "",
            "  shared with " + ",".join(shared) if shared and not path else ""))

    if not os.path.isdir(config.CACHE_DIR):
        os.makedirs(config.CACHE_DIR)

    # Merge over the previous snapshot so a transient API failure leaves the
    # last known-good numbers in place instead of blanking a column.
    if os.path.exists(config.GITHUB_FILE):
        with open(config.GITHUB_FILE) as fh:
            previous = json.load(fh)
        for mid, old in previous.items():
            if mid not in out:
                old["stale"] = True
                out[mid] = old

    with open(config.GITHUB_FILE, "w") as fh:
        json.dump(out, fh, indent=2)
    if failures:
        print("\n{} repo call(s) failed; kept previous values where available.".format(
            len(failures)))
    print("Wrote {}".format(config.GITHUB_FILE))


if __name__ == "__main__":
    main()
