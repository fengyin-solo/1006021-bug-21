import type { ActionResult, EntryRow } from './types'

// 廊桥领域规则集中在这一层：页面、动作层、落库层都走同一份状态机与检查项口径，
// 不允许再出现「检查项结论与作业状态分开落库、各认各的」的情况。

export const BRIDGE_KEY = 'bridge'
export const STAND_KEY = 'stand'

// 作业状态必须按 待靠接 → 已靠桥 → 已撤离 逐级走完；异常中止是旁路终态，不许再走撤离。
export const BRIDGE_STATUSES = ['待靠接', '已靠桥', '已撤离', '异常中止'] as const

// 对接检查项分两个时点：靠桥（对接）与撤桥（撤离），两个时点都必须能从检查项上核出来。
export type BridgeStage = '靠桥' | '撤桥'
export type CheckVerdict = '通过' | '不通过'
export type CheckItemEntry = { 项目: string; 结果: CheckVerdict }
export type StageCheck = { 时间: string; 检查项: CheckItemEntry[] }
// 落库形态：{ "靠桥": {...}, "撤桥": {...} }，序列化成 JSON 存进「对接检查项」字段。
export type BridgeChecks = Partial<Record<BridgeStage, StageCheck>>

export const DOCK_CHECK_ITEMS = ['轮位对位', '接机平台贴合', '自动调平锁定', '舱门对接密封']
export const RETRACT_CHECK_ITEMS = ['舱门解除对接', '平台撤收复位', '行走轮位归位', '撤桥距离确认']

const CHECK_FIELD = '对接检查项'

export type BridgeActionPayload = {
  items?: CheckItemEntry[]
  at?: string
}

export type BridgeActionOutcome = ActionResult & { row?: EntryRow }

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatStamp(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 历史数据里撤桥时间可能缺失，按靠桥时间顺延一个作业时段回填。
function shiftStamp(stamp: string, minutes: number): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(stamp.trim())
  if (!matched) {
    return stamp
  }
  const date = new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]) + minutes,
  )
  return formatStamp(date)
}

function passedStage(items: string[], at: string): StageCheck {
  return { 时间: at, 检查项: items.map((项目) => ({ 项目, 结果: '通过' })) }
}

// 解析「对接检查项」：返回 null 表示是老格式（纯文本、没结结构化过论），需要按状态回填。
export function parseChecks(value: unknown): BridgeChecks | null {
  const raw = String(value ?? '').trim()
  if (raw === '') {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const checks = parsed as Record<string, unknown>
  const readStage = (stage: BridgeStage): StageCheck | undefined => {
    const node = checks[stage]
    if (!node || typeof node !== 'object') {
      return undefined
    }
    const record = node as Record<string, unknown>
    const list = Array.isArray(record['检查项']) ? (record['检查项'] as unknown[]) : []
    const 检查项 = list
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null
        }
        const entry = item as Record<string, unknown>
        const 项目 = String(entry['项目'] ?? '').trim()
        if (!项目) {
          return null
        }
        return { 项目, 结果: entry['结果'] === '通过' ? '通过' : '不通过' } satisfies CheckItemEntry
      })
      .filter((item): item is CheckItemEntry => item !== null)
    if (检查项.length === 0) {
      return undefined
    }
    return { 时间: String(record['时间'] ?? ''), 检查项 }
  }
  const result: BridgeChecks = {}
  const dock = readStage('靠桥')
  const retract = readStage('撤桥')
  if (dock) {
    result['靠桥'] = dock
  }
  if (retract) {
    result['撤桥'] = retract
  }
  return result
}

function serializeChecks(checks: BridgeChecks): string {
  if (!checks['靠桥'] && !checks['撤桥']) {
    return ''
  }
  return JSON.stringify(checks)
}

// 老格式文本（如「廊桥靠接样例1」「靠桥检查未通过」）按当前作业状态补齐结构化结论：
// 已撤离按靠桥/撤桥时间回填两个时点；已靠桥只回填靠桥时点。
function legacyChecks(status: string, dockAt: string, retractAt: string): BridgeChecks {
  if (status === '已撤离') {
    const dockTime = dockAt
    const retractTime = retractAt || (dockTime ? shiftStamp(dockTime, 55) : '')
    return {
      靠桥: passedStage(DOCK_CHECK_ITEMS, dockTime),
      撤桥: passedStage(RETRACT_CHECK_ITEMS, retractTime),
    }
  }
  if (status === '已靠桥' || status === '异常中止') {
    return dockAt ? { 靠桥: passedStage(DOCK_CHECK_ITEMS, dockAt) } : {}
  }
  return {}
}

// 单条廊桥作业的对齐规则：检查项结论与作业状态冲突时，以作业状态为准收口检查项。
// 这是页面、动作、落库三层共用的唯一口径，读出来的数据保证自洽。
export function normalizeBridgeRow(input: EntryRow): EntryRow {
  const row: EntryRow = { ...input }
  const status = (BRIDGE_STATUSES as readonly string[]).includes(String(row.status))
    ? String(row.status)
    : '待靠接'
  const dockAt = String(row['靠桥时间'] ?? '').trim()
  const retractAt = String(row['撤桥时间'] ?? '').trim()

  let checks = parseChecks(row[CHECK_FIELD])
  if (checks === null) {
    checks = legacyChecks(status, dockAt, retractAt)
  }

  let dock = checks['靠桥']
  let retract = checks['撤桥']

  if (status === '已靠桥' || status === '已撤离' || (status === '异常中止' && dock)) {
    // 靠桥已完成：靠桥时点结论必须全部通过（落状态时的前置闸门）。历史未通过项以状态为准回填。
    dock = dock
      ? {
          时间: dock.时间 || dockAt,
          检查项: DOCK_CHECK_ITEMS.map((项目) => ({ 项目, 结果: '通过' })),
        }
      : passedStage(DOCK_CHECK_ITEMS, dockAt)
    if (dock.时间 === '') {
      dock.时间 = dockAt
    }
  }

  if (status === '已撤离') {
    // 已撤离却留着未通过/缺项的撤离检查项：按撤桥时间回填（缺失时按靠桥时间顺延）。
    const at = retract?.时间 || retractAt || (dock ? shiftStamp(dock.时间, 55) : '')
    retract = {
      时间: at,
      检查项: RETRACT_CHECK_ITEMS.map((项目) => ({ 项目, 结果: '通过' })),
    }
  } else {
    retract = undefined
  }

  if (status === '待靠接') {
    dock = undefined
    retract = undefined
  }

  const aligned: BridgeChecks = {}
  if (dock) {
    aligned['靠桥'] = dock
    row['靠桥时间'] = dock.时间
  }
  if (retract) {
    aligned['撤桥'] = retract
    row['撤桥时间'] = retract.时间
  } else if (status !== '待靠接') {
    row['撤桥时间'] = ''
  }

  row.status = status
  row['作业状态'] = status
  row[CHECK_FIELD] = serializeChecks(aligned)
  // 派生字段只在这里结算：异常中止才算异常，撤离正常收口不算异常。
  row.abnormal = status === '异常中止'
  row.pending = status === '待靠接' || status === '已靠桥'
  return row
}

// 页面表格/导出用的检查项摘要，结论与作业状态同口径。
export function checkSummary(input: EntryRow): string {
  const row = normalizeBridgeRow(input)
  const checks = parseChecks(row[CHECK_FIELD]) ?? {}
  const dock = checks['靠桥']
  const retract = checks['撤桥']
  if (!dock && !retract) {
    return '尚未对接检查'
  }
  const parts: string[] = []
  if (dock) {
    const passed = dock.检查项.filter((item) => item.结果 === '通过').length
    parts.push(`靠桥 ${passed}/${dock.检查项.length} 通过`)
  } else {
    parts.push('靠桥未完成')
  }
  if (retract) {
    const passed = retract.检查项.filter((item) => item.结果 === '通过').length
    parts.push(`撤桥 ${passed}/${retract.检查项.length} 通过`)
  } else {
    parts.push('撤桥未完成')
  }
  return parts.join('；')
}

type ItemCheck =
  | { ok: true; items: CheckItemEntry[] }
  | { ok: false; reason: string }

// 动作闸门：检查项必须逐项判定且全部通过，才允许状态推进。
function validateItems(items: CheckItemEntry[] | undefined, template: string[], stage: string): ItemCheck {
  const submitted = items ?? []
  const byName = new Map(submitted.map((item) => [item.项目, item.结果]))
  const ordered: CheckItemEntry[] = []
  const missing: string[] = []
  const failed: string[] = []
  for (const 项目 of template) {
    const 结果 = byName.get(项目)
    if (结果 !== '通过' && 结果 !== '不通过') {
      missing.push(项目)
      continue
    }
    ordered.push({ 项目, 结果 })
    if (结果 === '不通过') {
      failed.push(项目)
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: `${stage}检查项尚有 ${missing.length} 项未判定（${missing.join('、')}），不能收口` }
  }
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `${stage}检查项存在未通过项（${failed.join('、')}），共 ${failed.length}/${template.length} 项，不能落「${
        stage === '靠桥' ? '已靠桥' : '已撤离'
      }」`,
    }
  }
  return { ok: true, items: ordered }
}

function commit(row: EntryRow, message: string): BridgeActionOutcome {
  // 再走一遍归一化：写入即对齐，靠桥/撤桥时点与检查项互相可核。
  return { ok: true, message, row: normalizeBridgeRow(row) }
}

// 廊桥动作状态机：只允许逐级推进，异常中止的作业不许走撤离，终态重复操作一律拒绝（只结算一次）。
export function applyBridgeAction(
  input: EntryRow,
  action: string,
  payload: BridgeActionPayload = {},
): BridgeActionOutcome {
  const row = normalizeBridgeRow(input)
  const status = String(row.status)

  if (action === '开始靠接') {
    if (status !== '待靠接') {
      return { ok: false, message: '只有「待靠接」的作业才能开始靠接，状态须按 待靠接→已靠桥→已撤离 逐级走完，不许跳步' }
    }
    const checked = validateItems(payload.items, DOCK_CHECK_ITEMS, '靠桥')
    if (!checked.ok) {
      return { ok: false, message: checked.reason }
    }
    const at = payload.at || formatStamp()
    const updated: EntryRow = {
      ...row,
      status: '已靠桥',
      靠桥时间: at,
      撤桥时间: '',
      [CHECK_FIELD]: serializeChecks({ 靠桥: { 时间: at, 检查项: checked.items } }),
    }
    return commit(updated, '靠桥完成，对接检查项全部通过，对应机位已记为占用')
  }

  if (action === '确认撤离') {
    if (status === '待靠接') {
      return { ok: false, message: '尚未靠桥，不能确认撤离，不许跳步' }
    }
    if (status === '异常中止') {
      return { ok: false, message: '异常中止的作业不许走撤离' }
    }
    if (status === '已撤离') {
      return { ok: false, message: '该作业已确认撤离，重复确认不再结算异常量' }
    }
    const checked = validateItems(payload.items, RETRACT_CHECK_ITEMS, '撤桥')
    if (!checked.ok) {
      return { ok: false, message: checked.reason }
    }
    const at = payload.at || formatStamp()
    const dockStage = parseChecks(row[CHECK_FIELD])?.['靠桥']
    const updated: EntryRow = {
      ...row,
      status: '已撤离',
      撤桥时间: at,
      [CHECK_FIELD]: serializeChecks({
        靠桥: dockStage ?? passedStage(DOCK_CHECK_ITEMS, String(row['靠桥时间'] ?? '')),
        撤桥: { 时间: at, 检查项: checked.items },
      }),
    }
    return commit(updated, '已确认撤离，撤离检查项全部通过，对应机位占用待办已释放，本次作业正常收口')
  }

  if (action === '登记中止') {
    if (status === '已撤离' || status === '异常中止') {
      return { ok: false, message: `该作业已是「${status}」终态，不能再登记中止` }
    }
    const updated: EntryRow = { ...row, status: '异常中止' }
    return commit(updated, '已登记异常中止，异常量已结算，该作业不再允许撤离')
  }

  return { ok: false, message: `廊桥作业没有登记「${action}」这个动作` }
}

// 撤离/靠桥结论回写停机位：廊桥在桥（已靠桥）的机位一律占用，撤离/中止后释放；
// 机位状态与「占用待办」是同一份结论，停机位页面、概览、导出读到的占用不能两样。
export function reconcileStands(standRows: EntryRow[], bridgeRows: EntryRow[]): EntryRow[] {
  const bridges = bridgeRows.map(normalizeBridgeRow)
  const activeStands = new Set(
    bridges.filter((row) => String(row.status) === '已靠桥').map((row) => String(row['对应机位'] ?? '')),
  )
  const linkedStands = new Set(bridges.map((row) => String(row['对应机位'] ?? '')))

  return standRows.map((input) => {
    const row: EntryRow = { ...input }
    const code = String(row['机位编号'] ?? '')
    let status = String(row.status ?? '')
    if (activeStands.has(code)) {
      status = '占用中'
    } else if (linkedStands.has(code) && status === '占用中') {
      // 关联廊桥已撤离/中止：占用结论随撤离结论释放。
      status = '空闲'
    }
    row.status = status
    row['占用待办'] = status === '占用中'
    return row
  })
}

// 落库层统一归一化入口：廊桥、机位两张表一起对齐。
export function normalizeStore(
  data: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const bridges = (data[BRIDGE_KEY] ?? []).map(normalizeBridgeRow)
  const stands = reconcileStands(data[STAND_KEY] ?? [], bridges)
  return { ...data, [BRIDGE_KEY]: bridges, [STAND_KEY]: stands }
}
