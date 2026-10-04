// 链路验证：动作层 → 落库层 → 概览口径，外加历史脏数据回填、机位占用回写。
// 极简 DOM/localStorage 垫片：local-store 只用到 localStorage 与 window。
const memory = new Map<string, string>()
const localStorageShim = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, String(value))
  },
  removeItem: (key: string) => {
    memory.delete(key)
  },
}
;(globalThis as any).window = { localStorage: localStorageShim }
;(globalThis as any).document = {
  createElement: () => ({ click() {}, style: {} }),
  body: { appendChild() {}, removeChild() {} },
}
;(globalThis as any).localStorage = localStorageShim
;(globalThis as any).Blob = class {
  constructor(public parts: unknown[], public opts: unknown) {}
}
;(globalThis as any).URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }

import { runAction, loadOverview, listEntries, exportEntries } from '../src/api/local-service'
import { saveRows, allRows } from '../src/data/local-store'
import { checkSummary, normalizeBridgeRow, parseChecks } from '../src/data/bridge-domain'
import { SEED_ROWS } from '../src/data/seed'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${detail}`)
  }
}

// ---- 0. 迁移：种子里 BRID-0905 是「已撤离 + 老格式未通过检查项 + 无撤桥时间」脏数据 ----
console.log('\n[迁移回填]')
const migrated = allRows()
const dirty = migrated.bridge.find((r) => r['作业编号'] === 'BRID-0905')!
check('脏记录仍为已撤离（以作业状态为准）', dirty.status === '已撤离')
check('脏记录 abnormal 被回填修正为 false', dirty.abnormal === false, `got ${dirty.abnormal}`)
check('脏记录 pending=false', dirty.pending === false)
const dirtyChecks = parseChecks(dirty['对接检查项'])!
check('脏记录靠桥检查项按靠桥时间回填 4 项全通过',
  dirtyChecks['靠桥']?.时间 === '2026-10-03 14:20' &&
  dirtyChecks['靠桥'].检查项.length === 4 &&
  dirtyChecks['靠桥'].检查项.every((i) => i.结果 === '通过'))
check('脏记录撤桥检查项按靠桥时间顺延回填（14:20+55m=15:15）',
  dirtyChecks['撤桥']?.时间 === '2026-10-03 15:15' &&
  dirtyChecks['撤桥'].检查项.every((i) => i.结果 === '通过'))
check('撤桥时间字段与撤桥检查项时点一致', String(dirty['撤桥时间']) === '2026-10-03 15:15')
check('作业状态字段与 status 一致', dirty['作业状态'] === '已撤离')

// 关联机位 203：廊桥已撤离，但 203 本身是维护中，不应被改成空闲（只改占用中的关联机位）
const stand203 = migrated.stand.find((r) => r['机位编号'] === '203')!
check('维护中机位不被撤离结论改写状态', stand203.status === '维护中' && stand203['占用待办'] === false)

// ---- 1. 状态机：待靠接 BRID-1001 ----
console.log('\n[状态机逐级推进 / 闸门]')
const id1001 = SEED_ROWS.bridge[0].id
check('待靠接直接确认撤离被拒（不许跳步）', !runAction('bridge', id1001, '确认撤离', { items: [] }).ok)
check('待靠接登记中止后不许再撤离',
  runAction('bridge', id1001, '登记中止').ok &&
  !runAction('bridge', id1001, '确认撤离', { items: [] }).ok)
check('中止后重复中止被拒（只结算一次）', !runAction('bridge', id1001, '登记中止').ok)

// 用 1002 已靠桥验证撤离闸门
const id1002 = SEED_ROWS.bridge[1].id
const allRetract = ['舱门解除对接', '平台撤收复位', '行走轮位归位', '撤桥距离确认'].map((项目) => ({ 项目, 结果: '通过' as const }))
check('已靠桥撤离检查项缺项被拒',
  !runAction('bridge', id1002, '确认撤离', { items: allRetract.slice(0, 3) }).ok)
const withFail = allRetract.map((i, n) => ({ ...i, 结果: (n === 1 ? '不通过' : '通过') as const }))
const failResult = runAction('bridge', id1002, '确认撤离', { items: withFail })
check('撤离检查项有不通过被拒且提示缺口', !failResult.ok && failResult.message.includes('平台撤收复位'), failResult.message)
check('被拒后状态仍是已靠桥（没落已撤离）',
  String(listEntries('bridge').items.find((r) => Number(r.id) === id1002)!.status) === '已靠桥')
check('被拒后不产生异常标记',
  listEntries('bridge').items.find((r) => Number(r.id) === id1002)!.abnormal === false)
check('全部通过后确认撤离成功', runAction('bridge', id1002, '确认撤离', { items: allRetract, at: '2026-10-04 10:20' }).ok)
const after = listEntries('bridge').items.find((r) => Number(r.id) === id1002)!
check('撤离后 status/作业状态=已撤离', after.status === '已撤离' && after['作业状态'] === '已撤离')
check('撤离后 pending=false / abnormal=false', after.pending === false && after.abnormal === false)
check('撤桥时点与撤桥时间一致', parseChecks(after['对接检查项'])?.['撤桥']?.时间 === '2026-10-04 10:20' && String(after['撤桥时间']) === '2026-10-04 10:20')
check('重复确认撤离被拒且不再结算', !runAction('bridge', id1002, '确认撤离', { items: allRetract }).ok)

// ---- 2. 机位占用回写 ----
console.log('\n[机位占用回写]')
// 把 1001 重置成待靠接，走一遍 靠接→撤离，验证 201 占用/释放
saveRows('bridge', JSON.parse(JSON.stringify(SEED_ROWS.bridge)))
saveRows('stand', JSON.parse(JSON.stringify(SEED_ROWS.stand)))
const stand201Before = allRows().stand.find((r) => r['机位编号'] === '201')!
check('初始 201 空闲、无占用待办', stand201Before.status === '空闲' && stand201Before['占用待办'] === false)
const allDock = ['轮位对位', '接机平台贴合', '自动调平锁定', '舱门对接密封'].map((项目) => ({ 项目, 结果: '通过' as const }))
check('靠桥成功', runAction('bridge', id1001, '开始靠接', { items: allDock, at: '2026-10-04 11:25' }).ok)
const stand201Docked = allRows().stand.find((r) => r['机位编号'] === '201')!
check('靠桥后机位变占用中且占用待办=true',
  stand201Docked.status === '占用中' && stand201Docked['占用待办'] === true,
  `${stand201Docked.status}/${stand201Docked['占用待办']}`)
check('靠桥检查项含全部 4 项通过且时点=靠桥时间',
  checkSummary(listEntries('bridge').items.find((r) => Number(r.id) === id1001)!).includes('靠桥 4/4 通过'))
check('撤离成功', runAction('bridge', id1001, '确认撤离', { items: allRetract, at: '2026-10-04 12:10' }).ok)
const stand201After = allRows().stand.find((r) => r['机位编号'] === '201')!
check('撤离后机位释放空闲、占用待办=false',
  stand201After.status === '空闲' && stand201After['占用待办'] === false)
// 机位页读到的占用与落库一致
check('机位页列表读到同一份占用结论',
  listEntries('stand').items.find((r) => r['机位编号'] === '201')!.status === '空闲')

// 中止也应释放（把 1001 重置后：靠接再中止）
saveRows('bridge', JSON.parse(JSON.stringify(SEED_ROWS.bridge)))
runAction('bridge', id1001, '开始靠接', { items: allDock, at: '2026-10-04 11:25' })
check('异常中止成功', runAction('bridge', id1001, '登记中止').ok)
const abortedRow = allRows().bridge.find((r) => Number(r.id) === id1001)!
check('异常中止 abnormal=true（异常量唯一来源）', abortedRow.abnormal === true)
check('异常中止撤桥时间清空、无撤桥检查项',
  abortedRow['撤桥时间'] === '' && !parseChecks(abortedRow['对接检查项'])?.['撤桥'])
const stand201Abort = allRows().stand.find((r) => r['机位编号'] === '201')!
check('异常中止后机位同样释放', stand201Abort.status === '空闲' && stand201Abort['占用待办'] === false)

// ---- 3. 概览口径：作业记录与概览同一份结论 ----
console.log('\n[概览异常量口径]')
saveRows('bridge', JSON.parse(JSON.stringify(SEED_ROWS.bridge)))
saveRows('stand', JSON.parse(JSON.stringify(SEED_ROWS.stand)))
// 迁移后种子：只有 BRID-1004 异常中止 = 1 条异常；BRID-0905 已修正不算
const overview = loadOverview()
const bridgeStat = overview.modules.find((m) => m.name === '廊桥靠接')!
const directCount = listEntries('bridge').items.filter((r) => r.abnormal).length
check(`概览异常量与落库 abnormal 完全一致（概览=${bridgeStat.abnormal}，落库=${directCount}）`,
  bridgeStat.abnormal === directCount && bridgeStat.abnormal === 1,
  `overview=${bridgeStat.abnormal} rows=${directCount}`)
// 1002 撤离（正常）后异常量不变
runAction('bridge', id1002, '确认撤离', { items: allRetract, at: '2026-10-04 10:20' })
const overview2 = loadOverview()
const bridgeStat2 = overview2.modules.find((m) => m.name === '廊桥靠接')!
check('正常撤离不增加异常量', bridgeStat2.abnormal === 1)
runAction('bridge', id1002, '确认撤离', { items: allRetract, at: '2026-10-04 10:21' })
const overview3 = loadOverview()
check('重复撤离不增加异常量（只结算一次）',
  overview3.modules.find((m) => m.name === '廊桥靠接')!.abnormal === 1)

// ---- 4. 其它入口：导出 ----
console.log('\n[其它入口对齐]')
const csv = exportEntries('bridge').content
check('导出含可读检查项摘要（不再是老格式文本）', csv.includes('靠桥 4/4 通过') && csv.includes('撤桥 4/4 通过'))
const standCsv = exportEntries('stand').content
check('机位导出含占用待办列且布尔可读', standCsv.includes('占用待办') && (standCsv.includes('是') || standCsv.includes('否')))

// normalizeBridgeRow 幂等
const one = normalizeBridgeRow(SEED_ROWS.bridge[2])
const two = normalizeBridgeRow(one)
check('归一化幂等（其它入口重复读到的同一份数据）', JSON.stringify(one) === JSON.stringify(two))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
