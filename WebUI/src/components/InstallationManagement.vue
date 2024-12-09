<template>
  <div class="dialog-container z-10">
    <h1 class="text-center py-1 px-4 rounded text-white" style="font-size: 28px">Manage Installations</h1>
    <div v-for="item in apiServiceInformation">
      <div class="items-center" style=" display: flex; justify-content: center">
        <div style="background-color: #f9f9f9; border: 1px solid #ccc; padding: 5px; width: 50%; margin: 15px; ">
          <tr>
            <td>
              <div>{{ item.serviceName }}</div>
              <tr>
                <td>installed: {{ item.isSetUp }}</td>
                <td>status: {{ item.status.status }}</td>
              </tr>
            </td>
            <td>
              <div class="flex justify-center items-center gap-9">
                <button class="bg-color-control-bg  py-1 px-4 rounded text-white">install</button>
              </div>
            </td>
          </tr>
        </div>

        <div>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {Input} from '@/components/ui/input'
import {useGlobalSetup} from '@/assets/js/store/globalSetup';
import {useI18N} from '@/assets/js/store/i18n';
import {useModels, userModels} from '@/assets/js/store/models';

const apiServiceInformation = ref<ApiServiceInformation[]>([])

onBeforeMount(async () => {
  apiServiceInformation.value = await window.electronAPI.getServiceRegistry()
})


</script>

<style>
ul {
  list-style-type: disc;
  padding-left: 20px;
}

.hover-box {
  position: absolute;
  background-color: rgba(90, 90, 90, 0.91);
  border: 1px solid #000000;
  padding: 10px;
  border-radius: 10px;
  z-index: 1;
}

table {
   border-collapse: separate;
   border-spacing: 10px;
 }
</style>