<template>
  <div class="h-full flex flex-col">
    <!-- Add a button to fetch metrics -->
    <div class="flex-none flex flex-row justify-between items-center px-3 py-2 border-b border-color-spilter">
      <h1 class="text-lg font-bold">Metrics</h1>
      <button class="btn btn-primary" @click="fetchMetrics">Fetch Metrics</button>
    </div>
    <div v-if="metrics" class="metrics-container">
      <h2>Metrics</h2>
      <pre>{{ metrics }}</pre>
    </div>
    <div v-if="cpuTotalUsagePercentage" class="metrics-container">
      CPU: {{ cpuTotalUsagePercentage[cpuTotalUsagePercentage.length - 1].value }}%
    </div>
    <div v-if="memoryTotalUsagePercentage" class="metrics-container">
      Memory: {{ memoryTotalUsagePercentage[memoryTotalUsagePercentage.length - 1].value }}%
    </div>
    <div v-if="gpuDedicatedMemoryPercentage" class="metrics-container">
      GPU Dedicated Memory: {{ gpuDedicatedMemoryPercentage[gpuDedicatedMemoryPercentage.length - 1].value }}%
    </div>
    <div v-if="gpuCopyUsagePercentage" class="metrics-container">
      GPU Copy Usage: {{ gpuCopyUsagePercentage[gpuCopyUsagePercentage.length - 1].value }}%
    </div>
    <div v-if="gpuComputeUsagePercentage" class="metrics-container">
      GPU Compute Usage: {{ gpuComputeUsagePercentage[gpuComputeUsagePercentage.length - 1].value }}%
    </div>
  </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n.ts'
import { ref, onMounted } from 'vue'
import { useGlobalSetup } from '@/assets/js/store/globalSetup.ts'

const globalSetup = useGlobalSetup()
useI18N()

const metrics = ref(null)
const cpuTotalUsagePercentage = ref(null)
const memoryTotalUsagePercentage = ref(null)
const gpuDedicatedMemoryPercentage = ref(null)
const gpuCopyUsagePercentage = ref(null)
const gpuComputeUsagePercentage = ref(null)

const fetchMetrics = async () => {
  try {
    const response = await fetch(`${globalSetup.apiHost}/api/metrics`)
    if (!response.ok) {
      throw new Error('Network response was not ok')
    }
    metrics.value = await response.json()

    cpuTotalUsagePercentage.value = await (await fetch(`${globalSetup.apiHost}/api/metrics/CPUTotalUsagePercentage`)).json()
    memoryTotalUsagePercentage.value = await (await fetch(`${globalSetup.apiHost}/api/metrics/MemoryTotalUsagePercentage`)).json()
    gpuDedicatedMemoryPercentage.value = await (await fetch(`${globalSetup.apiHost}/api/metrics/GPUDedicatedMemoryPercentage`)).json()
    gpuCopyUsagePercentage.value = await (await fetch(`${globalSetup.apiHost}/api/metrics/GPUCopyUsagePercentage`)).json()
    gpuComputeUsagePercentage.value = await (await fetch(`${globalSetup.apiHost}/api/metrics/GPUComputeUsagePercentage`)).json()

  } catch (error) {
    console.error('Error fetching metrics:', error)
  }
}

onMounted(() => {
  fetchMetrics()
})
</script>