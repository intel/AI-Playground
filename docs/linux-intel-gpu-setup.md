# Linux Intel GPU Setup

How AI Playground uses Intel GPUs on Linux, what userspace drivers each backend
needs, and how to install/verify them. This mirrors the Windows behavior but on
Linux the GPU runtime is **not bundled** — it must be present on the host.

> TL;DR
>
> - **llama.cpp** → needs the **Vulkan** loader + Intel ANV driver.
> - **ComfyUI (XPU / torch-xpu)** and **OpenVINO (GPU)** → need the Intel
>   **Level Zero** runtime (`libze_loader` + `libze-intel-gpu`).
> - The card showing up in `lspci` is **not** enough — that's only the PCI
>   device; you also need the compute/Vulkan userspace driver.

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

Intel's `torch-xpu` / IPEX (used by ComfyUI XPU) only supports **Arc (DG2)**,
Data Center GPU Max, and **Core-Ultra Xe iGPUs (Meteor/Lunar/Panther Lake)**.
Older **Gen9 iGPUs (e.g. HD Graphics 630)** are **not** supported by XPU — on
those, ComfyUI correctly stays on CPU. llama.cpp (Vulkan) and OpenVINO (GPU)
_can_ still use Gen9.

---

## 2. Install the drivers (Ubuntu 24.04 "Noble")

The Level Zero / compute-runtime packages are **not** in the stock Ubuntu
archive — they come from **Intel's GPU repository**. On Noble the packages were
also renamed (the old `intel-level-zero-gpu` / `level-zero` names were the 22.04
"Jammy" names; on Noble they are `libze-intel-gpu1` / `libze1`).

### 2a. Add Intel's graphics repository

```bash
sudo apt-get update
sudo apt-get install -y gpg-agent curl

# Use curl (not wget): on corporate networks where http(s)_proxy is set but
# no_proxy contains \`*.intel.com\`, wget silently bypasses the proxy for the
# externally-hosted \`repositories.intel.com\` host (it resolves to AWS) and hangs.
# curl with an explicit \`--proxy\` survives that.
curl -fsSL ${http_proxy:+--proxy "$http_proxy"} \
  https://repositories.intel.com/gpu/intel-graphics.key \
  | sudo gpg --dearmor --output /usr/share/keyrings/intel-graphics.gpg

echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble unified" \
  | sudo tee /etc/apt/sources.list.d/intel-gpu-noble.list

sudo apt-get update
```

> If `apt-get update` 404s on the `unified` component, Intel may have pinned a
> dated path (e.g. `noble/production/2328 unified`). Check
> <https://repositories.intel.com/gpu/ubuntu/dists/> for the current component.

### 2b. Install Level Zero + OpenCL (ComfyUI XPU, OpenVINO GPU)

```bash
sudo apt-get install -y \
  libze-intel-gpu1 \
  libze1 \
  intel-opencl-icd \
  clinfo
```

- `libze1` → Level Zero **loader** (`libze_loader.so.1`) — what
  `linuxHasLevelZeroRuntime()` and OpenVINO look for.
- `libze-intel-gpu1` → Level Zero **GPU backend** for the Intel GPU.
- `intel-opencl-icd` → OpenCL (an alternate path OpenVINO GPU can use).
- `intel-metrics-discovery` is **omitted**: it is not in the
  Noble \`unified\` component (and is not required for inference). Skip it.


### 2c. Install Vulkan (llama.cpp GPU build)

```bash
sudo apt-get install -y libvulkan1 mesa-vulkan-drivers vulkan-tools
```

- `libvulkan1` → `libvulkan.so.1` loader.
- `mesa-vulkan-drivers` → provides `libvulkan_intel.so` (the **ANV** driver that
  drives Arc/DG2 and Gen9+ iGPUs).

### 2d. Render-node permissions

```bash
sudo gpasswd -a "$USER" render
sudo gpasswd -a "$USER" video
# log out/in (or `newgrp render`) so the group membership applies
```

### 2e. (Optional) Install the Intel NPU userspace driver

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

---

## 3. Verify the runtime is visible

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
sees the card but the **userspace compute/Vulkan driver is missing** — revisit §2.

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
`libze-intel-gpu1` (`libze_intel_gpu.so`) and an accessible render node. Confirm
the GPU is actually live (`clinfo` lists the device, `/dev/dri` accessible)
**before** reinstalling ComfyUI for XPU, or `torch.xpu.device_count()` will be 0.

---

## 4. Kernel requirements

- **Arc (DG2)** needs a kernel with DG2 `i915` support. Ubuntu 24.04's 6.8
  kernel supports it out of the box. On older kernels you may need
  `i915.force_probe=<device-id>` on the kernel command line.
- **Panther Lake / Lunar Lake / Arrow Lake** use the new **`xe`** kernel driver
  (not `i915`). Needs **kernel ≥ 6.10** — install `linux-generic-hwe-24.04`
  on Ubuntu 24.04 if your kernel is older.
- Confirm the driver bound with `lspci -nnk` → `Kernel driver in use: i915`
  (or `xe`).

### 4a. Verifying live GPU usage (works on both `i915` and `xe`)

`intel_gpu_top` (from `intel-gpu-tools`) does **not** support the `xe` driver
yet. To see what's actually using the GPU on a `xe`-driven host, look at
processes holding the render node:

```bash
sudo fuser -v /dev/dri/renderD128
# Healthy AI-Playground inference shows: ovms + ai-playground.bin + python (ComfyUI)
```

For instantaneous frequency / busy-time on `xe`, read sysfs:

```bash
cat /sys/class/drm/card0/device/tile0/gt0/freq0/cur_freq      # GPU current MHz
cat /sys/class/drm/card0/device/tile0/gt0/freq0/max_freq
```

---

## 5. Make the backends pick up the GPU

The GPU build/variant is selected during installation, so after the drivers are
in place:

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
