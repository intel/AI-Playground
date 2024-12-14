// Usage: node pack-offline.js <npm_package_res_dir> <platform>
//
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const childProcess = require('child_process');

const argv = require('minimist')(process.argv.slice(2));
const envDirArg = argv.env_dir
const platformArg = argv.platform
const comfyUIDIrArg = argv.comfy_ui_dir

if (!envDirArg || !platformArg || !comfyUIDIrArg) {
    console.error('Usage: node install-full-python-env.js --env_dir=$DIR ---platform=arc|ultra|ultra2\n');
    process.exit(1);
}

const envDir = existingFileOrExit(path.resolve(envDirArg));
const comfyUIDIr = existingFileOrExit(path.resolve(comfyUIDIrArg));
const platform = platformArg;

function existingFileOrExit(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error('Resource not found:', filePath);
        process.exit(1);
    }
    return filePath
}


function installPip(pythonExe, getPipFilePath) {
    const runGetPip = childProcess.spawnSync(pythonExe, [getPipFilePath]);
    console.log(runGetPip.stdout.toString());
    console.error(runGetPip.stderr.toString());
    if (runGetPip.status!== 0) {
        console.error('Failed to install requirements');
        process.exit(1);
    }
    console.log('Successfully installed pip');
}

function runPipInstall(pythonExe, requirementsFilePath) {
    console.log(`installing python dependencies from ${requirementsFilePath}`);
    const pipInstall = childProcess.spawnSync(pythonExe, ['-m', 'pip', 'install', '-r', requirementsFilePath]);
    console.log(pipInstall.stdout.toString());
    console.error(pipInstall.stderr.toString());
    if (pipInstall.status!== 0) {
        console.error('Failed to install requirements');
        process.exit(1);
    }
    console.log(`Installed dependencies from ${requirementsFilePath} successfully`);
}

function copyToTargetDir(sourceDir, targetDir) {
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    console.log(`copied resources to ${targetDir}`)
}

function prepareTargetDir(targetDir) {
    if (fs.existsSync(targetDir)) {
        console.log(`clearing previous env dir ${targetDir}`)
        fs.rmSync(targetDir, { recursive: true });
    }
}


function main() {
    const targetDir = path.join(envDir, '..', '..', 'offline', platform, 'prototype-python-env');
    prepareTargetDir(targetDir)
    copyToTargetDir(envDir, targetDir)

    const pythonExe = existingFileOrExit(path.join(targetDir, 'python.exe'));
    const getPipFile = existingFileOrExit(path.join(targetDir, 'get-pip.py'));

    const platformSpecificRequirementsTxt = existingFileOrExit(path.join(__dirname, '..', '..','..', 'service', `requirements-${platform}.txt`));
    const requirementsTxt = existingFileOrExit(path.join(__dirname, '..', '..', '..', 'service', `requirements.txt`));
    const comfyUiRequirementsTxt = existingFileOrExit(path.join(comfyUIDIr, `requirements.txt`));
    const ggufCostomNoderequirementsTxt = existingFileOrExit(path.join(comfyUIDIr, 'custom_nodes', 'ComfyUI-GGUF', `requirements.txt`));


    installPip(pythonExe, getPipFile)
    runPipInstall(pythonExe, platformSpecificRequirementsTxt)
    runPipInstall(pythonExe, requirementsTxt)
    runPipInstall(pythonExe, comfyUiRequirementsTxt)
    runPipInstall(pythonExe, ggufCostomNoderequirementsTxt)
}

main();
