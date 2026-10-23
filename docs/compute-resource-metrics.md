# Compute resource metrics

How AI Playground samples GPU and host memory, how those numbers land on Laminar
traces, and how they are shown in the UI.

## Why one sampler

Token speeds already come from the inference server (`timings` on llama.cpp, wall
clock elsewhere). They say how fast a call was, not what the machine was doing:
vRAM filled, GPU busy, host RAM stolen by an iGPU. Those are hardware facts, so
they are collected once in the Electron main process and fanned out to two
consumers:

1. **Traces** — peak/last values on the LLM span (`aipg.gpu.*` / `aipg.host.*`)
   and filterable metadata on the run root (`gpuUtilPeak`, `gpuMemPeakMib`,
   `hostMemPeakMib`), so a slow Game Agent turn can be correlated with a vRAM
   spike or a GPU that never left idle.
2. **UI** — live chip on the prompt status bar, and per-turn peaks on the chat
   message footer, both gated by Chat Settings → Metrics (the same toggle as
   tokens/s).

A probe failure never fails a turn. On Windows, missing vendor SMI still leaves
DXGI/PDH; missing WDDM suppresses utilization rather than substituting a known
incorrect vendor value. If every GPU probe is missing, the snapshot has host
RAM only.

## Sources

| Vendor / OS      | Probe                                                                                        | Notes                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Host (all)       | `os.totalmem` / `os.freemem`                                                                 | Always present. On Intel iGPU, most GPU memory is stolen from this pool (shared).            |
| Windows GPUs     | DXGI `GetDesc1` + PDH `\GPU Adapter Memory(*)` / `\GPU Engine(*)` via `koffi` (`dxgi`/`pdh`) | Same VidMm counters Task Manager reads. Memory used/total come from here, not from xpu-smi.  |
| NVIDIA (extra)   | `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`                                     | Power / clocks overlay; memory still WDDM on Windows.                                        |
| Intel SMI extra  | `xpu-smi` on `PATH` (Linux only)                                                             | Power / freq / memory. **Not sampled on Windows** — Level Zero queries reset Vulkan llama.cpp (`ErrorDeviceLost`). |
| Intel, Linux GPU | `xpu-smi` if XPU Manager is installed                                                        | No WDDM. Not bundled today (Linux discovery still uses `lspci`).                             |

### Windows: Task Manager (WDDM), not xpu-smi

xpu-smi (including 2.1.0) reports a board-firmware memory size that is wrong on
Intel iGPU — Arc B390's carve-out is tiny; the working set lives in **shared**
VidMm, which is what Task Manager shows. `torch.xpu.mem_get_info()` raises on
that device. WMI `AdapterRAM` is a 32-bit field. DXGI
`QueryVideoMemoryInfo` is **this process only**.

Windows sampling talks to the same two APIs Task Manager uses, from Electron
main, through `koffi` (already used for `user32` / `Shell32`):

| Value           | API                                            | What                                                           |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| Dedicated used  | PDH `\GPU Adapter Memory(*)\Dedicated Usage`   | bytes, English path (`PdhAddEnglishCounterW`)                  |
| Shared used     | PDH `\GPU Adapter Memory(*)\Shared Usage`      | bytes                                                          |
| GPU util        | PDH `\GPU Engine(*)\Utilization Percentage`    | busiest physical engine, same as Task Manager's overall figure |
| Dedicated total | DXGI `DXGI_ADAPTER_DESC1.DedicatedVideoMemory` | bytes                                                          |
| Shared total    | DXGI `DXGI_ADAPTER_DESC1.SharedSystemMemory`   | bytes                                                          |

PDH instance names are `luid_0x{High}_0x{Low}_phys_N`. DXGI `AdapterLuid` is
the join key. Software / Basic Render adapters are skipped.

Roll-up for the existing `memUsedMiB` / `memTotalMiB` fields (chip, traces):

- **Discrete** (dedicated capacity ≥ 3 GiB): dedicated only.
- **iGPU**: dedicated + shared, so the chip matches Task Manager's combined GPU
  memory rather than the 128 MiB carve-out xpu-smi calls "max".

The tooltip still lists dedicated and shared separately. nvidia-smi still
overlays power and frequency on NVIDIA Windows boxes. **Intel `xpu-smi` is not
sampled on Windows**: spawning it every 2s while llama.cpp is in Vulkan decode
causes `vk::Device::getFenceStatus: ErrorDeviceLost` (reproduced standalone
against xpu-smi 2.1.0 + llama.cpp b10666 on Arc B390). WDDM already supplies
memory and utilization; the only loss is Intel board power/clocks (and thus
the experimental chat energy estimate on Intel Windows). Linux still uses
xpu-smi — there is no WDDM there.

If WDDM is unavailable on Windows, NVIDIA memory can remain as a fallback, but
Intel SMI is not substituted.

The PDH query stays open for the sampler lifetime (engine util is a rate
counter — the first collect only arms it). `GPU Engine` rows are process
contexts (`pid_…_luid_…_phys_…_eng_…`), not already-aggregated adapters. The
sampler sums contexts belonging to the same physical engine, then reports the
busiest engine for each adapter. Taking the largest individual row would
undercount an engine shared by the app, compositor, and other processes.

Stock WDDM PDH has **no GPU power, clocks, or temperature**. On intel-ptl
(Arc B390) the extra counter sets are:

| Counter set | Useful? |
| --- | --- |
| `\GPU Adapter Memory(*)\Total Committed` | Different accounting than Dedicated+Shared Usage (Task Manager uses the latter, which we already read). |
| `\GPU Process Memory(*)\Dedicated/Shared Usage` | Works without admin here. iGPU working set is **shared**. Instance names are `pid_N_luid_…` — needs a PID→process map to split llama-server vs Electron vs DWM. |
| `\GPU Engine(*)\Running Time` | Cumulative; Utilization Percentage is the rate we already use. |
| `\Power Meter(*)\Power` | ACPI/RAPL; `0` on this machine, not GPU board power. |
| `\Thermal Zone Information(*)` | Package/CPU, not the Arc die. |

NPU has no util/memory probe here. Cloud turns still record **host** RAM but
omit GPU attributes — the serving GPU is not this machine.

Metric IDs for `xpu-smi dump`: `0` GPU Utilization (%), `1` GPU Power (W),
`2` GPU Frequency (MHz), `5` GPU Memory Utilization (%), `18` GPU Memory Used (MiB).

### `xpu-smi` is not one CLI — detect the dialect, never assume it

Three incompatible command surfaces ship under this name, and neither the
platform nor the version string tells them apart. Every attempt to assume one
produced a machine with no GPU rows, so the probe reads `--help` once and routes
on what it finds (`detectXpuDialect`):

| Dialect     | Detected by                             | Sampling command                                     |
| ----------- | --------------------------------------- | ---------------------------------------------------- |
| `query-gpu` | `--query-gpu` appears in `--help`       | `--query-gpu=<fields> --format=csv,noheader,nounits` |
| `dump`      | anything else (the CLI Intel documents) | `dump -d <id> -m 0,1,2,5,18 -n 1`, per device        |

What each of the three got wrong when assumed:

- **Linux `xpumcli`** accepts `dump -d -1` ("all devices") and `discovery --dump`.
  Both are Linux-only spellings; the Windows CLI rejects them.
- **The documented Windows CLI** takes `dump -d <id> -m …`, one device at a time,
  and lists devices with `discovery -j` (board memory needs `discovery -d <id> -j`).
- **xpu-smi v2.0 on Arc B-series** — the build this repo pins — is
  nvidia-smi-shaped: `--query-gpu`, `--format=csv`, `--id`, `--list-gpus`. Its
  `dump` exists but rejects `-m`/`-n`
  (`The following arguments were not expected: -m 0,1,2,5,18 -n 1`).

Because a build rejects the _whole_ query if one field is unknown, the
`query-gpu` path walks a ladder of field sets (richest first, down to
`memory.used`) and remembers the one that worked. `--query-gpu` field names are
nvidia-smi's, so one parser (`parseQueryGpuCsv`, driven by the requested field
list rather than column position) serves both vendors.

The binary also lives in two places: electron-builder installs it to
`<resources>/device-service/xpu-smi.exe` (`build-config.json`) while the fetch
script leaves it at `build/resources/xpu-smi.exe` for `npm run dev`.
`getXpuSmiExePath()` tries both — checking only the dev path is why a packaged
build silently fell back to the PowerShell device probe.

## Diagnosing a machine with no GPU numbers

Everything below is logged under the `compute-metrics` source, to the console,
the in-app debug stream, and `aip-<date>.log` (packaged: the app's config root;
dev: `WebUI/external/`).

- At startup, forced to the log file:
  `[compute-metrics]: sampling every 2000ms on win32; intel probe: disabled (Vulkan device-lost); nvidia probe: nvidia-smi.exe`
- The detected dialect: `xpu-smi dialect: query-gpu`
- After discovery: `xpu-smi discovered N device(s): 0=Intel(R) Arc(TM) B580 Graphics`
- The sampling command that worked:
  `xpu-smi sampling with --query-gpu=index,name,utilization.gpu,memory.used,memory.total`
- On failure, once per distinct failure (the poll runs every 2s, so repeats are
  suppressed): `probe failed: <command> <args> — exit <code>: <stderr>`

`window.electronAPI.getComputeMetricsDiagnostics()` in DevTools returns the same
thing as data: which binary each probe resolved to, the dialect and sampling
command it settled on, the device ids discovery returned, the last error per
vendor, and when each last succeeded.

If a build turns out to speak a fourth dialect, that pair of log lines (dialect,
then the failing command with its stderr) is what identifies it — start there
rather than reading the code.

## Sampling

`electron/computeMetrics.ts` polls every 2s after the window is created, skips
overlapping ticks (a 1s Intel dump must not pile up), and keeps ~120 samples
(~4 min). The renderer gets each snapshot over `computeMetricsUpdate`.

Pick the GPU to report: name-match against the selected device (`deviceName` on
the trace context), else the card with the highest memory used.

## Experimental chat energy estimate

The existing Chat Settings → Metrics checkbox also enables a deliberately
small, removable experiment in `src/lib/chatEnergy.ts`
(`CHAT_ENERGY_ESTIMATES_ENABLED` is the compile-time kill switch):

1. At turn start, the renderer retains the latest sampled board power.
2. Between 2-second snapshots it treats the last valid watt reading as held,
   clips the first/last interval to the turn wall-clock boundaries, and sums
   watt-milliseconds into Wh. Gaps with no power value contribute nothing.
3. The completed assistant message persists `metadata.energy` with the turn's
   Wh and AI SDK `totalUsage.outputTokens` (all tool/model steps, not merely
   the final step).
4. The chat footer sums only assistant turns that have **both** measured energy
   and `usage.outputTokens`, then reports:
   `sum(kWh) × $0.35 / sum(output tokens) × 1,000,000`.

This is an estimate of GPU board energy during the whole user-visible turn,
including model preparation, not total wall-plug/system energy. Cloud turns
and local turns whose SMI dialect exposes no power are omitted; their tokens
are also omitted from the denominator so missing measurements cannot make the
cost look artificially low. Deleting or regenerating a message naturally
recomputes the conversation figure from the messages that remain.

## Follow-ups worth doing, not in this slice

- Bundle `xpu-smi` for Linux the way Windows already does, or a sysfs/`xe`
  fallback for freq + drm client memory when XPU Manager is absent.
- Long-lived `xpu-smi dump` (no `-n 1`) to avoid the 1s dump interval — which
  also removes the per-device call this now makes on a multi-GPU box.
- Backend-owned numbers: llama.cpp `/slots` KV bytes, ComfyUI's own VRAM
  estimate — complementary to board-level SMI, not a replacement.
- Per-process GPU memory: PDH `\GPU Process Memory(*)\Shared Usage` (iGPU) /
  `Dedicated Usage` (dGPU). Instance names are PIDs; map `llama-server` /
  Electron / ComfyUI to split the adapter total. Worked without admin on
  Arc B390; some Intel setups still need `cap_perfmon`. Fit-estimator
  calibration from those counters: [`vram-fit.md`](vram-fit.md).
- Re-enable Windows `xpu-smi` only after Intel fixes Level Zero vs Vulkan
  device-lost (`scripts/gpu-metrics-llama-repro/`). Until then there is no
  safe WDDM source for Intel board power/clocks.
- Linux iGPU: drm/sysfs client memory so Linux is not stuck on xpu-smi totals.
