// Usage: node check-i18n.js --i18n-dir=$DIR

const fs = require('fs')
const path = require('path')
const argv = require('minimist')(process.argv.slice(2))

const i18nDirArg = argv.i18n_dir
if (!i18nDirArg) {
  console.error('Usage: node check-i18n.js --i18n-dir=$DIR\n')
  process.exit(1)
}

const i18nDir = path.resolve(i18nDirArg)
const enData = JSON.parse(fs.readFileSync(path.join(i18nDir, 'en-US.json')))
const keys = Object.keys(enData)

const langs = fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json'))
const missingKeys = {}
const unusedKeys = {}

langs.forEach((lang) => {
  const data = JSON.parse(fs.readFileSync(path.join(i18nDir, lang)))
  keys.forEach((key) => {
    if (!data[key]) {
      if (!missingKeys[lang]) {
        missingKeys[lang] = []
      }
      missingKeys[lang].push(key)
    }
  })

  Object.keys(data).forEach((key) => {
    if (!keys.includes(key)) {
      if (!unusedKeys[lang]) {
        unusedKeys[lang] = []
      }
      unusedKeys[lang].push(key)
    }
  })

  if (missingKeys[lang]) {
    // print pretty
    // 5 entries per row
    const entriesPerRow = 5
    const entries = missingKeys[lang]
    const rows = []
    for (let i = 0; i < entries.length; i += entriesPerRow) {
      rows.push(entries.slice(i, i + entriesPerRow).join(', '))
    }
    console.log(`${missingKeys[lang].length} missing keys for ${lang}:`)
    console.log(`  ${rows.join('\n  ')}`)
    console.log()
  }
  if (unusedKeys[lang]) {
    console.log(`${unusedKeys[lang].length} unused keys for ${lang}:`)
    console.log(`  ${unusedKeys[lang].join(', ')}`)
    console.log()
  }
})
