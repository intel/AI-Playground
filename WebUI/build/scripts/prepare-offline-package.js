// Usage: node fetch-python-package-resources.js --conda_env_dir=$DIR
const https = require('https')
const fs = require('fs')
const path = require('path')
const { HttpsProxyAgent } = require('https-proxy-agent')
const childProcess = require('child_process')

const argv = require('minimist')(process.argv.slice(2))
console.log('argv:', argv)

const condaEnvDirArg = argv.conda_env_dir

if (!condaEnvDirArg) {
  console.error(
    'Usage: npm run prepare-offline-package:win -- --conda_env_dir=$DIR\n',
  )
  process.exit(1)
}

function createOfflinePackage() {
    // run powershell script to create offline package
    const scriptPath = path.join(__dirname,  '../../../offline/create-offline-package.ps1')
    const command = `powershell -ExecutionPolicy Bypass -File ${scriptPath} -conda_env_dir=${condaEnvDirArg}`
    const result = childProcess.spawnSync(command, { shell: true, stdio: 'inherit' })
    if (result.error) {
        console.error('Error executing PowerShell script:', result.error)
        process.exit(1)
    }
    if (result.status !== 0) {
        console.error('PowerShell script failed with exit code:', result.status)
        process.exit(1)
    }
    console.log('Offline package created successfully.')
}

function main() {
  createOfflinePackage()
}

main()
