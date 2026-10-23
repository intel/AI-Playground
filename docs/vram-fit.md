# VRAM fit catalog

Empirical GPU-memory numbers for the llama.cpp estimator in `WebUI/src/lib/vram/`
and for the sidecar/Comfy peaks that estimator cannot compute from a GGUF header.
Use this when wiring **keep-loaded**, **LLM ↔ Comfy swap**, and **preset
recommendation** (hide / warn / allow).

Machine-readable copy: [`vram-measurements.json`](vram-measurements.json).

The estimator drives the model-size chip: next to the active model (status bar and
the picker's trigger) and on **every row of the picker's list**, so the verdict is
there while choosing rather than after. Product defaults it assumes:
`--gpu-layers 999 --no-mmap`, flash-attn on, `nParallel: 1`,
`VRAM_USABLE_FRACTION = 0.90` (`fit.ts`).

**The header is read whether or not the model is downloaded.** A GGUF's metadata
sits at the front of the file, so `electron/remoteGgufMeta.ts` range-requests it
from HuggingFace for a model that is not on disk — the verdict is worth the most
before paying for the download. It grows the window (1 → 4 → 16 MiB, appending
rather than refetching), takes the file's size from the `Content-Range` total and
the projector's from a HEAD, refuses any response that is not a `206` (a server
that ignored the range would hand back the whole model), and caches the result in
`{userData}/gguf-vram-cache.json`.

**A megabyte is the whole answer, and the parser is allowed to stop there.**
Reading a header to its end costs ~16 MiB and ~6 s for a 250k-token vocabulary,
which a list of 30 models cannot pay. Writers emit every `<arch>.*` key before the
tokenizer's, and a vocabulary's size is its array length — known before its
contents — so a parse that reached the tokenizer already holds everything the
estimator reads. `parseGgufMetadata(reader, { allowTruncated: true })` returns
what it got, `archIsSettled` decides whether that is enough, and only an unsettled
header grows the window (or, on disk, re-reads without a limit). Checked against
the six architectures in the catalog — hybrid, MoE, SWA, dense, gpt-oss, MTP — one
megabyte gives byte-identical arch and identical estimates to the full header.
The whole llamaCPP catalog then reads in 40 MiB and ~70 s cold, sequentially; the
picker reads three at a time and each result is cached for good.

**A split model's weights are all of its shards.** The catalog names shard one, and
its size alone made a 122B model look like 0.9 GiB and green; `shardedWeightsBytes`
HEADs the rest and refuses to answer at all if one cannot be sized. A model whose
file 404s (three in the catalog point at names their repo does not have) gets no
chip, which is the honest answer — it cannot be downloaded either.

## How these numbers were taken

- **Box:** Windows, Intel Arc B390. Comfy reports “Total VRAM” **34361 MiB**.
  Dedicated WDDM is 0; the working set is **shared** VidMm (system RAM).
- **Sampler:** process-tree `\GPU Process Memory(*)\Shared Usage` via `typeperf`
  (`scripts/vram-measure.mts`, `scripts/vram-measure-process.mts`). Do not use
  `xpu-smi` on Windows while Vulkan llama.cpp is up (`ErrorDeviceLost`).
- **AIPG Electron was stopped.** Orphan `llama-server` / `ovms` / Comfy python
  were killed between families. Two Vulkan servers must not run at once.
- **Units:** 1 GiB = 1024 MiB. Tables below round peaks to 0.1 GiB; JSON keeps
  the sampled MiB.
- **Do not test `-fa off` on this Arc** (device-lost).

Comfy idle (server up, no checkpoint) is **~219 MiB**. Subtract that only if a
decision needs “checkpoint vs empty Comfy”; catalog peaks already include it.

Between video sizes, POST `/free` `{ free_memory: true, unload_models: false }`
drops the activation workspace (~0.8 GiB) and **keeps weights**. WDDM does not
return the 22B working set. Unloading models is not required for a scale sweep.

## Decision sketch (not implemented)

For a workload with required bytes `R` and card total `T` (B390: 34361 MiB):

1. Empty-card budget `B = 0.90 × T` (~30925 MiB / 30.2 GiB on this box).
2. LLM: `R = estimateLlamaCppVram(...)`. The 10% pad covers the typical 2–7%
   Vulkan miss; see calibration. Gemma 3 4B still has a ~1 GiB floor.
3. Sidecar / Comfy: `R = catalog peak` for that preset (or the video formula
   below). There is no GGUF-style estimate yet.
4. Co-resident: `bothFit(llm, sidecar, budget)` (`fit.ts`). If false, swap
   (unload LLM, run Comfy, reload) instead of keep-loaded.
5. iGPU / unified: also require `R ≤ hostFree − 4 GiB` (`HOST_RESERVE_BYTES`).
   Shared GPU **is** host RAM; a 32 GiB LTX peak can pagefile-OOM the box even
   when the GPU “total” says it fits. Watch commit charge, not only the GPU
   counter.

## llama.cpp calibration

Flags match AIPG: `--gpu-layers 999 --no-mmap -fa on`. Positive delta = estimate
**under** measured shared GPU memory.

| Model | Ctx | KV path | Estimate (MiB) | Measured (MiB) | Delta |
|---|---:|---|---:|---:|---|
| Qwen3.5-9B Q4_K_M + mmproj | 8k | hybrid | 6639 | 7143 | +504 (7.1%) |
| Qwen3.5-9B Q4_K_M + mmproj | 32k | hybrid | 7383 | 7935 | +552 (7.0%) |
| Qwen3.5-9B Q4_K_M + mmproj | 128k | hybrid | 10479 | 11246 | +767 (6.8%) |
| Qwen3.5-9B MTP, spec off | 32k | hybrid | 7817 | 8222 | +405 (5%) |
| Qwen3.5-9B MTP, `--spec-type draft-mtp` | 32k | hybrid+mtp | — | — | **+514 (5.2%)** after `MTP_SPEC_WEIGHT_FRACTION = 0.25` (was ~20%) |
| Qwen3.8-27B, spec off | 8k | hybrid | 18689 | 19279 | +590 (3.1%) |
| Qwen3.8-27B, draft-mtp | 8k | hybrid+mtp | — | 23413 | ~20% before the 0.25×weights term; extra is ~23–25% of the GGUF, not nextn KV |
| Gemma 3 4B Q4_K_M | 8k / 32k / 128k | swa (period 6) | | 3705 / 4218 / 6350 | ~1 GiB floor; period 6 stops 128k from going *over* |
| Gemma 4 E4B Q4_K_M | 8k | swa | 4938 | 5515 | +577 (10.5%) |
| Gemma 4 E4B Q4_K_M | 32k | swa | 5310 | 5934 | +625 (10.5%) |
| Gemma 4 E4B Q4_K_M | 128k | swa | 6858 | 7679 | +822 (10.7%) |
| Llama 3.1 8B Q4_K_M | 8k | gqa/legacy | 5754 | 5860 | +106 (1.8%) |
| Llama 3.1 8B Q4_K_M | 32k | gqa/legacy | 8730 | 8903 | +174 (1.9%) |
| Llama 3.1 8B Q4_K_M | 128k | gqa/legacy | 21114 | 21490 | +377 (1.8%) |
| LFM2.5-350M Q4_K_M | 128k | gqa (per-layer KV) | — | — | +348 (16.5%); was 2× over when conv layers were billed as attention |
| GPT-OSS 20B Q8_0 | 8k | swa | 11698 | 11902 | +205 (1.7%) |
| GPT-OSS 20B Q8_0 | 32k | swa | 11977 | 12508 | +531 (4.2%) |

Estimator code notes that belong with these rows:

- Qwen3.5/3.8 hybrid: only `1/full_attention_interval` layers hold transformer KV;
  Mamba recurrent is separate.
- Gemma 3 GGUF has no SWA pattern → default period **6** (`arch.ts`).
- LFM2: `head_count_kv` is per-layer; zero-head (conv) layers are skipped.
- `--spec-type draft-mtp`: charge **0.25 × GGUF file size** plus nextn KV, not
  nextn KV alone.
- `nParallel` is **1** for VRAM (llama.cpp `/props` `total_slots: 4` must not
  multiply the decode graph).

## Sidecar / image catalog (peaks to fit against)

One generate (or one `/api/load`) per row. Comfy graphs in `scripts/comfy-*.json`.

| Workload | Peak | Notes |
|---|---:|---|
| bge-small embed (`llama-server --embedding`) | **47 MiB** | file 35 MiB |
| Whisper base int8 (OVMS GPU) | **56–133 MiB** | first load 133; later 56 |
| Qwen3-TTS 0.6B custom voice | **2.5–2.6 GiB** | after `/api/load`; idle ~0 |
| Qwen3-TTS 1.7B VoiceDesign | **4.3 GiB** | load via `QWEN3_TTS_MODEL` + `custom_voice` probe, `QWEN3_TTS_WARMUP=0` |
| Comfy SD1.5 512, DreamShaper, 8 steps | **3.3 GiB** | |
| Comfy SDXL 1024, Juggernaut, 8 steps | **10.5 GiB** | |
| Comfy Flux.2 Klein 4B fp8 @ 1024, 4 steps | **12.0 GiB** | |
| Comfy LTX 2B t2v 768×512 × 25f, 8 steps | **14.1 GiB** | isolated run; see video table |

Not measured: Qwen3-Embedding-0.6B (weights not on the box), Wan 14B i2v.

## Video scaling (LTX)

Distilled 8-step graphs. LTX 2B = fp8 checkpoint + T5
`t5xxl_fp8_e4m3fn`. LTX 2.3 = UnetLoaderGGUF 22B Q4_K_S + DualCLIPLoaderGGUF
Gemma 3 12B Q3_K_M + video/audio VAE, tiled VAE decode, CFG 1.

**Use `/free` peaks for 2.3.** 2B 768×512×25 catalog number is the **isolated
14.1 GiB** run; a later sweep that stacked 49-frame cache read 14.7 GiB.

| Model | Size | Peak | Activations (peak − post-`/free` rest) |
|---|---|---:|---:|
| LTX 2B | 512×512 × 9f | **11.9 GiB** | (first load; mostly weights) |
| LTX 2B | 512×512 × 25f | **12.5 GiB** | ~0.6 GiB vs 9f |
| LTX 2B | 512×512 × 49f | **14.4 GiB** | no `/free`; may include leftover 25f cache |
| LTX 2B | 768×512 × 25f | **14.1 GiB** | isolated; prefer this over the 14.7 stacked figure |
| LTX 2.3 | 512×512 × 25f | **27.5 GiB** | rest after `/free` **~26.7 GiB** (weights) |
| LTX 2.3 | 512×512 × 49f | **29.0 GiB** | act **2.3 GiB** |
| LTX 2.3 | 768×512 × 25f | **28.9 GiB** | act **2.1 GiB** (was 30.6 without `/free`) |
| LTX 2.3 | 512×512 × 105f | **32.3 GiB** | act **5.6 GiB**. Product default (~24 fps × 4.4 s) |

2.3 `/free` rest clustered at **26.7–26.8 GiB** = 22B + Gemma 12B + dual VAE.
That is the number to keep resident if keep-loaded; generate adds the
activation column.

### What the estimator should assume

```
peak ≈ weights(model) + k · W · H · T^α
```

On this data, **α ≈ 1.4** in frame count at 512² (not linear, not T²):

| Frames | 2.3 activations |
|---:|---:|
| 25 | ~0.8 GiB |
| 49 | 2.3 GiB (×2.7 vs 25; 49/25 = 1.96) |
| 105 | 5.6 GiB (×6.7 vs 25; 105/25 = 4.2) |

Resolution 512² → 768×512 is 1.5× pixels and ~2.5× activations at 25f on 2.3
(0.8 → 2.1 GiB). Spatial is steeper than linear W×H in this range, but still
small next to 26.7 GiB of weights.

**Frame length, not the 22B vs 2B gap, drives the increment.** 25→49 frames
added ~1.8–1.9 GiB on both models. The 15 GiB jump 2B→2.3 is weights.

**105f @ 512² = 32.3 GiB** vs empty-card budget **30.2 GiB** (90% of 34361).
A 90% rule would **warn / refuse** the product default on this B390; a 100%
rule still has ~1.2 GiB of Comfy-reported headroom. Recommendation logic
should treat 105f 2.3 as “fits this card, not the 90% pad.”

## Measurement gotchas

- **Intel Graphics overlay leak:** `IntelGraphicsSoftware.Overlay` held ~145 GB
  private commit on the box; safetensors mapping then failed with “paging file
  is too small.” Kill it before a Comfy sweep (`vram-measure-video-scale.ps1`).
- **Loopback auth:** Comfy `/system_stats` and `/prompt` need
  `Authorization: Bearer` (`AIPG_LOOPBACK_TOKEN`). `/queue` does not.
- **TTS 1.7B:** `QWEN3_TTS_VOICE_DESIGN_MODEL` did not reach Python (CR in the
  env wrapper). Working path: `QWEN3_TTS_MODEL` = VoiceDesign 1.7B dir +
  `{"mode":"custom_voice"}`.
- **LTX 2B CLIP:** the distilled checkpoint has no CLIP; the graph must load
  T5 separately (`scripts/comfy-ltx-t2v.json`).
- CUDA / XPU cache **does not shrink** between generates unless `/free` (or a
  process restart). Never compare resolution/frame deltas from a stacked sweep.

## Re-run

From a Windows box with the models, AIPG stopped:

```text
scripts/vram-measure.mts              # one llama-server vs header estimate
scripts/vram-measure-sidecars.ps1     # embed, STT, TTS 0.6B, SD15, SDXL
scripts/vram-measure-more.ps1         # Flux + LTX 2B
scripts/vram-measure-tts17.ps1        # TTS 1.7B
scripts/vram-measure-video-scale.ps1  # LTX 2B then 2.3 sweeps (`/free` between runs)
```

Sweep JSON: `scripts/vram-sweep-ltx2b.json`, `scripts/vram-sweep-ltx23.json`.

## Still missing

- Wan 14B i2v
- Qwen3-Embedding-0.6B
- MLA (DeepSeek-style) llama.cpp path
- Image-resolution sweeps (SD / Flux) comparable to the LTX table
- OVMS LLM (no GGUF math; catalog-only if we measure it)
- Linux / dedicated-VRAM discrete Arc (these rows are WDDM shared on B390)
