# Vendored `qwen_tts`

The Qwen3-TTS modelling code, vendored from the `qwen-tts` PyPI package instead of installed
as a dependency. Nothing in here is our code — treat it as a third-party tree (it is excluded
from Ruff in `ruff.toml`) and keep local edits to the minimum listed below so it stays
diffable against upstream.

## Provenance

| | |
|---|---|
| Package | `qwen-tts` 0.1.1 (PyPI) |
| Wheel | `qwen_tts-0.1.1-py3-none-any.whl` |
| Wheel SHA-256 | `11a290d8dabc7ef91a90c54478c8ab19b3edb1d85c0882313721892bdc4af15d` |
| Upstream source | <https://github.com/QwenLM/Qwen3-TTS> |
| License | Apache-2.0 (per-file headers retained) |

## Why vendored

The package declared `transformers==4.57.3`, `accelerate==1.12.0` and — for a Gradio demo CLI
this sidecar never imports — `gradio`, which transitively pulled `pillow`, `fastapi`,
`uvicorn`, `starlette`, `python-multipart` and ~30 more packages into an install that already
runs Flask. Vendoring drops that subtree, drops `sox` / `onnxruntime` / `torchaudio` / `einops`
(imported only by the 25 Hz tokenizer we don't use), and lets us set the `transformers`
constraint ourselves rather than inheriting an equality pin.

Full analysis and measurements: [`docs/qwen-tts-dependency-evaluation.md`](../../docs/qwen-tts-dependency-evaluation.md).

## Local modifications

### 1. Deletions — the 25 Hz tokenizer and the demo CLI

AI Playground only loads the 12 Hz checkpoints (`Qwen3-TTS-12Hz-*`), and the 25 Hz path is the
only importer of `sox`, `onnxruntime`, `torchaudio` and `einops`:

- removed `qwen_tts/core/tokenizer_25hz/` (5 files)
- removed `qwen_tts/cli/` and `qwen_tts/__main__.py` (the `gradio` importers)

Consequential edits:

- `qwen_tts/core/__init__.py` — dropped the `Qwen3TTSTokenizerV1{Config,Model}` re-exports.
- `qwen_tts/inference/qwen3_tts_tokenizer.py` — dropped the V1 imports and their
  `AutoConfig`/`AutoModel` registrations, and the 25 Hz branch of `decode()` (an unsupported
  tokenizer type now raises). Docstrings referring to the 25 Hz variant trimmed.

### 2. `transformers` 5 support

Upstream is written against `transformers` 4.57.3 internals and pins that version by equality.
4.x carries three advisories fixed only in 5.x, so the affected call sites now route through
**`qwen_tts/_compat.py`** (our file, not upstream's), which keeps the tree working on both
versions. Five things needed bridging:

| What | Why |
|---|---|
| `@check_model_inputs()` → `@check_model_inputs` | decorator factory became a plain decorator |
| `ROPE_INIT_FUNCTIONS["default"]` | removed in 5.x; the shim reproduces 4.57.3's computation |
| `rope_config_validation` | 5.x validates the new `rope_parameters` schema these configs don't use |
| `create_causal_mask` / `create_sliding_window_causal_mask` | `input_embeds` → `inputs_embeds`, and `cache_position` dropped (the cache supplies the query offset now) |
| `config.pad_token_id` | 5.x raises instead of returning `None` for a config that doesn't define it (it is `None` here on 4.57.3, so the `getattr` is the same value) |

Two changes are more than signature bridging, and both were silent failures worth knowing
about:

- **`reset_rotary_buffers()` after every `from_pretrained`.** `inv_freq` is a non-persistent
  buffer, so it is never in a checkpoint. transformers 5 builds modules on the meta device and
  only restores such buffers for rotary classes its own `_init_weights` recognizes (name
  contains `RotaryEmbedding` *and* an `original_inv_freq` attribute). None of these three
  qualify — this model overrides `_init_weights` without delegating, and the codec decoder's
  class is spelled `...RotatoryEmbedding` upstream. Without the reset, `inv_freq` keeps
  uninitialized memory and the first forward pass produces NaN logits.
- **`align_position_ids()` in the three forwards that take `position_ids`.** 4.x passed only
  the current step's positions; 5.x accumulates them (`_update_model_kwargs_for_generation`
  concatenates), so while decoding one token the model receives the whole sequence and
  attention output stops matching the query length.

## Verifying

Everything outside `_compat.py` and the five bridged call sites is byte-identical to the
wheel:

```bash
pip download --no-deps qwen-tts==0.1.1 -d /tmp/qtts && unzip -q /tmp/qtts/*.whl -d /tmp/qtts/src
diff -r /tmp/qtts/src/qwen_tts qwen3-tts/vendor/qwen_tts
```

Behaviour is checked two ways:

- `python -m unittest discover -s tests` — fast structural guards plus unit tests for the
  compat layer. No model download; runs in well under a second.
- `python tests/vendor_parity.py` — generates a fixed case list with both this tree and the
  upstream package and compares codec token sequences and waveforms bit-for-bit. Needs the
  model weights and a temporary upstream install (`uv pip install --no-deps qwen-tts==0.1.1`).
  Because upstream only runs on `transformers` 4.57.3, comparing against it means installing
  that version too — the tree still supports it, which is the reason the compat layer bridges
  rather than replaces.

The chain that justifies the vendoring is: upstream @ 4.57.3 == this tree @ 4.57.3 == this
tree @ 5.14.1, bit-for-bit, verified on the same torch build.

## Updating

Re-copy from the new wheel, re-apply the modifications above, then run both checks. A
`transformers` bump needs the parity check too: this is model code written against internal
APIs (`masking_utils`, `cache_utils`, `modeling_rope_utils`), and the failure modes are NaN
output and shape mismatches rather than import errors.
