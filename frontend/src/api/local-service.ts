import {
  applyBridgeAction,
  BRIDGE_KEY,
  STAND_KEY,
  checkSummary,
  normalizeBridgeRow,
  type BridgeActionPayload,
} from '@/data/bridge-domain'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, saveStore } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

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

// 机位动作落库后让「占用待办」与状态同源，避免机位页面动作写出第二份占用结论。
function withStandOccupancy(row: EntryRow, target: string): EntryRow {
  return { ...row, status: target, ['占用待办']: target === '占用中' }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: BridgeActionPayload = {},
): ActionResult {
  if (key === BRIDGE_KEY) {
    return runBridgeAction(id, action, payload)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
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
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === STAND_KEY) {
    updated = withStandOccupancy(updated, target)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 廊桥动作：走领域状态机（逐级推进、检查项闸门、异常量只结算一次），
// 并在同一笔写入里回写对应机位的占用结论。
function runBridgeAction(id: number, action: string, payload: BridgeActionPayload): ActionResult {
  const store = allRows()
  const bridges = store[BRIDGE_KEY] ?? []
  const index = bridges.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的廊桥作业` }
  }
  const outcome = applyBridgeAction(bridges[index], action, payload)
  if (!outcome.ok || !outcome.row) {
    return { ok: false, message: outcome.message }
  }
  const nextBridges = [...bridges]
  nextBridges[index] = outcome.row
  // normalizeStore 内会顺带把机位占用结论对齐，廊桥/机位一笔落库。
  saveStore({ ...store, [BRIDGE_KEY]: nextBridges })
  return { ok: true, message: outcome.message }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? '是' : '否'
  }
  return String(value ?? '')
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const source of listRows(key)) {
    // 导出读到的也是落库对齐后的同一份数据：廊桥检查项给可读摘要。
    const row = key === BRIDGE_KEY ? normalizeBridgeRow(source) : source
    const values = meta.fields.map((field) =>
      key === BRIDGE_KEY && field === '对接检查项'
        ? checkSummary(row)
        : csvCell(row[field]),
    )
    lines.push([row.id, ...values, csvCell(row.status)].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      // 异常量唯一口径：动作落库时结算的 abnormal 标记（廊桥仅「异常中止」）。
      // 概览不再照着检查项重算一遍，同一次撤离在作业记录与概览里必须是同一份结论。
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
