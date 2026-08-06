"""Tests for the transformers 4.x/5.x compatibility layer of the vendored tree.

Fast and dependency-light: no model weights, no network. They cover the two behaviours that
actually broke when the vendored code first ran on transformers 5, because both failures were
silent-ish and expensive to diagnose:

- `inv_freq` came back as uninitialized memory after loading, so the first forward pass
  produced NaN logits.
- `position_ids` accumulated across decoding steps, so the rotary embedding was computed for
  the whole sequence while only one token was being decoded.

End-to-end proof that the port is behaviour-preserving is `tests/vendor_parity.py`, which
compares generated audio bit-for-bit; these tests just make sure the mechanisms it relies on
cannot quietly disappear.

Run: python -m unittest discover -s tests
"""

import ast
import sys
import unittest
from pathlib import Path
from typing import ClassVar

SERVICE_DIR = Path(__file__).resolve().parent.parent
VENDOR_DIR = SERVICE_DIR / "vendor" / "qwen_tts"
sys.path.insert(0, str(SERVICE_DIR))

import torch  # noqa: E402
import transformers  # noqa: E402
from vendor.qwen_tts import _compat  # noqa: E402


class _FakeRopeConfig:
    """The attributes `_compute_default_rope_parameters` reads off a config."""

    rope_theta = 1000000
    hidden_size = 1024
    num_attention_heads = 16
    head_dim = 128


class _FakeRotary(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.config = _FakeRopeConfig()
        self.rope_type = "default"
        inv_freq, self.attention_scaling = _compat._compute_default_rope_parameters(
            self.config
        )
        self.register_buffer("inv_freq", inv_freq, persistent=False)
        self.original_inv_freq = self.inv_freq


class TestAlignPositionIds(unittest.TestCase):
    def test_trims_accumulated_positions_to_the_query(self):
        # transformers 5 hands the model every position seen so far while `inputs_embeds`
        # holds only the token being decoded.
        position_ids = torch.arange(20).view(1, 1, -1).expand(3, 1, -1)
        aligned = _compat.align_position_ids(position_ids, 1)
        self.assertEqual(tuple(aligned.shape), (3, 1, 1))
        self.assertEqual(
            aligned[0, 0, 0].item(), 19, "must keep the newest position, not the oldest"
        )

    def test_is_a_noop_when_lengths_already_agree(self):
        position_ids = torch.arange(19).view(1, -1)
        self.assertIs(_compat.align_position_ids(position_ids, 19), position_ids)

    def test_tolerates_none(self):
        self.assertIsNone(_compat.align_position_ids(None, 5))

    def test_never_pads_a_shorter_tensor(self):
        position_ids = torch.arange(3).view(1, -1)
        self.assertIs(_compat.align_position_ids(position_ids, 10), position_ids)


class TestResetRotaryBuffers(unittest.TestCase):
    def test_recomputes_uninitialized_inv_freq(self):
        module = _FakeRotary()
        expected = module.inv_freq.clone()
        # Simulate what transformers 5 leaves behind for a non-persistent buffer it does not
        # recognize: whatever was in memory.
        module.inv_freq.copy_(torch.full_like(module.inv_freq, float("nan")))
        self.assertTrue(torch.isnan(module.inv_freq).all())

        _compat.reset_rotary_buffers(module)

        self.assertFalse(torch.isnan(module.inv_freq).any())
        torch.testing.assert_close(module.inv_freq, expected, rtol=0, atol=0)
        torch.testing.assert_close(module.original_inv_freq, expected, rtol=0, atol=0)

    def test_is_idempotent(self):
        module = _FakeRotary()
        before = module.inv_freq.clone()
        _compat.reset_rotary_buffers(module)
        _compat.reset_rotary_buffers(module)
        torch.testing.assert_close(module.inv_freq, before, rtol=0, atol=0)

    def test_ignores_modules_without_a_rope_buffer(self):
        plain = torch.nn.Linear(4, 4)
        _compat.reset_rotary_buffers(plain)  # must not raise

    def test_matches_the_frequencies_transformers_4_computed(self):
        """The shim replaces `ROPE_INIT_FUNCTIONS["default"]`, dropped in transformers 5."""
        from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS

        if "default" not in ROPE_INIT_FUNCTIONS:
            self.skipTest(
                f"transformers {transformers.__version__} has no default rope entry"
            )
        expected, expected_scaling = ROPE_INIT_FUNCTIONS["default"](_FakeRopeConfig())
        actual, actual_scaling = _compat._compute_default_rope_parameters(
            _FakeRopeConfig()
        )
        torch.testing.assert_close(actual, expected, rtol=0, atol=0)
        self.assertEqual(actual_scaling, expected_scaling)


class TestVendoredCodeUsesTheShims(unittest.TestCase):
    """Direct use of the reworked transformers internals must go through `_compat`.

    Re-vendoring from a new upstream wheel re-introduces the 4.x call sites, and on
    transformers 5 they fail in ways that are tedious to trace back (NaN logits, a shape
    mismatch deep in attention). Failing here instead names the file and the symbol.
    """

    FORBIDDEN: ClassVar[dict[str, str]] = {
        "ROPE_INIT_FUNCTIONS": "use _compat.rope_init_fn()",
        "check_model_inputs": "use _compat.check_model_inputs (bare decorator)",
        "rope_config_validation": "use _compat.rope_config_validation()",
    }

    def _modelling_files(self):
        return [
            p
            for p in VENDOR_DIR.rglob("*.py")
            if "__pycache__" not in p.parts and p.name != "_compat.py"
        ]

    def test_no_direct_imports_of_reworked_internals(self):
        offenders = []
        for path in self._modelling_files():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or node.level:
                    continue
                if not (node.module or "").startswith("transformers"):
                    continue
                for alias in node.names:
                    if alias.name in self.FORBIDDEN:
                        offenders.append(
                            f"{path.relative_to(VENDOR_DIR)} imports {alias.name} from "
                            f"{node.module} — {self.FORBIDDEN[alias.name]}"
                        )
                    if alias.name in (
                        "create_causal_mask",
                        "create_sliding_window_causal_mask",
                    ):
                        offenders.append(
                            f"{path.relative_to(VENDOR_DIR)} imports {alias.name} from "
                            f"{node.module} — use the _compat wrapper (signature changed in 5.x)"
                        )
        self.assertEqual(offenders, [])

    def test_generation_token_ids_are_read_defensively(self):
        # transformers 5 raises instead of returning None for a config that does not define
        # them, so bare `config.pad_token_id` reintroduces a load failure.
        offenders = [
            str(p.relative_to(VENDOR_DIR))
            for p in self._modelling_files()
            if "config.pad_token_id" in p.read_text(encoding="utf-8")
        ]
        self.assertEqual(offenders, [], "read via getattr(config, ..., None) instead")

    def test_both_load_paths_reset_the_rope_buffers(self):
        wired = {
            path.name
            for path in self._modelling_files()
            if "reset_rotary_buffers(" in path.read_text(encoding="utf-8")
        }
        self.assertEqual(
            wired,
            {"modeling_qwen3_tts.py", "qwen3_tts_tokenizer.py"},
            "every from_pretrained path must reset inv_freq, or the first forward NaNs on 5.x",
        )


if __name__ == "__main__":
    unittest.main()
