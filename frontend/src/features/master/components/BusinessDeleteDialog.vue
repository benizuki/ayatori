<script setup lang="ts">
defineProps<{
  modelValue: boolean
  businessName: string
  businessCode: string
  departmentName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
}>()
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="470" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="delete-dialog-card">
      <div class="delete-dialog-icon"><v-icon size="27">mdi-trash-can-outline</v-icon></div>
      <v-card-title>この業務を削除しますか？</v-card-title>
      <v-card-text>
        <b>{{ businessName }}</b>
        <span>{{ businessCode }}｜{{ departmentName }}</span>
        <p>登録した確認観点も削除されます。この操作は取り消せません。</p>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="emit('update:modelValue', false)">キャンセル</v-btn>
        <v-btn color="error" prepend-icon="mdi-trash-can-outline" @click="emit('confirm')">業務を削除</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
