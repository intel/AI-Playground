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

- **`pyproject.toml`**: Defines ComfyUI v0.3.66 dependencies based on the official requirements.txt
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
- `revision`: Updated from v0.3.47 to v0.3.66

**Installation Flow:**
1. Clone ComfyUI repository
2. Checkout specified version
3. Check if dependencies are already installed using `checkProject()`
4. If not installed:
   - Copy `pyproject.toml` and `uv.lock` from `comfyui-deps/` to ComfyUI directory
   - Run `syncProject()` to install all dependencies in `.venv`

**Simplified:**
- Device detection now uses simple auto-select (matching aiBackendService)
- Removed complex requirements.txt checking and installation logic
- All dependencies handled through pyproject.toml

### 4. Environment Setup

The Python environment is now at `<aipgBaseDir>/ComfyUI/.venv` instead of a separate directory.

## TODO: Generate Real uv.lock

The current `comfyui-deps/uv.lock` is a placeholder from service/uv.lock.

To generate the real lock file:

```bash
cd /Users/schuettm/intel/AI-Playground/comfyui-deps
# Generate lock file (this will create/update uv.lock)
uv lock
# Commit the generated uv.lock to the repository
git add uv.lock
```

## Benefits

1. **Consistency**: Same installation pattern as aiBackendService
2. **Reproducibility**: Lock file ensures exact dependency versions
3. **Simplicity**: Less code, easier to maintain
4. **Speed**: UV is faster than pip for dependency resolution
5. **Reliability**: Bundled UV binary ensures consistent behavior

## Migration Notes

- The installation directory structure changed slightly (`.venv` is now inside ComfyUI directory)
- Old installations will need to be cleaned up and reinstalled
- The version was updated to v0.3.66 which includes latest ComfyUI features
