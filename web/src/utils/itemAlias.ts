/**
 * 名称别名（gameConfig/ItemAlias.json）。
 *
 * 上游停更后协议里的新道具（如红薯 307 系列）在官方 ItemInfo 快照里没有条目，
 * 后端只能输出「物品40307」这种占位名。前端再兜一层：
 * 从同源静态目录拉别名表，只替换占位名，不覆盖后端已经给出的真实名字。
 * 这样补别名只要换 JSON，不用重启后端、不掉登录态。
 */

export interface ItemAliasEntry {
  name: string
  type: number
}

let aliasPromise: Promise<Record<string, ItemAliasEntry>> | null = null

function normalizeRaw(raw: any): Record<string, ItemAliasEntry> {
  const map: Record<string, ItemAliasEntry> = {}
  for (const [key, value] of Object.entries(raw || {})) {
    const id = Number(key)
    if (!Number.isFinite(id) || id <= 0)
      continue
    const entry: any = value
    const name = String(typeof entry === 'string' ? entry : entry?.name || '').trim()
    if (!name)
      continue
    map[String(id)] = {
      name,
      type: Number(entry && typeof entry === 'object' ? entry.type : 0) || 0,
    }
  }
  return map
}

export function loadItemAlias(): Promise<Record<string, ItemAliasEntry>> {
  if (!aliasPromise) {
    aliasPromise = fetch('/game-config/ItemAlias.json')
      .then(res => (res.ok ? res.json() : {}))
      .then(normalizeRaw)
      .catch(() => ({}))
  }
  return aliasPromise
}

const TYPE_CATEGORY: Record<number, string> = { 5: 'seed', 6: 'fruit', 17: 'mutant' }

const PLACEHOLDER_NAME = /^物品\s*#?\d+$/

/** 只修占位名/缺类型，后端给出的真实名字和类型一律不动。 */
export function applyItemAliasToItem(item: any, alias: Record<string, ItemAliasEntry>): any {
  if (!item || typeof item !== 'object')
    return item
  const entry = alias[String(Number(item.id) || 0)]
  if (!entry)
    return item
  const patch: any = {}
  const name = String(item.name || '').trim()
  if (!name || PLACEHOLDER_NAME.test(name))
    patch.name = entry.name
  if (entry.type > 0) {
    const currentType = Number(item.itemType || 0)
    if (!currentType) {
      patch.itemType = entry.type
      if (!item.category || item.category === 'item')
        patch.category = TYPE_CATEGORY[entry.type] || item.category
    }
  }
  return Object.keys(patch).length ? { ...item, ...patch } : item
}

export function applyItemAliasToItems(items: any[], alias: Record<string, ItemAliasEntry>): any[] {
  if (!Array.isArray(items) || !items.length)
    return items
  return items.map((item: any) => applyItemAliasToItem(item, alias))
}
