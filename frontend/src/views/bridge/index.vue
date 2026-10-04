<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥靠接管理</h2>
        <p class="page-desc">廊桥作业按 待靠接 → 已靠桥 → 已撤离 逐级收口；靠桥、撤桥两个时点的对接检查项逐项通过才允许落状态，异常中止的作业不再撤离。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记廊桥作业</button>
        <button class="btn" type="button" @click="exportRows">导出廊桥靠接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '对接检查项'">
              <span class="check-summary">{{ checkSummary(row) }}</span>
            </template>
            <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
          </td>
          <td>
            <span :class="['status-tag', statusClass(row.status)]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <template v-if="actionsFor(row).length">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊桥靠接数据，可先登记廊桥作业</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥靠接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 对接检查项收口弹窗：靠桥/撤桥逐项判定，有未判定或不通过项时动作层拒绝落状态 -->
    <div v-if="checkDialog" class="modal-mask" @click.self="closeDialog">
      <div class="modal-box">
        <h3 class="modal-title">{{ checkDialog.title }}</h3>
        <p class="modal-desc">作业编号 {{ checkDialog.code }} · 对应机位 {{ checkDialog.stand }}，检查项须逐项判定且全部通过才能收口。</p>
        <ul class="check-list">
          <li v-for="item in checkDialog.items" :key="item" class="check-line">
            <span class="check-name">{{ item }}</span>
            <span class="check-options">
              <label>
                <input
                  type="radio"
                  :name="`${checkDialog.id}-${item}`"
                  value="通过"
                  :checked="checkDialog.draft[item] === '通过'"
                  @change="setVerdict(item, '通过')"
                />
                通过
              </label>
              <label>
                <input
                  type="radio"
                  :name="`${checkDialog.id}-${item}`"
                  value="不通过"
                  :checked="checkDialog.draft[item] === '不通过'"
                  @change="setVerdict(item, '不通过')"
                />
                不通过
              </label>
            </span>
          </li>
        </ul>
        <p v-if="dialogMessage" class="error-text">{{ dialogMessage }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitCheck">提交并{{ checkDialog.action }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  DOCK_CHECK_ITEMS,
  RETRACT_CHECK_ITEMS,
  checkSummary,
  formatStamp,
  parseChecks,
  type CheckVerdict,
} from '@/data/bridge-domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('bridge')
const columns = ["作业编号", "廊桥编号", "对应机位", "靠桥时间", "撤桥时间", "操作人员", "对接检查项", "作业状态"]
const statuses = ["待靠接", "已靠桥", "已撤离", "异常中止"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 状态逐级走完：只把当前状态允许的动作给出来，异常中止/已撤离没有后续动作。
function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待靠接':
      return ['开始靠接', '登记中止']
    case '已靠桥':
      return ['确认撤离', '登记中止']
    default:
      return []
  }
}

function statusClass(status: unknown): string {
  return {
    待靠接: 'status-todo',
    已靠桥: 'status-busy',
    已撤离: 'status-done',
    异常中止: 'status-abnormal',
  }[String(status)] ?? ''
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const today = formatStamp().slice(0, 10)
const stats = computed(() => [
  {
    label: '今日靠接作业',
    value: rows.value.filter((row) => {
      const dock = parseChecks(row['对接检查项'])?.['靠桥']
      return Boolean(dock && dock.时间.startsWith(today))
    }).length,
  },
  { label: '待靠桥作业', value: rows.value.filter((row) => String(row.status) === '待靠接').length },
  { label: '异常中止作业', value: rows.value.filter((row) => String(row.status) === '异常中止').length },
])

type CheckDialog = {
  id: number
  action: string
  title: string
  code: string
  stand: string
  items: string[]
  draft: Record<string, CheckVerdict | ''>
}

const checkDialog = ref<CheckDialog | null>(null)
const dialogMessage = ref('')

function openCheckDialog(action: string, row: EntryRow) {
  const isDock = action === '开始靠接'
  checkDialog.value = {
    id: Number(row.id),
    action,
    title: isDock ? '靠桥对接检查' : '撤桥对接检查',
    code: String(row['作业编号'] ?? ''),
    stand: String(row['对应机位'] ?? ''),
    items: isDock ? DOCK_CHECK_ITEMS : RETRACT_CHECK_ITEMS,
    draft: {},
  }
  dialogMessage.value = ''
}

function setVerdict(item: string, verdict: CheckVerdict) {
  if (!checkDialog.value) {
    return
  }
  checkDialog.value.draft[item] = verdict
}

function closeDialog() {
  checkDialog.value = null
  dialogMessage.value = ''
}

function submitCheck() {
  const dialog = checkDialog.value
  if (!dialog) {
    return
  }
  const undecided = dialog.items.filter((item) => dialog.draft[item] !== '通过' && dialog.draft[item] !== '不通过')
  if (undecided.length > 0) {
    dialogMessage.value = `还有 ${undecided.length} 项未判定：${undecided.join('、')}`
    return
  }
  const items = dialog.items.map((项目) => ({ 项目, 结果: dialog.draft[项目] as CheckVerdict }))
  const result = applyAction(meta.key, dialog.id, dialog.action, { items })
  if (!result.ok) {
    dialogMessage.value = result.message
    return
  }
  closeDialog()
  errorMessage.value = ''
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '廊桥作业登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '开始靠接' || action === '确认撤离') {
    openCheckDialog(action, row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊桥靠接列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.check-summary {
  white-space: pre-line;
  font-size: 12px;
  line-height: 1.5;
}
.status-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  border: 1px solid var(--border);
}
.status-todo { color: #667085; background: #f9fafb; }
.status-busy { color: #b54708; background: #fffaeb; border-color: #fedf89; }
.status-done { color: #027a48; background: #ecfdf3; border-color: #abefc6; }
.status-abnormal { color: #b42318; background: #fef3f2; border-color: #fda29b; }
.muted-text { color: var(--muted); }

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-box {
  width: 460px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  box-shadow: 0 12px 32px rgba(16, 24, 40, 0.18);
}
.modal-title { margin: 0 0 4px; font-size: 16px; }
.modal-desc { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
.check-list { list-style: none; margin: 0; padding: 0; }
.check-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}
.check-options label { margin-left: 14px; font-size: 13px; cursor: pointer; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
