"""Guards on the vendored Qwen3-TTS tree (see qwen3-tts/vendor/README.md).

These are deliberately cheap: stdlib only, no model download, no inference. They protect the
properties the vendoring bought — that the 25 Hz tokenizer and the Gradio demo CLI are gone,
and with them every dependency only those needed — so a careless re-vendor from a new upstream
wheel fails here instead of silently re-adding `sox`, `onnxruntime`, `torchaudio`, `einops` or
`gradio` to the install.

Bit-exact output parity against the upstream package is a separate, much slower check:
`python tests/vendor_parity.py` (needs the model weights and a temporary upstream install).

Run: python -m unittest discover -s tests
"""

import ast
import unittest
from pathlib import Path

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "qwen_tts"

# Third-party top-level modules the vendored tree is allowed to import. Every entry is a
# declared dependency in pyproject.toml; anything else means the manifest and the code have
# drifted apart.
ALLOWED_THIRD_PARTY = {
    "huggingface_hub",
    "librosa",
    "numpy",
    "soundfile",
    "torch",
    "transformers",
}

# Imported only by the removed 25 Hz tokenizer / demo CLI. Listed explicitly so a failure
# names the culprit instead of just reporting an unexpected import.
REMOVED_DEPENDENCIES = {"einops", "gradio", "onnxruntime", "sox", "torchaudio"}

STDLIB_PREFIXES = {
    "__future__",
    "abc",
    "argparse",
    "base64",
    "collections",
    "contextlib",
    "copy",
    "dataclasses",
    "enum",
    "functools",
    "glob",
    "hashlib",
    "io",
    "itertools",
    "json",
    "logging",
    "math",
    "os",
    "pathlib",
    "random",
    "re",
    "shutil",
    "subprocess",
    "sys",
    "tempfile",
    "threading",
    "time",
    "types",
    "typing",
    "urllib",
    "warnings",
}

# Files in the vendored tree that are ours rather than upstream's, and so are exempt from the
# "upstream notice preserved" check.
OUR_FILES = {"_compat.py"}

EXPECTED_FILES = OUR_FILES | {
    "__init__.py",
    "core/__init__.py",
    "core/models/__init__.py",
    "core/models/configuration_qwen3_tts.py",
    "core/models/modeling_qwen3_tts.py",
    "core/models/processing_qwen3_tts.py",
    "core/tokenizer_12hz/configuration_qwen3_tts_tokenizer_v2.py",
    "core/tokenizer_12hz/modeling_qwen3_tts_tokenizer_v2.py",
    "inference/qwen3_tts_model.py",
    "inference/qwen3_tts_tokenizer.py",
}


def _python_files():
    return sorted(p for p in VENDOR_DIR.rglob("*.py") if "__pycache__" not in p.parts)


def _parse(path):
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _top_level_imports(path):
    """Top-level module names imported by `path`, ignoring intra-package relative imports."""
    names = set()
    for node in ast.walk(_parse(path)):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import, stays inside the vendored tree
                continue
            if node.module:
                names.add(node.module.split(".")[0])
    return names


def _referenced_identifiers(path):
    """Identifiers the code actually uses — imported names, bare names, attribute names.

    Deliberately AST-based rather than a substring scan: upstream docstrings mention the 25 Hz
    classes in prose (including one copy-paste slip in the 12 Hz decoder), and those files are
    kept byte-identical to the wheel, so only real code references should fail.
    """
    names = set()
    for node in ast.walk(_parse(path)):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
    return names


class TestVendoredTree(unittest.TestCase):
    def test_vendor_dir_exists(self):
        self.assertTrue(VENDOR_DIR.is_dir(), f"missing vendored tree at {VENDOR_DIR}")

    def test_file_inventory_matches_documented_set(self):
        found = {
            str(p.relative_to(VENDOR_DIR)).replace("\\", "/") for p in _python_files()
        }
        self.assertEqual(
            found,
            EXPECTED_FILES,
            "vendored file set changed; update vendor/README.md and this list together",
        )

    def test_removed_dependencies_are_not_imported(self):
        offenders = {}
        for path in _python_files():
            hits = _top_level_imports(path) & REMOVED_DEPENDENCIES
            if hits:
                offenders[str(path.relative_to(VENDOR_DIR))] = sorted(hits)
        self.assertEqual(
            offenders,
            {},
            "the 25 Hz tokenizer / demo CLI dependencies are back; these are not installed",
        )

    def test_imports_are_declared_dependencies(self):
        unexpected = {}
        for path in _python_files():
            extras = {
                name
                for name in _top_level_imports(path)
                if name not in ALLOWED_THIRD_PARTY
                and name not in STDLIB_PREFIXES
                and name != "qwen_tts"
            }
            if extras:
                unexpected[str(path.relative_to(VENDOR_DIR))] = sorted(extras)
        self.assertEqual(
            unexpected,
            {},
            "vendored code imports something pyproject.toml does not declare",
        )

    def test_no_code_references_to_removed_25hz_symbols(self):
        offenders = []
        for path in _python_files():
            for name in sorted(_referenced_identifiers(path)):
                if "tokenizer_25hz" in name or name.startswith("Qwen3TTSTokenizerV1"):
                    offenders.append(f"{path.relative_to(VENDOR_DIR)}: {name}")
        self.assertEqual(
            offenders, [], "dangling references to the removed 25 Hz tokenizer"
        )

    def test_apache_license_notices_retained(self):
        # Upstream mixes two notice styles: an SPDX identifier, and the classic Apache text in
        # the files derived from HuggingFace. Either is fine; absence of both is not.
        missing = [
            str(p.relative_to(VENDOR_DIR))
            for p in _python_files()
            if str(p.relative_to(VENDOR_DIR)).replace("\\", "/") not in OUR_FILES
            and not any(
                notice in p.read_text(encoding="utf-8")[:1200]
                for notice in (
                    "SPDX-License-Identifier: Apache-2.0",
                    "Licensed under the Apache License",
                )
            )
        ]
        self.assertEqual(missing, [], "upstream Apache-2.0 notices must be preserved")


if __name__ == "__main__":
    unittest.main()
