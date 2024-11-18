## Prepare a base python 3.11 environment

1. fetch resources via web by calling ```npm run fetch-build-resources```
2. provide windows libuv dlls:
   - Install miniforge: https://github.com/conda-forge/miniforge
   - Create a reference conda environment with libuv installed
    ```
    conda create -n cp311_libuv python=3.11 libuv -y
    # copy the path to this conda env
    conda env list | findstr cp311_libuv
    ```
    - symlink or copy the conda env path into /python_package_resources
3. run ```npm run pack-python```

The resulting `WebUI/npm_package_res/env.7z` could be reused for all platforms.

## Package

```
npm run prebuild
npm run build:arc
npm run build:ultra
npm run build:ultra2
```
