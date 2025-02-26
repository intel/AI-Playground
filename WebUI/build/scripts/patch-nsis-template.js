path = require('path')
const customizedTemplate = path.resolve(__dirname, '../installSection.nsh')
const targetTemplate = path.resolve(
  __dirname,
  '../../node_modules/app-builder-lib/templates/nsis/installSection.nsh',
)
console.log(`Copying customized NSIS template ${customizedTemplate} to ${targetTemplate}`)
require('fs').copyFileSync(customizedTemplate, targetTemplate)

const addMediaOutputChangeWarningTemplate = path.resolve(__dirname, '../installUtil.nsh')
const addMediaOutputChangeWarningTargetTemplate = path.resolve(
  __dirname,
  '../../node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh',
)
console.log(
  `Copying customized NSIS template ${addMediaOutputChangeWarningTemplate} to ${addMediaOutputChangeWarningTargetTemplate} displaying now a warning to back-up media files`,
)
require('fs').copyFileSync(
  addMediaOutputChangeWarningTemplate,
  addMediaOutputChangeWarningTargetTemplate,
)
