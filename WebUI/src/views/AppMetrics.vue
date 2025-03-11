<template>
  <div
    id="app-metrics-panel"
    class="settings-panel absolute right-0 top-0 h-full bg-color-bg-main text-sm text-white py-4"
  >
    <h1>Metrics</h1>
    <textarea v-if="metrics" style="height: 100%;">{{ JSON.stringify(metrics, null, 2) }}</textarea>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

// metrics data
const metrics = ref<object>({})

// Subscribe to the metrics-data event
window.electronAPI.onMetrics((_metrics) => {

  // For every key in metrics
  for (const key in _metrics) {
    // Ignore non-numerical values
    if (typeof _metrics[key] !== 'number') {
      continue
    }

    // If the key is not in metrics
    if (!metrics.value.hasOwnProperty(key)) {
      // Add the key to metrics
      metrics.value[key] = []
    }
    // Push the value to the key
    metrics.value[key].push(_metrics[key])

    // Keep only the last 50 values
    if (metrics.value[key].length > 50) {
      metrics.value[key].shift()
    }
  }
});
</script>
