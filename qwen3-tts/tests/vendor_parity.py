"""Assert the vendored Qwen3-TTS tree produces bit-identical audio to the upstream package.

This is the check that makes vendoring safe to trust, and the one to re-run after re-vendoring
from a new wheel or changing the `transformers` constraint. It is slow (loads the model and
synthesizes several clips on the selected device), needs the model weights, and needs the
upstream package temporarily installed, so it is a maintenance tool rather than a unit test —
hence the module name, which `unittest discover` will not pick up. The cheap structural guards
live in test_vendor.py.

Setup (installs upstream into the service venv *without* its dependency tree, so the
comparison runs on one interpreter with one torch and one transformers):

    uv pip install --no-deps qwen-tts==0.1.1

Run:

    python tests/vendor_parity.py                 # CPU
    python tests/vendor_parity.py --device xpu    # or cuda:0

Both implementations register "qwen3_tts" with transformers' Auto* registries, and registering
one model_type from two different classes is an error, so each implementation runs in its own
subprocess and results are compared from disk.
"""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent

# (label, mode, seed, generate kwargs). Fixed seeds make generation reproducible, so any
# difference is the code, not sampling. The greedy case removes sampling from the picture
# entirely; the German case exercises a non-default language id.
CASES = [
    (
        "english-ryan",
        "custom_voice",
        1234,
        {
            "text": "AI Playground text to speech is working.",
            "language": "English",
            "speaker": "Ryan",
        },
    ),
    (
        "english-aiden",
        "custom_voice",
        7,
        {
            "text": "The quick brown fox jumps over the lazy dog.",
            "language": "English",
            "speaker": "Aiden",
        },
    ),
    (
        "german-serena",
        "custom_voice",
        99,
        {
            "text": "Kurze Ansage auf Deutsch, bitte deutlich sprechen.",
            "language": "German",
            "speaker": "Serena",
        },
    ),
    (
        "greedy",
        "custom_voice",
        5,
        {
            "text": "Sampling disabled, greedy decode.",
            "language": "English",
            "speaker": "Ryan",
            "do_sample": False,
            "subtalker_dosample": False,
        },
    ),
]


def stub_removed_25hz_modules() -> list[str]:
    """Register empty stubs for the 25 Hz tokenizer's imports, if they are absent.

    Importing the *upstream* package pulls `qwen_tts.core.tokenizer_25hz`, whose vq module
    imports sox / onnxruntime / torchaudio / einops. Those are exactly the packages vendoring
    removed from the install, so upstream would be unimportable here. The cases below only ever
    touch the 12 Hz path, so bare stubs are enough — and because they are plain modules with no
    attributes, any actual use fails loudly instead of silently returning a mock.
    """
    import importlib.machinery
    import types

    needed = {
        "sox": (),
        "onnxruntime": (),
        "einops": ("rearrange", "repeat"),
        "torchaudio": ("compliance",),
        "torchaudio.compliance": ("kaldi",),
        "torchaudio.compliance.kaldi": (),
    }
    stubbed = []
    for name, attributes in needed.items():
        if (
            importlib.util.find_spec(name.split(".")[0]) is not None
            and name in sys.modules
        ):
            continue
        try:
            __import__(name)
            continue
        except ImportError:
            pass
        module = types.ModuleType(name)
        # A stub without a real __spec__ breaks anything that introspects the module list —
        # torch._dynamo.trace_rules calls find_spec() on every name it knows and raises
        # "ValueError: <name>.__spec__ is None" otherwise.
        module.__spec__ = importlib.machinery.ModuleSpec(
            name, loader=None, is_package=True
        )
        module.__path__ = []
        sys.modules[name] = module
        stubbed.append(name)
        for attribute in attributes:
            child = f"{name}.{attribute}"
            if child in needed:
                continue
            setattr(module, attribute, None)
    # Wire the nested torchaudio stubs together so `torchaudio.compliance.kaldi` resolves.
    for parent, attribute in (
        ("torchaudio", "compliance"),
        ("torchaudio.compliance", "kaldi"),
    ):
        child = f"{parent}.{attribute}"
        if parent in sys.modules and child in sys.modules:
            setattr(sys.modules[parent], attribute, sys.modules[child])
    return stubbed


def generate(impl: str, out_path: str, model: str, device: str) -> None:
    """Child-process entry point: synthesize every case with one implementation."""
    import numpy as np
    import torch
    import transformers

    if impl == "vendored":
        sys.path.insert(0, str(SERVICE_DIR))
        from vendor.qwen_tts import Qwen3TTSModel
    else:
        stubbed = stub_removed_25hz_modules()
        if stubbed:
            print(
                f"  [{impl}] stubbed absent 25 Hz imports: {', '.join(stubbed)}",
                flush=True,
            )
        from qwen_tts import Qwen3TTSModel

    print(
        f"  [{impl}] module={Qwen3TTSModel.__module__} "
        f"transformers={transformers.__version__} torch={torch.__version__}",
        flush=True,
    )

    tts = Qwen3TTSModel.from_pretrained(
        model, device_map=device, dtype=torch.float32, attn_implementation="sdpa"
    )

    # Spy on the codes handed to the speech tokenizer so a mismatch can be attributed to the
    # talker (codes differ) rather than the codec decoder (codes match, audio differs).
    codes: list = []
    inner_decode = tts.model.speech_tokenizer.decode

    def spy(encoded, *args, **kwargs):
        codes.append(
            np.asarray(encoded[0]["audio_codes"].detach().cpu(), dtype=np.int64)
        )
        return inner_decode(encoded, *args, **kwargs)

    tts.model.speech_tokenizer.decode = spy

    arrays = {}
    for index, (label, mode, seed, kwargs) in enumerate(CASES):
        torch.manual_seed(seed)
        np.random.seed(seed)
        generate_fn = (
            tts.generate_voice_design
            if mode == "voice_design"
            else tts.generate_custom_voice
        )
        wavs, sample_rate = generate_fn(**kwargs)
        arrays[f"wav_{index}"] = np.ascontiguousarray(wavs[0], dtype=np.float32)
        arrays[f"codes_{index}"] = codes[-1]
        arrays[f"sr_{index}"] = np.asarray(sample_rate)
        print(
            f"  [{impl}] {label}: {arrays[f'wav_{index}'].shape[0]} samples @ "
            f"{sample_rate} Hz, codes {codes[-1].shape}",
            flush=True,
        )

    np.savez(out_path, **arrays)


def compare(upstream_path: str, vendored_path: str) -> bool:
    import numpy as np

    upstream = np.load(upstream_path)
    vendored = np.load(vendored_path)
    all_equal = True
    for index, (label, _, seed, _) in enumerate(CASES):
        wav_a, wav_b = upstream[f"wav_{index}"], vendored[f"wav_{index}"]
        codes_a, codes_b = upstream[f"codes_{index}"], vendored[f"codes_{index}"]
        rate_a, rate_b = int(upstream[f"sr_{index}"]), int(vendored[f"sr_{index}"])
        codes_equal = codes_a.shape == codes_b.shape and np.array_equal(
            codes_a, codes_b
        )
        wav_equal = wav_a.shape == wav_b.shape and np.array_equal(wav_a, wav_b)
        all_equal &= codes_equal and wav_equal and rate_a == rate_b
        detail = ""
        if not wav_equal and wav_a.shape == wav_b.shape:
            detail = f" max_abs_diff={np.abs(wav_a - wav_b).max():.3e}"
        print(
            f"  {label} (seed={seed}): codes_equal={codes_equal} "
            f"wav_bit_exact={wav_equal} sample_rate={rate_a}/{rate_b}{detail}"
        )
    return all_equal


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    parser.add_argument(
        "--device", default="cpu", help="device_map value: cpu, xpu, cuda:0"
    )
    parser.add_argument(
        "--impl", choices=["upstream", "vendored"], help=argparse.SUPPRESS
    )
    parser.add_argument("--out", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.impl:  # child process
        generate(args.impl, args.out, args.model, args.device)
        return 0

    if importlib.util.find_spec("qwen_tts") is None:
        print(
            "upstream qwen-tts is not installed, so there is nothing to compare against.\n"
            "Install it without its dependency tree first:\n"
            "    uv pip install --no-deps qwen-tts==0.1.1",
            file=sys.stderr,
        )
        return 2

    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for impl in ("upstream", "vendored"):
            paths[impl] = str(Path(tmp) / f"{impl}.npz")
            print(f"generating with {impl} implementation ...", flush=True)
            subprocess.run(
                [
                    sys.executable,
                    __file__,
                    "--impl",
                    impl,
                    "--out",
                    paths[impl],
                    "--model",
                    args.model,
                    "--device",
                    args.device,
                ],
                check=True,
                cwd=SERVICE_DIR,
            )
        print("\ncomparing:")
        ok = compare(paths["upstream"], paths["vendored"])

    print(f"\nPARITY: {'bit-exact' if ok else 'MISMATCH'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
