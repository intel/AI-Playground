// Usage: node provide-electron-build-resources.js --build_resources_dir=$DIR --python_env_dir=$DIR ---backend_dir=$DIR --target_dir=$DIR

const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const argv = require('minimist')(process.argv.slice(2))
const buildResourcesDirArg = argv.build_resources_dir
const pythonEnvDirArg = argv.python_env_dir
const aiBackendDirArg = argv.backend_dir
const llamaCppBackendDirArg = argv.llamacpp_dir
const targetDirectoryArg = argv.target_dir

if (
  !buildResourcesDirArg ||
  !pythonEnvDirArg ||
  !aiBackendDirArg ||
  !targetDirectoryArg ||
  !llamaCppBackendDirArg
) {
  console.error(
    'Usage: node provide-electron-build-resources.js --build_resources_dir=$DIR --python_env_dir=$DIR --backend_dir=$DIR --llamacpp_dir=$DIR --target_dir=$DIR\n',
  )
  process.exit(1)
}

const buildResourcesDir = path.resolve(buildResourcesDirArg)
const pythenEnvDir = path.resolve(pythonEnvDirArg)
const backendDir = path.resolve(aiBackendDirArg)
const llamaCppBackendDir = path.resolve(llamaCppBackendDirArg)
const targetDir = path.resolve(targetDirectoryArg)

function symlinkDir(dir, target) {
  // remove link if already exists
  if (fs.existsSync(target)) {
    fs.unlinkSync(target)
    console.log('Removed symlink:', target)
  }
  // make link from service to <build_dir>/service
  fs.symlinkSync(dir, target, 'junction')
  console.log('Created symlink:', dir)
}

function zipPythonEnv(sevenZipExe, pythonEnvDir, targetPath) {
  console.log(`zipping ${pythonEnvDir} to ${targetPath}`)

  const zip = childProcess.spawnSync(sevenZipExe, ['a', targetPath, pythonEnvDir])
  console.log(zip.stdout.toString())
  console.error(zip.stderr.toString())
  if (zip.status !== 0) {
    console.error('Failed to compress offline env directory')
    process.exit(1)
  }

  console.log('Offline env has been compressed to:', targetPath)
}

function copyFiles(targetDir, ...files) {
  for (const file of files) {
    fs.copyFileSync(file, path.join(targetDir, path.basename(file)))
    console.log('Copied:', file, 'to:', path.join(targetDir, path.basename(file)))
  }
}

function clearPreviousZip(zipFilePath) {
  if (fs.existsSync(zipFilePath)) {
    console.log('Removing previous zip file:', zipFilePath)
    fs.rmSync(zipFilePath, { recursive: true })
  }
}

function main() {
  const sevenZipExe = path.join(buildResourcesDir, '7zr.exe')

  clearPreviousZip(path.join(targetDir, `prototype-python-env.7z`))
  zipPythonEnv(sevenZipExe, pythenEnvDir, path.join(targetDir, `prototype-python-env.7z`))

  symlinkDir(backendDir, path.join(targetDir, 'service'))
  symlinkDir(llamaCppBackendDir, path.join(targetDir, 'LlamaCpp'))
  copyFiles(targetDir, sevenZipExe)
}

main()
