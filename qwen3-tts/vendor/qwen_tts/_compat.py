"""Transformers 4.x / 5.x compatibility shims for the vendored Qwen3-TTS code.

Not upstream. The vendored modelling code is written against `transformers` 4.57.3 internals
(`masking_utils`, `modeling_rope_utils`, `utils.generic`), several of which were reworked in
5.0. Rather than rewrite the model files against one version, the handful of affected call
sites import from here, which keeps the tree runnable on **both**:

- 5.x is what the service installs, because 4.57.3 has three published advisories that are
  only fixed in 5.x (see docs/qwen-tts-dependency-evaluation.md).
- 4.57.3 still matters for verification: it is the only version the upstream `qwen-tts`
  package runs on, so `tests/vendor_parity.py` can only compare against upstream there.

Each shim below mirrors what 4.57.3 did, so behaviour is unchanged; where 5.x moved a
responsibility elsewhere (mask offsets now come from the cache), the shim drops the argument
rather than re-deriving it. `tests/vendor_parity.py` and
`tests/test_transformers5_equivalence.py` are what make that claim checkable.
"""

from __future__ import annotations

import torch
from transformers import __version__ as _transformers_version
from transformers import masking_utils as _masking_utils
from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS as _ROPE_INIT_FUNCTIONS
from transformers.utils.generic import check_model_inputs as _check_model_inputs

# Parsed by hand rather than with `packaging`, which is only ever an indirect dependency here.
IS_TRANSFORMERS_V5 = int(_transformers_version.split(".", 1)[0]) >= 5


def check_model_inputs(func):
    """`@check_model_inputs` as a plain decorator on both versions.

    4.57.3 exposes a decorator *factory* (`@check_model_inputs()`); 5.x replaced it with a
    plain decorator that forwards to `merge_with_config_defaults`. Using the bare form
    everywhere and adapting here keeps the call sites version-agnostic.
    """
    if IS_TRANSFORMERS_V5:
        return _check_model_inputs(func)
    return _check_model_inputs()(func)


def _compute_default_rope_parameters(config, device=None, **_ignored):
    """The "default" RoPE init, which 5.x removed from `ROPE_INIT_FUNCTIONS`.

    Byte-for-byte the same computation as 4.57.3's `_compute_default_rope_parameters`, reading
    `rope_theta` from wherever the config keeps it (5.x moved transformers' own configs to a
    `rope_parameters` dict, though the vendored config classes still use a plain attribute).
    """
    base = getattr(config, "rope_theta", None)
    if base is None:
        base = config.rope_parameters["rope_theta"]
    partial_rotary_factor = getattr(config, "partial_rotary_factor", 1.0)
    head_dim = getattr(config, "head_dim", None) or config.hidden_size // config.num_attention_heads
    dim = int(head_dim * partial_rotary_factor)

    attention_factor = 1.0  # Unused in this type of RoPE

    inv_freq = 1.0 / (
        base ** (torch.arange(0, dim, 2, dtype=torch.int64).to(device=device, dtype=torch.float) / dim)
    )
    return inv_freq, attention_factor


def rope_init_fn(rope_type):
    """Resolve a RoPE init function by type across versions."""
    if rope_type == "default":
        # 5.x dropped the "default" entry and inlined the computation into each model's
        # rotary embedding class as a static method.
        return _ROPE_INIT_FUNCTIONS.get("default", _compute_default_rope_parameters)
    return _ROPE_INIT_FUNCTIONS[rope_type]


def rope_config_validation(config):
    """Validate `rope_scaling`, when the installed transformers still understands that schema.

    5.x rewrote the validator around `config.rope_parameters` (`RotaryEmbeddingConfigMixin`),
    which the vendored config classes do not implement — they keep 4.x's `rope_theta` /
    `rope_scaling` attributes. Validation has no effect on numerics, so it is skipped there
    rather than adapted.
    """
    if IS_TRANSFORMERS_V5:
        return
    from transformers.modeling_rope_utils import rope_config_validation as _validate

    _validate(config)


def _adapt_mask_kwargs(kwargs):
    """Translate 4.57.3 mask-builder kwargs to the installed signature.

    5.x renamed `input_embeds` to `inputs_embeds` and dropped `cache_position`: the query
    offset now comes from the cache (`Cache.get_query_offset()`) and the kv sizes from the
    query length, so there is nothing to re-derive. `position_ids` keeps the same meaning in
    both versions (packed-sequence detection only).
    """
    embeds = kwargs.pop("inputs_embeds", None)
    if embeds is None:
        embeds = kwargs.pop("input_embeds", None)
    else:
        kwargs.pop("input_embeds", None)

    if IS_TRANSFORMERS_V5:
        kwargs.pop("cache_position", None)
        kwargs["inputs_embeds"] = embeds
    else:
        kwargs["input_embeds"] = embeds
    return kwargs


def create_causal_mask(**kwargs):
    return _masking_utils.create_causal_mask(**_adapt_mask_kwargs(kwargs))


def create_sliding_window_causal_mask(**kwargs):
    return _masking_utils.create_sliding_window_causal_mask(**_adapt_mask_kwargs(kwargs))


def align_position_ids(position_ids, query_length):
    """Trim `position_ids` to the tokens actually being processed in this forward pass.

    4.57.3's `prepare_inputs_for_generation` handed the model only the current step's
    positions. 5.x instead *accumulates* them — `_update_model_kwargs_for_generation`
    concatenates the next positions onto the running tensor — so during decoding a model that
    takes `position_ids` receives the whole sequence while `inputs_embeds` holds just the new
    token. Feeding that straight to the rotary embedding yields cos/sin for the full sequence
    and the attention output no longer matches the query length (it fails in `o_proj` with a
    shape mismatch).

    Positions are aligned to the *end* of the sequence, which is where the current query
    tokens live. A no-op on 4.57.3, where the lengths already agree.
    """
    if position_ids is not None and position_ids.shape[-1] > query_length:
        return position_ids[..., -query_length:]
    return position_ids


def reset_rotary_buffers(model):
    """Recompute every rotary embedding's `inv_freq` after weights have been loaded.

    `inv_freq` is a *non-persistent* buffer: it is computed in the module's `__init__` and never
    stored in a checkpoint. transformers 5 builds the module tree on the meta device and then
    only restores such buffers for modules its own `PreTrainedModel._init_weights` recognizes,
    which it decides by looking for `"RotaryEmbedding"` in the class name plus an
    `original_inv_freq` attribute. None of the three rotary classes here qualify — the
    talker's two define `original_inv_freq` but this model overrides `_init_weights` without
    delegating, and the codec decoder's class is spelled `...RotatoryEmbedding` upstream — so
    without this, `inv_freq` keeps uninitialized memory and the first forward pass produces
    NaN logits.

    Recomputing from the config is deterministic and idempotent, so this is a no-op on 4.57.3,
    where the constructor's value survives loading.
    """
    for module in model.modules():
        if not (hasattr(module, "rope_type") and hasattr(module, "inv_freq")):
            continue
        inv_freq, attention_scaling = rope_init_fn(module.rope_type)(module.config)
        with torch.no_grad():
            for name in ("inv_freq", "original_inv_freq"):
                buffer = getattr(module, name, None)
                if isinstance(buffer, torch.Tensor) and not buffer.is_meta:
                    buffer.copy_(inv_freq.to(dtype=buffer.dtype, device=buffer.device))
        module.attention_scaling = attention_scaling
    return model
