#!/usr/bin/env python3
"""Detect GPU hardware via OpenVINO and output device info as JSON."""
import json
import sys


def main():
    try:
        import openvino as ov

        core = ov.Core()
        gpu_devices = []
        for dev in core.available_devices:
            if not dev.startswith("GPU"):
                continue
            try:
                from openvino.properties import intel_gpu

                device_id = core.get_property(dev, intel_gpu.device_id)
            except Exception:
                device_id = None
            try:
                full_name = core.get_property(dev, "FULL_DEVICE_NAME")
            except Exception:
                full_name = dev
            gpu_devices.append(
                {"device": dev, "name": full_name, "gpuDeviceId": device_id}
            )
        print(json.dumps({"success": True, "gpuDevices": gpu_devices}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
