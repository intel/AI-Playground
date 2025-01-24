// https://github.com/intel/compute-runtime/blob/master/shared/source/dll/devices/devices_base.inl
const ID2ARCH: { [key: number]: Arch } = {
    // bmg
    0xE202: "bmg",
    0xE20B: "bmg",
    0xE20C: "bmg",
    0xE20D: "bmg",
    0xE212: "bmg",

    // lnl
    0x6420: "lnl",
    0x64A0: "lnl",
    0x64B0: "lnl",

    // dg2, using alias name "acm"
    0x4F80: "acm",
    0x4F81: "acm",
    0x4F82: "acm",
    0x4F83: "acm",
    0x4F84: "acm",
    0x4F85: "acm",
    0x4F86: "acm",
    0x4F87: "acm",
    0x4F88: "acm",
    0x5690: "acm",
    0x5691: "acm",
    0x5692: "acm",
    0x5693: "acm",
    0x5694: "acm",
    0x5695: "acm",
    0x5696: "acm",
    0x5697: "acm",
    0x56A3: "acm",
    0x56A4: "acm",
    0x56B0: "acm",
    0x56B1: "acm",
    0x56B2: "acm",
    0x56B3: "acm",
    0x56BA: "acm",
    0x56BB: "acm",
    0x56BC: "acm",
    0x56BD: "acm",
    0x56BE: "acm",
    0x56BF: "acm",
    0x56A0: "acm",
    0x56A1: "acm",
    0x56A2: "acm",
    0x56A5: "acm",
    0x56A6: "acm",
    0x56C0: "acm",
    0x56C1: "acm",
    0x56C2: "acm",

    // mtl
    0x7D40: "mtl",
    0x7D55: "mtl",
    0x7DD5: "mtl",
    0x7D45: "mtl",

    // // arl
    // 0x7D67: "arl",
    // 0x7D51: "arl",
    // 0x7DD1: "arl",
    // 0x7D41: "arl",
};

export function getDeviceArch(deviceId: number): Arch {
    return ID2ARCH[deviceId] || "unknown";
}

export function getArchPriority(arch: Arch): number {
    switch (arch) {
        case "bmg": return 4;
        case "acm": return 3;
        case "lnl": return 2;
        case "mtl": return 1;
        default: return 0;
    }
}

export type Arch = "bmg" | "acm" | "lnl" | "mtl" | "unknown"