/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 对接检查项结论：每一项都带所属时点（靠桥/撤桥）、核验人和核验时间，是作业状态的判定凭证。 */
export type CheckItem = {
  name: string
  phase: 'dock' | 'evac'
  result: 'pass' | 'fail' | 'pending'
  checkedAt: string
  checker: string
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /**
   * 状态机：key 为当前状态，value 为可推进到的状态（必须逐级，不许跳步）。
   * 不配则沿用通用动作的宽松校验；廊桥必须显式配置，异常中止是终态分支。
   */
  transitions?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
