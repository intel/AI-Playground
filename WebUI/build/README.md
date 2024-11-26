# Installer Build

## Fetch remote dependencies for build

1. run ```npm install```
2. aquire windows libuv dlls, e.g. via miniforge:
   - Install miniforge: https://github.com/conda-forge/miniforge
   - Create a reference conda environment with libuv installed
    ```
    conda create -n cp311_libuv python=3.11 libuv -y
    # copy the path to this conda env
    conda env list | findstr cp311_libuv
    ```
    - copy the path of the Library directory of your conda env  
3. run ```npm run fetch-build-resources --conda_env_library_dir=$PATH_TO_CONDA_ENV_LIBRARY_DIR```

## decide for offline or online installer

### online installer

run 
```
npm run prepare-build:${PLATFORM}
npm run build:${PLATFORM}
```

### offline installer
run
```
npm run prepare-build:${PLATFORM}-offline
npm run build:${PLATFORM}-offline
```

Fetching, installing and compressing the full python dependencies takes a considerable amount of time.
