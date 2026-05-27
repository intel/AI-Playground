"""Self-contained pure-PyTorch RRDBNet, sufficient to load
RealESRGAN_x4plus weights without pulling in the heavy `basicsr` package
(which is also broken on newer torchvision releases due to the
`functional_tensor` removal).

Layer naming matches the reference RealESRGAN/basicsr `RRDBNet` so that
`Comfy-Org/Real-ESRGAN_repackaged/RealESRGAN_x4plus.safetensors`
(and the upstream `RealESRGAN_x4plus.pth`) load directly.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn


class _ResidualDenseBlock(nn.Module):
    def __init__(self, num_feat: int = 64, num_grow_ch: int = 32) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class _RRDB(nn.Module):
    def __init__(self, num_feat: int, num_grow_ch: int = 32) -> None:
        super().__init__()
        self.rdb1 = _ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = _ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = _ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x


class RRDBNet(nn.Module):
    """RealESRGAN/ESRGAN RRDBNet, fixed scale=4 (matches RealESRGAN_x4plus)."""

    def __init__(
        self,
        num_in_ch: int = 3,
        num_out_ch: int = 3,
        num_feat: int = 64,
        num_block: int = 23,
        num_grow_ch: int = 32,
        scale: int = 4,
    ) -> None:
        super().__init__()
        if scale != 4:
            raise ValueError(f"RRDBNet here only supports scale=4, got {scale}")
        self.scale = scale
        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[_RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feat = self.conv_first(x)
        body_feat = self.conv_body(self.body(feat))
        feat = feat + body_feat
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        out = self.conv_last(self.lrelu(self.conv_hr(feat)))
        return out


def _strip_state_dict_prefixes(state_dict: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    """RealESRGAN checkpoints are sometimes shipped with a `params_ema.` /
    `params.` / `model.` key prefix from BasicSR's training trainer state.
    Pick the namespace that actually contains module weights and strip it."""
    if not state_dict:
        return state_dict
    for prefix in ("params_ema.", "params.", "model."):
        prefixed_keys = [k for k in state_dict if k.startswith(prefix)]
        if prefixed_keys:
            return {k[len(prefix) :]: v for k, v in state_dict.items() if k.startswith(prefix)}
    return state_dict


def load_rrdbnet_x4plus(weights_path: str) -> RRDBNet:
    """Load RealESRGAN_x4plus weights (.pth or .safetensors) into a fresh RRDBNet."""
    suffix = weights_path.lower().rsplit(".", 1)[-1]
    if suffix == "safetensors":
        from safetensors.torch import load_file

        state_dict = load_file(weights_path)
    else:
        loaded = torch.load(weights_path, map_location="cpu", weights_only=True)
        if isinstance(loaded, dict) and "params_ema" in loaded and isinstance(loaded["params_ema"], dict):
            state_dict = loaded["params_ema"]
        elif isinstance(loaded, dict) and "params" in loaded and isinstance(loaded["params"], dict):
            state_dict = loaded["params"]
        else:
            state_dict = loaded if isinstance(loaded, dict) else {}

    state_dict = _strip_state_dict_prefixes(state_dict)
    net = RRDBNet().eval()
    missing, unexpected = net.load_state_dict(state_dict, strict=False)
    if missing:
        raise RuntimeError(
            f"RealESRGAN_x4plus weights are missing {len(missing)} expected keys "
            f"(first few: {missing[:5]}); is this an RRDBNet x4plus checkpoint?"
        )
    if unexpected:
        # Tolerate extra keys (e.g. EMA bookkeeping shipped alongside weights),
        # but log them for debugging.
        import logging

        logging.getLogger("OpenVINOImageUpscale").info(
            "Ignoring %d unexpected RRDBNet checkpoint keys (e.g. %s)",
            len(unexpected),
            unexpected[:3],
        )
    return net
