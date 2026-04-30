import { ALL_SHOP_LIST_HELPER_COPIES } from './shopInputCopy'

/** Remove invisible / formatting chars browsers sometimes leave in the textarea (not stripped by .trim()). */
function stripInvisibleAndTrim(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u200E\u200F\u202A-\u202E\u2060]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim()
}

/**
 * Split a pasted or typed list into individual items (commas, semicolons, newlines).
 * Drops segments with no letters or digits so “empty-looking” boxes can’t build a shop.
 */
export function parseShopListInput(text: string): string[] {
  const raw = stripInvisibleAndTrim(text)
  if (!raw) return []
  return raw
    .split(/[\n,;]+/u)
    .map((s) => stripInvisibleAndTrim(s))
    .filter((s) => s.length > 0 && /[\p{L}\p{N}]/u.test(s) && !isNoiseListLine(s))
}

/** Normalized form for comparing user text to our on-screen helper blocks (exact match). */
export function shopListPlaceholderFingerprint(text: string): string {
  return stripInvisibleAndTrim(text)
    .toLowerCase()
    .replace(/\u2019|\u2018/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

const KNOWN_PLACEHOLDER_FINGERPRINTS = new Set<string>(
  ALL_SHOP_LIST_HELPER_COPIES.map((c) => shopListPlaceholderFingerprint(c)),
)

/**
 * True when the textarea contains our grey hint / marketing copy (not a real list).
 * That copy has many commas — if parsed as a list it wrongly “builds” dozens of fake items.
 */
export function isLikelyUiPlaceholderList(text: string): boolean {
  const fp = shopListPlaceholderFingerprint(text)
  if (KNOWN_PLACEHOLDER_FINGERPRINTS.has(fp)) return true
  const n = fp
  if (
    n.includes('try milk') &&
    n.includes('pasta') &&
    n.includes('bread') &&
    (n.includes('upload') || n.includes('say a list') || n.includes('type') || n.includes('paste'))
  )
    return true
  if (
    (n.includes("we'll build your shop") || n.includes('build your shop in seconds')) &&
    n.includes('review and edit')
  )
    return true
  if (n.includes('need inspiration') && n.includes('meals and items below')) return true
  if (n.length < 32) return false
  if (
    n.includes('try milk, pasta, bread') &&
    n.includes('type, paste') &&
    n.includes('upload or say')
  )
    return true
  return false
}

/** Comma-split fragments from our UI copy / marketing lines — not real products. */
function isNoiseListLine(line: string): boolean {
  const t = stripInvisibleAndTrim(line).toLowerCase().replace(/\u2019|\u2018/g, "'")
  if (t.length === 0) return true
  if (/^(type|paste|or|a|the|and|we|ll|to|of|in|on|at|for|say|list|tap|add|by|using|mic|an|your|shop|seconds|review|edit|below|more|any|time)\.?$/u.test(t))
    return true
  if (/^upload or say a list\.?$/u.test(t)) return true
  if (/bread\s*-\s*type/u.test(t)) return true
  if (/we'?ll build your shop/u.test(t)) return true
  if (/review and edit/u.test(t)) return true
  if (/need inspiration/u.test(t)) return true
  if (/meals and items below/u.test(t)) return true
  if (/add more by typing/u.test(t)) return true
  return false
}

/** Safe list lines for building a shop — never treats UI placeholder copy as products. */
export function getShopListLinesFromUserInput(text: string): string[] {
  const raw = stripInvisibleAndTrim(text)
  if (!raw) return []
  if (isLikelyUiPlaceholderList(raw)) return []
  return parseShopListInput(raw)
}

const MEAL_HINTS = [
  'spag',
  'bpag', // Cyrillic-confusable variant of 'spag' (В normalises to B)
  'bolognese',
  'curry',
  'shepherd',
  'lasagne',
  'lasagna',
  'fajita',
  'tagine',
  'risotto',
  'biryani',
  'korma',
  'tikka',
  'pad thai',
  'ramen',
  'stroganoff',
  'casserole',
  'stir fry',
  'stir-fry',
  'hotpot',
  'dhal',
  'dahl',
  'teriyaki',
  'carbonara',
  'parmigiana',
  'enchilada',
  'macaroni',
  'goulash',
  'chili con',
  'chilli con',
  'paella',
  'moussaka',
  'wellington',
  'jalfrezi',
  'massaman',
  'rendang',
  'fish pie',
  'mac and cheese',
  'cottage pie',
  'pie for',
  'pasta bake',
  'roast chicken',
  'roast beef',
  'roast lamb',
  'roast pork',
  'thai green',
  'thai red',
  'green thai',
  'red thai',
  'lemon drizzle',
  'drizzle cake',
  'cake',
]

/**
 * Words that, when present alongside a MEAL_HINT, indicate the line is an
 * ingredient/product rather than a dish to cook (e.g. "Lasagne Sauce",
 * "Dolmio Sauce", "Curry Paste", "Tikka Marinade").
 */
const INGREDIENT_QUALIFIERS = [
  'sauce', 'sheets', 'pasta', 'mix', 'kit', 'jar', 'tin', 'can',
  'paste', 'powder', 'spice', 'seasoning', 'marinade', 'stock',
  'base', 'meal kit', 'ready meal', 'ready-meal',
]

/** Heuristic: treat a line as a meal group if it looks like a dish rather than a single ingredient. */
export function isLikelyMealLine(line: string): boolean {
  const t = line.toLowerCase()
  if (t.length >= 28) return true
  if (!MEAL_HINTS.some((h) => t.includes(h))) return false
  // Override: if the line looks like a product (sauce, sheets, paste…) it's an essential.
  if (INGREDIENT_QUALIFIERS.some((q) => t.includes(q))) return false
  return true
}
