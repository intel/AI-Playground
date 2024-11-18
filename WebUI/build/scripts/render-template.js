const fs = require('fs');
const path = require('path');
const buildDir = path.join(__dirname, '..')
// Function to render the template with environment variables
function renderTemplate(templatePath, outputPath, variables) {
  // Read the template content
  fs.readFile(templatePath, 'utf8', (err, data) => {
    if (err) {
      console.error(`Error reading template: ${err}`);
      return;
    }

    // Replace placeholders with environment variable values
    let renderedData = data;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = new RegExp(`\\$\\{${key}\\}`, 'g');
      renderedData = renderedData.replace(placeholder, value);
    }

    // Write the rendered content to the output file
    fs.writeFile(outputPath, renderedData, 'utf8', (err) => {
      if (err) {
        console.error(`Error writing output file: ${err}`);
        return;
      }
      console.log(`Template has been rendered successfully.`);
    });
  });
}

// Example usage
const templatePath = path.join(buildDir, 'installer.nsh.template');
const outputPath = path.join(buildDir, 'installer.nsh');
const variables = {
  PLATFORM: process.env.PLATFORM || 'arc'
};

renderTemplate(templatePath, outputPath, variables);
