import { spawn } from 'child_process';
import path from 'path';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../../public/scripts/collector.ps1');

export function runPowerShellScript() {
  console.log('Running PowerShell script...');
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass' ,'-File', scriptPath]);

  ps.stdout.on('data', (data) => {
    const output = data.toString();
    processOutput(output);
  });

  ps.stderr.on('data', (data) => {
    console.error('Error:', data.toString());
  });

  ps.on('close', (code) => {
    console.log(`PowerShell script exited with code ${code}`);
    runPowerShellScript(); // Restart the process
  });
}

import { BrowserWindow } from 'electron';
let win: BrowserWindow | null = null;

export function setWindow(window: BrowserWindow) {
  win = window;
}

function processOutput(output: string) {
  
  // Split output by new line
  const lines = output.split('\n');

  // Process each line
  lines.forEach((line) => {
    
    // Initialize metrics object
    let metrics: { [key: string]: number } = {};

    // Split line by space
    const segments = line.split(' ');

    // Check that the first segment is the "metrics" keyword
    if (segments[0] !== 'metrics') {
      return;
    }

    // Process each metric
    segments[1].split(',').forEach((metric) => {
      const [key, value] = metric.split('=');
      metrics[key] = parseFloat(value);
    });

    // Add the timestamp
    metrics['epoch'] = parseInt(segments[2], 10);

    // Send the metrics to the renderer
    win?.webContents.send('metrics', metrics);
  });
}