## Prepare a base python 3.11 environment

1. Download embedded python for windows from https://github.com/adang1345/PythonWindows
2. Download get-pip.py from https://bootstrap.pypa.io/get-pip.py
3. Install miniforge: https://github.com/conda-forge/miniforge
4. Create a reference conda environment with libuv installed
5. Download 7zr executable from https://www.7-zip.org/a/7zr.exe, put it under `WebUI\package_res` folder.

```
conda create -n cp311_libuv python=3.11 libuv -y

# copy the path to this conda env
conda env list | findstr cp311_libuv
```

5. Run prepack script with 3 additional arguments, this will generate `env.7z` under `WebUI\package_res` folder.

```
cd WebUI
npm run prepack <python_embed_zip> <get_pip_py> <ref_conda_env>
```

`package_res/env.7z` could be reused for all platforms.

## Package

```
npm run prebuild
npm run build:arc
npm run build:ultra
npm run build:ultra2
```
