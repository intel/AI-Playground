path = require('path')
const customizedTemplate = path.resolve(__dirname, '../installSection.nsh')
const targetTemplate = path.resolve(
  __dirname,
  '../../node_modules/app-builder-lib/templates/nsis/installSection.nsh',
)
console.log(`Copying customized NSIS template ${customizedTemplate} to ${targetTemplate}`)
require('fs').copyFileSync(customizedTemplate, targetTemplate)
