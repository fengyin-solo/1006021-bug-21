import { normalizeStore } from './bridge-domain'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 结构版本变了就读取时迁移：检查项结论/作业状态/机位占用历史脏数据在这一层统一收口。
const VERSION_KEY = 'airport-ground-ops:entries-version'
const STORAGE_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function writeStorage(next: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
  }
}

function readStorage(): { data: Record<string, EntryRow[]>; changed: boolean } {
  const seed = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return { data: normalizeStore(seed), changed: false }
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const version = window.localStorage.getItem(VERSION_KEY)
  if (!raw) {
    const data = normalizeStore(seed)
    writeStorage(data)
    return { data, changed: false }
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = { ...seed, ...(JSON.parse(raw) as Record<string, EntryRow[]>) }
  } catch {
    const data = normalizeStore(seed)
    writeStorage(data)
    return { data, changed: false }
  }
  // 老版本（检查项与状态分落的脏数据）或防御性读取：读出即对齐并回写一次。
  const changed = version !== String(STORAGE_VERSION)
  const data = normalizeStore(parsed)
  if (changed) {
    writeStorage(data)
  }
  return { data, changed }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage().data
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 整库写入（廊桥与机位两张表必须在同一笔写入里对齐，避免半写状态被其它入口读到）。
export function saveStore(next: Record<string, EntryRow[]>): void {
  const aligned = normalizeStore(next)
  cache = aligned
  writeStorage(aligned)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveStore({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return listRows(key)
}

export function storageKey(): string {
  return STORAGE_KEY
}
