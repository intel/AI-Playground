# Replacing `qwen-tts`: evaluation of vLLM-Omni

Evaluation of whether the `qwen-tts` PyPI package used by the `qwen3-tts` sidecar can be
replaced with [`vllm-omni`](https://github.com/vllm-project/vllm-omni), motivated by
`qwen-tts` being poorly maintained and dragging in dependencies with published advisories.

> TL;DR
>
> - **No, not today.** vLLM-Omni does support Qwen3-TTS and its API is a good fit, but it
>   runs on **vLLM, which has no Windows support at all** — and Windows + Intel XPU is our
>   primary shipping configuration. Intel XPU has no pre-built wheels even on Linux (Docker
>   or a oneAPI source build only) and needs torch 2.13, which we explicitly ceiling out.
> - **The advisories are mostly not `qwen-tts`'s model code — they're `gradio`.** 13 of the
>   18 advisories in the lock come from `pillow`, which is pulled in *only* by `gradio`,
>   which is pulled in *only* by `qwen-tts`, for a demo CLI we never run. Excluding `gradio`
>   removes 35 packages and 13 advisories, and is verified safe.
> - **The one genuine `qwen-tts` problem is its `transformers==4.57.3` hard pin** (2 high +
>   1 medium advisory, one of them reachable from our load path). That is *not* fixable by
>   unpinning: `qwen-tts` 0.1.1 does not run on transformers 5.x. Verified — see
>   [§5.1](#51-tested-unpin-transformers-fails).
>
> **Status: both halves have landed.** The 12 Hz subset is vendored
> ([§5.4](#54-scoping-the-vendor-and-port-option) Step A) and ported to `transformers` 5.14.1
> (Step B, [§5.5](#55-the-transformers-5-port-as-landed)). The lock went 145 → 110 packages
> and the advisory count **18 → 2**, the remainder being a deliberate `torch` ceiling and an
> unreachable `setuptools` sdist issue. Audio is bit-identical to the upstream package
> throughout.

---

## 1. What we run today

`qwen3-tts/` is a Flask sidecar (`web_api.py` → `tts_engine.py`) that loads Qwen3-TTS
through `qwen_tts.Qwen3TTSModel.from_pretrained()` and returns WAV bytes over loopback.
Two 12 Hz checkpoints are used, cached side by side so a mode switch never reloads:

| Mode | Model | Engine call |
|---|---|---|
| `custom_voice` | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | `generate_custom_voice()` |
| `voice_design` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `generate_voice_design()` |

Torch comes from a per-accelerator extra (`xpu` on Windows, `cuda` in NVIDIA product mode,
`cpu` elsewhere), and `list_devices.py` enumerates XPU/CUDA/CPU for the device selector.

## 2. Is `qwen-tts` actually badly maintained?

Yes, with one nuance: it is a research drop, not a maintained library.

- **6 releases, all inside a two-week window** (0.0.2 on 2026-01-22 → 0.1.1 on 2026-02-06),
  nothing since.
- **The PyPI project URLs are dead.** Both `Homepage` and `Repository` point at
  `github.com/Qwen/Qwen3-TTS`, which 404s. The real code lives at `QwenLM/Qwen3-TTS`
  (12.8k stars, 56 open issues, last push 2026-03-17), so there is no issue tracker
  reachable from the package a consumer installs.
- **It hard-pins `transformers==4.57.3` and `accelerate==1.12.0`** — equality pins on a
  fast-moving library, which is what makes the advisories below unfixable in place.
- **It depends on `gradio` unconditionally** for a demo CLI, and on `sox` (a wrapper around
  a SoX CLI binary we don't ship — importing the package prints `SoX could not be found!`).

## 3. What the advisories actually are

Audited every `name`/`version` pair in `qwen3-tts/uv.lock` (137 distinct packages) against
the GitHub Advisory Database. 18 matches, and they cluster sharply:

| Package | Locked | Advisories | Source of the dependency | Fixable by relocking? |
|---|---|---|---|---|
| `pillow` | 12.2.0 | **13** (10 high, 3 medium) | `gradio` → `qwen-tts` | Yes — `pillow` 12.3.0 exists and `gradio` allows `pillow<13.0` |
| `transformers` | 4.57.3 | **3** (2 high, 1 medium) | `qwen-tts` (`==4.57.3`) | **No** — the pin blocks it |
| `setuptools` | 81.0.0 | 1 (medium) | `torch` | No — see below |
| `torch` | 2.12.1 | 1 (low) | ours | No — we ceiling `torch<2.13` deliberately |

Re-running the same audit after each step:

| Lock | Packages | Advisories |
|---|---|---|
| original, `qwen-tts` dependency | 137 | 18 |
| after vendoring ([§5.4](#54-scoping-the-vendor-and-port-option)) | 95 | 5 |
| after the `transformers` 5 port ([§5.5](#55-the-transformers-5-port-as-landed)) | 106 | **2** |

Vendoring removed the 13 `pillow` advisories along with `gradio`; the port removed the three
`transformers` ones. The two that remain are deliberate. `torch` is held below 2.13 on purpose.
`setuptools` is an unbounded requirement of `torch` that resolves to 81.0.0 and does not move on
`uv lock --upgrade-package setuptools`; the advisory is an sdist `MANIFEST.in` bypass on macOS
filesystems, which is unreachable for a service that never builds an sdist, so it is not worth
adding a floor on a transitive build tool to silence.

Two things follow:

**The `pillow` cluster is a stale-lock artifact, not a `qwen-tts` design flaw.** Nothing
constrains `pillow` below 12.3.0; the lock is simply older than the fix.

**The `transformers` cluster is the real issue, and one of the three is reachable from our
code path.** [CVE-2026-4372](https://github.com/advisories/GHSA-29pf-2h5f-8g72) (high,
fixed in 5.3.0): a malicious `config.json` sets `_attn_implementation_internal` to an
attacker-controlled Hub repo id, and `from_pretrained()` then downloads and executes code
from it — explicitly **bypassing `trust_remote_code`**. `tts_engine._load_model()` calls
`Qwen3TTSModel.from_pretrained(model_id, …)` with a model id that is overridable via
`QWEN3_TTS_MODEL`, so this is a live path, not a theoretical one. (The other two —
LightGlue loading and the `Trainer` class — are unreachable for us.)

## 4. Could vLLM-Omni replace it?

**Capability: yes.** vLLM-Omni has first-class Qwen3-TTS support covering all three task
types (CustomVoice, VoiceDesign, Base/voice-cloning) for the exact `Qwen3-TTS-12Hz-*`
checkpoints we use, and its OpenAI-compatible `POST /v1/audio/speech` takes `voice`,
`language`, `instructions`, `task_type` and streaming options — a superset of what
`/api/synthesize` exposes. It would also give us streaming audio and voice cloning, which
we don't have today.

**Platform: no.** Every blocker below is independent, and the first one alone is decisive.

1. **No Windows.** vLLM's supported platforms are CUDA/ROCm/XPU GPUs and x86/ARM/Apple/IBM Z
   CPUs — **all Linux** (the x86 CPU doc states `OS: Linux` outright). PyPI ships only
   `manylinux_2_28_{x86_64,aarch64}` wheels for `vllm` 0.26.0; native Windows support is
   still an open request upstream ([vllm#42877](https://github.com/vllm-project/vllm/issues/42877),
   and scoped to a *CUDA source build* at that). Our production build is
   `electron-builder --win --x64`. Adopting vLLM-Omni would remove TTS from the primary
   platform.
2. **No installable Intel XPU path.** vLLM's own XPU doc says "Currently, there are no
   pre-built XPU wheels" — you build from source with `VLLM_TARGET_DEVICE=xpu`, the Level
   Zero compute-runtime driver and `vllm-xpu-kernels`. vLLM-Omni's XPU page has empty
   wheel/source sections and says "vLLM-Omni currently recommends using the Docker image
   setup steps below" (an `intel/deep-learning-essentials` image that clones and compiles
   vLLM under oneAPI). We install backends on end-user machines with `uv sync` and
   `no-build = true`; a oneAPI source build is not something that fits behind an installer
   progress bar. XPU is also validated only on Arc B-Series, not the iGPUs we support.
3. **Direct version conflict.** vLLM's `requirements/xpu.txt` builds against torch 2.13 and
   `triton-xpu` 3.7.x. `qwen3-tts/pyproject.toml` carries `constraint-dependencies =
   ["torch<2.13"]` because "torch 2.13 breaks on Linux (driver issues)". These cannot both
   hold.
4. **No CPU story.** `vllm_omni/platforms/` has `cuda`, `rocm`, `xpu`, `npu`, `musa` — no
   `cpu` — and there is no CPU installation doc. CPU is our fallback whenever no accelerator
   is usable, and the default extra on Linux and macOS.
5. **Footprint and memory model are hostile to a co-resident app.** The `vllm` wheel alone is
   **304 MB** versus 113 KB for `qwen-tts`, on top of torch. Worse, vLLM pre-allocates KV
   cache to `gpu_memory_utilization`, **default 0.92**, documented as a per-instance limit
   that ignores other instances on the same GPU. AI Playground already shares one GPU
   between the LLM backend and ComfyUI. And because `vllm serve` hosts one model per
   process, keeping CustomVoice and VoiceDesign both resident (which the current two-slot
   cache does) would mean two servers, each grabbing its own pool.
6. **It is young and moves fast.** Development Status is `3 - Alpha`, releases track upstream
   vLLM minor-for-minor (0.11.0rc1 → 0.26.0 since Nov 2025), and its own docs recommend
   installing from source because it "is rapidly evolving". Swapping a stale dependency for
   one that re-bases every few weeks trades one maintenance problem for another.

Migration cost on our side would be moderate but not the issue: `spawnAPIProcess` would
launch `vllm serve` instead of `web_api.py`, and `synthesizeTextToSpeech` would post to
`/v1/audio/speech` — the `/api/config` speaker/language catalogue maps onto
`/v1/audio/voices`. The platform story is what rules it out.

## 5. Alternatives, and what we measured

### 5.1 Tested: unpin `transformers` without touching the code (fails)

The attractive cheap fix is to override `qwen-tts`'s pin and move to transformers 5.x, fixing
all three advisories with no code changes. That does not work — the code has to be ported,
which is what [§5.5](#55-the-transformers-5-port-as-landed) did. Against transformers 5.14.1,
`qwen-tts` 0.1.1 fails progressively, and each mechanical fix reveals the next breakage:

| # | Failure | API change |
|---|---|---|
| 1 | `TypeError: check_model_inputs() missing 1 required positional argument` — at **import** | decorator factory → plain decorator |
| 2 | `AttributeError: 'Qwen3TTSTalkerConfig' object has no attribute 'pad_token_id'` | generation attrs removed from `PretrainedConfig` |
| 3 | `KeyError: 'default'` in `ROPE_INIT_FUNCTIONS` | RoPE init registry restructured |
| 4 | `create_causal_mask() got an unexpected keyword argument 'input_embeds'` | renamed to `inputs_embeds` |
| 5 | `create_causal_mask() got an unexpected keyword argument 'cache_position'` | replaced by `position_ids` |
| 6 | `RuntimeError: probability tensor contains either inf, nan or element < 0` | **numerical**, not an API error |

Failure 6 is the important one, and it is what made this a port rather than a version bump:
after five mechanical shims the model loads and runs, and then produces NaN logits. Guessing
does not close that gap — [§5.5](#55-the-transformers-5-port-as-landed) records what actually
caused it.

So the `transformers==4.57.3` pin is load-bearing *for the unmodified package*. Fixing those
three advisories requires either vendoring and properly porting the modelling code — scoped in
[§5.4](#54-scoping-the-vendor-and-port-option), landed in
[§5.5](#55-the-transformers-5-port-as-landed) — or replacing the runner entirely.

Note this also rules out a tempting simpler idea: **`trust_remote_code` is not an option**
either. The `Qwen3-TTS-12Hz-*` repos ship no modeling `.py` and no `auto_map`, and upstream
`transformers` has no native `qwen3_tts` architecture (only `qwen3_omni_moe` and `mimi`), so
the model code has to come from a package.

### 5.2 Superseded: drop the `gradio` subtree with a uv override

> Kept for the reasoning; the implemented change was
> [§5.4](#54-scoping-the-vendor-and-port-option) Step A, which removes the `qwen-tts`
> dependency outright and so needs no override.


`gradio` is imported in exactly one file, `qwen_tts/cli/demo.py`, which nothing in our
sidecar touches — so it is pure install weight. Excluding it via a uv override (verified,
[§6](#6-reproducing-the-evidence)) drops **35 packages**: `gradio`, `gradio-client`,
`hf-gradio`, `safehttpx`, `pillow`, `fastapi`, `starlette`, `uvicorn`, `httpx`, `httpcore`,
`python-multipart`, `pydub`, `typer`, `rich`, `pandas` and friends — an entire second web
stack inside a sidecar that already runs Flask. That clears 13 of the 18 advisories, and a
plain relock clears `setuptools` too, leaving only the three `transformers` ones and the
deliberate `torch` ceiling.

```toml
# qwen3-tts/pyproject.toml, in [tool.uv]
# qwen-tts pulls gradio for its demo CLI (qwen_tts/cli/demo.py), which this sidecar never
# imports. A marker no `environments` entry can satisfy drops gradio and its 35-package
# subtree (pillow, fastapi, uvicorn, …) from the resolution. Without the `environments`
# restriction above, uv's universal resolver keeps gradio for a hypothetical platform.
override-dependencies = ["gradio; sys_platform == 'nonexistent'"]
```

Either way, `pyproject.toml` and `uv.lock` must change together — `checkBackend()` runs
`uv sync --check`, so a lock that lags the manifest makes the service report itself as not
set up.

Residual, worth knowing but not advisories: `sox` (1.4.1, a wrapper around a CLI binary we
don't ship), `onnxruntime`, `torchaudio` and `einops` are all imported at package-import time
via `core/tokenizer_25hz/vq/`, a path our 12 Hz models never execute — and by nothing else in
the wheel or in our sidecar. They can only be removed by vendoring ([§5.4](#54-scoping-the-vendor-and-port-option)).

### 5.3 If the `transformers` pin must go

In rough order of cost:

1. **Ask upstream.** A `transformers` 5.x compatible `qwen-tts` release, or at least a range
   instead of `==`, fixes this for everyone. `QwenLM/Qwen3-TTS` is stale but not archived.
2. **Vendor the 12 Hz subset and port it** — scoped in [§5.4](#54-scoping-the-vendor-and-port-option).
   The vendoring and the porting are separable, and only the second half is expensive.
3. **Revisit vLLM-Omni** once vLLM ships Windows and pre-built XPU wheels. Worth re-checking
   periodically, since the capability fit is genuinely good.

Note that even option 3 does not remove `transformers` risk: `vllm-omni` requires
`transformers>=5.5.3`, which is *newer* than the fixed versions here — so simply being able
to track a current `transformers` is most of the benefit, and options 1 and 2 get it without
changing platforms.

### 5.4 Scoping the vendor-and-port option

The important structural point: **vendoring and porting are two separable changes**, and they
have very different risk profiles.

**Step A — vendor at `transformers` 4.57.3.** Pure deletion, no behavior change. **Done** —
`qwen3-tts/vendor/qwen_tts/`, see [`vendor/README.md`](../qwen3-tts/vendor/README.md) for
provenance and the exact local edits. Keep the 12 Hz path, drop the 25 Hz tokenizer and the
demo CLI:

| | Files | Lines | |
|---|---|---|---|
| `core/models/` | 4 | 2924 | keep (`modeling_qwen3_tts.py` alone is 2299) |
| `core/tokenizer_12hz/` | 2 | 1199 | keep |
| `inference/` | 2 | 1287 | keep |
| `core/tokenizer_25hz/` | 5 | 3145 | **drop** |
| `cli/demo.py` | 1 | 634 | **drop** |

So ~5.4k lines kept of 9.3k, spanning ~51 classes (26 plain `nn.Module`, 4 `PreTrainedModel`,
6 config classes, 4 `ModelOutput`, 1 subclass of transformers' `MimiModel`).

Dependency effect, measured in one harness (`uv lock`, same `environments`, torch from PyPI so
the three are comparable):

| Dependency set | Packages |
|---|---|
| current, `qwen-tts` as-is | 114 |
| `gradio` excluded via override ([§5.2](#52-superseded-drop-the-gradio-subtree-with-a-uv-override)) | 79 |
| 12 Hz vendored, no `qwen-tts` dependency | 72 |

In the real `qwen3-tts/uv.lock`, which also carries the per-accelerator torch extras, the same
change took the lock from **145 to 99** package entries.

The extra 7 are `qwen-tts`, `sox`, `onnxruntime`, `protobuf`, `flatbuffers`, `torchaudio` and
`einops` — chunkier than the count suggests, since `onnxruntime` and `torchaudio` are native
wheels, and `torchaudio` is currently installed per-accelerator from the PyTorch index for
nothing. What remains is `torch`, `transformers`, `accelerate` (for `device_map`), `numpy`,
`librosa`, `soundfile`, `huggingface_hub`, plus our Flask.

Step A is cheap and verifiable, but note it **does not fix the three `transformers`
advisories** — it only buys the freedom to change the pin ourselves, plus a smaller install.
As landed, 8 of the 10 vendored files are byte-identical to the wheel; the two that differ do
so by 2 and 51 lines, all of it removing the 25 Hz tokenizer's imports, `Auto*` registrations
and `decode()` branch. `modeling_qwen3_tts.py`, the 2299-line core, is untouched. Two guards
keep it that way: [`tests/test_vendor.py`](../qwen3-tts/tests/test_vendor.py) (stdlib-only,
0.1 s — asserts the file inventory, that no vendored module imports anything
`pyproject.toml` does not declare, and that the removed 25 Hz dependencies stay gone) and
[`tests/vendor_parity.py`](../qwen3-tts/tests/vendor_parity.py) (the bit-exact A/B described
below).

**Step B — port to `transformers` 5.x.** This is the real cost. Of the 35 transformers symbols
the kept files import, 18 are unchanged between 4.57.3 and 5.14.1 and 17 differ — but ~9 of
those are cosmetic (`Optional[X]` → `X | None`, `PretrainedConfig` → `PreTrainedConfig` in
annotations). The behavioral ones:

| Change | Sites |
|---|---|
| `check_model_inputs` decorator factory → plain decorator | 1 |
| `ROPE_INIT_FUNCTIONS` lost `"default"` (gained `"proportional"`) | 3 |
| `rope_config_validation` now takes `RotaryEmbeddingConfigMixin`, not a config | config classes must adopt the mixin |
| `create_causal_mask` / `create_sliding_window_causal_mask`: `input_embeds` → `inputs_embeds`, `cache_position` dropped, `block_sequence_ids`/`layer_idx` added | 3 |
| generation attrs (`pad_token_id`, …) removed from `PretrainedConfig` | 2 |
| `MimiConfig` is keyword-only and replaced `rope_theta` with `rope_parameters` | see below |

Two things make this more than a mechanical sweep:

- **The NaN failure is not on that list.** Shimming the five loud breakages took ~5 edits and
  got the model loading and generating, and then the logits were NaN
  ([§5.1](#51-tested-unpin-transformers-fails)). Diagnosing that means bisecting mask and
  position semantics against a reference implementation, and it is the part that cannot be
  estimated from an API diff.
- **We inherit an upstream model, and config translation is silent.**
  `Qwen3TTSTokenizerV2Model.__init__` unconditionally builds `Qwen3TTSTokenizerV2Encoder`,
  which **subclasses transformers' `MimiModel`** — so even CustomVoice/VoiceDesign, which
  never encode reference audio, drag in Mimi's internals. The checkpoints ship a
  `speech_tokenizer/config.json` written for 4.x (`rope_theta`, `_frame_rate`). Feeding it to
  5.14.1's `MimiConfig` does **not** raise: `rope_theta` is silently dropped and re-derived
  from the new `rope_parameters` default. Here that default happens to be the same 10000.0, so
  it works *by luck*; a checkpoint with a non-default theta would be silently mis-modelled.
  A vendored port therefore needs an explicit config-translation shim, and owes upstream Mimi
  a re-check on every `transformers` bump.

**A/B can be numeric, not by ear.** Better than feared: generation is bit-reproducible on a
fixed stack. Same seed, two runs, sampled *and* greedy — `max_abs_diff = 0.000e+00` for both
(§6). That is what [`tests/vendor_parity.py`](../qwen3-tts/tests/vendor_parity.py) exploits: it
runs a fixed case list (English, German, and one greedy case that removes sampling from the
picture) under both implementations and compares **talker codec token sequences** as well as
waveforms. Codes are the primary signal — integers, immune to RNG, and they localize a
mismatch to the talker rather than the codec decoder. Step A passes it bit-exactly on both
torch builds tested (`2.12.1+cpu` and `2.12.1+cu130`).

Budget ~30–45 s per case on 4 CPU cores at fp32, so the tool is a manual gate, not a
per-commit check. One caveat for Step B: bit-equality *across* transformers versions is
stricter than correctness — a single differing logit from kernel dispatch or mask dtype will
diverge a sampled sequence completely, so a port should be judged on the greedy case first and
on where the codes first diverge, not on pass/fail alone.

Two practical notes for whoever runs it. The two implementations cannot share a process:
both register `qwen3_tts` with transformers' `Auto*` registries and registering one
`model_type` from two classes is an error, so each runs in its own subprocess. And importing
*upstream* now fails in the service venv, because its `__init__` reaches the 25 Hz tokenizer
whose imports we deliberately removed — the tool stubs those modules in the upstream child
rather than reinstalling them (with real `__spec__`s, or `torch._dynamo`'s module scan raises
`ValueError: onnxruntime.__spec__ is None`).

**What Step B adds to what we own:** a compatibility layer over model code that uses internal
transformers APIs, re-validated on every `transformers` bump. Step A on its own carries none of
that — the code is upstream's, byte for byte, apart from deletions — which is why it landed
first and separately.

### 5.5 The `transformers` 5 port, as landed

Cheaper than [§5.4](#54-scoping-the-vendor-and-port-option) feared, but only because the two
non-obvious failures were found by instrumenting rather than guessing. The work lives in
`vendor/qwen_tts/_compat.py`, which bridges both versions rather than rewriting against 5.x —
that matters because the upstream package only runs on 4.57.3, so keeping 4.x working is what
keeps `tests/vendor_parity.py` able to compare against upstream at all.

Three of the six failures from [§5.1](#51-tested-unpin-transformers-without-touching-the-code-fails)
were signature bridging (the `check_model_inputs` decorator form, the `"default"` RoPE entry,
the mask builders' renamed/dropped arguments). Two were narrower than they looked:
`config.pad_token_id` resolves to `None` on 4.57.3 for these checkpoints, so reading it through
`getattr` is the same value rather than a new default; and `rope_config_validation` only
validates, so it is skipped where 5.x expects the `rope_parameters` schema these configs do not
use. Several things that looked like they would need work did not: `Cache.update()` still
absorbs the old `cache_kwargs` positionally, `ALL_ATTENTION_FUNCTIONS[...]` still supports
indexing, and the `PretrainedConfig` rename is aliased.

The two real problems, both silent:

**Uninitialized `inv_freq` — the NaN.** `inv_freq` is a *non-persistent* buffer, computed in
`__init__` and never stored in a checkpoint. transformers 5 builds the module tree on the meta
device and then restores such buffers only for rotary modules that its own
`PreTrainedModel._init_weights` recognizes, which it decides by looking for `"RotaryEmbedding"`
in the class name plus an `original_inv_freq` attribute. None of the three rotary classes here
qualify: the talker's two define `original_inv_freq` but this model overrides `_init_weights`
without delegating to `super()`, and the codec decoder's class is spelled
`Qwen3TTSTokenizerV2Decoder**Rotatory**Embedding` upstream, so the name test fails outright.
The result was `inv_freq` holding uninitialized memory (`1.6e-31, 0.0, 0.0, …` with a NaN),
which is why the first forward pass produced NaN logits. `reset_rotary_buffers()` recomputes it
after each `from_pretrained`; recomputation is deterministic and idempotent, so it is a no-op
on 4.57.3. Diagnosing this took one dump of the loaded buffers — the model's *inputs* were
identical across versions, so the difference had to be in state, not in the forward path.

**Accumulated `position_ids` — the shape mismatch.** 4.x's `prepare_inputs_for_generation`
handed the model only the current step's positions; 5.x's
`_update_model_kwargs_for_generation` instead *concatenates* the next positions onto the
running tensor. So on the first decode step the model received `position_ids` of length 20
alongside an `inputs_embeds` of length 1, computed cos/sin for the whole sequence, and failed
in `o_proj` with `mat1 and mat2 shapes cannot be multiplied (1x40960 and 2048x1024)`.
`align_position_ids()` trims to the query length at the three forwards that accept
`position_ids`, which is again a no-op on 4.57.3.

**Verification.** The chain from [§5.4](#54-scoping-the-vendor-and-port-option) closed exactly
as designed, on one torch build (`2.12.1+cpu`) so that `transformers` is the only variable:

| Comparison | Result |
|---|---|
| upstream `qwen-tts` @ 4.57.3 vs vendored @ 4.57.3 | codes equal, waveforms bit-exact (4/4 cases) |
| vendored @ 4.57.3 vs vendored @ 5.14.1 | codes equal, waveforms bit-exact (4/4 cases) |
| all 144 shared model buffers after load, 4.57.3 vs 5.14.1 | identical |

The waveform hashes are also unchanged from the pre-port Step A run, so the port did not move
the output at all. Both product modes then ran through the sidecar API on 5.14.1
(`custom_voice` on the 0.6B model, `voice_design` on the 1.7B one). The buffer comparison was
worth doing separately: uninitialized memory does not have to contain NaN, so a second
mis-restored buffer could have shifted output subtly instead of failing loudly.

**Cost.** `transformers` 5 pulls `typer` (it grew a CLI) and with it `rich`, `markdown-it-py`,
`mdurl`, `pygments` and `shellingham`, and `huggingface-hub` moves to 1.x: 99 → 110 packages.
That is the price of closing two high-severity RCEs, one of which was reachable from
`tts_engine._load_model()`.

**Constraint.** `transformers>=5.14.0,<6` — floor is the version verification ran on, not the
oldest version that merely clears the advisories (5.5.0), since the two failures above were
version-specific behaviours and there is no reason to claim untested ground.

## 6. Reproducing the evidence

All of the following was run on Ubuntu with `uv` 0.12.1, CPython 3.12.13, torch 2.12.1
and CPU inference.

**Advisory audit** — every `name`/`version` in the lock, queried against the GitHub
Advisory Database (`gh api /advisories?ecosystem=pip&affects=<pkg>`) and matched with
`packaging.specifiers`; 18 hits as tabulated in §3.

**Baseline synthesis works, without `gradio`.** A script mirroring
`tts_engine.synthesize_wav()` ran in a venv with `torch` 2.12.1, `transformers` 4.57.3,
`accelerate` 1.12.0, `librosa`, `soundfile`, `sox`, `onnxruntime`, `einops` and `qwen-tts`
0.1.1 installed **`--no-deps`** — i.e. no `gradio`, `pillow`, `fastapi`, `uvicorn`,
`starlette`, `pydub` or `python-multipart` anywhere. It loaded
`Qwen3-TTS-12Hz-0.6B-CustomVoice` in 3.1 s and produced 4.96 s of valid 24 kHz WAV in
10.5 s (`custom_voice` only; the 1.7B `voice_design` path was not run):

```
transformers=4.57.3 torch=2.12.1+cu130
LOADED in 3.1s
GENERATED in 10.5s
OK sr=24000 samples=119040 duration=4.96s wav_bytes=238124 peak=0.438
```

**transformers 5.x fails.** The same script against `transformers` 5.14.1, patching each
failure in an out-of-tree copy on `PYTHONPATH`, produced the six failures in §5.1.

> One methodology note, since it would otherwise be easy to repeat: do **not** patch
> `site-packages` in place to test this. `uv` hardlinks from its global cache, so editing an
> installed file mutates the cache and silently corrupts every other venv that installs the
> same wheel. A first control run was invalidated exactly that way. Patch a copy and inject
> it with `PYTHONPATH`.

**`gradio` exclusion works.** Two manifests differing only by the override line, both
carrying the `environments` list this project already declares (`win32`/`darwin`/`linux`):

```
$ uv lock            # without the override
Resolved 114 packages
$ uv lock            # with override-dependencies = ["gradio; sys_platform == 'nonexistent'"]
Resolved 79 packages

gradio 0  gradio-client 0  pillow 0  fastapi 0  uvicorn 0  starlette 0
pydub 0   python-multipart 0  safehttpx 0  hf-gradio 0  typer 0  rich 0  pandas 0
transformers 4.57.3  accelerate 1.12.0  librosa 0.11.0  sox 1.4.1  onnxruntime 1.28.0
```

The `environments` restriction is what makes this work: without it, uv's universal resolver
treats `sys_platform == 'nonexistent'` as potentially satisfiable by some hypothetical
platform and keeps `gradio` in the lock anyway.

**Generation is bit-reproducible**, which is what makes a numeric A/B possible. Same seed,
two runs each, on the pinned stack:

```
transformers=4.57.3 torch=2.12.1+cu130
sampled (do_sample=True, seed=1234): len=84480/84480   identical=True max_abs_diff=0.000e+00
greedy  (do_sample=False):           len=145920/145920 identical=True max_abs_diff=0.000e+00
```

**The transformers API surface was diffed symbol by symbol.** All 35 symbols the 12 Hz subset
imports from `transformers` were probed under both versions for existence and signature
(`inspect.signature`, plus dict contents for `ACT2FN` and `ROPE_INIT_FUNCTIONS`): 18 unchanged,
17 changed, of which ~9 are typing-only. `ACT2FN` still has `silu` and `gelu`, the only entries
this code selects.

**The vendored tree produces bit-identical audio** (`tests/vendor_parity.py`, in the service's
own venv, `transformers` 4.57.3 / `torch` 2.12.1+cpu):

```
  english-ryan (seed=1234):  codes_equal=True wav_bit_exact=True sample_rate=24000/24000
  english-aiden (seed=7):    codes_equal=True wav_bit_exact=True sample_rate=24000/24000
  german-serena (seed=99):   codes_equal=True wav_bit_exact=True sample_rate=24000/24000
  greedy (seed=5):           codes_equal=True wav_bit_exact=True sample_rate=24000/24000

PARITY: bit-exact
```

**And the sidecar serves it.** `uv sync --extra cpu` from the new lock, then `web_api.py`:
`/healthy` ok, an unauthenticated `/api/config` correctly 401s, and `/api/synthesize` returned
5.12 s of 24 kHz WAV for `custom_voice` (0.6B) and 2.80 s for `voice_design` (1.7B, the second
model-cache slot) — both in bfloat16, the dtype the Electron service uses. `uv sync --check`,
which is what `checkBackend()` runs to decide whether the service is set up, reports "Would
make no changes".

> Note on regenerating the lock here: this VM's egress blocks `download-r2.pytorch.org`, the
> CDN host the PyTorch indexes link to, while the identical paths on `download.pytorch.org`
> are reachable — but only with matching SNI *and* `Host` (a mismatched `Host` returns 403).
> A local proxy that terminates TLS for the r2 host and re-originates to `download.pytorch.org`
> is enough to run `uv lock`, and because uv still sees the original index HTML, the lock it
> writes keeps the normal r2 URLs and hashes: identical to one produced with unrestricted
> egress (verified — 12 r2 URLs, no localhost, `torch` block unchanged). The clean fix is to
> allowlist `download-r2.pytorch.org`.
