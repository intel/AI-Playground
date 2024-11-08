// Usage: node prebuild.js <package_res_dir> <service_dir> <build_dir>

const fs = require('fs');
const path = require('path');

if (process.argv.length < 5) {
    console.error('Usage: node prebuild.js <package_res_dir> <service_dir> <build_dir>');
    process.exit(1);
}

const packageResDir = path.resolve(process.argv[2]);
const serviceDir = path.resolve(process.argv[3]);
const buildDir = path.resolve(process.argv[4]);

if (!fs.existsSync(packageResDir)) {
    console.error('Directory not found:', packageResDir);
    process.exit(1);
}

// remove link if already exists
const serviceLink = path.join(buildDir, 'service');
if (fs.existsSync(serviceLink)) {
    fs.unlinkSync(serviceLink);
    console.log('Removed symlink:', serviceLink);
}
// make link from service to <build_dir>/service
fs.symlinkSync(serviceDir, serviceLink, 'junction');
console.log('Created symlink:', serviceDir);

// copy 7zr.exe to <build_dir>/7zr.exe
const sevenZipExe = path.join(packageResDir, '7zr.exe');
const sevenZipDest = path.join(buildDir, '7zr.exe');
fs.copyFileSync(sevenZipExe, sevenZipDest);
console.log('Copied 7zr.exe to:', sevenZipDest);

// copy env.7z to <build_dir>/env.7z
const envArchive = path.join(packageResDir, 'env.7z');
const envArchiveDest = path.join(buildDir, 'env.7z');
fs.copyFileSync(envArchive, envArchiveDest);
console.log('Copied env.7z to:', envArchiveDest);
