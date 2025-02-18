// Usage: node fetch-python-package-resources.js --target-dir=$DIR --conda_env_dir=$DIR
const https = require('https')
const fs = require('fs')
const path = require('path')
const { HttpsProxyAgent } = require('https-proxy-agent')

const argv = require('minimist')(process.argv.slice(2))
const targetDirArg = argv.target_dir
const condaEnvDirArg = argv.conda_env_dir

if (!targetDirArg || !condaEnvDirArg) {
  console.error(
    'Usage: node fetch-python-package-resources.js --target_dir=$DIR --conda_env_dir=$DIR\n',
  )
  process.exit(1)
}

const targetDir = path.resolve(targetDirArg)
const condaTargetDir = path.join(targetDir, 'conda-env-lib')
const condaEnvLibraryDir = path.resolve(path.join(condaEnvDirArg, 'Library'))

const embeddablePythonUrl =
  'https://raw.githubusercontent.com/adang1345/PythonWindows/master/3.11.10/python-3.11.10-embed-amd64.zip'
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
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  const options = proxy ? { agent: new HttpsProxyAgent(proxy) } : {}
  https
    .get(url, options, (response) => {
      const filePath = path.join(targetDir, getBaseFileName(url))
      const file = fs.createWriteStream(filePath)
      response.pipe(file)

      file.on('finish', () => {
        file.close()
        console.log(`Downloaded ${filePath} successfully!`)
      })
    })
    .on('error', (err) => {
      console.error(`Error downloading ${url}: ${err}`)
    })
}

function getBaseFileName(url) {
  const urlPathSegments = url.split('/')
  const baseFileName = urlPathSegments[urlPathSegments.length - 1]
  return baseFileName
}

function prepareTargetPath() {
  if (!fs.existsSync(condaTargetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }
}

function copyLibuvDllsIfNotPresent() {
  if (fs.existsSync(path.join(condaTargetDir, 'Library', 'bin', 'uv.dll'))) {
    console.log(`omitting fetching copying of libuv DLLs, as they already exist`)
  } else {
    if (!path.join(condaEnvLibraryDir, 'bin', 'uv.dll')) {
      console.log(`provided conda env at ${condaEnvLibraryDir} is missing uv.dll. Aborting`)
      process.exit(1)
    }
    fs.cp(condaEnvLibraryDir, path.join(condaTargetDir, 'Library'), { recursive: true }, (err) => {
      if (err) {
        console.error(err)
        console.log('Failed to copy directory')
        process.exit(1)
      } else {
        console.log('Directory copied successfully')
      }
    })
  }
}

function main() {
  prepareTargetPath()
  fetchFileIfNotPresent(embeddablePythonUrl)
  fetchFileIfNotPresent(getPipScriptUrl)
  fetchFileIfNotPresent(sevenZrExeUrl)
  copyLibuvDllsIfNotPresent()
}

main()
