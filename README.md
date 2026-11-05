<img src="assets/logo.svg" alt="S2F Tracker logo" width="80">

# S2F Tracker

S2F Tracker maps sequence-to-function models on a shared base-pair ruler, making it easier to compare their input lengths, prediction resolution, readouts, and research activity.

[View the live site](https://eastmanmd.github.io/S2F-tracker/)

## FAQ

**Where does the data come from?**  
Model details are curated from publications. Citation and usage data come from OpenAlex, GitHub, Hugging Face, PyPI, Zenodo, and Kaggle.

**How are models sorted by default?**  
By tracker score, highest first. The default score combines attention (35%), citation momentum (25%), usage (20%), openness (10%), and runnability (10%).

**How and how often is the data refreshed?**  
A GitHub Actions workflow runs the data pipeline every Monday at 06:00 UTC. It fetches updated information from the tracked sources, rebuilds the data files, and publishes the changes. The workflow can also be run manually.

**How are new models discovered and selected?**  
The pipeline searches bioRxiv and arXiv for relevant research and adds candidates to `pipeline/discovery_queue.json`. Candidates are reviewed manually; only selected models are added to the curated registry. Discovery does not add models to the tracker automatically.

**Where is the data stored?**  
In JSON files in this repository's `data/` directory. The model registry is maintained in `pipeline/registry.json`.

**What does each track show?**  
A track runs from the model's output resolution to its input length on a logarithmic base-pair ruler. Its colored stripes indicate the readouts it predicts.

**Does a higher score mean a model is more accurate?**  
No. The score measures attention, usage, openness, and runnability; it does not measure predictive accuracy.

**Can I change the score weights?**  
Yes. Use **score weights** on the Tracks view. Scores and ranks update in your browser, and the settings are included in the shareable URL.

**What is the gray zone?**  
It contains related sequence models, such as DNA language models and specialized splicing models, that are often compared with S2F models. It is hidden by default and can be enabled with the gray zone toggle.

**Does “evaluated together” mean two models were directly compared?**  
Not necessarily. It counts papers classified as benchmarks that cite both models; it does not verify a head-to-head comparison.
