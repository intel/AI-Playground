// Usage: node pack-offline.js <package_res_dir> <platform>

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

if (process.argv.length < 4) {
    console.error('Usage: node pack-offline.js <package_res_dir> <platform>');
    process.exit(1);
}

const packageResDir = path.resolve(process.argv[2]);
const platform = process.argv[3];

if (!fs.existsSync(packageResDir)) {
    console.error('Directory not found:', packageResDir);
    process.exit(1);
}

const sevenZipExe = path.join(packageResDir, '7zr.exe');
if (!fs.existsSync(sevenZipExe)) {
    console.error('7zr.exe not found:', sevenZipExe);
    process.exit(1);
}

const baseEnvArchive = path.join(packageResDir, 'env.7z');
if (!fs.existsSync(baseEnvArchive)) {
    console.error('env.7z not found:', baseEnvArchive);
    process.exit(1);
}
const workDir = path.join(__dirname, `env-${platform}`);
if (fs.existsSync(workDir)) {
    console.warn("Removing existing offline env directory:", workDir);
    fs.rmSync(workDir, { recursive: true });
}

const spawnSync = require('child_process').spawnSync;
const unzip = spawnSync(sevenZipExe, ['x', baseEnvArchive, `-o${workDir}`]);
console.log(unzip.stdout.toString());
console.error(unzip.stderr.toString());
if (unzip.status !== 0) {
    console.error('Failed to extract env.7z');
    process.exit(1);
}

const offlineEnvDir = path.join(workDir, 'env');
const pythonExe = path.join(offlineEnvDir, 'python.exe');
if (!fs.existsSync(pythonExe)) {
    console.error('python.exe not found:', pythonExe);
    process.exit(1);
}

const requirementsTxt = path.join(__dirname, '..', '..', 'service', `requirements-${platform}.txt`);
if (!fs.existsSync(requirementsTxt)) {
    console.error('requirements.txt not found:', requirementsTxt);
    process.exit(1);
}

const spawn = require('child_process').spawn;
const pipInstall = spawn(pythonExe, ['-m', 'pip', 'install', '-r', requirementsTxt], { cwd: offlineEnvDir });
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

    const offlineEnvArchive = path.join(packageResDir, `env-offline-${platform}.7z`);
    const zip = spawnSync(sevenZipExe, ['a', offlineEnvArchive, offlineEnvDir]);
    console.log(zip.stdout.toString());
    console.error(zip.stderr.toString());
    if (zip.status !== 0) {
        console.error('Failed to compress offline env directory');
        process.exit(1);
    }

    console.log('Offline env has been created successfully:', offlineEnvArchive);
});
