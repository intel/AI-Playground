// Usage: node fetch-python-package-resources.js <target_dir>
const https = require('https');
const fs = require('fs');
const path = require('path');


if (process.argv.length < 3) {

    console.error('Usage: fetch-python-package-resources.js <target_dir>');
    process.exit(1);
}

const targetDir = path.resolve(process.argv[2]);

const embeddablePythonUrl = 'https://raw.githubusercontent.com/adang1345/PythonWindows/master/3.11.10/python-3.11.10-embed-amd64.zip';
const getPipScriptUrl = 'https://bootstrap.pypa.io/get-pip.py'
const sevenZrExeUrl = 'https://www.7-zip.org/a/7zr.exe'

function fetchFileIfNotPresent(url, targetDir) {
    const expectedFilePath = path.join(targetDir, getBaseFileName(url))
    if (fs.existsSync(expectedFilePath)) {
        console.log(`omitting fetching of ${url} as ${expectedFilePath} already exists`)
    } else {
        fetchFile(url, targetDir)
    }
}

function fetchFile(url, targetDir) {
    https.get(url, (response) => {
        const filePath = path.join(targetDir, getBaseFileName(url))
        const file = fs.createWriteStream(filePath);
        response.pipe(file);

        file.on('finish', () => {
            file.close();
            console.log(`Downloaded ${filePath} successfully!`);
        });
    }).on('error', (err) => {
        console.error(`Error downloading ${embeddablePythonUrl}: ${err}`);
    });
}


function getBaseFileName(url) {
        const urlPathSegments = url.split('/');
        const baseFileName = urlPathSegments[urlPathSegments.length - 1]
        return baseFileName;
}

function prepareTargetPath() {
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
}

function provideLibuvDlls() {
    console.error("provideLibuvDlls is currently only mocked")
    console.error(`please simlink to conda virtual env into ${targetDir} manually`)
}

function main() {
    prepareTargetPath()
    fetchFileIfNotPresent(embeddablePythonUrl, targetDir)
    fetchFileIfNotPresent(getPipScriptUrl, targetDir)
    fetchFileIfNotPresent(sevenZrExeUrl, targetDir)
    provideLibuvDlls()
}

main()
