"""Shared configuration for the sequence-to-function (S2F) model tracker pipeline."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "cache")
DATA_DIR = os.path.join(ROOT, "data")

# Curated model registry -- the one file edited by hand.
REGISTRY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.json")

# Model classes. Only the first two show by default on the site; the rest sit
# behind the gray-zone toggle. Scores are computed across all of them so a
# model's number does not change when the toggle does.
CORE_CLASSES = ("core", "derivative")
GRAY_CLASSES = ("dna-lm", "splicing", "mpra")

# OpenAlex: citations, yearly counts, and the works that cite each paper.
# Setting OPENALEX_MAILTO puts requests in the polite pool (faster, more
# reliable). It is read from the environment only -- the Action supplies it as
# a repository variable -- so no address is baked into the code.
OPENALEX_BASE = "https://api.openalex.org"
# None, not "", when unset: requests drops None-valued params entirely.
OPENALEX_MAILTO = os.environ.get("OPENALEX_MAILTO") or None
# Optional. OpenAlex refuses cursor paging past page one without a key
# (HTTP 401); with no key, fetch_openalex.py falls back to page-number paging.
OPENALEX_API_KEY = os.environ.get("OPENALEX_API_KEY", "")
OPENALEX_DELAY = 0.3
OPENALEX_PER_PAGE = 200

# GitHub repo stats. GITHUB_TOKEN is supplied automatically inside Actions;
# without it the API allows 60 requests/hour. A full local run needs roughly
# 4 calls per repo, so a cold unauthenticated run of ~27 repos can hit that
# limit -- export a token locally if it does.
GITHUB_API = "https://api.github.com"
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_DELAY = 0.2

# Hugging Face weights + download counts.
HF_API = "https://huggingface.co/api"
HF_DELAY = 0.2

# PyPI: packaging (runnability) and monthly downloads (usage).
PYPI_API = "https://pypi.org/pypi"
PYPISTATS_API = "https://pypistats.org/api/packages"

# Other weight hosts. S2F weights mostly do not live on Hugging Face: Enformer
# is on Kaggle, the Kelley-lineage and Zhou-lineage models on Zenodo or cloud
# buckets. Zenodo reports downloads; Kaggle's public API reports only votes.
ZENODO_API = "https://zenodo.org/api/records"
KAGGLE_API = "https://www.kaggle.com/api/v1/models"
USAGE_DELAY = 0.5

USER_AGENT = "s2f-tracker (+https://github.com/Eastmanmd/S2F-tracker)"

# Discovery scan for new candidate models. Terms are matched against titles and
# abstracts after both sides are normalized (lowercased, hyphens and dashes
# folded to spaces), so "sequence-to-function" and "sequence to function" are
# the same string.
BIORXIV_API = "https://api.biorxiv.org/details/biorxiv"
ARXIV_API = "http://export.arxiv.org/api/query"
DISCOVERY_TERMS = [
    "sequence-to-function",
    "sequence-to-expression",
    "sequence-to-activity",
    "sequence-based deep learning model",
    "genomic deep learning model",
    "regulatory sequence model",
    "predict gene expression from DNA sequence",
    "from DNA sequence alone",
    "DNA language model",
    "genomic language model",
    "genomic foundation model",
    "DNA foundation model",
]
DISCOVERY_WINDOW_DAYS = 30

# bioRxiv has no term search: the details endpoint pages a date interval 30
# records at a time and the filtering happens here. A week is roughly 1,700
# preprints, so the scan is incremental -- cache/discovery.json records the
# date already paged and the next run starts there, not 30 days back.
BIORXIV_DELAY = 0.3
BIORXIV_PAGE = 30           # records per page, fixed by the API
# bioRxiv answers a page in roughly six seconds, so the run is bounded by a
# page budget rather than wall time. The watermark advances after each
# *completed* chunk, so a budget-capped run still makes progress.
BIORXIV_CHUNK_DAYS = 7
BIORXIV_PAGE_BUDGET = 150   # ~15 min at 6s/page; a normal week needs ~80
# Preprints are posted days after the date they carry; re-page a few days of
# overlap and let DOI dedupe make the repeats free.
DISCOVERY_OVERLAP_DAYS = 3

# arXiv has real term search, so each term is one query. Their docs ask for a
# 3-second gap between calls.
ARXIV_DELAY = 3.0
ARXIV_MAX_RESULTS = 100

# The review queue. Committed and hand-edited, deliberately NOT in cache/: a
# dismissal is a judgement that has to survive a cache wipe.
DISCOVERY_QUEUE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "discovery_queue.json")
DISCOVERY_STATUSES = ("new", "dismissed", "added")
DISCOVERY_ABSTRACT_CHARS = 600

# Scoring. Same five components and default weights as the scFM tracker, so
# the two sites read the same way; the site's sliders re-weight client-side.
SCORE_WEIGHTS = {
    "attention": 0.35,   # log-scaled total citations
    "momentum": 0.25,    # citations dated in the trailing year
    "usage": 0.20,       # stars + weight/package downloads per month
    "openness": 0.10,    # access tier + licence + active upkeep
    "runnable": 0.10,    # packaged, pinned, released, documented, answered
}

# Access tiers, from registry.json. "access" is the curated judgement; the
# licence string is the evidence for it. Gated weights (a click-through
# licence) are usable by most academics, API-only models cannot be inspected
# or fine-tuned at all, and that difference is the point of a tier.
ACCESS_SCORE = {
    "open": 1.0,
    "non-commercial": 0.6,
    "gated": 0.5,
    "api-only": 0.2,
    "none": 0.0,
}

# Signals inside the runnability component, renormalized per model by the
# weight of what could actually be observed.
RUNNABLE_WEIGHTS = {
    "installable": 0.25,   # a PyPI package that links back to the repo
    "env": 0.20,           # requirements / environment / pyproject / Dockerfile
    "release": 0.15,       # a tagged release to pin
    "tutorials": 0.15,     # notebooks in the repo
    "responsive": 0.25,    # an issue closed in the trailing 90 days
}
TUTORIALS_FULL_CREDIT = 3

MOMENTUM_WINDOW_DAYS = 365
STALE_DAYS = 90          # no commits in this long => repo is "quiet"
CITING_PER_MODEL = 40    # citing articles kept in the upfront index

# Files
RESOLVED_FILE = os.path.join(CACHE_DIR, "resolved.json")
RUNNABLE_FILE = os.path.join(CACHE_DIR, "runnable.json")
OPENALEX_FILE = os.path.join(CACHE_DIR, "openalex.json")
GITHUB_FILE = os.path.join(CACHE_DIR, "github.json")
HF_FILE = os.path.join(CACHE_DIR, "huggingface.json")
USAGE_FILE = os.path.join(CACHE_DIR, "usage.json")
CITING_CACHE_FILE = os.path.join(CACHE_DIR, "citing_cache.json")
DISCOVERY_FILE = os.path.join(CACHE_DIR, "discovery.json")

# data/history.json is append-only and lives in the repo, not the cache --
# weekly snapshots are the only way deltas can be computed.
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")

CHANGELOG_FILE = os.path.join(DATA_DIR, "changelog.json")
FEED_FILE = os.path.join(ROOT, "feed.xml")
SITE_URL = "https://eastmanmd.github.io/S2F-tracker/"
SITE_DOMAIN = "eastmanmd.github.io"
SITE_TITLE = "Sequence-to-Function Model Tracker"
CHANGELOG_WEEKS = 52
FEED_ENTRIES = 20
CHANGELOG_MAX_PAPERS = 12

RANK_MOVE_MIN = 2        # places
SCORE_MOVE_MIN = 0.5     # points
CITATION_MILESTONES = (100, 250, 500, 1000, 2500, 5000, 10000)

CITING_DIR = os.path.join(DATA_DIR, "citations")
