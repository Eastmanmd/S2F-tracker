# Sequence-to-Function Model Tracker

**Live site: https://eastmanmd.github.io/S2F-tracker/**
(This URL assumes the repository is named `S2F-tracker`. If it isn't, change
`SITE_URL` in `pipeline/config.py` and the canonical/og URLs in `index.html`.)

A field map of sequence-to-function (S2F) models: networks that read DNA and
predict a molecular readout such as accessibility, TF binding, histone marks,
transcription initiation, RNA-seq coverage, splicing or 3D contacts. Every
model is drawn as a track on one base-pair ruler, so you can see at a glance
how much DNA it reads, how finely it predicts and what it predicts. Each model
also gets a score for how much it is **cited**, **downloaded** and
**maintained**.

Data refresh weekly from OpenAlex, the GitHub API, the Hugging Face Hub,
pypistats, Zenodo and Kaggle. This is the sister project of the
[scFM Tracker](https://github.com/Eastmanmd/scFM-tracker), and its pipeline is
ported from it.

## What is tracked

The registry (`pipeline/registry.json`) is curated by hand. Whether something
counts as an S2F model is a judgement call, not a keyword match.

| Class | Count | Examples |
|---|---:|---|
| **core** | 17 | DeepSEA, Basset, Basenji, Enformer, Borzoi, BPNet, ChromBPNet, Sei, Akita, Orca, AlphaGenome |
| **derivative** | 3 | Flashzoi, Scooby, Decima (fine-tunes or re-implementations of a core model) |
| **gray zone** | 10 | DNA language models (DNABERT, Nucleotide Transformer, HyenaDNA, Caduceus, GPN-MSA, Evo 2), splicing models (SpliceAI, Pangolin), MPRA activity (Malinois) |

The gray zone is hidden by default. These models are routinely benchmarked
against S2F models, but they either predict no assay track (language models
output embeddings) or cover one narrow readout. Ranks shown with the gray zone
off cover core and derivative models only (`view_rank` in the data). Turn the
gray zone on and SpliceAI, the most cited model on the list, ranks first.

Species are human and mouse for now.

Each registry entry also records the model's geometry: input context, output
resolution, output type (`track`, `window`, `gene`, `contact_map`,
`embedding`), track count, and the readouts it predicts. All of these come from
the paper. Where a paper reports no single number (DNABERT-2's variable input,
Decima's per-gene output), the field is left empty and the site shows "not
reported" rather than a guess.

## The ruler

The home view is a genome-browser layout. The x-axis is log₁₀ base pairs, from
1 bp to 300 Mb. Each model's bar starts at its output resolution and ends at
its input context:

- **Striped bar.** A track model. Each stripe is one readout it predicts.
- **Diamond.** A window- or gene-level model. It emits one number per input, so
  it sits at its input length.
- **Hatched bar.** A language model. It outputs embeddings, not assay tracks.
- **Dashed stub.** The input length is not fixed or not reported.

Hovering the ruler draws a crosshair that reads across the whole field, for
example "9 of 17 read at least 120 kb; 11 output at this resolution or finer".
Clicking a track opens its spec sheet. Every view, filter, open model and
custom weighting is kept in the URL hash, so any state can be shared as a link.
The sun/moon button in the top bar switches between the dark (default) and a
light background; the choice is remembered in the visitor's browser.

## Score

> **score = 100 × (0.35·attention + 0.25·momentum + 0.20·usage + 0.10·openness + 0.10·runnable)**

| Component | What it measures |
|---|---|
| **Attention** (×0.35) | Log-scaled citations, deduplicated across every version of the model's paper |
| **Momentum** (×0.25) | Citations dated in the trailing 365 days, read off each citing paper's publication date |
| **Usage** (×0.20) | GitHub stars plus downloads per month from every host that reports downloads (see below) |
| **Openness** (×0.10) | Access tier 40%, licence 25%, upkeep 35% |
| **Runnable** (×0.10) | Installable package, environment file, tagged release, tutorial notebooks, an issue closed in the last 90 days |

Each component is scaled 0–1 across the tracked models. Where a component
cannot be measured for a model, it is left out and the remaining weights are
renormalized, so a gap is not a penalty.

There is one exception. A model with nothing public to measure (no repository
of its own, no tracked weights host, no package) scores **0** on usage, not
"missing". A model with no code at all also scores 0 on runnability. Without
this rule, DeepSEA and DeepBind ranked #1 and #2 on citations alone, for having
nothing that could fail. It is the same failure the scFM tracker hit with
Geneformer. They now rank #6 and #7 of 20.

Access tiers are curated per model: open 1.0, non-commercial 0.6, gated 0.5,
API only 0.2, none 0. Six models ship under non-commercial terms (SpliceAI,
Sei, Orca, Puffin, Decima, Nucleotide Transformer). AlphaGenome's weights are
gated behind a sign-up. Upkeep comes from the latest commit: active if within 90 days,
slowing within a year, dormant beyond that, and 0 if the repo
is archived.

The **score weights** panel on the Tracks view re-weights everything in the
browser. It recomputes scores and ranks with the same renormalization the
pipeline uses, and writes the weighting into the link (`#w=35,25,20,10,10`).

## Usage: where S2F weights actually live

The scFM tracker could read usage off Hugging Face alone. S2F models can't be
measured that way. Enformer ships through Kaggle, the Kelley and
Zhou lineages through Zenodo or cloud buckets, and the most-used tools
(SpliceAI, the AlphaGenome client) through PyPI. Reading only Hugging Face
would score most of the field's workhorses as unused.
`pipeline/fetch_usage.py` converts each source to downloads per month before
anything is added:

| Host | What it reports | How it is counted |
|---|---|---|
| Hugging Face | 30-day downloads | as is |
| PyPI (pypistats) | last-month downloads | as is, only for a package whose metadata links back to the model's repository. A same-named package is never assumed: PyPI's `scooby` is unrelated to the Scooby model and is rejected |
| Zenodo | all-time downloads of the record | divided by months since publication (a lifetime monthly average) |
| Kaggle | votes only | shown, never counted: a vote is not a download |
| cloud buckets, lab sites | nothing | listed on the spec sheet only |

Downloads are therefore a floor. Many S2F weights are fetched from cloud
buckets that publish no counts.

## Shared repositories

Several models are one folder of a much larger repository. Enformer lives in
`google-deepmind/deepmind-research` (15k stars) and Akita in `calico/basenji`.
The registry's `github_path` field handles this:

- the model gets **no credit** for the parent repository's stars;
- upkeep comes from the last commit that touched its folder;
- runnability is checked only inside that folder.

Models with more than one repository (AlphaGenome's client and research code,
`github_also`) have their stars summed, and the latest push wins. When two
tracked models genuinely share a repository (Basenji and Basenji2), both are
flagged `shared_with`.

## Citations are deduplicated across paper versions

Most of these models have a preprint and a journal version. A paper citing
both would be counted twice by a naive sum. The pipeline unions citing works
across every registered version and dedupes by OpenAlex work ID. For example,
DeepSEA has a naive sum of 2,279 and **2,213 deduplicated**; SpliceAI has
2,806 and 2,745.

A citing record dated before the paper it cites is a metadata error. It stays
in the total but is left out of the year histogram.

## Who cites each model, and how

Every citing paper is labelled on two axes from its title, abstract and
OpenAlex topics:

- **Use:** application, benchmark, extension or review.
- **Field:** biology, method, unclear or off-topic.

Each model's spec sheet shows both splits and the full list of citing papers,
newest first and filterable by use. The Citing papers view pools the 40 newest
papers per model.

> **Caveat: the classifier is not yet validated for S2F.** Its rules are
> ported from the scFM tracker, which was validated on 92 hand-labelled papers.
> S2F vocabulary has been added (variant-effect prediction, GWAS and eQTL
> fine-mapping, MPRA and CRISPR screens), but `pipeline/labels.json` is still
> empty. Corpus-wide, 35% of classified citations come out as biology and 25%
> as unclear. Treat the splits as approximate until about 100 papers are hand
> labelled and `pipeline/validate_classifier.py` has been run against them.

## Which models are evaluated together

A citing paper labelled `benchmark` that cites two tracked models is an
evaluation covering both. Intersecting the corpus on that label gives a
matrix: 141 of 403 benchmark papers cite two or more tracked models. Clicking a
cell lists the papers.

| Pair (core models) | Benchmark papers citing both | Any paper citing both |
|---|---:|---:|
| DeepBind · DeepSEA | 32 | 972 |
| DeepSEA · Enformer | 23 | 395 |
| Basset · DeepSEA | 22 | 658 |
| BPNet · Enformer | 17 | 251 |

The matrix makes two limited claims:

- **It counts co-citation by an evaluating paper, not a verified head-to-head
  result.** A paper that evaluates one model and cites the other only in its
  introduction is still counted.
- **An empty cell means missing evidence, not a verdict.**

## What changed this week

Each refresh is diffed against the one before it. The result goes to
`data/changelog.json` and is published as the [`feed.xml`](feed.xml) Atom feed.
The feed reports models joining the registry, rank moves of at least two places
and half a score point, repositories going quiet or being archived, licence
changes, citation milestones, new benchmark papers, and the first time two
models are evaluated together.

The first run writes a baseline entry. A same-day rerun stays a baseline
rather than announcing all 30 models as new.

## How new models get found

The registry stays curated. Only the search runs automatically.
`pipeline/discover.py` scans bioRxiv and arXiv each week for twelve phrases
(for example `sequence-to-function`, `regulatory sequence model`,
`predict gene expression from DNA sequence`, `genomic language model`). Matches
go to `pipeline/discovery_queue.json` with status `new`. Review a row by
setting its status to `dismissed` or `added`; nothing is ever added to the
registry automatically. The queue is committed, not cached, so a dismissal is
kept.

The queue is noisy for now: DNA language-model terms also catch metagenomics
and protein papers.

## Running it

```bash
python3 -m venv .venv && .venv/bin/pip install requests
```

```bash
GITHUB_TOKEN=... .venv/bin/python pipeline/run_all.py
```

`GITHUB_TOKEN` is optional but strongly recommended. Unauthenticated GitHub
allows 60 calls an hour and a full run makes about 135, so runnability goes
partly unmeasured without a token. Setting `OPENALEX_MAILTO` puts you in
OpenAlex's polite pool, and `OPENALEX_API_KEY` enables cursor paging.

To view the site, serve the folder. Opening `index.html` from disk can't fetch
the JSON.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploying

1. Push the repository to GitHub.
2. **Settings → Pages:** deploy from branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions:** allow read and
   write, so the weekly job can commit refreshed data.
4. Optional: add a repository **variable** `OPENALEX_MAILTO` and a **secret**
   `OPENALEX_API_KEY`.

`.github/workflows/refresh-data.yml` runs every Monday at 06:00 UTC, or on
demand from the Actions tab. It commits `data/`, `feed.xml` and
`pipeline/discovery_queue.json`.

## Layout

```
index.html, styles.css, app.js   the site (static, no build step, no libraries)
data/models.json                 one row per model: geometry, metrics, score
data/meta.json                   totals, weights, sources
data/headtohead.json             pair counts and the benchmark papers behind them
data/citations.json              index: newest 40 citing papers per model
data/citations/<id>.json         every citing paper for one model (loaded on demand)
data/history.json                weekly snapshots
data/changelog.json, feed.xml    what changed
pipeline/registry.json           the curated model list
pipeline/run_all.py              runs every step in order
mockups/                         the three UI directions considered
```

---

Data: [OpenAlex](https://openalex.org/) ·
[GitHub API](https://docs.github.com/rest) ·
[Hugging Face Hub](https://huggingface.co/docs/hub/api) ·
[pypistats](https://pypistats.org/) · [Zenodo](https://zenodo.org/) ·
[Kaggle](https://www.kaggle.com/models).
Citation counts measure attention, not quality. This is a research aid, not a
recommendation.
