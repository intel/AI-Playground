// Usage: node pack-offline.js <npm_package_res_dir> <platform>
//
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const childProcess = require('child_process');

if (process.argv.length < 4) {
    console.error('Usage: node pack-offline.js <npm_package_res_dir> <platform>');
    process.exit(1);
}

const packageResDir = existingFileOrExit(path.resolve(process.argv[2]));
const platform = process.argv[3];

const sevenZipExe = existingFileOrExit(path.join(packageResDir, '7zr.exe'));
const zippedPyenv = existingFileOrExit(path.join(packageResDir, 'env.7z'));

function existingFileOrExit(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error('Resource not found:', filePath);
        process.exit(1);
    }
    return filePath
}


function unzippedPackagedPyenv(pyenvArchive) {
    existingFileOrExit(pyenvArchive)
    const pyenvTargetDir = workDir

    if (fs.existsSync(pyenvTargetDir)) {
        console.warn("Removing existing offline env directory:", pyenvTargetDir);
        fs.rmSync(workDir, { recursive: true });
    }

    const unzip = childProcess.spawnSync(sevenZipExe, ['x', pyenvArchive, `-o${workDir}`]);
    console.log(unzip.stdout.toString());
    console.error(unzip.stderr.toString());
    if (unzip.status !== 0) {
        console.error('Failed to extract env.7z');
        process.exit(1);
    }

    const offlineEnvDir = existingFileOrExit(path.join(workDir, 'env'));
    return offlineEnvDir
}

function installPip(getPipFilePath, workingDir) {
    const runGetPip = spawn(pythonExe, [getPipFilePath], { cwd: workingDir });
    runGetPip.stdout.on('data', (data) => {
        console.log(data.toString());
    });
    runGetPip.stderr.on('data', (data) => {
        console.error(data.toString());
    });
    pipInstall.on('close', (code) => {
        if (code !== 0) {
            console.error('Failed to install pip');
            process.exit(1);
        }
    });
}

function runPipInstall(requirementsFilePath, workingDir) {
    const pipInstall = spawn(pythonExe, ['-m', 'pip', 'install', '-r', requirementsFilePath], { cwd: workingDir });
    pipInstall.stdout.on('data', (data) => {
        console.log(data.toString());
    });
    pipInstall.stderr.on('data', (data) => {
        console.error(data.toString());
    });
    pipInstall.on('close', (code) => {
        if (code !== 0) {
            console.error('Failed to install requirements');
            process.exit(1);
        }
    });
}

function zipPyenv(pyEnvDir) {
    const offlineEnvArchiveTargetPath = path.join(packageResDir, `env-offline-${platform}.7z`);
    const zip = childProcess.spawnSync((sevenZipExe, ['a', offlineEnvArchiveTargetPath, existingFileOrExit(pyEnvDir)]);
    console.log(zip.stdout.toString());
    console.error(zip.stderr.toString());
    if (zip.status !== 0) {
        console.error('Failed to compress offline env directory');
        process.exit(1);
    }

    console.log('Offline env has been created successfully:', offlineEnvArchiveTargetPath);
}

function main() {
    const workDir = path.join(__dirname, `env-${platform}`);

    const offlineEnvDir = unzippedPackagedPyenv(zippedPyenv)
    const pythonExe = existingFileOrExit(path.join(offlineEnvDir, 'python.exe'));

    const getPipFile = existingFileOrExit(path.join(offlineEnvDir, 'get-pip.py'));
    const platformSpecificRequirementsTxt = existingFileOrExit(path.join(__dirname, '..', '..', 'service', `requirements-${platform}.txt`));
    const requirementsTxt = existingFileOrExit(path.join(__dirname, '..', '..', 'service', `requirements.txt`));

    installPip(getPipFile, offlineEnvDir)
    runPipInstall(platformSpecificRequirementsTxt, offlineEnvDir)
    runPipInstall(requirementsTxt, offlineEnvDir)

    zipPyenv(offlineEnvDir)
}