<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥靠接管理</h2>
        <p class="page-desc">维护廊桥作业，围绕作业编号、廊桥编号、对应机位、靠桥时间做登记、筛选与状态流转。</p>
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

    <p class="rule-hint">
      状态须按 待靠接 → 已靠桥 → 已撤离 逐级推进，不许跳步；异常中止的作业不再走撤离。
      靠桥与撤桥检查项须全部通过才能收口对应动作，撤离结论同步释放停机位占用。
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table bridge-table">
      <thead>
        <tr>
          <th class="col-expand"></th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr>
            <td class="col-expand">
              <button class="link" type="button" @click="toggleExpand(row)">
                {{ expandedIds.has(Number(row.id)) ? '收起' : '检查项' }}
              </button>
            </td>
            <td v-for="column in columns" :key="column">
              <span v-if="column === '对接检查项'" :class="checkBadgeClass(row)">
                {{ row[column] ?? '—' }}
              </span>
              <span v-else>{{ row[column] ?? '—' }}</span>
            </td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in availableActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <span v-if="!availableActions(row).length" class="muted">—</span>
            </td>
          </tr>
          <tr v-if="expandedIds.has(Number(row.id))" class="check-row">
            <td></td>
            <td :colspan="columns.length + 2">
              <div class="check-panel">
                <div v-for="group in checkGroups(row)" :key="group.phase" class="check-group">
                  <h4 class="check-group-title">
                    {{ group.label }}检查项
                    <span class="check-group-time">{{ group.timeLabel }}：{{ group.time || '—' }}</span>
                  </h4>
                  <table class="check-items">
                    <thead>
                      <tr><th>检查项</th><th>结论</th><th>核验时间</th><th>核验人</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in group.items" :key="`${group.phase}-${item.name}`">
                        <td>{{ item.name }}</td>
                        <td>
                          <select
                            class="check-select"
                            :class="`check-${item.result}`"
                            :value="item.result"
                            :disabled="!canEdit(row, group.phase)"
                            @change="onCheckChange(row, group.phase, item.name, ($event.target as HTMLSelectElement).value)"
                          >
                            <option value="pending">待检</option>
                            <option value="pass">通过</option>
                            <option value="fail">未通过</option>
                          </select>
                        </td>
                        <td>{{ item.checkedAt || '—' }}</td>
                        <td>{{ item.checker || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-if="!canEdit(row, group.phase)" class="check-lock">
                    {{ String(row.status) === '已撤离' ? '撤离已结算，检查项凭证封档不可改' : '该阶段检查项暂不可登记' }}
                  </p>
                </div>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无廊桥靠接数据，可先登记廊桥作业</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥靠接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  recordBridgeCheck,
  runAction as applyAction,
} from '@/api/local-service'
import {
  BRIDGE_ACTIONS,
  BRIDGE_FIELDS,
  checkSummary,
  parseCheckItems,
} from '@/data/bridge'
import type { CheckItem, EntryRow } from '@/data/types'

const meta = moduleMeta('bridge')
// 「作业状态」列与独立的「当前状态」列同源于 status，页面只展示一份，避免两个状态打架。
const columns = ["作业编号", "廊桥编号", "对应机位", "靠桥时间", "撤桥时间", "操作人员", "对接检查项"]
const statuses = ["待靠接", "已靠桥", "已撤离", "异常中止"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["作业编号", "廊桥编号", "对应机位"]
const expandedIds = ref<Set<number>>(new Set())

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '今日靠接作业', value: rows.value.length },
  { label: '待靠桥作业', value: rows.value.filter((row) => String(row.status) === '待靠接').length },
  { label: '异常中止作业', value: rows.value.filter((row) => String(row.status) === '异常中止').length },
])

/** 页面只给当前状态允许的动作，逐级推进；动作层仍会再校验一次。 */
function availableActions(row: EntryRow): string[] {
  const current = String(row.status)
  const allowed = meta.transitions?.[current] ?? []
  const reverse: Record<string, string> = {
    已靠桥: BRIDGE_ACTIONS.startDock,
    已撤离: BRIDGE_ACTIONS.confirmEvac,
    异常中止: BRIDGE_ACTIONS.abort,
  }
  return allowed.map((target) => reverse[target]).filter((action): action is string => Boolean(action))
}

function toggleExpand(row: EntryRow) {
  const id = Number(row.id)
  const next = new Set(expandedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  expandedIds.value = next
}

type CheckGroup = {
  phase: CheckItem['phase']
  label: string
  timeLabel: string
  time: string
  items: CheckItem[]
}

function checkGroups(row: EntryRow): CheckGroup[] {
  const items = parseCheckItems(row)
  return [
    {
      phase: 'dock',
      label: '靠桥',
      timeLabel: '靠桥时间',
      time: String(row[BRIDGE_FIELDS.dockTime] ?? ''),
      items: items.filter((item) => item.phase === 'dock'),
    },
    {
      phase: 'evac',
      label: '撤桥',
      timeLabel: '撤桥时间',
      time: String(row[BRIDGE_FIELDS.evacTime] ?? ''),
      items: items.filter((item) => item.phase === 'evac'),
    },
  ]
}

function canEdit(row: EntryRow, phase: CheckItem['phase']): boolean {
  const status = String(row.status)
  return phase === 'dock'
    ? status === '待靠接' || status === '已靠桥'
    : status === '已靠桥'
}

function checkBadgeClass(row: EntryRow): string {
  const items = parseCheckItems(row)
  if (items.some((item) => item.result === 'fail')) {
    return 'check-badge check-fail'
  }
  if (items.some((item) => item.result === 'pending')) {
    return 'check-badge check-pending'
  }
  return 'check-badge check-pass'
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
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function onCheckChange(row: EntryRow, phase: CheckItem['phase'], name: string, value: string) {
  errorMessage.value = ''
  const result = recordBridgeCheck(Number(row.id), phase, name, value as CheckItem['result'])
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items.map((row) => {
      // 页面上的「对接检查项」列由结构化凭证派生，不再与凭证分开各存一份。
      return { ...row, [BRIDGE_FIELDS.checkSummary]: checkSummary(parseCheckItems(row)) }
    })
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊桥靠接列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.rule-hint {
  margin: 8px 0 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--c-fill, #f4f6f8);
  color: #5a6472;
  font-size: 13px;
}

.col-expand {
  width: 64px;
  text-align: center;
}

.check-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
}

.check-pass {
  background: #e6f6ec;
  color: #1f8a4c;
}

.check-pending {
  background: #fdf3e0;
  color: #b7791f;
}

.check-fail {
  background: #fdeaea;
  color: #c0392b;
}

.check-row > td {
  background: #fafbfc;
}

.check-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  padding: 12px 16px;
}

.check-group {
  flex: 1 1 360px;
}

.check-group-title {
  margin: 0 0 8px;
  font-size: 14px;
}

.check-group-time {
  margin-left: 8px;
  font-weight: 400;
  color: #8a93a0;
  font-size: 12px;
}

.check-items {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.check-items th,
.check-items td {
  border: 1px solid #e3e7ed;
  padding: 6px 8px;
  text-align: left;
}

.check-select {
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid #c9d0da;
}

.check-select.check-fail {
  border-color: #c0392b;
  color: #c0392b;
}

.check-select.check-pass {
  border-color: #1f8a4c;
  color: #1f8a4c;
}

.check-lock {
  margin: 6px 0 0;
  font-size: 12px;
  color: #8a93a0;
}

.muted {
  color: #a4acb8;
}
</style>
