<template>
  <div class="h-full flex flex-col">
    <!-- Add a button to fetch metrics -->
    <div class="flex-none flex flex-row justify-between items-center px-3 py-2 border-b border-color-spilter">
      <h1 class="text-lg font-bold">Metrics</h1>
    </div>
    <div v-if="cpuTotalUsagePercentage" class="metrics-container">
      <div class="flex flex-row justify-between items-center w-full">
        <label for="cpu-usage" class="w-1/4">{{ metricsLabels.cpuUsage }}</label>
        <progress id="cpu-usage" :value="getLastValue(cpuTotalUsagePercentage)" max="100" class="w-3/4">
          {{ getLastValue(cpuTotalUsagePercentage) }}%
        </progress>
      </div>
    </div>
    <div v-if="memoryTotalUsagePercentage" class="metrics-container">
      <div class="flex flex-row justify-between items-center w-full">
        <label for="memory-usage" class="w-1/4">{{ metricsLabels.memoryUsage }}</label>
        <progress id="memory-usage" :value="getLastValue(memoryTotalUsagePercentage)" max="100" class="w-3/4">
          {{ memoryTotalUsagePercentage }}%
        </progress>
      </div>
    </div>
    <div v-if="gpuDedicatedMemoryPercentage" class="metrics-container">
      <div class="flex flex-row justify-between items-center w-full">
        <label for="gpu-dedicated-memory" class="w-1/4">{{ metricsLabels.gpuDedicatedMemoryUsage }}</label>
        <progress id="gpu-dedicated-memory" :value="getLastValue(gpuDedicatedMemoryPercentage)" max="100" class="w-3/4">
          {{ getLastValue(gpuDedicatedMemoryPercentage) }}%
        </progress>
      </div>
    </div>
    <div v-if="gpuCopyUsagePercentage" class="metrics-container">
      <div class="flex flex-row justify-between items-center w-full">
        <label for="gpu-copy-usage" class="w-1/4">{{ metricsLabels.gpuCopyUsage }}</label>
        <progress id="gpu-copy-usage" :value="getLastValue(gpuCopyUsagePercentage)" max="100" class="w-3/4">
          {{ getLastValue(gpuCopyUsagePercentage) }}%
        </progress>
      </div>
    </div>
    <div v-if="gpuComputeUsagePercentage" class="metrics-container">
      <div class="flex flex-row justify-between items-center w-full">
        <label for="gpu-compute-usage" class="w-1/4">{{ metricsLabels.gpuComputeUsage }}</label>
        <progress id="gpu-compute-usage" :value="getLastValue(gpuComputeUsagePercentage)" max="100" class="w-3/4">
          {{ getLastValue(gpuComputeUsagePercentage) }}%
        </progress>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n.ts'
import { ref, onMounted, onUnmounted } from 'vue'
import { useGlobalSetup } from '@/assets/js/store/globalSetup.ts'

const globalSetup = useGlobalSetup()
useI18N()

const metrics = ref(null)

const metricsLabels = {
  cpuUsage: 'CPU Utilization',
  memoryUsage: 'Memory Utilization',
  gpuDedicatedMemoryUsage: 'GPU Dedicated Memory Utilization',
  gpuCopyUsage: 'GPU Copy Engine Utilization',
  gpuComputeUsage: 'GPU Compute Engine Utilization',
}

const cpuTotalUsagePercentage = ref(null)
const memoryTotalUsagePercentage = ref(null)
const gpuDedicatedMemoryPercentage = ref(null)
const gpuCopyUsagePercentage = ref(null)
const gpuComputeUsagePercentage = ref(null)

const getLastValue = (metric) => {
  return metric[metric.length - 1].value
}

const fetchMetrics = async () => {
  try {
    const response = await fetch(`${globalSetup.apiHost}/api/metrics`)
    if (!response.ok) {
      throw new Error('Network response was not ok')
    }
    metrics.value = await response.json()

    // Timeseries data
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
  const intervalId = setInterval(fetchMetrics, 3000)
  onUnmounted(() => {
    clearInterval(intervalId)
  })
})
</script>

<style scoped>
.metrics-container {
  margin-top: 10px;
}

</style>