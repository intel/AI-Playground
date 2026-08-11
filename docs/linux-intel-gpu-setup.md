# Linux Intel GPU Setup

How AI Playground uses Intel GPUs on Linux and what must already be on the
host. AI Playground **does not install** Linux GPU drivers or kernels — prepare
the system **before** you install the app (AppImage, `.deb`, or dev build).

> TL;DR (host prep **before** AI Playground)
>
> 1. Follow Intel's **[OMIX install guide](https://dgpu-docs.intel.com/installation-guides/installing-omix.html)** for kernel + compute drivers (`intel-omix`).
> 2. Install **Vulkan** from Ubuntu (§2b) — required for llama.cpp GPU, not covered by OMIX alone.
> 3. Verify Level Zero / Vulkan (§3), then install AI Playground and reinstall backends if needed (§5).
>
> The card showing up in `lspci` is **not** enough — that's only the PCI device;
> you need userspace compute and Vulkan drivers on the host first.

---

## 1. How backend → GPU selection works

Each backend independently decides whether to use the GPU on Linux. The decision
is made by `WebUI/electron/subprocesses/deviceDetection.ts`, which checks both
hardcoded library paths **and** the dynamic linker cache (`ldconfig -p`) so it
works across distros. The decision is **logged** to the terminal running
`npm run dev` (not the in-app console, because it runs at service-construction
time before the renderer logger attaches):

```
Linux Level Zero runtime detected — Intel GPU (XPU) enabled
Linux Vulkan loader detected — llama.cpp will use the GPU (ubuntu-vulkan-x64) build
```

| Backend       | Variant/build chosen                            | Gating function                                                | Required runtime                 |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| **llama.cpp** | `ubuntu-vulkan-x64` (GPU) vs `ubuntu-x64` (CPU) | `linuxHasVulkanLoader()`                                       | Vulkan loader + Intel ANV        |
| **ComfyUI**   | `xpu` (torch+xpu) vs `cpu`                      | `linuxHasLevelZeroRuntime()`                                   | Level Zero loader + Intel L0 GPU |
| **OpenVINO**  | `GPU` device exposed via OVMS                   | OpenVINO `ov.Core().available_devices` (Python detection venv) | Level Zero and/or OpenCL         |

The build/variant is chosen **at install time**, so after installing the GPU
drivers you must **reinstall** (or re-pick) the affected backends — see §5.

### Hardware support note

Upstream **PyTorch XPU** (`torch.xpu`, used by ComfyUI XPU) only supports **Arc (DG2)**,
Data Center GPU Max, and **Core-Ultra Xe iGPUs (Meteor/Lunar/Panther Lake)**.
Older **Gen9 iGPUs (e.g. HD Graphics 630)** are **not** supported by XPU — on
those, ComfyUI correctly stays on CPU. llama.cpp (Vulkan) and OpenVINO (GPU)
_can_ still use Gen9.

---

## 2. Host setup before installing AI Playground

Do this on Ubuntu **before** installing AI Playground. None of these steps are
run by the app installer; they are standard system administration.

### 2a. Intel OMIX (kernel + compute drivers)

Use Intel's documentation as the source of truth for repository setup, kernel
requirements, `intel-omix` installation, render-group access, and upgrades:

**[Installing Intel Open Middleware Xe](https://dgpu-docs.intel.com/installation-guides/installing-omix.html)**

Check your GPU, Ubuntu version, and kernel against Intel's
[OMIX support matrix](https://dgpu-docs.intel.com/overview/support-matrix/omix-support-matrix.html)
before you start. On Ubuntu 24.04, Intel currently documents **24.04.4**, **26.04**,
or **24.04 with the 6.17 HWE kernel** for OMIX — follow Intel's prerequisites
and installation steps there, not a copy in this repo.

What AI Playground expects after you finish Intel's guide:

| Host requirement | Used by |
| ---------------- | ------- |
| `intel-omix` runtime (Level Zero + OpenCL compute stack) | ComfyUI XPU, OpenVINO GPU |
| Kernel version Intel documents for your hardware | Stable GPU/NPU binding |
| Membership in the DRM **render** group (per Intel's guide) | OpenCL / Level Zero device access |

You do **not** need `intel-omix-dev` to run AI Playground — that package is for
building PyTorch/SYCL workloads locally.

> **Corporate proxy tip.** Intel's guide uses `wget` for the GPG key. If
> `http(s)_proxy` is set but `no_proxy` includes `*.intel.com`, `wget` may hang
> because `repositories.intel.com` resolves outside that pattern. Prefer
> `curl -fsSL ${http_proxy:+--proxy "$http_proxy"} https://repositories.intel.com/gpu/intel-graphics.key | sudo gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg`
> when fetching the key.

Optional: install `clinfo` from apt if Intel's procedure does not already, so you
can verify OpenCL in §3.

### 2b. Vulkan (llama.cpp GPU build — not in OMIX)

OMIX covers the compute stack for ComfyUI and OpenVINO; **llama.cpp** still needs
Vulkan from Ubuntu. Install this on the host before AI Playground as well:

```bash
sudo apt-get install -y libvulkan1 mesa-vulkan-drivers vulkan-tools
```

- `libvulkan1` → `libvulkan.so.1` loader.
- `mesa-vulkan-drivers` → provides `libvulkan_intel.so` (the **ANV** driver that
  drives Arc/DG2 and Gen9+ iGPUs).

### 2c. Render-node permissions (if not already done)

Intel's OMIX guide adds your user to the **render** group. Some setups also need
**video** for legacy `i915` paths:

```bash
sudo gpasswd -a "$USER" render
sudo gpasswd -a "$USER" video
# log out/in (or `newgrp render`) so the group membership applies
```

### 2d. (Optional) Install the Intel NPU userspace driver

Required only if your CPU has an integrated NPU (Meteor/Lunar/Panther/Arrow Lake)
**and** you want OpenVINO to enumerate `NPU` as an inference target. Without it,
`Core().available_devices` silently returns only `['CPU', 'GPU']` — even though
`/dev/accel/accel0` is present and `intel_vpu` is loaded.

The NPU userspace **is not in the GPU APT repo above**. It ships only as a
release tarball on GitHub:

```bash
# Pick the latest tag from https://github.com/intel/linux-npu-driver/releases
NPU_TAG=v1.33.0
NPU_BUILD=v1.33.0.20260529-26625960453

cd /tmp
curl -fL ${http_proxy:+--proxy "$http_proxy"} \
  -o linux-npu-driver.tar.gz \
  "https://github.com/intel/linux-npu-driver/releases/download/${NPU_TAG}/linux-npu-driver-${NPU_BUILD}-ubuntu2404.tar.gz"

mkdir -p linux-npu-driver && tar -xzf linux-npu-driver.tar.gz -C linux-npu-driver

sudo apt install -y \
  ./linux-npu-driver/intel-driver-compiler-npu_*.deb \
  ./linux-npu-driver/intel-fw-npu_*.deb \
  ./linux-npu-driver/intel-level-zero-npu_*.deb
```

Verify (after re-login so `render` group membership is active):

```bash
ls /usr/lib/x86_64-linux-gnu/libze_intel_npu.so*   # plugin must exist
# Use the app's managed Python venv (system python3 won't have openvino):
~/.local/share/ai-playground/resources/OpenVINO/.venv/bin/python3 -c \
  "import openvino as ov; print(ov.Core().available_devices)"
# Expected: ['CPU', 'GPU', 'NPU']
```

> **Kernel pairing.** The NPU userspace ABI is locked to the kernel `intel_vpu`
> module. Panther Lake needs **kernel ≥ 6.10**; on older Ubuntu kernels
> install `linux-generic-hwe-24.04`.
>
> **Proxy.** GitHub release downloads redirect to AWS, which the
> `*.intel.com` `no_proxy` rule does **not** cover. The `${http_proxy:+--proxy ...}`
> form above forwards the proxy explicitly when one is set.

### 2e. Alternative: legacy `unified` repository (hardware outside OMIX)

If your GPU or Ubuntu/kernel combination is **not** listed in Intel's OMIX support
matrix (for example some Arc A-series setups on an older 24.04 kernel), install
Level Zero from Intel's generic GPU repo **before** AI Playground using the
legacy path:

```bash
curl -fsSL ${http_proxy:+--proxy "$http_proxy"} \
  https://repositories.intel.com/gpu/intel-graphics.key \
  | sudo gpg --dearmor --output /usr/share/keyrings/intel-graphics.gpg

echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble unified" \
  | sudo tee /etc/apt/sources.list.d/intel-gpu-noble.list

sudo apt-get update
sudo apt-get install -y libze-intel-gpu1 libze1 intel-opencl-icd clinfo
```

If `apt-get update` 404s on `unified`, Intel may have pinned a dated path (e.g.
`noble/production/2328 unified`). Check
<https://repositories.intel.com/gpu/ubuntu/dists/> for the current component.

---

## 3. Verify the runtime is visible (before / after installing AI Playground)

```bash
# Kernel binding + render node (Arc exposes /dev/dri/renderD12x)
ls -l /dev/dri
lspci -nnk -d 8086:5690        # "Kernel driver in use: i915" (or xe) + device id

# Level Zero (ComfyUI XPU + OpenVINO GPU)
ldconfig -p | grep -E 'libze_loader|libze_intel_gpu'
clinfo | grep -iE 'Number of platforms|Device Name'      # expect "Intel(R) Arc(TM) A770"

# Vulkan (llama.cpp)
ldconfig -p | grep libvulkan
vulkaninfo --summary | grep -iE 'deviceName|driverName'  # expect Intel Arc + ANV
```

If `lspci` lists the GPU but `clinfo` / `vulkaninfo` show no device, the kernel
sees the card but the **userspace compute/Vulkan driver is missing** — finish §2
(OMIX or §2e legacy packages, plus §2b for Vulkan) before installing the app.

### Troubleshooting: `clinfo` reports `Number of platforms 0`

Two common causes (often both):

1. **Group membership not applied.** After `gpasswd -a "$USER" render` you must
   **log out and back in** (or reboot). Until then your session cannot open
   `/dev/dri/renderD12x`, so OpenCL/Level Zero see no device. Verify with
   `groups | tr ' ' '\n' | grep -E 'render|video'` and `ls -l /dev/dri`.
2. **OpenCL ICD not installed.** `0 platforms` means no ICD is registered —
   install `intel-opencl-icd`. Check `/etc/OpenCL/vendors/*.icd`.

Note the **Level Zero loader is separate from the OpenCL ICD**: `libze_loader.so`
being present (so `linuxHasLevelZeroRuntime()` returns `true`) does **not** mean
the GPU is usable. torch.xpu / OpenVINO also need the Level Zero **GPU backend**
(`libze_intel_gpu.so`, installed via `intel-omix` or `libze-intel-gpu1`) and an
accessible render node. Confirm the GPU is actually live (`clinfo` lists the
device, `/dev/dri` accessible) **before** reinstalling ComfyUI for XPU, or
`torch.xpu.device_count()` will be 0.

---

## 4. Kernel requirements

Use Intel's OMIX guide and support matrix (§2a) as the primary kernel guidance for
your GPU. Additional notes for AI Playground backends:

- **Arc (DG2)** needs a kernel with DG2 `i915` support. Ubuntu 24.04's 6.8
  kernel supports it out of the box when OMIX does not require a newer HWE build.
  On older kernels you may need `i915.force_probe=<device-id>` on the kernel
  command line.
- **Panther Lake / Lunar Lake / Arrow Lake** use the new **`xe`** kernel driver
  (not `i915`). Needs **kernel ≥ 6.10** — install `linux-generic-hwe-24.04`
  on Ubuntu 24.04 if your kernel is older (OMIX may require **6.17** HWE on
  24.04; prefer the version Intel documents for your GPU).
- Confirm the driver bound with `lspci -nnk` → `Kernel driver in use: i915`
  (or `xe`).

### 4a. Monitoring live GPU usage

For live utilization, frequency, and memory stats on Intel GPUs, use **xpu-smi**
from Intel's [XPU Manager (xpumanager)](https://github.com/intel/xpumanager)
repo. Install and run it on the host per that project's Linux documentation
(for example, `xpu-smi discovery` to list devices, then the `stats` subcommands
while AI Playground is generating).

`intel_gpu_top` (from `intel-gpu-tools`) does **not** support the `xe` driver
yet. If you do not have xpu-smi installed, you can still see which processes hold
the render node on `xe`:

```bash
sudo fuser -v /dev/dri/renderD128
# Healthy AI-Playground inference shows: ovms + ai-playground.bin + python (ComfyUI)
```

For instantaneous frequency on `xe` without xpu-smi, read sysfs:

```bash
cat /sys/class/drm/card0/device/tile0/gt0/freq0/cur_freq      # GPU current MHz
cat /sys/class/drm/card0/device/tile0/gt0/freq0/max_freq
```

---

## 5. After AI Playground is installed — make backends pick up the GPU

Host drivers must already be in place (§2–§3). The GPU build/variant is selected
during **backend** installation inside the app, so after drivers are ready:

- **ComfyUI** — detection flips to `xpu` and the UI prompts a reinstall on the
  `cpu → xpu` variant mismatch. Accept it so `torch+xpu` wheels are installed.
- **llama.cpp** — CPU and Vulkan share the same `standard` variant, so it does
  **not** auto-reinstall. **Uninstall + reinstall** llama.cpp so it downloads the
  `ubuntu-vulkan-x64` build. Afterwards `--list-devices` lists the GPU and
  `--gpu-layers 999` offloads to it.
- **OpenVINO** — restart the backend; the device dropdown will list `GPU`
  (detection runs in the OpenVINO Python venv via `detect_devices.py`).

---

## 6. Known follow-up: ComfyUI `comfyui-deps` lock on Linux

After adding `sys_platform == 'linux'` to `comfyui-deps/pyproject.toml` and
`pyproject-flexible-venv.toml`, the `uv.lock` should be regenerated on Linux so
the `xpu` extra resolves to the `pytorch-xpu` index instead of the default
CUDA-bundled PyPI `torch`. Symptom if stale: `uv` tries to install `nvidia-*` /
`cuda-*` packages on a non-NVIDIA Linux host and the env check fails with
`expected object, received null`.

Regenerate on the Linux machine:

```bash
cd comfyui-deps
uv lock
```

---

## 7. Relevant source

- `WebUI/electron/subprocesses/deviceDetection.ts` — `linuxHasLevelZeroRuntime()`,
  `linuxHasVulkanLoader()` (ldconfig-aware, logged).
- `WebUI/electron/subprocesses/comfyUIBackendService.ts` — XPU variant selection,
  oneAPI `LD_LIBRARY_PATH`, `ZE_FLAT_DEVICE_HIERARCHY`, lowvram handling.
- `WebUI/electron/subprocesses/llamaCppBackendService.ts` — Vulkan build
  selection (`resolveDownloadUrl()`), `--list-devices` parsing.
- `WebUI/electron/subprocesses/openVINOBackendService.ts` — OVMS env (system
  Python on Linux), Python device-detection venv.
- `WebUI/electron/subprocesses/hardwareDiscovery.ts` — `lspci`-based Intel GPU
  detection (mode recommendation).
