#include <sycl/sycl.hpp>
#include <iostream>

using namespace sycl;

int main() {
  std::cout << "[";
  unsigned int id = 0;
  for (const auto &plt : platform::get_platforms()) {
    if (plt.get_backend() != backend::ext_oneapi_level_zero)
      continue;

    for (const auto &dev : plt.get_devices()) {
      if (id > 0)
        std::cout << ", ";
      std::string name = dev.get_info<info::device::name>();
      std::cout << "{\"id\": " << id << ", \"name\": \"" << name << "\"";
      if (dev.has(aspect::ext_intel_device_id)) {
        int device_id = dev.get_info<ext::intel::info::device::device_id>();
        std::cout << ", \"device_id\": " << device_id;
      }
      std::cout << "}";
      id++;
    }
  }
  std::cout << "]" << std::endl;
}
