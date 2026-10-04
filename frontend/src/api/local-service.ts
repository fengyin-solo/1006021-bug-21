import {
  BRIDGE_ACTIONS,
  BRIDGE_FIELDS,
  BRIDGE_KEY,
  STAND_KEY,
  activeBridgeOnStand,
  applyBridgeAction,
  setBridgeCheckResult,
} from '@/data/bridge'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, saveRowsBatch } from '@/data/local-store'
import type { ActionResult, CheckItem, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 廊桥作业走领域结算：检查项结论与作业状态在同一写入里对齐，并原子回写停机位占用。
  if (key === BRIDGE_KEY && Object.values(BRIDGE_ACTIONS).includes(action as (typeof BRIDGE_ACTIONS)[keyof typeof BRIDGE_ACTIONS])) {
    const outcome = applyBridgeAction(listRows(BRIDGE_KEY), listRows(STAND_KEY), id, action)
    if (!outcome.result.ok) {
      return outcome.result
    }
    const patch: Record<string, EntryRow[]> = { [BRIDGE_KEY]: outcome.bridges }
    if (outcome.standsChanged) {
      patch[STAND_KEY] = outcome.stands
    }
    saveRowsBatch(patch)
    return outcome.result
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const allowed = meta.transitions?.[current]
  if (allowed && !allowed.includes(target)) {
    return { ok: false, message: `${meta.entity}当前为「${current}」，不能直接流转到「${target}」，请按状态逐级推进` }
  }
  // 跨模块闸口：仍有在桥作业占着的停机位，不能从机位侧绕过廊桥释放/封闭，
  // 否则机位占用会和廊桥撤离结论两份不一样。
  if (key === STAND_KEY && (target === '空闲' || target === '已封闭')) {
    const standNo = String(rows[index]['机位编号'] ?? '')
    const bridgeRow = activeBridgeOnStand(listRows(BRIDGE_KEY), standNo)
    if (bridgeRow) {
      const code = String(bridgeRow[BRIDGE_FIELDS.code] ?? '')
      return {
        ok: false,
        message: `机位 ${standNo} 仍被廊桥作业 ${code}（${String(bridgeRow.status)}）占用，须先在廊桥靠接里完成撤离或处置中止后再${action}`,
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 各模块末尾的展示状态字段（如「机位状态」）与 status 同步，防止一个实体两份状态。
  const statusField = meta.fields.find((field) => field.endsWith('状态'))
  if (statusField) {
    updated[statusField] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 廊桥对接检查项逐项登记结论；只允许在对应相位录入，终态凭证封档不可改。 */
export function recordBridgeCheck(
  id: number,
  phase: CheckItem['phase'],
  name: string,
  result: CheckItem['result'],
): ActionResult {
  const { result: actionResult, bridges } = setBridgeCheckResult(listRows(BRIDGE_KEY), id, phase, name, result)
  if (actionResult.ok) {
    saveRows(BRIDGE_KEY, bridges)
  }
  return actionResult
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  // 概览只读取落库时已结算好的 abnormal/pending，绝不再按检查项二次推算，
  // 同一次撤离在作业记录与概览里只能是同一个结论。
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

export { BRIDGE_FIELDS }
