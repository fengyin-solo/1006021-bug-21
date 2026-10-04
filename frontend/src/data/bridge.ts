import type { ActionResult, CheckItem, EntryRow } from './types'

// 廊桥作业领域模块。
// 唯一判定口径：对接检查项是现场逐项核验、带核验时点的一手凭证；作业状态是动作层
// 按检查项结论推导出的派生标记。写入时检查项结论收口作业状态；存量冲突一律以检查
// 项为准回退状态（已撤离却留未通过项的，按靠桥时间回退到已靠桥重修）。

export const BRIDGE_KEY = 'bridge'
export const STAND_KEY = 'stand'

export const BRIDGE_STATUS = {
  waiting: '待靠接',
  docked: '已靠桥',
  evacuated: '已撤离',
  aborted: '异常中止',
} as const

export const BRIDGE_ACTIONS = {
  startDock: '开始靠接',
  confirmEvac: '确认撤离',
  abort: '登记中止',
} as const

export const BRIDGE_FIELDS = {
  code: '作业编号',
  bridgeNo: '廊桥编号',
  standNo: '对应机位',
  dockTime: '靠桥时间',
  evacTime: '撤桥时间',
  operator: '操作人员',
  checkSummary: '对接检查项',
  statusText: '作业状态',
} as const

const STAND_FIELDS = {
  no: '机位编号',
  statusText: '机位状态',
  occupiedPeriod: '占用时段',
  currentFlight: '当前航班',
} as const

/** 结构化检查项的内部存储键；页面上的「对接检查项」列由它派生，两份不再各自落库。 */
export const CHECK_ITEMS_KEY = '__checkItems'

// 靠桥、撤桥两个时点各有一组检查项，结论与核验时间都能从这张凭证上核出来。
const DOCK_CHECK_NAMES = ['行走机构复位', '机轮制动锁止', '接机口对接到位', '地板高度调平']
const EVAC_CHECK_NAMES = ['撤离信号确认', '接机口安全脱离', '廊桥回位锁定', '行走通道清场']

const FAIL_MARK = /未通过|不合格/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function nowText(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function blankChecks(names: string[], phase: CheckItem['phase']): CheckItem[] {
  return names.map((name) => ({ name, phase, result: 'pending', checkedAt: '', checker: '' }))
}

export function defaultCheckItems(): CheckItem[] {
  return [...blankChecks(DOCK_CHECK_NAMES, 'dock'), ...blankChecks(EVAC_CHECK_NAMES, 'evac')]
}

export function parseCheckItems(row: EntryRow): CheckItem[] {
  const raw = row[CHECK_ITEMS_KEY]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (
        Array.isArray(parsed) &&
        parsed.every(
          (item) =>
            item &&
            typeof item.name === 'string' &&
            (item.phase === 'dock' || item.phase === 'evac') &&
            ['pass', 'fail', 'pending'].includes(String(item.result)),
        )
      ) {
        return parsed as CheckItem[]
      }
    } catch {
      // 落到旧数据推断
    }
  }
  return inferLegacyCheckItems(row)
}

/** 旧记录没有结构化检查项，按状态与文本里的未通过标记推断，推断结果同样带核验时点。 */
function inferLegacyCheckItems(row: EntryRow): CheckItem[] {
  const status = String(row.status)
  const dockTime = String(row[BRIDGE_FIELDS.dockTime] ?? '')
  const evacTime = String(row[BRIDGE_FIELDS.evacTime] ?? '')
  const declaredFail = FAIL_MARK.test(String(row[BRIDGE_FIELDS.checkSummary] ?? ''))

  if (status === BRIDGE_STATUS.waiting) {
    return defaultCheckItems()
  }
  // 文本里带「未通过」的：靠桥检查项名称命中算靠桥遗留，否则按名称匹配撤桥检查项。
  const summary = String(row[BRIDGE_FIELDS.checkSummary] ?? '')
  const declaredName = summary.split(/[\s　]+/)[0]
  const failAtDock = declaredFail && DOCK_CHECK_NAMES.includes(declaredName)
  const dock = DOCK_CHECK_NAMES.map((name, index) => {
    const dockFail = declaredFail && failAtDock && name === declaredName
    return {
      name,
      phase: 'dock' as const,
      result: dockFail ? ('fail' as const) : ('pass' as const),
      checkedAt: dockTime,
      checker: index === 0 ? String(row[BRIDGE_FIELDS.operator] ?? '') : '',
    }
  })
  if (status === BRIDGE_STATUS.aborted) {
    return [...dock, ...blankChecks(EVAC_CHECK_NAMES, 'evac')]
  }
  const failName =
    declaredFail && !failAtDock
      ? EVAC_CHECK_NAMES.find((name) => summary.includes(name)) ?? null
      : null
  const evac = EVAC_CHECK_NAMES.map((name) => ({
    name,
    phase: 'evac' as const,
    result: failName === name ? ('fail' as const) : ('pass' as const),
    checkedAt: evacTime,
    checker: '',
  }))
  if (status === BRIDGE_STATUS.evacuated) {
    return [...dock, ...evac]
  }
  // 已靠桥：撤桥项尚未到核验时点，一律待检。
  return [...dock, ...blankChecks(EVAC_CHECK_NAMES, 'evac')]
}

function groupSummary(label: string, items: CheckItem[]): string {
  const pass = items.filter((item) => item.result === 'pass').length
  const fail = items.filter((item) => item.result === 'fail').length
  const pending = items.filter((item) => item.result === 'pending').length
  const tails: string[] = []
  if (fail > 0) {
    tails.push(`${fail} 项未通过`)
  }
  if (pending > 0) {
    tails.push(`${pending} 项待检`)
  }
  return `${label} ${pass}/${items.length}${tails.length ? `（${tails.join('，')}）` : ' 全部通过'}`
}

export function checkSummary(items: CheckItem[]): string {
  return [
    groupSummary('靠桥', items.filter((item) => item.phase === 'dock')),
    groupSummary('撤桥', items.filter((item) => item.phase === 'evac')),
  ].join('；')
}

/** 由检查项结论 + 状态重算全部派生字段，状态与结论在同一写入里对齐，只落这一份。 */
function recompose(row: EntryRow, items: CheckItem[]): EntryRow {
  const status = String(row.status)
  const hasOpenFail = items.some((item) => item.result === 'fail')
  row[CHECK_ITEMS_KEY] = JSON.stringify(items)
  row[BRIDGE_FIELDS.checkSummary] = checkSummary(items)
  row[BRIDGE_FIELDS.statusText] = status
  row.abnormal = status === BRIDGE_STATUS.aborted || hasOpenFail
  row.pending = status !== BRIDGE_STATUS.evacuated && status !== BRIDGE_STATUS.aborted
  return row
}

export function hasUnclosedChecks(items: CheckItem[], phase?: CheckItem['phase']): boolean {
  const scoped = phase ? items.filter((item) => item.phase === phase) : items
  return scoped.some((item) => item.result !== 'pass')
}

function stampOpenAsPass(items: CheckItem[], phase: CheckItem['phase'], at: string, checker: string): void {
  for (const item of items) {
    if (item.phase === phase && item.result === 'pending') {
      item.result = 'pass'
      item.checkedAt = at
      item.checker = checker
    }
  }
}

function reopenPending(items: CheckItem[], phase: CheckItem['phase']): void {
  // 只把「待检」的项打回未核验；已登记未通过的结论保留——带着未通过项本身就是异常。
  for (const item of items) {
    if (item.phase === phase && item.result === 'pending') {
      item.checkedAt = ''
      item.checker = ''
    }
  }
}

// ---- 停机位占用回写：撤离/中止结论与机位占用同一事务改，机位读到的占用只有一份 ----

function findStand(stands: EntryRow[], standNo: string): number {
  return stands.findIndex((stand) => String(stand[STAND_FIELDS.no] ?? '') === standNo)
}

function claimStand(
  stands: EntryRow[],
  standNo: string,
  code: string,
  since: string,
): 'claimed' | 'synced' | 'busy' | 'blocked' | 'missing' {
  const index = findStand(stands, standNo)
  if (index < 0) {
    return 'missing'
  }
  const stand = stands[index]
  const current = String(stand.status)
  if (current === '占用中') {
    // 占用结论已在，但待办字段（时段/航班/展示状态）可能缺漏，回写补齐，保证只读到一份占用。
    let changed = false
    if (stand.pending !== true) {
      stand.pending = true
      changed = true
    }
    if (stand.abnormal !== false) {
      stand.abnormal = false
      changed = true
    }
    const period = `${since} 起`
    if (since && String(stand[STAND_FIELDS.occupiedPeriod] ?? '') === '') {
      stand[STAND_FIELDS.occupiedPeriod] = period
      changed = true
    }
    if (code && String(stand[STAND_FIELDS.currentFlight] ?? '') === '') {
      stand[STAND_FIELDS.currentFlight] = code
      changed = true
    }
    if (stand[STAND_FIELDS.statusText] !== '占用中') {
      stand[STAND_FIELDS.statusText] = '占用中'
      changed = true
    }
    return changed ? 'synced' : 'busy'
  }
  if (current !== '空闲') {
    return 'blocked'
  }
  stand.status = '占用中'
  stand.pending = true
  stand.abnormal = false
  stand[STAND_FIELDS.statusText] = '占用中'
  stand[STAND_FIELDS.occupiedPeriod] = `${since} 起`
  stand[STAND_FIELDS.currentFlight] = code
  return 'claimed'
}

function releaseStand(stands: EntryRow[], standNo: string): boolean {
  const index = findStand(stands, standNo)
  if (index < 0) {
    return false
  }
  const stand = stands[index]
  if (String(stand.status) !== '占用中') {
    return false
  }
  stand.status = '空闲'
  stand.pending = false
  stand.abnormal = false
  stand[STAND_FIELDS.statusText] = '空闲'
  stand[STAND_FIELDS.occupiedPeriod] = ''
  stand[STAND_FIELDS.currentFlight] = ''
  return true
}

type BridgeActionOutcome = {
  result: ActionResult
  bridges: EntryRow[]
  stands: EntryRow[]
  standsChanged: boolean
}

/**
 * 廊桥动作结算。状态机按 待靠接→已靠桥→已撤离 逐级推进；异常中止是终态分支，
 * 已异常中止的作业不许走撤离。异常量在状态落成已撤离/异常中止时只结算这一次，
 * 重复确认被状态机挡回，不会二次落库。
 */
export function applyBridgeAction(
  bridgeRows: EntryRow[],
  standRows: EntryRow[],
  id: number,
  action: string,
  at: string = nowText(),
): BridgeActionOutcome {
  const bridges = bridgeRows.map((row) => ({ ...row }))
  const stands = standRows.map((row) => ({ ...row }))
  const index = bridges.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { result: { ok: false, message: `没有找到编号为 ${id} 的廊桥作业` }, bridges: bridgeRows, stands: standRows, standsChanged: false }
  }
  const row = bridges[index]
  const current = String(row.status)
  const items = parseCheckItems(row)
  const standNo = String(row[BRIDGE_FIELDS.standNo] ?? '')
  const code = String(row[BRIDGE_FIELDS.code] ?? '')
  let standsChanged = false

  if (action === BRIDGE_ACTIONS.startDock) {
    if (current !== BRIDGE_STATUS.waiting) {
      return reject(bridges, stands, `廊桥作业当前为「${current}」，只能从待靠接开始靠接，不能跳步`)
    }
    if (hasUnclosedChecks(items, 'dock')) {
      return reject(bridges, stands, '存在未通过或待检的靠桥检查项，靠桥不能完成；如无法排除请登记中止')
    }
    const claim = claimStand(stands, standNo, code, at)
    if (claim === 'blocked') {
      return reject(bridges, stands, `对应机位 ${standNo} 当前不可占用（维护中/已封闭），不能靠桥`)
    }
    row[BRIDGE_FIELDS.dockTime] = at
    row.status = BRIDGE_STATUS.docked
    recompose(row, items)
    standsChanged = claim === 'claimed' || claim === 'synced'
    const suffix =
      claim === 'missing'
        ? `；未找到机位 ${standNo}，占用待办未回写`
        : claim === 'busy'
          ? '；机位此前已处于占用中'
          : claim === 'synced'
            ? '；已补全机位占用待办'
            : ''
    return done(`廊桥已靠桥，靠桥检查项全部通过，靠桥时间 ${at}${suffix}`, bridges, stands, standsChanged)
  }

  if (action === BRIDGE_ACTIONS.confirmEvac) {
    if (current === BRIDGE_STATUS.evacuated) {
      return reject(bridges, stands, '该次撤离已结算过，重复确认不再重复计异常量')
    }
    if (current === BRIDGE_STATUS.aborted) {
      return reject(bridges, stands, '异常中止的作业不许走撤离流程')
    }
    if (current !== BRIDGE_STATUS.docked) {
      return reject(bridges, stands, `廊桥作业当前为「${current}」，须先完成靠桥才能撤桥，不许跳步`)
    }
    if (hasUnclosedChecks(items)) {
      // 关键收口：差一项没通过也不许落已撤离，异常先挂在作业记录上，不再只出现在概览。
      recompose(row, items)
      return reject(bridges, stands, '靠桥或撤桥检查项仍有未通过/待检，检查项不收口不能确认撤离')
    }
    row[BRIDGE_FIELDS.evacTime] = at
    row.status = BRIDGE_STATUS.evacuated
    recompose(row, items)
    standsChanged = releaseStand(stands, standNo)
    return done(`撤离已确认，靠桥/撤桥检查项全部通过，撤桥时间 ${at}，机位 ${standNo} 已释放`, bridges, stands, standsChanged)
  }

  if (action === BRIDGE_ACTIONS.abort) {
    if (current === BRIDGE_STATUS.evacuated || current === BRIDGE_STATUS.aborted) {
      return reject(bridges, stands, `廊桥作业当前为「${current}」，不能再登记中止`)
    }
    row.status = BRIDGE_STATUS.aborted
    reopenPending(items, 'dock')
    reopenPending(items, 'evac')
    row[BRIDGE_FIELDS.evacTime] = ''
    recompose(row, items)
    const reachedDock = String(row[BRIDGE_FIELDS.dockTime] ?? '').trim() !== ''
    if (reachedDock) {
      // 靠桥之后中止：廊桥实际还接着飞机，机位保持占用待人工处置。
      const claim = claimStand(stands, standNo, code, String(row[BRIDGE_FIELDS.dockTime] ?? ''))
      standsChanged = claim === 'claimed' || claim === 'synced'
      return done('廊桥作业已登记异常中止，撤离流程关闭，机位保持占用待人工处置', bridges, stands, standsChanged)
    }
    standsChanged = releaseStand(stands, standNo)
    return done('廊桥作业已在靠桥前登记异常中止，未实际占用机位，撤离流程关闭', bridges, stands, standsChanged)
  }

  return reject(bridges, stands, `廊桥作业没有登记「${action}」这个动作`)
}

function reject(bridges: EntryRow[], stands: EntryRow[], message: string): BridgeActionOutcome {
  return { result: { ok: false, message }, bridges, stands, standsChanged: false }
}

function done(message: string, bridges: EntryRow[], stands: EntryRow[], standsChanged: boolean): BridgeActionOutcome {
  return { result: { ok: true, message }, bridges, stands, standsChanged }
}

/** 页面逐项登记检查结论；可登记的相位由当前作业状态约束。 */
export function setBridgeCheckResult(
  bridgeRows: EntryRow[],
  id: number,
  phase: CheckItem['phase'],
  name: string,
  result: Exclude<CheckItem['result'], 'pending'> | 'pending',
  at: string = nowText(),
): { result: ActionResult; bridges: EntryRow[] } {
  const bridges = bridgeRows.map((row) => ({ ...row }))
  const index = bridges.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { result: { ok: false, message: `没有找到编号为 ${id} 的廊桥作业` }, bridges: bridgeRows }
  }
  const row = bridges[index]
  const status = String(row.status)
  const editable =
    phase === 'dock'
      ? status === BRIDGE_STATUS.waiting || status === BRIDGE_STATUS.docked
      : status === BRIDGE_STATUS.docked
  if (!editable) {
    return {
      result: {
        ok: false,
        message:
          status === BRIDGE_STATUS.evacuated
            ? '作业已撤离结算，检查项凭证不可改动'
            : status === BRIDGE_STATUS.aborted
              ? '作业已异常中止，检查项凭证不可改动'
              : '撤桥检查项须在已靠桥后登记',
      },
      bridges: bridgeRows,
    }
  }
  const items = parseCheckItems(row)
  const target = items.find((item) => item.phase === phase && item.name === name)
  if (!target) {
    return { result: { ok: false, message: `没有找到检查项「${name}」` }, bridges: bridgeRows }
  }
  target.result = result
  if (result === 'pending') {
    target.checkedAt = ''
    target.checker = ''
  } else {
    target.checkedAt = target.checkedAt || at
    target.checker = target.checker || String(row[BRIDGE_FIELDS.operator] ?? '')
  }
  recompose(row, items)
  return { result: { ok: true, message: `检查项「${name}」已登记为${result === 'pass' ? '通过' : result === 'fail' ? '未通过' : '待检'}` }, bridges }
}

/**
 * 存量修复 + 跨模块对齐（落库时执行一次，幂等）：
 * 1. 已撤离却留未通过/待检检查项的记录，以检查项为准，按靠桥时间回退到已靠桥重修，
 *    撤桥时间作废、异常量结算一次；
 * 2. 已靠桥/异常中止的作业，对应机位必须读作占用中；已撤离的作业，对应机位必须空闲；
 * 3. 机位的「机位状态」展示字段与 status 对齐，任何入口读到的占用都只有一份。
 */
export function reconcileStore(
  map: Record<string, EntryRow[]>,
): { map: Record<string, EntryRow[]>; changed: boolean } {
  const next: Record<string, EntryRow[]> = { ...map }
  let changed = false

  const bridges = (next[BRIDGE_KEY] ?? []).map((row) => ({ ...row }))
  for (const row of bridges) {
    if (repairBridgeRow(row)) {
      changed = true
    }
  }
  if (next[BRIDGE_KEY]) {
    next[BRIDGE_KEY] = bridges
  }

  const stands = (next[STAND_KEY] ?? []).map((row) => ({ ...row }))
  for (const row of bridges) {
    const standNo = String(row[BRIDGE_FIELDS.standNo] ?? '')
    if (!standNo) {
      continue
    }
    const status = String(row.status)
    const code = String(row[BRIDGE_FIELDS.code] ?? '')
    const dockTime = String(row[BRIDGE_FIELDS.dockTime] ?? '')
    if (status === BRIDGE_STATUS.docked ||
      (status === BRIDGE_STATUS.aborted && String(row[BRIDGE_FIELDS.dockTime] ?? '').trim() !== '')) {
      const claim = claimStand(stands, standNo, code, dockTime)
      if (claim === 'claimed' || claim === 'synced') {
        changed = true
      }
    } else if (status === BRIDGE_STATUS.evacuated || status === BRIDGE_STATUS.aborted) {
      // 已撤离、或靠桥前就中止的作业，机位都必须空闲。
      if (releaseStand(stands, standNo)) {
        changed = true
      }
    }
  }
  for (const stand of stands) {
    if (stand[STAND_FIELDS.statusText] !== String(stand.status)) {
      stand[STAND_FIELDS.statusText] = String(stand.status)
      changed = true
    }
  }
  if (next[STAND_KEY]) {
    next[STAND_KEY] = stands
  }

  return { map: next, changed }
}

function repairBridgeRow(row: EntryRow): boolean {
  const before = JSON.stringify(row)
  const items = parseCheckItems(row)
  const status = String(row.status)
  const dockTime = String(row[BRIDGE_FIELDS.dockTime] ?? '')
  const evacTime = String(row[BRIDGE_FIELDS.evacTime] ?? '')

  if (status === BRIDGE_STATUS.waiting) {
    row[BRIDGE_FIELDS.dockTime] = ''
    row[BRIDGE_FIELDS.evacTime] = ''
    for (const item of items) {
      item.result = 'pending'
      item.checkedAt = ''
      item.checker = ''
    }
  } else if (status === BRIDGE_STATUS.docked) {
    if (!dockTime) {
      row[BRIDGE_FIELDS.dockTime] = latestCheckedAt(items, 'dock')
    }
    row[BRIDGE_FIELDS.evacTime] = ''
  } else if (status === BRIDGE_STATUS.aborted) {
    // 中止作业不靠检查项核验时间反推靠桥时间：没走到靠桥完成，靠桥时间就保持空。
    row[BRIDGE_FIELDS.evacTime] = ''
    reopenPending(items, 'evac')
  } else if (status === BRIDGE_STATUS.evacuated) {
    if (hasUnclosedChecks(items)) {
      // 凭证与状态冲突：以检查项结论为准，锚定靠桥时间回退到已靠桥，撤桥结论作废重修。
      row.status = BRIDGE_STATUS.docked
      row[BRIDGE_FIELDS.evacTime] = ''
      reopenPending(items, 'evac')
      if (!dockTime) {
        row[BRIDGE_FIELDS.dockTime] = latestCheckedAt(items, 'dock')
      }
    } else {
      if (!dockTime) {
        row[BRIDGE_FIELDS.dockTime] = latestCheckedAt(items, 'dock')
      }
      if (!evacTime) {
        row[BRIDGE_FIELDS.evacTime] = latestCheckedAt(items, 'evac')
      }
    }
  }

  recompose(row, items)
  return JSON.stringify(row) !== before
}

function latestCheckedAt(items: CheckItem[], phase: CheckItem['phase']): string {
  const times = items.filter((item) => item.phase === phase && item.checkedAt).map((item) => item.checkedAt)
  return times.length ? times.sort().reverse()[0] : ''
}

/**
 * 其它入口（机位分配页等）改机位状态前的闸口：只要还有已靠桥/异常中止且实际靠过桥的
 * 廊桥作业指向该机位，机位就必须读作占用，不能从机位侧绕过廊桥直接释放或封闭。
 */
export function activeBridgeOnStand(bridgeRows: EntryRow[], standNo: string): EntryRow | null {
  return (
    bridgeRows.find((row) => {
      if (String(row[BRIDGE_FIELDS.standNo] ?? '') !== standNo) {
        return false
      }
      const status = String(row.status)
      if (status === BRIDGE_STATUS.docked) {
        return true
      }
      if (status === BRIDGE_STATUS.aborted && String(row[BRIDGE_FIELDS.dockTime] ?? '').trim() !== '') {
        return true
      }
      return false
    }) ?? null
  )
}
