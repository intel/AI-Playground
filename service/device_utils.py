"""
Device detection utilities for AI Playground.
Supports Intel XPU (Arc GPU) and NVIDIA CUDA devices.
"""

import sys
import logging

logger = logging.getLogger(__name__)


def detect_all_available_devices():
    """
    Detect all available devices for inference.

    Returns:
        list: List of available device types ['xpu', 'cuda', 'cpu']
    """
    available_devices = []

    # Check for XPU (Intel Arc GPUs)
    try:
        import torch
        if hasattr(torch, 'xpu') and torch.xpu.is_available():
            device_count = torch.xpu.device_count()
            if device_count > 0:
                device_name = torch.xpu.get_device_name(0)
                logger.info(f"XPU device detected: {device_name} (count: {device_count})")
                available_devices.append("xpu")
    except Exception as e:
        logger.debug(f"XPU not available: {e}")

    # Check for CUDA (NVIDIA GPUs)
    try:
        import torch
        if torch.cuda.is_available():
            device_count = torch.cuda.device_count()
            if device_count > 0:
                device_name = torch.cuda.get_device_name(0)
                logger.info(f"CUDA device detected: {device_name} (count: {device_count})")
                available_devices.append("cuda")
    except Exception as e:
        logger.debug(f"CUDA not available: {e}")

    # CPU is always available
    available_devices.append("cpu")
    logger.info(f"Available devices: {', '.join(available_devices)}")

    return available_devices


def detect_available_device():
    """
    Detect the best available device for inference (for backward compatibility).
    Priority: XPU > CUDA > CPU

    Returns:
        str: Device type ('cuda', 'xpu', or 'cpu')
    """
    available = detect_all_available_devices()
    # Return first available device (priority order: xpu, cuda, cpu)
    if "xpu" in available:
        return "xpu"
    elif "cuda" in available:
        return "cuda"
    else:
        return "cpu"


def get_device_count(device_type):
    """
    Get the number of available devices for the specified type.

    Args:
        device_type (str): Device type ('cuda', 'xpu', or 'cpu')

    Returns:
        int: Number of devices (1 for CPU)
    """
    try:
        import torch
        if device_type == "cuda" and torch.cuda.is_available():
            return torch.cuda.device_count()
        elif device_type == "xpu" and hasattr(torch, 'xpu') and torch.xpu.is_available():
            return torch.xpu.device_count()
    except Exception as e:
        logger.debug(f"Error getting device count for {device_type}: {e}")

    return 1 if device_type == "cpu" else 0


def get_device_name(device_type, device_id=0):
    """
    Get the name of a specific device.

    Args:
        device_type (str): Device type ('cuda', 'xpu', or 'cpu')
        device_id (int): Device index

    Returns:
        str: Device name
    """
    try:
        import torch
        if device_type == "cuda" and torch.cuda.is_available():
            return torch.cuda.get_device_name(device_id)
        elif device_type == "xpu" and hasattr(torch, 'xpu') and torch.xpu.is_available():
            return torch.xpu.get_device_name(device_id)
    except Exception as e:
        logger.debug(f"Error getting device name for {device_type}:{device_id}: {e}")

    return "CPU" if device_type == "cpu" else "Unknown Device"


def get_device_info():
    """
    Get comprehensive device information for all available devices.

    Returns:
        dict: Device information including all available device types with their details
    """
    available_device_types = detect_all_available_devices()
    default_device_type = detect_available_device()

    all_devices = []
    device_info_by_type = {}

    for device_type in available_device_types:
        device_count = get_device_count(device_type)
        devices = []

        for i in range(device_count):
            devices.append({
                "id": i,
                "name": get_device_name(device_type, i),
                "type": device_type
            })

        device_info_by_type[device_type] = {
            "count": device_count,
            "devices": devices
        }
        all_devices.extend(devices)

    return {
        "available_device_types": available_device_types,
        "default_device_type": default_device_type,
        "device_info_by_type": device_info_by_type,
        "all_devices": all_devices
    }


if __name__ == "__main__":
    # Test device detection
    logging.basicConfig(level=logging.INFO)
    info = get_device_info()
    print(f"\nAvailable device types: {', '.join(info['available_device_types'])}")
    print(f"Default device (auto): {info['default_device_type']}\n")

    for device_type in info['available_device_types']:
        type_info = info['device_info_by_type'][device_type]
        print(f"{device_type.upper()} Devices (count: {type_info['count']}):")
        for device in type_info['devices']:
            print(f"  Device {device['id']}: {device['name']}")

