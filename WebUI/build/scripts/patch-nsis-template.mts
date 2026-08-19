#!/usr/bin/env node
/**
 * Patch NSIS templates for AI Playground installer
 * Applies custom NSIS templates to electron-builder
 * Uses fixed directory structure and proper error handling
 */

import { existsSync, copyFileSync } from 'fs'
import { join, normalize } from 'path'
import { getBuildPaths, getTargetPlatform } from './build-paths.mts'

// Fixed directory structure
const buildPaths = getBuildPaths(getTargetPlatform())
const { webUIBuildDir: WEBUI_BUILD_DIR, webUINodeModulesDir: WEBUI_NODE_MODULES_DIR } = buildPaths
const TEMPLATES_DIR = WEBUI_BUILD_DIR

interface TemplateConfig {
  source: string
  target: string
  description: string
}

/**
 * Get template configurations
 */
function getTemplateConfigs(): TemplateConfig[] {
  return [
    {
      source: join(TEMPLATES_DIR, 'installSection.nsh'),
      target: join(
        WEBUI_NODE_MODULES_DIR,
        'app-builder-lib',
        'templates',
        'nsis',
        'installSection.nsh',
      ),
      description: 'Main installation section template',
    },
    {
      source: join(TEMPLATES_DIR, 'installUtil.nsh'),
      target: join(
        WEBUI_NODE_MODULES_DIR,
        'app-builder-lib',
        'templates',
        'nsis',
        'include',
        'installUtil.nsh',
      ),
      description: 'Installation utilities template with media backup warning',
    },
  ]
}

/**
 * Verify template files exist
 */
function verifyTemplateFiles(configs: TemplateConfig[]): void {
  console.log('🔍 Verifying template files...')
  for (const config of configs) {
    if (!existsSync(config.source)) {
      console.error(`❌ Source template not found: ${config.source}`)
      console.error(`   Description: ${config.description}`)
      process.exit(1)
    }
    console.log(`✅ Found template: ${config.source}`)
  }

  // Verify webUINodeModules directory exists
  if (!existsSync(WEBUI_NODE_MODULES_DIR)) {
    console.error(`❌ node_modules directory not found: ${WEBUI_NODE_MODULES_DIR}`)
    console.error('Please run "npm install" first')
    process.exit(1)
  }

  console.log('✅ All template files verified')
}

/**
 * Copy template file with error handling
 */
function copyTemplate(config: TemplateConfig): void {
  try {
    console.log(`📋 Copying template: ${config.description}`)
    console.log(`   From: ${config.source}`)
    console.log(`   To: ${config.target}`)

    copyFileSync(config.source, config.target)
    console.log(`✅ Successfully copied: ${config.description}`)
  } catch (error) {
    console.error(`❌ Failed to copy template: ${config.description}`)
    console.error(`   Error: ${error}`)
    process.exit(1)
  }
}

/**
 * Verify target directories exist
 */
function verifyTargetDirectories(configs: TemplateConfig[]): void {
  console.log('🔍 Verifying target directories...')

  for (const config of configs) {
    const targetDir = config.target

    if (!existsSync(targetDir)) {
      console.error(`❌ Target directory not found: ${targetDir}`)
      console.error(`   For template: ${config.description}`)
      console.error('Please ensure electron-builder is properly installed')
      process.exit(1)
    }
  }

  console.log('✅ All target directories verified')
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  console.log('🚀 Starting NSIS template patching...')
  console.log(`📂 Templates directory: ${TEMPLATES_DIR}`)
  console.log(`📂 Node modules directory: ${WEBUI_NODE_MODULES_DIR}`)

  try {
    // Get template configurations
    const templateConfigs = getTemplateConfigs()

    // Verify source template files exist
    verifyTemplateFiles(templateConfigs)

    // Verify target directories exist
    verifyTargetDirectories(templateConfigs)

    // Copy all templates
    for (const config of templateConfigs) {
      copyTemplate(config)
    }

    console.log('✅ NSIS template patching completed successfully!')
    console.log('📦 Electron-builder will now use the customized NSIS templates')
  } catch (error) {
    console.error('❌ Fatal error during NSIS template patching:', error)
    process.exit(1)
  }
}

// Execute main function
if (normalize(import.meta.url) === normalize(`file://${process.argv[1]}`)) {
  main().catch((error) => {
    console.error('❌ Unhandled error:', error)
    process.exit(1)
  })
}
