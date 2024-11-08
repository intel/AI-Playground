import torch
import intel_extension_for_pytorch as ipex

# filter out non-Arc devices
supported_ids = []
for i in range(torch.xpu.device_count()):
    props = torch.xpu.get_device_properties(i)
    if 'arc' in props.name.lower():
        supported_ids.append(str(i))

print(','.join(supported_ids))
