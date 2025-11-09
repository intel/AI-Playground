const fs = require('fs')
const path = require('path')

// Mapping of preset names to image files in assets/image
const presetImageMapping = {
  // Image generation presets
  'Colorize': 'colorize.png',
  'CopyFace': 'copyface.png',
  'FaceSwap-HD': 'faceswap.png',
  'Edit By Prompt': 'editbyprompt.png',
  'Flux.1-Schnell Med Quality': 'flux_schnell.png',
  'Flux.1-Schnell High Quality': 'flux_schnell.png',
  'SketchToPhoto-HD-Draft': 'draft.png',
  'SketchToPhoto-HD-Quality': 'sketchtophoto.png',
  'SD1.5 (old)': null, // No specific image, will use backend default
  'SDXL': null, // No specific image, will use backend default
  
  // Chat presets
  'llamaCPP Fast': 'llamacpp.png',
  'Ollama Local': 'ollama.png',
  'OpenVINO Default': 'openvino.png',
  'OpenVINO with RAG': 'openvino.png',
}

// Preset name to filename mapping (for cases where names don't match exactly)
const presetNameToFilename = {
  'Colorize': 'Colorize',
  'CopyFace': 'CopyFace',
  'FaceSwap-HD': 'FaceSwapHD',
  'Edit By Prompt': 'EditByPrompt',
  'Flux.1-Schnell Med Quality': 'fluxQ4',
  'Flux.1-Schnell High Quality': 'fluxQ8',
  'SketchToPhoto-HD-Draft': 'SketchToPhotoHD-Draft',
  'SketchToPhoto-HD-Quality': 'SketchToPhotoHD-Quality',
  'SD1.5 (old)': 'sd15',
  'SDXL': 'sdxl',
  'llamaCPP Fast': 'llamacpp-fast',
  'Ollama Local': 'ollama-local',
  'OpenVINO Default': 'openvino-default',
  'OpenVINO with RAG': 'openvino-rag',
}

const assetsImageDir = path.join(__dirname, '../src/assets/image')
const presetsDir = path.join(__dirname, '../external/presets')

function migratePresetImages() {
  console.log('Starting preset image migration...')
  
  if (!fs.existsSync(assetsImageDir)) {
    console.error(`Assets image directory not found: ${assetsImageDir}`)
    return
  }
  
  if (!fs.existsSync(presetsDir)) {
    console.error(`Presets directory not found: ${presetsDir}`)
    return
  }
  
  // Read all preset files
  const presetFiles = fs.readdirSync(presetsDir).filter(file => file.endsWith('.json'))
  
  let migratedCount = 0
  let skippedCount = 0
  
  for (const presetFile of presetFiles) {
    try {
      const presetPath = path.join(presetsDir, presetFile)
      const presetContent = fs.readFileSync(presetPath, 'utf-8')
      const preset = JSON.parse(presetContent)
      
      const presetName = preset.name
      const imageFileName = presetImageMapping[presetName]
      
      if (!imageFileName) {
        console.log(`No image mapping found for preset: ${presetName}`)
        skippedCount++
        continue
      }
      
      const sourceImagePath = path.join(assetsImageDir, imageFileName)
      
      if (!fs.existsSync(sourceImagePath)) {
        console.warn(`Source image not found: ${sourceImagePath}`)
        skippedCount++
        continue
      }
      
      // Get the target filename (preset filename without .json extension)
      const presetFilename = presetNameToFilename[presetName] || path.basename(presetFile, '.json')
      const sourceExt = path.extname(imageFileName)
      const targetImagePath = path.join(presetsDir, `${presetFilename}${sourceExt}`)
      
      // Check if target already exists
      if (fs.existsSync(targetImagePath)) {
        console.log(`Image already exists for preset ${presetName}, skipping: ${targetImagePath}`)
        skippedCount++
        continue
      }
      
      // Copy the image file
      fs.copyFileSync(sourceImagePath, targetImagePath)
      console.log(`Migrated image for preset "${presetName}": ${imageFileName} -> ${path.basename(targetImagePath)}`)
      migratedCount++
      
    } catch (error) {
      console.error(`Error processing preset file ${presetFile}:`, error)
      skippedCount++
    }
  }
  
  console.log(`\nMigration complete!`)
  console.log(`  Migrated: ${migratedCount} images`)
  console.log(`  Skipped: ${skippedCount} presets`)
}

if (require.main === module) {
  migratePresetImages()
}

module.exports = { migratePresetImages }

