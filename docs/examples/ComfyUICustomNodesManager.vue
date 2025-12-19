<template>
  <div class="comfyui-custom-nodes-manager">
    <h2>ComfyUI Custom Nodes Manager</h2>
    
    <!-- Git Status -->
    <div class="status-section">
      <h3>System Status</h3>
      <p>Git Installed: {{ gitInstalled ? '✓ Yes' : '✗ No' }}</p>
      <p>ComfyUI Installed: {{ comfyUIInstalled ? '✓ Yes' : '✗ No' }}</p>
    </div>

    <!-- Installed Nodes List -->
    <div class="installed-nodes">
      <h3>Installed Custom Nodes ({{ installedNodes.length }})</h3>
      <button @click="refreshInstalledNodes">Refresh List</button>
      <ul v-if="installedNodes.length > 0">
        <li v-for="node in installedNodes" :key="node">
          {{ node }}
          <button @click="uninstallNode(node)">Uninstall</button>
        </li>
      </ul>
      <p v-else>No custom nodes installed</p>
    </div>

    <!-- Install New Node -->
    <div class="install-section">
      <h3>Install Custom Node</h3>
      <form @submit.prevent="installCustomNode">
        <div>
          <label>GitHub Username:</label>
          <input v-model="newNode.username" required placeholder="ltdrdata" />
        </div>
        <div>
          <label>Repository Name:</label>
          <input v-model="newNode.repoName" required placeholder="ComfyUI-Manager" />
        </div>
        <div>
          <label>Git Ref (optional):</label>
          <input v-model="newNode.gitRef" placeholder="main" />
        </div>
        <button type="submit" :disabled="installing">
          {{ installing ? 'Installing...' : 'Install Node' }}
        </button>
      </form>
    </div>

    <!-- Status Messages -->
    <div v-if="statusMessage" class="status-message" :class="statusType">
      {{ statusMessage }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

// Configuration - these would typically come from app settings
const comfyUiRootPath = ref('../ComfyUI')
const pythonExePath = ref('../comfyui-backend-env/python.exe')
const pythonEnvPath = ref('../comfyui-backend-env')

// State
const gitInstalled = ref(false)
const comfyUIInstalled = ref(false)
const installedNodes = ref<string[]>([])
const installing = ref(false)
const statusMessage = ref('')
const statusType = ref<'success' | 'error' | 'info'>('info')

// Form data
const newNode = ref<ComfyUICustomNodeRepoId>({
  username: '',
  repoName: '',
  gitRef: '',
})

// Check system status
async function checkSystemStatus() {
  try {
    gitInstalled.value = await window.electronAPI.comfyui.isGitInstalled()
    comfyUIInstalled.value = await window.electronAPI.comfyui.isComfyUIInstalled(
      comfyUiRootPath.value
    )
  } catch (error) {
    console.error('Failed to check system status:', error)
    showStatus('Failed to check system status', 'error')
  }
}

// Refresh list of installed nodes
async function refreshInstalledNodes() {
  try {
    installedNodes.value = await window.electronAPI.comfyui.listInstalledCustomNodes(
      comfyUiRootPath.value
    )
  } catch (error) {
    console.error('Failed to list installed nodes:', error)
    showStatus('Failed to list installed nodes', 'error')
  }
}

// Install a custom node
async function installCustomNode() {
  if (!newNode.value.username || !newNode.value.repoName) {
    showStatus('Please enter both username and repository name', 'error')
    return
  }

  installing.value = true
  showStatus(`Installing ${newNode.value.username}/${newNode.value.repoName}...`, 'info')

  try {
    // Check if already installed
    const alreadyInstalled = await window.electronAPI.comfyui.isCustomNodeInstalled(
      {
        username: newNode.value.username,
        repoName: newNode.value.repoName,
      },
      comfyUiRootPath.value
    )

    if (alreadyInstalled) {
      showStatus('Custom node is already installed', 'error')
      installing.value = false
      return
    }

    // Install the node
    const success = await window.electronAPI.comfyui.downloadCustomNode(
      {
        username: newNode.value.username,
        repoName: newNode.value.repoName,
        gitRef: newNode.value.gitRef || undefined,
      },
      comfyUiRootPath.value,
      pythonExePath.value
    )

    if (success) {
      showStatus(
        `Successfully installed ${newNode.value.username}/${newNode.value.repoName}`,
        'success'
      )
      // Reset form
      newNode.value = { username: '', repoName: '', gitRef: '' }
      // Refresh the list
      await refreshInstalledNodes()
    } else {
      showStatus('Failed to install custom node', 'error')
    }
  } catch (error) {
    console.error('Installation error:', error)
    showStatus(`Installation failed: ${error}`, 'error')
  } finally {
    installing.value = false
  }
}

// Uninstall a custom node
async function uninstallNode(nodeName: string) {
  if (!confirm(`Are you sure you want to uninstall ${nodeName}?`)) {
    return
  }

  try {
    const success = await window.electronAPI.comfyui.uninstallCustomNode(
      {
        username: '', // Not needed for uninstall
        repoName: nodeName,
      },
      comfyUiRootPath.value
    )

    if (success) {
      showStatus(`Successfully uninstalled ${nodeName}`, 'success')
      await refreshInstalledNodes()
    } else {
      showStatus(`Failed to uninstall ${nodeName}`, 'error')
    }
  } catch (error) {
    console.error('Uninstall error:', error)
    showStatus(`Uninstall failed: ${error}`, 'error')
  }
}

// Show status message
function showStatus(message: string, type: 'success' | 'error' | 'info') {
  statusMessage.value = message
  statusType.value = type
  setTimeout(() => {
    statusMessage.value = ''
  }, 5000)
}

// Initialize on mount
onMounted(async () => {
  await checkSystemStatus()
  if (comfyUIInstalled.value) {
    await refreshInstalledNodes()
  }
})
</script>

<style scoped>
.comfyui-custom-nodes-manager {
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
}

.status-section,
.installed-nodes,
.install-section {
  margin: 20px 0;
  padding: 15px;
  border: 1px solid #ddd;
  border-radius: 5px;
}

h2 {
  margin-bottom: 20px;
}

h3 {
  margin-bottom: 10px;
}

button {
  padding: 8px 16px;
  margin: 5px;
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

button:hover {
  background-color: #45a049;
}

button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}

ul {
  list-style: none;
  padding: 0;
}

li {
  padding: 8px;
  margin: 5px 0;
  background-color: #f5f5f5;
  border-radius: 3px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

form div {
  margin: 10px 0;
}

label {
  display: inline-block;
  width: 150px;
  font-weight: bold;
}

input {
  padding: 8px;
  width: 300px;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.status-message {
  padding: 15px;
  margin: 20px 0;
  border-radius: 5px;
  font-weight: bold;
}

.status-message.success {
  background-color: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.status-message.error {
  background-color: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.status-message.info {
  background-color: #d1ecf1;
  color: #0c5460;
  border: 1px solid #bee5eb;
}
</style>
