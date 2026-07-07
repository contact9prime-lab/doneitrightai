# Publishing models to the Hugging Face Hub

Every successful training job registers its artifact under **Models**. From
there, publishing is one click (or one API call).

## 1. Get a token

Create a token with the **write** role at
<https://huggingface.co/settings/tokens>. Then either:

- `export HF_TOKEN=hf_...` before starting the server (recommended — the UI
  header shows an "HF" chip when set), or
- paste the token into the publish dialog per upload. Per-request tokens are
  used once and **never stored** anywhere.

## 2. Publish

UI: **Models → Publish** → enter `your-username/model-name`, choose
private/public → **Publish**. API:

```bash
curl -X POST localhost:8000/api/models/1/publish \
  -H 'Content-Type: application/json' \
  -d '{"repo_id": "your-username/my-model", "private": true}'
```

The repo is created if needed (**private by default** — flip the checkbox to
make it public), all artifact files are uploaded, and the model row records
the repo and timestamp; the UI links straight to it.

## What gets uploaded

Exactly the files listed under **Models → Files**:

- **Transformers tasks** — standard HF layout (`config.json`,
  `model.safetensors`, tokenizer files, `label_mapping.json` for
  classification), loadable with `pipeline(...)`/`from_pretrained(...)`.
- **Tabular tasks** — `model.joblib` (a full sklearn pipeline) and
  `inference.json` describing expected input columns.

## Model cards

If the artifact has no `README.md`, TrainForge generates one at publish time
with the task, base model, metrics, and a usage snippet — so published models
are self-describing. Edit the card on the Hub afterwards, or drop your own
`README.md` into the model directory before publishing to override it.

## Using a published model

```python
# transformers artifacts
from transformers import pipeline
clf = pipeline("text-classification", model="your-username/my-model")

# tabular artifacts
from huggingface_hub import hf_hub_download
import joblib
pipe = joblib.load(hf_hub_download("your-username/my-model", "model.joblib"))
```

For private repos, log in first (`hf auth login`) or pass `token=`.
