// Usage: node fetch-python-package-resources.js --target-dir=$DIR --conda-env-library-dir=$DIR
const https = require('https');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');


const argv = require('minimist')(process.argv.slice(2));
const targetDirArg = argv.target_dir
const condaEnvLibraryDirArg = argv.conda_env_library_dir

if (!targetDirArg || !condaEnvLibraryDirArg) {
    console.error('Usage: node fetch-python-package-resources.js --target_dir=$DIR --conda_env_library_dir=$DIR\n');
    process.exit(1);
}

const targetDir = path.resolve(targetDirArg);
const condaTargetDir = path.join(targetDir, 'conda-env-lib')
const condaEnvLibraryDir = path.resolve(condaEnvLibraryDirArg);

const embeddablePythonUrl = 'https://raw.githubusercontent.com/adang1345/PythonWindows/master/3.11.10/python-3.11.10-embed-amd64.zip';
const getPipScriptUrl = 'https://bootstrap.pypa.io/get-pip.py'
const sevenZrExeUrl = 'https://www.7-zip.org/a/7zr.exe'

function fetchFileIfNotPresent(url) {
    const expectedFilePath = path.join(targetDir, getBaseFileName(url))
    if (fs.existsSync(expectedFilePath)) {
        console.log(`omitting fetching of ${url} as ${expectedFilePath} already exists`)
    } else {
        fetchFile(url)
    }
}

function fetchFile(url) {
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
    if (!fs.existsSync(condaTargetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
}

function copyLibuvDllsIfNotPresent() {
    if (fs.existsSync(path.join(condaTargetDir, 'Library', 'bin', 'uv.dll'))) {
        console.log(`omitting fetching copying of libuvDLLs, as they already exist`)
    } else {
        if (!path.join(condaEnvLibraryDir, 'bin', 'uv.dll')) {
            console.log(`provided conda env at ${condaEnvLibraryDir} is missing uv.dll. Aborting`)
            process.exit(1);
        }
        fs.cp(condaEnvLibraryDir, path.join(condaTargetDir, 'Library'), { recursive: true }, (err) => {
            if (err) {
                console.error(err);
                console.log('Failed to copy directory');
                process.exit(1)
            } else {
                console.log('Directory copied successfully');
            }
        });
    }
}

function fetchComfyUIIfNotPresent() {
    const comfyUICloneDir = path.join(targetDir, 'ComfyUI')
    if (fs.existsSync(comfyUICloneDir)) {
        console.log(`omitting fetching of comfyUI as ${comfyUICloneDir} already exists`)
    } else {
        gitClone("https://github.com/comfyanonymous/ComfyUI.git", comfyUICloneDir)
        gitClone("https://github.com/city96/ComfyUI-GGUF.git", path.join(comfyUICloneDir, 'custom_nodes', 'ComfyUI-GGUF'))
    }
}


function gitClone(repoURL, targetDir) {
    const gitClone = childProcess.spawnSync("git", ["clone", repoURL, targetDir]);
    console.log(gitClone.stdout.toString());
    console.error(gitClone.stderr.toString());
    if (gitClone.status!== 0) {
        console.error('Failed to clone repo: ', repoURL);
        process.exit(1);
    }
    console.log('Successfully fetched: ', repoURL);
}


function main() {
    prepareTargetPath()
    fetchFileIfNotPresent(embeddablePythonUrl)
    fetchFileIfNotPresent(getPipScriptUrl)
    fetchFileIfNotPresent(sevenZrExeUrl)
    fetchComfyUIIfNotPresent()
    copyLibuvDllsIfNotPresent()
}

main()
