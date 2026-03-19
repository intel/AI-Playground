# ComfyUI UV-Based Installation Migration

This document describes the changes made to migrate ComfyUI installation from UvPipService to the bundled UV binary approach, matching the pattern used in aiBackendService.

## Overview

The ComfyUI backend now uses the bundled `uv` binary for dependency management instead of the custom UvPipService wrapper. This provides:
- Consistent installation pattern across all backends
- Better dependency locking via `uv.lock`
- Simplified maintenance and debugging

## Key Changes

### 1. New Dependency Files

Created `comfyui-deps/` directory at root level containing:

- **`pyproject.toml`**: Defines the **tested** Python dependency set (regenerate `uv.lock` from here). `[project].version` is uv package metadata, not the ComfyUI git tag.
- **`uv.lock`**: Placeholder lock file (currently using service/uv.lock - needs to be replaced with actual ComfyUI lock)

Note: This directory is at root level so the files can be committed to the repository.

### 2. New UV Functions

Added to `WebUI/electron/subprocesses/uvBasedBackends/uv.ts`:

```typescript
// Generic function to sync a uv project (runs `uv sync`)
export const syncProject = async (projectDir: string, loggerSource: string)

// Generic function to check if a uv project is synced (runs `uv sync --check`)
export const checkProject = async (projectDir: string, loggerSource: string)
```

These are reusable functions that can be used for any uv-based project, not just ComfyUI.

### 3. ComfyUI Backend Service Changes

Updated `WebUI/electron/subprocesses/comfyUIBackendService.ts`:

**Removed:**
- `UvPipService` instance and usage
- Python ensureInstalled() calls
- Device-specific requirements.txt installation
- Manual wheel installation during setup

**Changed:**
- `baseDir`: Now uses `aipgBaseDir` from uv.ts
- `pythonEnvDir`: Changed from `comfyui-backend-env` to `ComfyUI/.venv`
- Default ComfyUI git ref comes from shipped [`WebUI/external/backend-versions.json`](../WebUI/external/backend-versions.json) (`getBundledComfyUiGitRefSync()` in [`WebUI/electron/remoteUpdates.ts`](../WebUI/electron/remoteUpdates.ts)).

**Sources of truth**

| Artifact | Role |
|----------|------|
| `comfyui-deps/pyproject.toml` + `uv.lock` | **Tested dependencies** for the pinned ComfyUI line-up |
| Shipped `WebUI/external/backend-versions.json` → `comfyui-backend.version` | **Bundled ComfyUI git ref** (default install target and ref the shipped lock matches) |

[`resolveBackendVersion`](WebUI/electron/remoteUpdates.ts) may return a **remote** `backend-versions.json` first for UI defaults. **Lock vs flexible** still compares the requested ref to the **local shipped** JSON (via `getBundledComfyUiGitRefSync()`), so if remote moves ahead of the packaged lock, installs use the flexible `requirements.txt` path until a new build refreshes the lock.

**Installation Flow (two paths):**

1. Clone ComfyUI repository and checkout the requested git ref.
2. **Pinned ref** — when the ref matches `getBundledComfyUiGitRefSync()` (shipped `comfyui-backend.version`):
   - Copy `pyproject.toml` and `uv.lock` from `comfyui-deps/` into the ComfyUI directory.
   - Run `uv venv` + `uv sync` (via `installBackend('ComfyUI')`).
   - Idempotency: `uv sync --check` / `checkBackend`; write `.aipg-comfyui-deps.json` with `{ "mode": "locked", "revision": "<normalized>" }`.
3. **Any other ref** (e.g. user override to v0.17.0):
   - Restore `pyproject.toml` / `uv.lock` from `git checkout HEAD --` where tracked, drop `uv.lock` if present so resolution is not lockfile-driven.
   - Temporarily use [`comfyui-deps/pyproject-flexible-venv.toml`](../comfyui-deps/pyproject-flexible-venv.toml) (minimal `[project]` + full `[tool.uv]` for Intel torch/XPU) while running `uv pip install -r requirements.txt` from the checked-out ComfyUI tree.
   - Restore upstream `pyproject.toml` after install if the ref had one; otherwise keep the flexible stub for future `uv pip` operations.
   - Write `.aipg-comfyui-deps.json` with `{ "mode": "flexible", "revision": "<normalized>" }`. Startup skips `uv sync --check` when marker mode is `flexible` and revision still matches.

**Simplified:**
- Device detection now uses simple auto-select (matching aiBackendService)
- Pinned path: dependencies locked via `pyproject.toml` + `uv.lock`
- Non-pinned path: dynamic resolution via upstream `requirements.txt` (not QA-gated like the lockfile)

### 4. Environment Setup

The Python environment is now at `<aipgBaseDir>/ComfyUI/.venv` instead of a separate directory.

## TODO: Generate Real uv.lock

The current `comfyui-deps/uv.lock` is a placeholder from service/uv.lock.

To regenerate the lock file after bumping the pinned ComfyUI tag:

1. Set `comfyui-backend.version` in `WebUI/external/backend-versions.json` to the target git ref (this is the bundled default and lock target).
2. Refresh `comfyui-deps/pyproject.toml` from that tag’s `requirements.txt` / upstream metadata as needed, then:

```bash
cd /Users/schuettm/intel/AI-Playground/comfyui-deps
uv lock
git add uv.lock pyproject.toml
```

3. Copy any `[tool.uv]` changes into `comfyui-deps/pyproject-flexible-venv.toml` so flexible installs keep the same torch index configuration.

## Benefits

1. **Consistency**: Same installation pattern as aiBackendService
2. **Reproducibility**: Lock file ensures exact dependency versions
3. **Simplicity**: Less code, easier to maintain
4. **Speed**: UV is faster than pip for dependency resolution
5. **Reliability**: Bundled UV binary ensures consistent behavior

## Migration Notes

- The installation directory structure changed slightly (`.venv` is now inside ComfyUI directory)
- Old installations will need to be cleaned up and reinstalled
- Bump `backend-versions.json` and regenerate `uv.lock` together when changing the pinned ComfyUI release
