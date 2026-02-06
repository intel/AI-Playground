#!/usr/bin/env python3
"""Query OpenVINO devices and output as JSON."""
import json
import sys


def main():
    try:
        import openvino as ov

        core = ov.Core()
        devices = []
        for device_id in core.available_devices:
            try:
                full_name = core.get_property(device_id, "FULL_DEVICE_NAME")
            except Exception:
                full_name = device_id
            devices.append({"id": device_id, "name": full_name})
        print(json.dumps({"success": True, "devices": devices}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
