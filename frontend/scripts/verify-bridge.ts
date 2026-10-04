// 廊桥链路端到端验证：不依赖浏览器，用内存 localStorage 垫片驱动本地数据层。
// 用法：npx tsx scripts/verify-bridge.ts
import { loadOverview, listEntries, recordBridgeCheck, resetModule, runAction } from '../src/api/local-service'
import {
  BRIDGE_ACTIONS,
  BRIDGE_FIELDS,
  parseCheckItems,
} from '../src/data/bridge'

let store: Record<string, string> = {}
;(globalThis as { window?: unknown }).window = globalThis
;(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value
  },
  removeItem: (key: string) => delete store[key],
  clear: () => {
    store = {}
  },
  key: () => null,
  get length() {
    return Object.keys(store).length
  },
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
function bridge(id: number) {
  const row = listEntries('bridge').items.find((item) => Number(item.id) === id)
  if (!row) throw new Error(`missing bridge ${id}`)
  return row
}
function stand(no: string) {
  const row = listEntries('stand').items.find((item) => String(item['机位编号']) === no)
  if (!row) throw new Error(`missing stand ${no}`)
  return row
}
function overviewAbnormal(moduleName: string) {
  const mod = loadOverview().modules.find((item) => item.name === moduleName)
  return mod?.abnormal
}

// ---------- 场景 0：存量修复 ----------
console.log('存量修复（已撤离夹未通过撤桥项，按靠桥时间回填）')
const old = bridge(3)
check('已撤离夹未通过项的记录回退为已靠桥', String(old.status) === '已靠桥', String(old.status))
check('回退后锚定靠桥时间不变', String(old[BRIDGE_FIELDS.dockTime]) === '2026-09-03 08:55')
check('回退后撤桥时间作废', String(old[BRIDGE_FIELDS.evacTime]) === '')
check('回退后异常量在作业记录里结算为 1', old.abnormal === true)
check('作业记录与概览异常量一致（同一条不是两个结论）', overviewAbnormal('廊桥靠接') === 2)
check('回退后机位 STAN-0003 重新读作占用中', String(stand('STAN-0003').status) === '占用中')

// ---------- 场景 0b：已靠桥带未通过靠桥项 ----------
const docked = bridge(2)
const dockedItems = parseCheckItems(docked)
check('已靠桥记录的未通过项落在靠桥相位并保留', dockedItems.some((i) => i.phase === 'dock' && i.name === '接机口对接到位' && i.result === 'fail'))
check('已靠桥带未通过项时作业记录为异常', docked.abnormal === true)
check('已靠桥时撤桥检查项保持待检', dockedItems.filter((i) => i.phase === 'evac').every((i) => i.result === 'pending'))
check('已靠桥记录的机位待办一致占用', String(stand('STAN-0002').status) === '占用中' && String(stand('STAN-0002')['当前航班']) === 'BRID-0002')

// ---------- 场景 1：检查项不收口不许落已撤离 ----------
console.log('\n确认撤离收口校验')
let r = runAction('bridge', 3, BRIDGE_ACTIONS.confirmEvac)
check('有未通过撤桥项时确认撤离被拒绝', r.ok === false, r.message)
check('拒绝后状态仍为已靠桥（没硬落已撤离）', String(bridge(3).status) === '已靠桥')

// 修好检查项：把遗留的 fail 项登记成通过
const failingItem = parseCheckItems(bridge(3)).find((item) => item.result === 'fail')
check('存在遗留未通过项', Boolean(failingItem), '未找到 fail 项')
if (failingItem) {
  const rr = recordBridgeCheck(3, failingItem.phase, failingItem.name, 'pass')
  check('未通过项可登记为通过', rr.ok, rr.message)
}
check('修好后作业记录异常清零', bridge(3).abnormal === false)
check('修好后概览异常量同步为 1', overviewAbnormal('廊桥靠接') === 1, String(overviewAbnormal('廊桥靠接')))

// ---------- 场景 2：正常撤离 + 机位释放 + 重复确认只结算一次 ----------
console.log('\n正常撤离与重复确认')
r = runAction('bridge', 3, BRIDGE_ACTIONS.confirmEvac)
check('全部通过后确认撤离成功', r.ok, r.message)
check('状态落成已撤离', String(bridge(3).status) === '已撤离')
check('撤桥时间已回写', String(bridge(3)[BRIDGE_FIELDS.evacTime]).length > 0)
check('已撤离不再异常', bridge(3).abnormal === false)
check('撤离后机位 STAN-0003 释放为空闲', String(stand('STAN-0003').status) === '空闲')
check('机位占用时段清空', String(stand('STAN-0003')['占用时段']) === '')
check('机位状态展示字段与 status 一致', String(stand('STAN-0003')['机位状态']) === '空闲')
const abnormalBeforeRepeat = overviewAbnormal('廊桥靠接')
r = runAction('bridge', 3, BRIDGE_ACTIONS.confirmEvac)
check('重复确认撤离被拒绝', r.ok === false, r.message)
check('重复确认不改变异常量', overviewAbnormal('廊桥靠接') === abnormalBeforeRepeat)

// ---------- 场景 3：逐级推进不许跳步 ----------
console.log('\n状态逐级推进')
r = runAction('bridge', 1, BRIDGE_ACTIONS.confirmEvac)
check('待靠接直接确认撤离（跳步）被拒绝', r.ok === false, r.message)
check('待靠接登记中止允许（中止分支）', runAction('bridge', 1, BRIDGE_ACTIONS.abort).ok)
r = runAction('bridge', 1, BRIDGE_ACTIONS.confirmEvac)
check('异常中止后不许走撤离', r.ok === false, r.message)
check('靠桥前中止的作业靠桥时间为空', String(bridge(1)[BRIDGE_FIELDS.dockTime]) === '')
check('靠桥前中止不占用机位 STAN-0001', String(stand('STAN-0001').status) === '空闲')
check('中止作业本身计异常', bridge(1).abnormal === true)

// ---------- 场景 4：靠桥检查项须全通过 ----------
console.log('\n开始靠接收口')
resetModule('bridge')
// id=1 待靠接，检查项全待检
r = runAction('bridge', 1, BRIDGE_ACTIONS.startDock)
check('靠桥检查项未逐项登记通过时开始靠接被拒绝', r.ok === false, r.message)
const dockItems = parseCheckItems(bridge(1)).filter((item) => item.phase === 'dock')
for (const item of dockItems) {
  recordBridgeCheck(1, 'dock', item.name, 'pass')
}
r = runAction('bridge', 1, BRIDGE_ACTIONS.startDock)
check('靠桥检查项全通过后开始靠接成功', r.ok, r.message)
check('靠桥时间已回写', String(bridge(1)[BRIDGE_FIELDS.dockTime]).length > 0)
check('靠桥后机位 STAN-0001 占用中', String(stand('STAN-0001').status) === '占用中')
check('机位占用待办写入作业编号', String(stand('STAN-0001')['当前航班']) === 'BRID-0001')

// 两个时点都能从检查项凭证核出来
const afterDock = parseCheckItems(bridge(1))
check('靠桥时点可从检查项核验时间核出', afterDock.some((i) => i.phase === 'dock' && i.checkedAt))
check('靠桥后撤桥检查项仍待检', afterDock.some((i) => i.phase === 'evac' && i.result === 'pending'))

// ---------- 场景 5：机位占用只有一份结论 ----------
console.log('\n下游一致性')
const s = stand('STAN-0001')
check('机位 status 与机位状态字段一致', String(s.status) === String(s['机位状态']))

// 机位页不能绕过廊桥直接释放/封闭仍被占用的机位
const standId = Number(s.id)
let rr = runAction('stand', standId, '释放机位')
check('机位侧释放被在桥作业挡住', rr.ok === false, rr.message)
rr = runAction('stand', standId, '封闭机位')
check('机位侧封闭被在桥作业挡住', rr.ok === false, rr.message)
check('被挡后机位仍占用', String(stand('STAN-0001').status) === '占用中')

// 走廊桥撤离释放后，机位侧才能正常操作
for (const item of parseCheckItems(bridge(1)).filter((i) => i.phase === 'evac')) {
  recordBridgeCheck(1, 'evac', item.name, 'pass')
}
check('撤离后机位侧释放允许', runAction('bridge', 1, BRIDGE_ACTIONS.confirmEvac).ok)
check('廊桥撤离后机位空闲', String(stand('STAN-0001').status) === '空闲')

// ---------- 汇总 ----------
console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
