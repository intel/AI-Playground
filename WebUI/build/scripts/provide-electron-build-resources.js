// Usage: node provide-build-resources.js --python_env_dir=$DIR ---backend_dir=$DIR --target_dir=$DIR

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const argv = require('minimist')(process.argv.slice(2));
const buildResourcesDirArg = argv.build_resources_dir
const pythonEnvDirArg = argv.python_env_dir
const backendDirArg = argv.backend_dir
const targetDirectoryArg = argv.target_dir


if (!buildResourcesDirArg || !pythonEnvDirArg || !backendDirArg || !targetDirectoryArg) {
    console.error('Usage: node prebuild.js --build_resources_dir=$DIR --python_env_dir=$DIR ---backend_dir=$DIR --target_dir=$DIR\n');
    process.exit(1);
}

const buildResourcesDir = path.resolve(buildResourcesDirArg)
const pythenEnvDir = path.resolve(pythonEnvDirArg)
const backendDir = path.resolve(backendDirArg)
const targetDir = path.resolve(targetDirectoryArg)


function symlinkBackendDir(backendDir, serviceLink) {
    // remove link if already exists
    if (fs.existsSync(serviceLink)) {
        fs.unlinkSync(serviceLink);
        console.log('Removed symlink:', serviceLink);
    }
    // make link from service to <build_dir>/service
    fs.symlinkSync(backendDir, serviceLink, 'junction');
    console.log('Created symlink:', backendDir);
}


function zipPythonEnv(sevenZipExe, pythonEnvDir, targetPath) {
    console.log(`zipping ${pythonEnvDir} to ${targetPath}`);

    const zip = childProcess.spawnSync(sevenZipExe, ['a', targetPath, pythonEnvDir]);
    console.log(zip.stdout.toString());
    console.error(zip.stderr.toString());
    if (zip.status !== 0) {
        console.error('Failed to compress offline env directory');
        process.exit(1);
    }

    console.log('Offline env has been compressed to:', targetPath);
}

function copyFiles(targetDir, ...files) {
    for (const file of files) {
        fs.copyFileSync(file, path.join(targetDir, path.basename(file)));
        console.log('Copied:', file, 'to:', path.join(targetDir, path.basename(file)));
    }
}

function copyDirectories(targetDir, ...dirs) {
    for (const dir of dirs) {
        fs.cpSync(dir, path.join(targetDir, path.basename(dir)), { recursive: true });
        console.log('Copied:', dir, 'to:', path.join(targetDir, path.basename(dir)));
    }
}

function clearPreviousZip(zipFilePath) {
    if
    (fs.existsSync(zipFilePath)) {
        console.log('Removing previous zip file:', zipFilePath)<
        fs.rmSync(zipFilePath, { recursive: true });
    }
}

function main() {
    const sevenZipExe = path.join(buildResourcesDir, '7zr.exe');
    const comfyUI = path.join(buildResourcesDir, 'ComfyUI');

    clearPreviousZip(path.join(targetDir, `env.7z`));
    zipPythonEnv(sevenZipExe, pythenEnvDir, path.join(targetDir, `env.7z`));

    symlinkBackendDir(backendDir, path.join(targetDir, 'service'))
    copyFiles(targetDir,
        sevenZipExe
    )

    copyDirectories(targetDir,
        comfyUI
    )
}

main()
