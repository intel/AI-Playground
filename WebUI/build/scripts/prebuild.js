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

// Copy all files under package_res_dir to build_dir
const files = fs.readdirSync(packageResDir);
for (const file of files) {
    const src = path.join(packageResDir, file);
    const dest = path.join(buildDir, file);
    fs.copyFileSync(src, dest);
    console.log('Copied:', src, 'to:', dest);
}

// check 7zr.exe exists
const sevenZipExe = path.join(buildDir, '7zr.exe');
if (!fs.existsSync(sevenZipExe)) {
    console.error('7zr.exe not found:', sevenZipExe);
    process.exit(1);
}

// check there's at least one .7z file in build_dir
const archives = fs.readdirSync(buildDir).filter(f => f.endsWith('.7z'));
if (archives.length === 0) {
    console.error('No .7z file found in:', buildDir);
    process.exit(1);
}
