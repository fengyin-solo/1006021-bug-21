import { reconcileStore } from './bridge'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function writeStorage(map: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  }
}

function normalize(map: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 修复存量冲突（已撤离夹未通过检查项等）并对齐机位占用；幂等，正常数据原样通过。
  const { map: repaired, changed } = reconcileStore(map)
  if (changed) {
    writeStorage(repaired)
  }
  return repaired
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalize(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalize(fallback)
    writeStorage(seeded)
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return normalize({ ...fallback, ...parsed })
  } catch {
    const seeded = normalize(fallback)
    writeStorage(seeded)
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  writeStorage(next)
}

/** 跨模块原子写入（如廊桥撤离同时回写停机位占用）：只落一次盘，两个模块读到的是同一份结论。 */
export function saveRowsBatch(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  cache = next
  writeStorage(next)
}

export function resetRows(key: string): EntryRow[] {
  // 先落重置结果，再跑一次跨模块对齐，避免重置廊桥后机位仍挂旧占用、或反过来。
  const next = { ...allRows(), [key]: clone(SEED_ROWS[key] ?? []) }
  const { map: repaired } = reconcileStore(next)
  cache = repaired
  writeStorage(repaired)
  return repaired[key] ?? []
}

export function storageKey(): string {
  return STORAGE_KEY
}
