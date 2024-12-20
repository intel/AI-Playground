// Usage: node pack-python.js <output_package_res_dir> <python_embed_zip> <get_pip_file> <reference_conda_env>

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

if (process.argv.length < 6) {
    console.error('Usage: node pack-python.js <output_package_res_dir> <python_embed_zip> <get_pip_file> <reference_conda_env>');
    process.exit(1);
}

const packageResDir = path.resolve(process.argv[2]);
const pythonEmbedZip = path.resolve(process.argv[3]);
const getPipFile = path.resolve(process.argv[4]);
const referenceCondaEnv = path.resolve(process.argv[5]);

if (!fs.existsSync(pythonEmbedZip)) {
    console.error('File not found:', pythonEmbedZip);
    process.exit(1);
}

// unzip python embed
const pythonEmbed = new AdmZip(pythonEmbedZip);
const pythonEmbedDir = path.join(__dirname, 'env');
if (fs.existsSync(pythonEmbedDir)) {
    console.warn("Removing existing python env directory:", pythonEmbedDir);
    fs.rmSync(pythonEmbedDir, { recursive: true });
}
pythonEmbed.extractAllTo(pythonEmbedDir, true);
console.log('Extracted python embed to:', pythonEmbedDir);

// copy get-pip.py
const getPipDest = path.join(pythonEmbedDir, 'get-pip.py');
fs.copyFileSync(getPipFile, getPipDest);
console.log('Copied get-pip.py to:', getPipDest);

// execute env/python.exe get-pip.py
const spawnSync = require('child_process').spawnSync;
const getpip = spawnSync(path.join(pythonEmbedDir, 'python.exe'), [getPipDest]);
console.log(getpip.stdout.toString());
console.error(getpip.stderr.toString());
if (getpip.status !== 0) {
    console.error('Failed to run get-pip.py');
    process.exit(1);
}

// check whether libuv has been installed in the reference conda env
const condaBinDir = path.join(referenceCondaEnv, 'Library', 'bin');
const uvDll = path.join(condaBinDir, 'uv.dll');
if (!fs.existsSync(uvDll)) {
    console.error('libuv.dll not found in reference conda env:', uvDll);
    process.exit(1);
}

// copy conda dlls from Library/bin to env
const condaDlls = fs.readdirSync(condaBinDir);
for (const condaDll of condaDlls) {
    const src = path.join(condaBinDir, condaDll);
    const dest = path.join(pythonEmbedDir, condaDll);
    fs.copyFileSync(src, dest);
    console.log('Copied conda dll to:', dest);
}

// write custom content to env/python311._pth
const pthFile = path.join(pythonEmbedDir, 'python311._pth');
const pthContent = `
python311.zip
.
../service

# Uncomment to run site.main() automatically
import site
`;
fs.writeFileSync(pthFile, pthContent);
console.log('Wrote custom content to:', pthFile);

// 7z compress the env directory
// create folder if not exists
if (!fs.existsSync(packageResDir)) {
    fs.mkdirSync(packageResDir, { recursive: true });
}
const sevenZipExe = path.join(packageResDir, '7zr.exe');
if (!fs.existsSync(sevenZipExe)) {
    console.error('7zr.exe not found:', sevenZipExe);
    process.exit(1);
}
const outputFile = path.join(packageResDir, 'env.7z');
if (fs.existsSync(outputFile)) {
    console.warn("Removing existing 7z file:", outputFile);
    fs.rmSync(outputFile);
}
const zip = spawnSync(sevenZipExe, ['a', outputFile, pythonEmbedDir]);
console.log(zip.stdout.toString());
console.error(zip.stderr.toString());
if (zip.status !== 0) {
    console.error('Failed to compress env directory');
    process.exit(1);
}

console.log('Compressed env directory to:', outputFile);
