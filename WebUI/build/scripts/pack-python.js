// Usage: node pack-python.js <python_package_res_dir> <target_res_dir>

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const childProcess = require('child_process');

if (process.argv.length < 3) {
    console.error('Usage: node pack-python.js <python_package_res_dir> <target_res_dir>');
    process.exit(1);
}

const pythonPackageResourcesDir = path.resolve(process.argv[2]);
const targetResDir = path.resolve(process.argv[3]);
const webUIBuildDir = path.join(__dirname, '..', '..');
const pythonEmbedDir = path.join(webUIBuildDir, '..',  'env');

const packageResourceFiles = fs.readdirSync(pythonPackageResourcesDir);
const pythonEmbedZipFile = path.join(pythonPackageResourcesDir, packageResourceFiles.find((fileName) => { return fileName.startsWith('python') && fileName.endsWith('.zip') }));
const condaDir = path.join(pythonPackageResourcesDir, packageResourceFiles.find((fileName) => { return fileName.includes('conda') }));
const condaBinDir = path.join(condaDir, 'Library', 'bin');
const getPipFile = path.join(pythonPackageResourcesDir, 'get-pip.py');
const sevenZipExe = path.join(pythonPackageResourcesDir, '7zr.exe')
const sevenZipBinary = () => {
    if (childProcess.execSync('which 7z').toString().includes('7z')) {
        return "7z";
    } else if (fs.existsSync(sevenZipExe)) {
        return sevenZipExe;
    } else {
        console.error('No 7z executable found');
        process.exit(1);
    }
}

function verifyFilesExist() {
    console.log('verifying all required files exist.')
    if (!fs.existsSync(pythonEmbedZipFile)) {
        console.error('File not found:', pythonEmbedZipFile);
        process.exit(1);
    }

    if (!fs.existsSync(getPipFile)) {
        console.error('File not found:', getPipFile);
        process.exit(1);
    }

    if (!fs.existsSync(sevenZipExe)) {
        console.error('File not found:', sevenZipExe);
        process.exit(1);
    }

    // check whether libuv has been installed in the conda env
    const uvDll = path.join(condaBinDir, 'uv.dll');
    if (!fs.existsSync(uvDll)) {
        console.error('libuv.dll not found in reference conda env:', uvDll);
        process.exit(1);
    }
    console.log('all required files exist.')

    if (!fs.existsSync(targetResDir)) {
        console.log(`Creating missing target dir: ${targetResDir}`)
        fs.mkdirSync(targetResDir, { recursive: true });
    }
}

function preparePythonEnvDir(pyEnvTargetPath) {
    if (fs.existsSync(pyEnvTargetPath)) {
        console.warn("Removing existing python env directory:", pyEnvTargetPath);
        fs.rmSync(pyEnvTargetPath, {recursive: true});
    }
}

function createPythonEnvFromEmbedabblePythonZip() {
    const pyEnvTargetPath = pythonEmbedDir
    preparePythonEnvDir(pyEnvTargetPath);
    console.log('Creating python env.')
    const pythonEmbed = new AdmZip(pythonEmbedZipFile);
    pythonEmbed.extractAllTo(pyEnvTargetPath, true);
    console.log('Extracted embeddable python to:', pyEnvTargetPath);

    // configure path of python env:
    console.log('Patching path of python environment');
    const pthFile = path.join(pyEnvTargetPath, 'python311._pth');
    const pthContent = `
python311.zip
.
../service

# Uncomment to run site.main() automatically
import site
`;
    fs.writeFileSync(pthFile, pthContent);
    console.log('patched python paths');

    console.log('Copying get-pip.py');
    const getPipDest = path.join(pyEnvTargetPath, 'get-pip.py');
    fs.copyFileSync(getPipFile, getPipDest);
    console.log('Copied get-pip.py to:', getPipDest);
    return pyEnvTargetPath;
}

function patchCondaDllsIntoPythonEnv(pyEnvDirPath) {
    console.log('Copying conda dlls to python env');

    for (const condaDll of fs.readdirSync(condaBinDir)) {
        const src = path.join(condaBinDir, condaDll);
        const dest = path.join(pyEnvDirPath, condaDll);
        fs.copyFileSync(src, dest);
    }
    console.log('Copied conda dlls into:', pyEnvDirPath);
}

function compressPythonEnvDirectory(pyEnvDirPath) {
    const outputFile = path.join(pythonEmbedDir, 'env.7z');
    console.log(`7zipping env directory into ${outputFile}`)
    if (fs.existsSync(outputFile)) {
        console.warn("Removing existing 7z file:", outputFile);
        fs.rmSync(outputFile);
    }

    const zip = childProcess.spawnSync(sevenZipBinary(), ['a', outputFile, pyEnvDirPath]);
    console.log(zip.stdout.toString());
    console.error(zip.stderr.toString());
    if (zip.status !== 0) {
        console.error('Failed to compress env directory');
        process.exit(1);
    }

    console.log('Compressed env directory to:', outputFile);
    return outputFile
}

function copyToTargetDir(filePaths) {
    for (const sourceFilePath of filePaths) {
        const destinationPath = path.join(targetResDir, path.basename(sourceFilePath));
        fs.copyFileSync(sourceFilePath, destinationPath);
        console.log(`copied ${path.basename(sourceFilePath)} into ${targetResDir}`)
    }
}

function main() {
    verifyFilesExist();
    const pyEnvPath = createPythonEnvFromEmbedabblePythonZip();
    patchCondaDllsIntoPythonEnv(pyEnvPath);
    const sevenZippedPyenv = compressPythonEnvDirectory(pyEnvPath);
    copyToTargetDir([sevenZippedPyenv, sevenZipExe]);
}

main();
