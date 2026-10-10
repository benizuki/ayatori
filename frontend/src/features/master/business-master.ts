import type { BusinessProcessMaster } from '../../models'

/**
 * 業務が1件も無いときに画面へ渡すプレースホルダー。初期データを流用すると
 * 画面上の編集がシードを書き換えてしまうため、空の業務を都度作って返す。
 */
export function emptyBusinessMaster(): BusinessProcessMaster {
  return {
    id: '',
    code: '',
    name: '',
    departmentId: '',
    category: '',
    description: '',
    startCondition: '',
    endCondition: '',
    sapScope: '未判定',
    sapModule: '',
    ownerRole: '',
    status: '作成中',
    updatedAt: '',
    interviewTopics: [],
    parentId: '',
  }
}
