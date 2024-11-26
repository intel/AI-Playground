import subprocess
import re

def get_devices():
    result = subprocess.run(["wmic", "path", "win32_VideoController", "get", "name,pnpdeviceid"], capture_output=True, text=True)
    lines = result.stdout.split("\n")
    devices = {} # {name: device_id}
    devices_with_index = []
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
                        devices_with_index.append(device_id)
                        break
    return devices, devices_with_index

devices, devices_with_index = get_devices()

def is_supported(name, gpu_id=0):
    return "arc" in name.lower() or (name in devices and devices[name].lower() == "e20b") or (devices_with_index[gpu_id].lower()== "e20b")

import torch
import intel_extension_for_pytorch as ipex  # noqa: F401

# filter out unsupported devices
supported_ids = []
for i in range(torch.xpu.device_count()):
    props = torch.xpu.get_device_properties(i)
    if is_supported(props.name, i):
        supported_ids.append(str(i))

print(",".join(supported_ids))
