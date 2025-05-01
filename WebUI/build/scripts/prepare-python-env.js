// Usage: node prepare-python-env.js --target_dir=$DIR ---env_resources_dir=$DIR

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const childProcess = require('child_process')

const argv = require('minimist')(process.argv.slice(2))
const buildResourcesDirArg = argv.build_resources_dir
const targetDirArg = argv.target_dir

if (!buildResourcesDirArg || !targetDirArg) {
  console.error('Usage: node prepare-python-env.js --target_dir=$DIR ---env_resources_dir=$DIR\n')
  process.exit(1)
}

const envResourcesDir = path.resolve(buildResourcesDirArg)
const targetDir = path.resolve(targetDirArg)

const envResourcesFiles = fs.readdirSync(envResourcesDir)
const pythonEmbedZipFile = path.join(
  envResourcesDir,
  envResourcesFiles.find((fileName) => {
    return fileName.startsWith('python-3.12.10') && fileName.endsWith('.zip')
  }),
)
const condaDir = path.join(
  envResourcesDir,
  envResourcesFiles.find((fileName) => {
    return fileName.includes('conda')
  }),
)
const condaBinDir = path.join(condaDir, 'Library', 'bin')
const getPipFile = path.join(envResourcesDir, 'get-pip.py')

function verifyFilesExist() {
  console.log('verifying all required files exist.')
  if (!fs.existsSync(pythonEmbedZipFile)) {
    console.error('File not found:', pythonEmbedZipFile)
    process.exit(1)
  }

  if (!fs.existsSync(getPipFile)) {
    console.error('File not found:', getPipFile)
    process.exit(1)
  }

  // check whether libuv has been installed in the conda env
  const uvDll = path.join(condaBinDir, 'uv.dll')
  if (!fs.existsSync(uvDll)) {
    console.error('uv.dll not found in reference conda env:', uvDll)
    process.exit(1)
  }
  console.log('all required files exist.')

  if (!fs.existsSync(targetDir)) {
    console.log(`Creating missing target dir: ${targetDir}`)
    fs.mkdirSync(targetDir, { recursive: true })
  }
}

function preparePythonEnvDir(pyEnvTargetPath) {
  if (fs.existsSync(pyEnvTargetPath)) {
    console.warn('Removing existing python env directory:', pyEnvTargetPath)
    fs.rmSync(pyEnvTargetPath, { recursive: true })
  }
}

function createPythonEnvFromEmbedabblePythonZip(targetDir, pythonEmbedZipFile) {
  preparePythonEnvDir(targetDir)
  console.log('Creating python env.')
  const pythonEmbed = new AdmZip(pythonEmbedZipFile)
  pythonEmbed.extractAllTo(targetDir, true)
  console.log('Extracted embeddable python to:', targetDir)

  // configure path of python env:
  console.log('Patching path of python environment')

  // Find the Python version by looking for python*._pth file
  const files = fs.readdirSync(targetDir)
  const pthFilePattern = /^python(\d+)\._pth$/
  let pythonVersion = null
  let pthFileName = null

  for (const file of files) {
    const match = file.match(pthFilePattern)
    if (match) {
      pythonVersion = match[1]
      pthFileName = file
      break
    }
  }

  if (!pythonVersion || !pthFileName) {
    console.error('Could not find python*._pth file in the target directory')
    process.exit(1)
  }

  console.log(`Found Python version: ${pythonVersion} (${pthFileName})`)

  const pthFile = path.join(targetDir, pthFileName)
  const pthContent = `
python${pythonVersion}.zip
.

# Uncomment to run site.main() automatically
import site
`
  fs.writeFileSync(pthFile, pthContent)
  console.log(`Patched Python paths in ${pthFileName}`)

  console.log('Copying get-pip.py')
  const getPipDest = path.join(targetDir, 'get-pip.py')
  fs.copyFileSync(getPipFile, getPipDest)
  console.log('Copied get-pip.py to:', getPipDest)

  console.log('Installing pip')
  const pythonExe = path.join(targetDir, 'python.exe')
  const pipInstallCmd = `"${pythonExe}" "${getPipDest}"`
  childProcess.execSync(pipInstallCmd)
  console.log('Installed pip')

  console.log('Installing uv')
  const pipInstallUvCmd = `"${pythonExe}" -m pip install uv`
  childProcess.execSync(pipInstallUvCmd)
  console.log('Installed uv')

  return targetDir
}

function patchCondaDllsIntoPythonEnv(pyEnvDirPath, condaBinDir) {
  console.log('Copying conda dlls to python env')

  for (const condaDll of fs.readdirSync(condaBinDir)) {
    const src = path.join(condaBinDir, condaDll)
    const dest = path.join(pyEnvDirPath, condaDll)
    fs.copyFileSync(src, dest)
  }
  console.log('Copied conda dlls into:', pyEnvDirPath)
}

function prepareTargetDir(targetDir) {
  if (fs.existsSync(targetDir)) {
    console.log(`clearing previous env dir ${targetDir}`)
    fs.rmSync(targetDir, { recursive: true })
  }
}

function main() {
  verifyFilesExist()
  prepareTargetDir(targetDir)
  createPythonEnvFromEmbedabblePythonZip(targetDir, pythonEmbedZipFile)
  patchCondaDllsIntoPythonEnv(targetDir, condaBinDir)
}

main()
