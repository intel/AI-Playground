"""ComfyUI node: OpenVINO image upscale via in-process OpenVINO runtime.

Default model: RealESRGAN_x4plus (4x). Weights are read from the existing
`Comfy-Org/Real-ESRGAN_repackaged/RealESRGAN_x4plus.safetensors` upscale
model (no separate download), converted to OpenVINO IR with a dynamic
NCHW shape on first use, and cached to disk. Inference is tile-based so
arbitrarily large inputs do not OOM.

If a path to a prebuilt OpenVINO `.xml` (or .onnx) is given, that is
loaded directly.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path

import numpy as np
import torch
from PIL import Image

try:
    import openvino as ov
except ImportError:  # pragma: no cover - exercised at runtime in ComfyUI
    ov = None  # type: ignore[assignment]

log = logging.getLogger("OpenVINOImageUpscale")

MODEL_ROOT_ENV = "AIPG_OPENVINO_IMAGE_MODELS"
PREBUILT_MODEL_SUFFIXES = (".xml", ".onnx")
WEIGHTS_SUFFIXES = (".safetensors", ".pth", ".bin")
RRDBNET_X4PLUS_TAG = "rrdbnet_x4plus_v1"
DEFAULT_TILE_SIZE = 512
TILE_OVERLAP = 32
MODEL_SCALE = 4

_COMPILED_MODEL_CACHE: dict[tuple[str, str, int | None], "ov.CompiledModel"] = {}


# --- I/O helpers -----------------------------------------------------------


def _tensor_image_to_pil(image: torch.Tensor) -> Image.Image:
    if image.dim() != 4:
        raise RuntimeError(f"Expected IMAGE tensor shape NHWC, got {tuple(image.shape)}")
    tensor = image[0].detach().cpu().clamp(0.0, 1.0).numpy()
    if tensor.shape[-1] < 3:
        raise RuntimeError(f"Expected IMAGE tensor with at least 3 channels, got {tensor.shape[-1]}")
    rgb = (tensor[..., :3] * 255.0).round().astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    rgb = image.convert("RGB")
    array = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


# --- Model file resolution -------------------------------------------------


def _normalize_model_reference(model_ref: str) -> str:
    return model_ref.replace("\\", os.sep).replace("/", os.sep).strip()


def _candidate_model_roots() -> list[Path]:
    """Search roots for `model_path` strings that are not absolute.

    Order: env var -> ComfyUI's `upscale_models` folder (via `folder_paths`)
    -> local `models/openvino-image` and `models/upscale` siblings.
    """
    roots: list[Path] = []

    env_root = os.environ.get(MODEL_ROOT_ENV)
    if env_root:
        roots.append(Path(env_root).expanduser())

    try:  # pragma: no cover - only available inside ComfyUI
        import folder_paths  # type: ignore[import-not-found]

        for root in folder_paths.get_folder_paths("upscale_models"):
            roots.append(Path(root))
    except Exception:
        pass

    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        roots.append(parent / "models" / "openvino-image")
        roots.append(parent / "models" / "upscale")
        roots.append(parent / "models" / "ComfyUI" / "upscale_models")

    unique_roots: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        try:
            resolved = root.resolve()
        except OSError:
            continue
        if resolved in seen or not resolved.exists():
            continue
        seen.add(resolved)
        unique_roots.append(resolved)
    return unique_roots


def _pick_first_match(directory: Path, suffixes: tuple[str, ...]) -> Path | None:
    files = [path for path in directory.rglob("*") if path.is_file()]
    for suffix in suffixes:
        matches = [path for path in files if path.suffix.lower() == suffix]
        if matches:
            return sorted(matches, key=lambda path: (len(path.parts), str(path)))[0]
    return None


def _resolve_model_file(model_ref: str) -> Path:
    """Resolve a workflow `model_path` string into an absolute file path.

    Accepts absolute paths, ComfyUI-style relative references like
    `Comfy-Org---Real-ESRGAN_repackaged/RealESRGAN_x4plus.safetensors`,
    and bare directory references (in which case the first matching IR
    or weights file inside is used).
    """
    normalized_ref = _normalize_model_reference(model_ref)
    if not normalized_ref:
        raise RuntimeError("OpenVINO upscale model path is empty")

    raw_path = Path(normalized_ref)
    if raw_path.is_absolute():
        if raw_path.is_file():
            return raw_path
        if raw_path.is_dir():
            picked = _pick_first_match(raw_path, PREBUILT_MODEL_SUFFIXES + WEIGHTS_SUFFIXES)
            if picked:
                return picked
        raise RuntimeError(f"OpenVINO upscale model path does not exist: {raw_path}")

    # ComfyUI's `folder_paths.get_full_path` understands forward-slash style refs
    # under a registered folder type and respects extra_model_paths.yaml.
    try:  # pragma: no cover - only available inside ComfyUI
        import folder_paths  # type: ignore[import-not-found]

        forward_ref = normalized_ref.replace(os.sep, "/")
        resolved = folder_paths.get_full_path("upscale_models", forward_ref)
        if resolved:
            resolved_path = Path(resolved)
            if resolved_path.is_file():
                return resolved_path
    except Exception:
        pass

    # Some shipped paths use `repo---name/file` (Comfy-Org repackaged style)
    # but the on-disk layout flips the first two segments to a `repo/name`
    # layout. Try both.
    repo_style_path = raw_path
    repo_parts = normalized_ref.replace("\\", "/").split("/")
    if len(repo_parts) >= 2 and "---" not in repo_parts[0]:
        repo_root = Path(f"{repo_parts[0]}---{repo_parts[1]}")
        repo_style_path = repo_root.joinpath(*repo_parts[2:])

    for root in _candidate_model_roots():
        for candidate in [root / raw_path, root / repo_style_path]:
            if candidate.is_file():
                return candidate
            if candidate.is_dir():
                picked = _pick_first_match(
                    candidate, PREBUILT_MODEL_SUFFIXES + WEIGHTS_SUFFIXES
                )
                if picked:
                    return picked

    searched_roots = ", ".join(str(root) for root in _candidate_model_roots()) or "(none)"
    raise RuntimeError(
        f"Could not resolve OpenVINO upscale model '{model_ref}'. Searched: {searched_roots}"
    )


# --- IR cache (PyTorch weights -> OpenVINO IR) -----------------------------


def _ir_cache_root() -> Path:
    env_root = os.environ.get(MODEL_ROOT_ENV)
    if env_root:
        return Path(env_root).expanduser() / "_ir_cache"
    # Best-effort fallback: sibling of the package directory
    return Path(__file__).resolve().parent / "_ir_cache"


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_prebuilt_ir(path: Path) -> bool:
    return path.suffix.lower() in PREBUILT_MODEL_SUFFIXES


def _convert_weights_to_ir(weights_path: Path) -> Path:
    """Convert RealESRGAN_x4plus weights to OpenVINO IR and cache it on disk.

    Cache key = sha256(weights file bytes) + arch tag. Re-conversion on a
    second machine is idempotent and bit-for-bit reproducible per (weights,
    arch).
    """
    if ov is None:  # pragma: no cover - guarded by callers
        raise RuntimeError("OpenVINO Python package is not installed in the ComfyUI environment.")

    from .rrdbnet import load_rrdbnet_x4plus

    digest = _hash_file(weights_path)
    cache_dir = _ir_cache_root() / RRDBNET_X4PLUS_TAG / digest
    xml_path = cache_dir / "model.xml"
    bin_path = cache_dir / "model.bin"
    if xml_path.is_file() and bin_path.is_file():
        return xml_path

    cache_dir.mkdir(parents=True, exist_ok=True)
    log.info("Converting %s to OpenVINO IR (cache: %s)", weights_path, cache_dir)

    net = load_rrdbnet_x4plus(str(weights_path))
    net.eval()

    example = torch.randn(1, 3, 64, 64)
    with torch.no_grad():
        ov_model = ov.convert_model(
            net,
            example_input=example,
            input=[ov.PartialShape([-1, 3, -1, -1])],
        )
    ov.save_model(ov_model, str(xml_path), compress_to_fp16=True)
    log.info("Saved OpenVINO IR to %s", xml_path)
    return xml_path


# --- Compile + run ---------------------------------------------------------


def _normalize_device_name(device: str) -> str:
    value = str(device).strip().upper()
    return value or "AUTO"


def _device_needs_static_shape(device_name: str) -> bool:
    """The Intel NPU compiler rejects unbounded dynamic dimensions (Level0
    pfnCreate2 fails with `Missing upper bound for one or more nodes`). The
    safest workaround is to reshape the model to a fully static input size
    when the user targets NPU; we then pad edge tiles in `_run_tiled` to
    match. CPU/GPU/AUTO keep the dynamic path which is faster and avoids
    wasted compute on tiles smaller than `tile_size`.
    """
    return "NPU" in device_name


def _load_compiled_model(
    model_ref: str, device: str, tile_size: int
) -> "ov.CompiledModel":
    if ov is None:
        raise RuntimeError(
            "OpenVINO Python package is not installed in the ComfyUI environment. "
            "Install the preset requirements and try again."
        )

    device_name = _normalize_device_name(device)
    needs_static = _device_needs_static_shape(device_name)
    resolved = _resolve_model_file(model_ref)

    if _is_prebuilt_ir(resolved):
        ir_path = resolved
    else:
        ir_path = _convert_weights_to_ir(resolved)

    # Static reshape produces a different compiled model per tile_size, so
    # include it in the cache key only when it actually affects compilation.
    cache_key = (str(ir_path), device_name, tile_size if needs_static else None)
    compiled_model = _COMPILED_MODEL_CACHE.get(cache_key)
    if compiled_model is not None:
        return compiled_model

    log.info("Compiling OpenVINO upscale model %s on %s", ir_path, device_name)
    core = ov.Core()
    blob_cache = _ir_cache_root() / "_blob_cache"
    blob_cache.mkdir(parents=True, exist_ok=True)
    try:
        core.set_property({"CACHE_DIR": str(blob_cache)})
    except Exception:  # pragma: no cover - older OpenVINO builds
        pass
    model = core.read_model(model=str(ir_path))
    if needs_static:
        log.info(
            "Reshaping model to static [1, 3, %d, %d] for %s", tile_size, tile_size, device_name
        )
        input_name = model.input(0).any_name
        model.reshape({input_name: ov.PartialShape([1, 3, tile_size, tile_size])})
    compiled_model = core.compile_model(model=model, device_name=device_name)
    _COMPILED_MODEL_CACHE[cache_key] = compiled_model
    return compiled_model


# --- Tile-based inference --------------------------------------------------


def _feather_mask(h: int, w: int, ramp: int) -> np.ndarray:
    """Build a 2D feather weight that ramps from `1/(ramp+1)` at the very
    edge up to 1 in the interior. Always strictly positive so we never
    divide by zero when stitching.
    """
    if ramp <= 0:
        return np.ones((h, w), dtype=np.float32)
    yy = np.arange(h, dtype=np.float32)
    xx = np.arange(w, dtype=np.float32)
    dist_y = np.minimum(np.minimum(yy + 1.0, h - yy), float(ramp + 1))
    dist_x = np.minimum(np.minimum(xx + 1.0, w - xx), float(ramp + 1))
    my = dist_y / float(ramp + 1)
    mx = dist_x / float(ramp + 1)
    return np.minimum(my[:, None], mx[None, :]).astype(np.float32)


def _static_input_hw(compiled_model: "ov.CompiledModel") -> tuple[int, int] | None:
    """If the compiled model has a fully static NCHW input shape, return its
    (H, W). Otherwise (dynamic spatial dims), return None.
    """
    try:
        partial_shape = compiled_model.input(0).partial_shape
    except Exception:
        return None
    if not partial_shape.is_static or len(partial_shape) != 4:
        return None
    return int(partial_shape[2].get_length()), int(partial_shape[3].get_length())


def _pad_to(chw: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
    """Pad an NCHW float32 tile to (target_h, target_w) using reflection
    where possible, falling back to edge replication when the tile is too
    small for reflection (numpy's reflect mode requires pad <= dim - 1).
    """
    _, _, h, w = chw.shape
    if h >= target_h and w >= target_w:
        return chw
    pad_b = max(0, target_h - h)
    pad_r = max(0, target_w - w)
    pad_spec = ((0, 0), (0, 0), (0, pad_b), (0, pad_r))
    mode: str = "reflect" if h > pad_b and w > pad_r else "edge"
    return np.pad(chw, pad_spec, mode=mode)  # type: ignore[arg-type]


def _run_tiled(
    compiled_model: "ov.CompiledModel",
    rgb: np.ndarray,
    tile_size: int,
    overlap: int,
    scale: int,
) -> np.ndarray:
    """Run a fixed-`scale`x model over `rgb` (HxWx3 float32 in [0,1])
    using sliding-window tiles with linear-ramp blending. Returns
    HxWx3 * scale float32 in [0,1].

    When the compiled model has a static NCHW input shape (NPU path), each
    tile is padded up to that shape before inference and the corresponding
    valid region is cropped from the output.
    """
    h, w, _ = rgb.shape
    out_h, out_w = h * scale, w * scale
    output = np.zeros((out_h, out_w, 3), dtype=np.float32)
    weight = np.zeros((out_h, out_w, 1), dtype=np.float32)

    stride = max(1, tile_size - overlap)
    output_port = compiled_model.output(0)
    static_hw = _static_input_hw(compiled_model)

    ys = list(range(0, max(1, h - overlap), stride)) if h > tile_size else [0]
    xs = list(range(0, max(1, w - overlap), stride)) if w > tile_size else [0]
    if ys[-1] + tile_size < h:
        ys.append(h - tile_size)
    if xs[-1] + tile_size < w:
        xs.append(w - tile_size)
    ys = sorted(set(max(0, y) for y in ys))
    xs = sorted(set(max(0, x) for x in xs))

    for y0 in ys:
        for x0 in xs:
            y1 = min(y0 + tile_size, h)
            x1 = min(x0 + tile_size, w)
            tile_in = rgb[y0:y1, x0:x1, :]
            th, tw = tile_in.shape[:2]
            chw = tile_in.transpose(2, 0, 1)[None, :, :, :].astype(np.float32)

            if static_hw is not None:
                chw = _pad_to(chw, static_hw[0], static_hw[1])

            result = compiled_model([chw])[output_port]
            tile_out = np.asarray(result)[0]
            tile_out = np.transpose(tile_out, (1, 2, 0)).astype(np.float32)

            if static_hw is not None:
                tile_out = tile_out[: th * scale, : tw * scale, :]
            tile_out = np.clip(tile_out, 0.0, 1.0)

            mask = _feather_mask(th, tw, overlap)
            mask_out = np.repeat(np.repeat(mask, scale, axis=0), scale, axis=1)
            mask_out = mask_out[: th * scale, : tw * scale, None]

            oy0, ox0 = y0 * scale, x0 * scale
            oy1, ox1 = oy0 + th * scale, ox0 + tw * scale
            output[oy0:oy1, ox0:ox1, :] += tile_out * mask_out
            weight[oy0:oy1, ox0:ox1, :] += mask_out

    np.maximum(weight, 1e-8, out=weight)
    return np.clip(output / weight, 0.0, 1.0)


# --- ComfyUI node ----------------------------------------------------------


class OpenVINOImageUpscale:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "model_path": (
                    "STRING",
                    {
                        "default": "Comfy-Org---Real-ESRGAN_repackaged/"
                        "RealESRGAN_x4plus.safetensors",
                        "multiline": False,
                    },
                ),
                "target_scale": (
                    "FLOAT",
                    {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.1},
                ),
                "device": (
                    "STRING",
                    {"default": "AUTO", "multiline": False},
                ),
                "tile_size": (
                    "INT",
                    {"default": DEFAULT_TILE_SIZE, "min": 64, "max": 2048, "step": 32},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "upscale"
    CATEGORY = "AIPG/openvino"

    def upscale(self, image, model_path, target_scale, device, tile_size=DEFAULT_TILE_SIZE):
        source = _tensor_image_to_pil(image)
        target_scale_f = float(target_scale)
        if target_scale_f <= 1.0:
            return (_pil_to_tensor(source),)

        tile_size_int = int(tile_size)
        compiled_model = _load_compiled_model(model_path, device, tile_size_int)

        rgb = np.asarray(source.convert("RGB"), dtype=np.float32) / 255.0
        upscaled = _run_tiled(
            compiled_model,
            rgb,
            tile_size=tile_size_int,
            overlap=TILE_OVERLAP,
            scale=MODEL_SCALE,
        )
        upscaled_uint8 = (upscaled * 255.0).round().astype(np.uint8)
        upscaled_image = Image.fromarray(upscaled_uint8, mode="RGB")

        target_width = max(1, int(round(source.width * target_scale_f)))
        target_height = max(1, int(round(source.height * target_scale_f)))
        if upscaled_image.size != (target_width, target_height):
            upscaled_image = upscaled_image.resize(
                (target_width, target_height), Image.BICUBIC
            )

        return (_pil_to_tensor(upscaled_image),)


NODE_CLASS_MAPPINGS = {
    "OpenVINOImageUpscale": OpenVINOImageUpscale,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OpenVINOImageUpscale": "OpenVINO Image Upscale",
}
