<script setup lang="ts">
defineProps<{
  modelValue: boolean
  laneName: string
  stepCount: number
  destinationLanes: string[]
  destination: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:destination': [value: string]
  confirm: []
}>()
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="480" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="delete-dialog-card">
      <div class="delete-dialog-icon"><v-icon size="27">mdi-table-row-remove</v-icon></div>
      <v-card-title>このレーンを削除しますか？</v-card-title>
      <v-card-text>
        <b>{{ laneName }}</b>
        <span>所属ステップ {{ stepCount }}件</span>
        <v-select
          :model-value="destination"
          :items="destinationLanes"
          label="ステップの移動先"
          class="lane-delete-destination"
          density="comfortable"
          hide-details
          @update:model-value="(value: string) => emit('update:destination', value)"
        ></v-select>
        <p>レーン内のステップは指定した移動先へまとめて移動します。ステップ自体は削除されません。</p>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="emit('update:modelValue', false)">キャンセル</v-btn>
        <v-btn color="error" prepend-icon="mdi-trash-can-outline" :disabled="!destination" @click="emit('confirm')">レーンを削除</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
