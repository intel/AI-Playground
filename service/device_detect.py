import subprocess
import re

def get_devices():
    result = subprocess.run(["wmic", "path", "win32_VideoController", "get", "name,pnpdeviceid"], capture_output=True, text=True)
    lines = result.stdout.split("\n")
    devices = {} # {name: device_id}
    for line in lines:
        # vendor:8086 is an Intel device
        if "VEN_8086" in line:
            parts = line.split("  ")
            name = parts[0].strip()
            for part in parts[1:]:
                if "VEN_8086" in part:
                    # regex match "VEN_8086&DEV_{device_id}"
                    if match := re.search(r"VEN_8086\&DEV_([0-9A-F]+)", part):
                        device_id = match.group(1)
                        devices[name] = device_id
                        break

    return devices

devices = get_devices()

def is_supported(name):
    return "arc" in name.lower() or (name in devices and devices[name].lower() == "e20b")

import torch
import intel_extension_for_pytorch as ipex  # noqa: F401

# filter out unsupported devices
supported_ids = []
for i in range(torch.xpu.device_count()):
    props = torch.xpu.get_device_properties(i)
    if is_supported(props.name):
        supported_ids.append(str(i))

print(",".join(supported_ids))
