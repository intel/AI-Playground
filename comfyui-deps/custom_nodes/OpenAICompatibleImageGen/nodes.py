import base64
import io
import json
import logging
import secrets
import urllib.error
import urllib.request

import numpy as np
import torch
from PIL import Image

log = logging.getLogger("OpenAICompatibleImageGen")


def _encode_multipart_form(
    fields: dict[str, str],
    files: list[tuple[str, str, bytes, str]],
) -> tuple[bytes, str]:
    boundary = secrets.token_hex(16)
    crlf = b"\r\n"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f"--{boundary}".encode("ascii") + crlf)
        parts.append(
            f'Content-Disposition: form-data; name="{name}"'.encode("ascii") + crlf + crlf
        )
        parts.append(str(value).encode("utf-8") + crlf)
    for name, filename, content, content_type in files:
        parts.append(f"--{boundary}".encode("ascii") + crlf)
        disp = (
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"'
        ).encode("ascii")
        parts.append(disp + crlf)
        parts.append(f"Content-Type: {content_type}".encode("ascii") + crlf + crlf)
        parts.append(content + crlf)
    parts.append(f"--{boundary}--".encode("ascii") + crlf)
    return b"".join(parts), boundary


def _tensor_image_to_rgb_png(image: torch.Tensor) -> bytes:
    if image.dim() != 4:
        raise RuntimeError(f"Expected IMAGE shape NHWC, got {tuple(image.shape)}")
    t = image[0].detach().cpu().clamp(0.0, 1.0).numpy()
    if t.shape[-1] < 3:
        raise RuntimeError(f"Expected at least 3 channels for IMAGE, got {t.shape[-1]}")
    t = t[..., :3]
    arr = (t * 255.0).round().astype(np.uint8)
    pil = Image.fromarray(arr, mode="RGB")
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return buf.getvalue()


def _mask_hw_numpy(mask: torch.Tensor) -> np.ndarray:
    """Comfy MASK (1.0 = inpaint region) as H×W float array in [0, 1]."""
    if mask.dim() == 2:
        m = mask
    elif mask.dim() == 3:
        m = mask[0]
    elif mask.dim() == 4:
        if mask.shape[1] == 1:
            m = mask[0, 0]
        elif mask.shape[-1] == 1:
            m = mask[0, :, :, 0]
        else:
            m = mask[0]
    else:
        raise RuntimeError(f"Unexpected MASK shape {tuple(mask.shape)}")
    return m.detach().cpu().clamp(0.0, 1.0).numpy()


def _mask_array_to_l_png(m: np.ndarray) -> bytes:
    """OVMS mask PNG: white = repaint (matches Comfy 1.0 = inpaint)."""
    arr = (m * 255.0).round().astype(np.uint8)
    pil = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return buf.getvalue()


def _mask_has_inpaint_region(m: np.ndarray) -> bool:
    return float(m.max()) >= 1.0 / 255.0


def _decode_b64_response(url: str, raw: bytes) -> torch.Tensor:
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON from image API at {url}: {raw[:500]!r}") from e
    items = data.get("data")
    if not items or not isinstance(items, list):
        raise RuntimeError(f"Image API response missing data[]: {data!r}"[:2000])
    b64 = items[0].get("b64_json") if isinstance(items[0], dict) else None
    if not b64 or not isinstance(b64, str):
        raise RuntimeError(f"Image API response missing data[0].b64_json: {data!r}"[:2000])
    try:
        image_bytes = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError) as e:
        raise RuntimeError("Invalid base64 in data[0].b64_json") from e
    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


class OpenAICompatibleImageGeneration:
    """Text-to-image via OpenAI-compatible POST /images/generations (e.g. OVMS v3)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_url": (
                    "STRING",
                    {"default": "http://127.0.0.1:8000/v3", "multiline": False},
                ),
                "model": (
                    "STRING",
                    {
                        "default": "OpenVINO/stable-diffusion-v1-5-int8-ov",
                        "multiline": False,
                    },
                ),
                "text": ("STRING", {"default": "", "multiline": True}),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0x7FFFFFFF},
                ),
                "steps": ("INT", {"default": 50, "min": 1, "max": 200}),
                "width": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 8}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "generate"
    CATEGORY = "AIPG/remote"

    def generate(self, base_url, model, text, seed, steps, width, height):
        url = f"{base_url.rstrip('/')}/images/generations"
        body = {
            "model": model,
            "prompt": text,
            "response_format": "b64_json",
            "rng_seed": int(seed),
            "num_inference_steps": int(steps),
            "size": f"{int(width)}x{int(height)}",
        }
        log.debug("POST %s  body=%s", url, json.dumps(body, ensure_ascii=False))
        payload = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:2000]
            log.error("HTTP %d from %s: %s", e.code, url, err_body)
            raise RuntimeError(
                f"OpenAI-compatible image API HTTP {e.code} at {url}: {err_body}"
            ) from e
        except urllib.error.URLError as e:
            log.error("Connection failed for %s: %s", url, e.reason)
            raise RuntimeError(
                f"OpenAI-compatible image API request failed for {url}: {e.reason}"
            ) from e

        log.debug("Response %d from %s (%d bytes)", status, url, len(raw))
        tensor = _decode_b64_response(url, raw)
        return (tensor,)


class OpenAICompatibleImageEdit:
    """Inpaint/outpaint via OpenAI-compatible POST /images/edits (e.g. OVMS v3)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "base_url": (
                    "STRING",
                    {"default": "http://127.0.0.1:8000/v3", "multiline": False},
                ),
                "model": (
                    "STRING",
                    {
                        "default": "stable-diffusion-v1-5/stable-diffusion-inpainting",
                        "multiline": False,
                    },
                ),
                "text": ("STRING", {"default": "", "multiline": True}),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0x7FFFFFFF},
                ),
                "steps": ("INT", {"default": 50, "min": 1, "max": 200}),
                "width": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 8}),
            },
            "optional": {
                "strength": (
                    "FLOAT",
                    {"default": 0.67, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "edit"
    CATEGORY = "AIPG/remote"

    def edit(self, image, mask, base_url, model, text, seed, steps, width, height, strength=0.67):
        url = f"{base_url.rstrip('/')}/images/edits"
        png_image = _tensor_image_to_rgb_png(image)
        m = _mask_hw_numpy(mask)
        has_mask = _mask_has_inpaint_region(m)
        log.debug(
            "edit: image=%s  mask=%s  has_mask=%s  mask_range=[%.4f, %.4f]",
            tuple(image.shape), tuple(mask.shape), has_mask, float(m.min()), float(m.max()),
        )
        if has_mask:
            fields = {
                "model": model,
                "prompt": text,
                "num_inference_steps": str(int(steps)),
                "size": f"{int(width)}x{int(height)}",
                "rng_seed": str(int(seed)),
            }
            files = [
                ("image", "image.png", png_image, "image/png"),
                ("mask", "mask.png", _mask_array_to_l_png(m), "image/png"),
            ]
        else:
            fields = {
                "model": model,
                "prompt": text,
                "num_inference_steps": str(int(steps)),
                "size": f"{int(width)}x{int(height)}",
                "rng_seed": str(int(seed)),
                "strength": str(float(strength)),
            }
            files = [("image", "image.png", png_image, "image/png")]
        log.debug(
            "POST %s  fields=%s  files=[%s]",
            url, fields, ", ".join(f"{n}({fn}, {len(c)} bytes)" for n, fn, c, _ in files),
        )
        body, boundary = _encode_multipart_form(fields, files)
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:2000]
            log.error("HTTP %d from %s: %s", e.code, url, err_body)
            raise RuntimeError(
                f"OpenAI-compatible image edit HTTP {e.code} at {url}: {err_body}"
            ) from e
        except urllib.error.URLError as e:
            log.error("Connection failed for %s: %s", url, e.reason)
            raise RuntimeError(
                f"OpenAI-compatible image edit request failed for {url}: {e.reason}"
            ) from e

        log.debug("Response %d from %s (%d bytes)", status, url, len(raw))
        tensor = _decode_b64_response(url, raw)
        return (tensor,)


NODE_CLASS_MAPPINGS = {
    "OpenAICompatibleImageGeneration": OpenAICompatibleImageGeneration,
    "OpenAICompatibleImageEdit": OpenAICompatibleImageEdit,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OpenAICompatibleImageGeneration": "OpenAI Compatible Image (OVMS)",
    "OpenAICompatibleImageEdit": "OpenAI Compatible Image Edit (OVMS)",
}
