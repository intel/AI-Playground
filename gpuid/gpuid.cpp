// gpuid.cpp : This file contains the 'main' function. Program execution begins and ends there.
// 
// This code is a simple example of how to get the GPU information using the DXGI API. It is based on the code in the following link:
// https://asawicki.info//news_1695_there_is_a_way_to_query_gpu_memory_usage_in_vulkan_-_use_dxgi
// 
// Related to this implementation, NPU could be inspected in a similar fashion:
// https://learn.microsoft.com/en-us/answers/questions/1700210/how-to-read-and-output-the-npu-utilization => Something related to the NPU
// 
// To compile, link against dxgi.lib and use static linking

#include <iostream>
#include <dxgi1_4.h>
#include <atlbase.h>
#include <iomanip>
#include <locale>
#include <codecvt>

int main()
{
    IDXGIFactory4* dxgiFactory = nullptr;
    CreateDXGIFactory1(IID_PPV_ARGS(&dxgiFactory));

    IDXGIAdapter1* tmpDxgiAdapter = nullptr;

    std::wstring_convert<std::codecvt_utf8<wchar_t>> converter;

    UINT adapterIndex = 0;
    while (dxgiFactory->EnumAdapters1(adapterIndex, &tmpDxgiAdapter) != DXGI_ERROR_NOT_FOUND)
    {
        DXGI_ADAPTER_DESC1 desc;
        tmpDxgiAdapter->GetDesc1(&desc);
        if (desc.Flags == 0)
        {
            std::cout << "Found adapter: " << converter.to_bytes(desc.Description) << std::endl;
            std::cout << "Adapter LUID: luid_" 
                << "0x" << std::hex << std::setw(8) << std::setfill('0') << desc.AdapterLuid.HighPart << std::dec
                << "_" 
                << "0x" << std::hex << std::uppercase << std::setw(8) << std::setfill('0') << desc.AdapterLuid.LowPart << std::dec
                << "_phys_0"
                << std::endl;
            std::cout << "Adapter Shared Memory: " << static_cast<double>(desc.SharedSystemMemory) / (1024 * 1024 * 1024) << " GB" << std::endl;
            std::cout << "Adapter Dedicated Memory: " << static_cast<double>(desc.DedicatedVideoMemory) / (1024 * 1024 * 1024) << " GB" << std::endl;
            std::cout << std::endl;
        }
        tmpDxgiAdapter->Release();
        ++adapterIndex;
    }

    dxgiFactory->Release();
}

// Run program: Ctrl + F5 or Debug > Start Without Debugging menu
// Debug program: F5 or Debug > Start Debugging menu

// Tips for Getting Started: 
//   1. Use the Solution Explorer window to add/manage files
//   2. Use the Team Explorer window to connect to source control
//   3. Use the Output window to see build output and other messages
//   4. Use the Error List window to view errors
//   5. Go to Project > Add New Item to create new code files, or Project > Add Existing Item to add existing code files to the project
//   6. In the future, to open this project again, go to File > Open > Project and select the .sln file
