import sys


def patch_import(file_path):
    # Read the file
    with open(file_path, "r") as file:
        lines = file.readlines()

    # Patch the import line
    with open(file_path, "w") as file:
        for line in lines:
            # Replace the old import line with the new one
            if (
                "from torchvision.transforms.functional_tensor import rgb_to_grayscale"
                in line
            ):
                line = line.replace(
                    "from torchvision.transforms.functional_tensor import rgb_to_grayscale",
                    "from torchvision.transforms.functional import rgb_to_grayscale",
                )
            file.write(line)

    print(f"Patched {file_path} successfully.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python patch_import.py <path_to_file>")
        sys.exit(1)

    file_path = sys.argv[1]
    patch_import(file_path)
