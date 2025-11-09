const fs = require('fs');
const path = require('path');

// Standard settings that should always be included
const STANDARD_SETTINGS = [
  { name: 'prompt', type: 'string', label: 'Prompt', defaultValue: '' },
  { name: 'seed', type: 'number', label: 'Seed', defaultValue: -1 },
  { name: 'inferenceSteps', type: 'number', label: 'Inference Steps', defaultValue: 20 },
  { name: 'width', type: 'number', label: 'Width', defaultValue: 512 },
  { name: 'height', type: 'number', label: 'Height', defaultValue: 512 },
  { name: 'resolution', type: 'string', label: 'Resolution', defaultValue: '512x512' },
  { name: 'batchSize', type: 'number', label: 'Batch Size', defaultValue: 1 },
  { name: 'negativePrompt', type: 'string', label: 'Negative Prompt', defaultValue: 'nsfw' },
  { name: 'imageModel', type: 'string', label: 'Image Model', defaultValue: 'Lykon/dreamshaper-8' },
  { name: 'inpaintModel', type: 'string', label: 'Inpaint Model', defaultValue: 'Lykon/dreamshaper-8-inpainting' },
  { name: 'guidanceScale', type: 'number', label: 'Guidance Scale', defaultValue: 7 },
  { name: 'lora', type: 'string', label: 'LoRA', defaultValue: 'None' },
  { name: 'scheduler', type: 'string', label: 'Scheduler', defaultValue: 'DPM++ SDE Karras' },
  { name: 'imagePreview', type: 'boolean', label: 'Image Preview', defaultValue: true },
  { name: 'safetyCheck', type: 'boolean', label: 'Safety Check', defaultValue: true },
];

function migrateWorkflowToPreset(workflow) {
  const preset = {
    type: 'comfy',
    name: workflow.name,
    displayPriority: workflow.displayPriority ?? 0,
    tags: workflow.tags ?? [],
    backend: 'comfyui',
    category: workflow.category,
    description: workflow.description,
    requiredCustomNodes: workflow.comfyUIRequirements?.customNodes ?? [],
    requiredPythonPackages: workflow.comfyUIRequirements?.pythonPackages ?? [],
    requiredModels: workflow.comfyUIRequirements?.requiredModels ?? [],
    settings: [],
    comfyUiApiWorkflow: workflow.comfyUiApiWorkflow,
  };

  // Add all standard settings
  for (const setting of STANDARD_SETTINGS) {
    let defaultValue = workflow.defaultSettings?.[setting.name] ?? setting.defaultValue;
    const displayed = workflow.displayedSettings?.includes(setting.name) ?? false;
    const modifiable = workflow.modifiableSettings?.includes(setting.name) ?? false;

    // Parse resolution to extract width/height if needed
    if (setting.name === 'width' && workflow.defaultSettings?.resolution) {
      const [width] = workflow.defaultSettings.resolution.split('x').map(Number);
      if (!isNaN(width)) defaultValue = width;
    }
    if (setting.name === 'height' && workflow.defaultSettings?.resolution) {
      const [, height] = workflow.defaultSettings.resolution.split('x').map(Number);
      if (!isNaN(height)) defaultValue = height;
    }

    preset.settings.push({
      type: setting.type,
      label: setting.label,
      displayed,
      modifiable,
      defaultValue,
      settingName: setting.name,
    });
  }

  // Add ComfyUI-specific inputs (from the inputs array)
  if (workflow.inputs && Array.isArray(workflow.inputs)) {
    for (const input of workflow.inputs) {
      // Only add if it has nodeTitle and nodeInput (ComfyInput)
      if (input.nodeTitle && input.nodeInput) {
        preset.settings.push({
          type: input.type,
          label: input.label,
          displayed: input.displayed ?? false,
          modifiable: input.modifiable ?? false,
          defaultValue: input.defaultValue,
          nodeTitle: input.nodeTitle,
          nodeInput: input.nodeInput,
        });
      }
    }
  }

  return preset;
}

function migrateWorkflows() {
  const workflowsDir = path.join(__dirname, '../external/workflows');
  const presetsDir = path.join(__dirname, '../external/presets');

  // Ensure presets directory exists
  if (!fs.existsSync(presetsDir)) {
    fs.mkdirSync(presetsDir, { recursive: true });
  }

  // Read all workflow files
  const workflowFiles = fs.readdirSync(workflowsDir).filter(file => file.endsWith('.json'));

  console.log(`Found ${workflowFiles.length} workflow files to migrate`);

  for (const file of workflowFiles) {
    const workflowPath = path.join(workflowsDir, file);
    const presetPath = path.join(presetsDir, file);

    try {
      const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
      const workflow = JSON.parse(workflowContent);

      // Skip if already a preset (has type field)
      if (workflow.type === 'comfy') {
        console.log(`Skipping ${file} - already a preset`);
        continue;
      }

      const preset = migrateWorkflowToPreset(workflow);
      const presetJson = JSON.stringify(preset, null, 2);

      fs.writeFileSync(presetPath, presetJson, 'utf-8');
      console.log(`Migrated ${file} -> ${presetPath}`);
    } catch (error) {
      console.error(`Error migrating ${file}:`, error.message);
    }
  }

  console.log('Migration complete!');
}

migrateWorkflows();

