import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { recognize } from 'tesseract.js'
import { MyTrolleyView, type TrolleyLine } from './components/my-trolley-view'
import { EssentialProductPod, IconBin, IconChevronMeal, IconPen, RecipeProductPod } from './components/shopping-list-pods'
import { ProductAutocomplete } from './components/product-autocomplete'
import { runVisionOcr } from './lib/visionOcr'
import { bestCatalogMatch, topCatalogMatches } from './lib/catalogMatch'
import {
  deriveInputMode,
  detectPastedMultiItemList,
  getActiveInputLine,
  shouldShowAutocomplete,
  type InputMode,
  type ProductSuggestion,
} from './lib/inputExperience'
import { lineMatchesManualEssential, rankCatalogHitsWithPersonalization, rankProductsForEntry } from './lib/listEntryPrediction'
import {
  isRecipeCatalogHit,
  filterSwapAlternatives,
  resolveSwapIngredientIntent,
  swapSearchQuery,
} from './lib/recipeIngredientMatch'
import { getShopListLinesFromUserInput, isLikelyMealLine, isLikelyUiPlaceholderList } from './lib/parseShopList'
import { searchProductSuggestions, enrichSuggestionFromCatalog } from './lib/productAutocomplete'
import {
  SHOP_LIST_HELPER_INITIAL,
} from './lib/shopInputCopy'
import { loadCatalogForBuildShop, catalogProductImage, type WaitroseCatalogItem } from './lib/waitroseCatalog'
import {
  MEAL_CHIP_ORDER_BY_CUISINE,
  chipLabelForMeal,
  methodUrlForMeal,
  waitroseRecipeMethodUrl,
  findMealRecipeForLine,
  type Cuisine,
  type RecipeIngredient,
} from './data/mealRecipes'

type DietOption = 'Vegetarian' | 'Vegan' | 'Gluten free' | 'Pescatarian'
type RangeOption = 'No 1 Range' | 'Essentials' | 'Organic'
type HouseholdOption = 'Serves 1' | 'Serves 2' | 'Serves 3' | 'Serves 4' | 'Serves 5' | 'Serves 6+'
type SwapRefinement = 'All' | 'Organic' | 'Vegan' | 'Vegetarian' | 'Gluten-free' | 'Essential' | 'No.1'

const SWAP_REFINEMENT_OPTIONS: SwapRefinement[] = [
  'All',
  'Organic',
  'Vegan',
  'Vegetarian',
  'Gluten-free',
  'Essential',
  'No.1',
]

type BuildPreferencesState = {
  dietSelections: DietOption[]
  rangeSelections: RangeOption[]
  household: HouseholdOption | null
  itemsOnly: boolean
}

function emptyBuildPreferences(): BuildPreferencesState {
  return {
    dietSelections: [],
    rangeSelections: [],
    household: null,
    itemsOnly: false,
  }
}

function copyBuildPreferences(preferences: BuildPreferencesState): BuildPreferencesState {
  return {
    ...preferences,
    dietSelections: [...preferences.dietSelections],
    rangeSelections: [...preferences.rangeSelections],
  }
}

type Ingredient = {
  id: string
  name: string
  needText: string
  price: number
  unitPrice: string
  qty: number
  selected: boolean
  image: string
  productType?: string
  /** Internal: whether this ingredient was matched to a real POPMAS / catalog product. */
  matched?: boolean
  /** Internal: set when `matched === false` and a fallback ingredient row was created. */
  fallbackReason?: 'no-popmas-match'
  /** Internal: intent text used for matching (helps Swap relevance + debugging). */
  originalText?: string
  /** Recipe ingredient intent, e.g. "spaghetti" — used for swap alternatives. */
  ingredientIntent?: string
}

type MealGroup = {
  id: string
  title: string
  /** Internal: cuisine metadata from the recipe model. */
  cuisine?: Cuisine
  /** Internal: inspiration chip label when built from a recipe chip. */
  chipLabel?: string
  /** Waitrose recipe method page for this meal. */
  methodUrl?: string
  serves: string
  removed: boolean
  expanded: boolean
  ingredients: Ingredient[]
}

type Essential = {
  id: string
  name: string
  price: number
  unitPrice: string
  qty: number
  selected: boolean
  image: string
  productType?: string
  originalText?: string
  selectedProductId?: string
  manuallySelected?: boolean
}

type SavedList = {
  id: string
  name: string
  mealGroups: MealGroup[]
  essentials: Essential[]
  generated: boolean
  /** Set when the customer leaves this list via the index; reopening starts collapsed. */
  hasLeftAndReturned?: boolean
}

type SwapItem = {
  name: string
  image: string
  price: number
  unitPrice: string
  productType?: string
  intentQuery?: string
  ingredientIntent?: string
}
type SwapTarget =
  | { kind: 'meal'; mealId: string; ingredientId: string; item: SwapItem }
  | { kind: 'essential'; id: string; item: SwapItem }

function normalizedSwapProductMetadata(product: WaitroseCatalogItem): {
  text: string
  tokens: Set<string>
} {
  const text = [
    product.range,
    product.productType,
    product.grouping,
    product.popmasType,
    product.organic ? 'organic' : '',
    product.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { text, tokens: new Set(text.split(' ').filter(Boolean)) }
}

function filterPoolBySwapRefinement(
  products: WaitroseCatalogItem[],
  refinement: SwapRefinement,
): WaitroseCatalogItem[] {
  if (refinement === 'All') return products
  return products.filter((p) => {
    const { text, tokens } = normalizedSwapProductMetadata(p)
    switch (refinement) {
      case 'Organic':
        return (
          tokens.has('organic') ||
          tokens.has('duchy') ||
          tokens.has('org') ||
          tokens.has('dorg')
        )
      case 'Vegan':
        return (
          tokens.has('vegan') ||
          text.includes('plant based') ||
          text.includes('dairy free')
        )
      case 'Vegetarian':
        return tokens.has('vegetarian')
      case 'Gluten-free':
        return (
          text.includes('gluten free') ||
          text.includes('free from')
        )
      case 'Essential':
        return tokens.has('essential') || tokens.has('essentials')
      case 'No.1':
        return (
          text.includes('no 1') ||
          tokens.has('no1')
        )
      default:
        return true
    }
  })
}

function buildSwapAlternativePool(
  item: SwapItem,
  products: WaitroseCatalogItem[],
): WaitroseCatalogItem[] {
  const intent = resolveSwapIngredientIntent(item.ingredientIntent, item.intentQuery, item.name)
  const query = swapSearchQuery(intent)
  const sameCategory = filterSwapAlternatives(intent, products)
  const ordered = topCatalogMatches(query, sameCategory, sameCategory.length, item.name)
  return rankCatalogHitsWithPersonalization(query, ordered)
}

function mergeSwapCatalogs(
  primary: WaitroseCatalogItem[],
  fallback: WaitroseCatalogItem[],
): WaitroseCatalogItem[] {
  const seen = new Set<string>()
  return [...primary, ...fallback].filter((product) => {
    const key = product.name.toLowerCase().trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type AppView = 'index' | 'build' | 'trolley' | 'favourites'

function mergeAppendBuildOntoTrolley(
  prev: TrolleyLine[],
  mealGroups: MealGroup[],
  essentials: Essential[],
): TrolleyLine[] {
  const incoming: TrolleyLine[] = []
  for (const m of mealGroups.filter((x) => !x.removed)) {
    for (const i of m.ingredients) {
      if (!i.selected) continue
      incoming.push({
        id: crypto.randomUUID(),
        name: i.name,
        image: i.image,
        price: i.price,
        unitPrice: i.unitPrice,
        qty: i.qty,
        allowSubstitute: true,
      })
    }
  }
  for (const e of essentials) {
    incoming.push({
      id: crypto.randomUUID(),
      name: e.name,
      image: e.image,
      price: e.price,
      unitPrice: e.unitPrice,
      qty: e.qty,
      allowSubstitute: true,
    })
  }
  const key = (l: TrolleyLine) => `${l.name}\u0000${l.unitPrice}\u0000${String(l.price)}`
  const map = new Map<string, TrolleyLine>()
  for (const l of prev) {
    map.set(key(l), { ...l })
  }
  for (const l of incoming) {
    const k = key(l)
    const ex = map.get(k)
    if (ex) {
      map.set(k, { ...ex, qty: ex.qty + l.qty })
    } else {
      map.set(k, l)
    }
  }
  return Array.from(map.values())
}

const INSPIRATION_CHIP_COUNT = 6

function visibleInspirationChips(
  cuisine: 'All' | Cuisine,
  mealGroups: MealGroup[],
): string[] {
  const usedChipLabels = new Set<string>()
  for (const meal of mealGroups) {
    if (meal.removed) continue
    const label = chipLabelForMeal(meal)
    if (label) usedChipLabels.add(label)
  }
  return MEAL_CHIP_ORDER_BY_CUISINE[cuisine]
    .filter((chip) => !usedChipLabels.has(chip))
    .slice(0, INSPIRATION_CHIP_COUNT)
}

type RemoveConfirmTarget =
  | { kind: 'meal'; mealId: string; name: string }
  | { kind: 'essential'; id: string; name: string }


function parseLinesFromOcrText(raw: string): string[] {
  if (!raw) return []
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^[\s\-*•·●▪◦□☐☑✓✔\d().,:;]+/u, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    // Allow 2-char lines so known abbreviations like "OJ" reach the alias rewrite stage.
    .filter((line) => line.length >= 2)
    .filter((line) => /[\p{L}]/u.test(line))
    .filter((line) => !/^\d+([.,]\d+)?$/u.test(line))
    .filter((line) => !/^(total|subtotal|vat|change|cash|card|balance|receipt|store|date|time)$/iu.test(line))
    .filter((line) => !/(£\s?\d|[0-9]+[.,][0-9]{2})/u.test(line))
}


// Shorthand and common OCR-distortion corrections applied line-by-line.
/**
 * Google Vision sometimes returns Cyrillic characters when reading handwritten
 * Latin text — e.g. handwritten "Spag Bol" → "Брад Bос" because:
 *   S ≈ Б,  p ≈ р,  a ≈ а,  g ≈ д,  o ≈ о,  c ≈ с  (visual confusables)
 * Map these back to their Latin lookalikes before ASCII-only cleaning so our
 * alias patterns can still fire.
 */
function normaliseCyrillicConfusables(text: string): string {
  return text
    .replace(/\u0430/g, 'a').replace(/\u0435/g, 'e').replace(/\u043E/g, 'o')
    .replace(/\u0440/g, 'p').replace(/\u0441/g, 'c').replace(/\u0445/g, 'x')
    .replace(/\u0434/g, 'g').replace(/\u0431/g, 'b').replace(/\u0432/g, 'v')
    .replace(/\u0410/g, 'A').replace(/\u0412/g, 'B').replace(/\u0415/g, 'E')
    .replace(/\u041A/g, 'K').replace(/\u041C/g, 'M').replace(/\u041D/g, 'H')
    .replace(/\u041E/g, 'O').replace(/\u0420/g, 'P').replace(/\u0421/g, 'C')
    .replace(/\u0422/g, 'T').replace(/\u0425/g, 'X')
    .replace(/\u0411/g, 'S')  // Б ≈ S  (handwriting confusable)
    .replace(/\u0414/g, 'G')  // Д ≈ G
}

// These correct specific OCR mis-reads of known grocery terms — they are NOT
// a fallback vocabulary; they only fire when a line actually matches.
const OCR_ALIAS_REWRITES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\boj\b|\bo\.?j\.?\b/i, replacement: 'orange juice' },
  // [sb]p[aeo]g covers both "spag" (normal) and "bpag" (Cyrillic В confusable — Vision reads
  // handwritten S as В which normalises to B). b[oa][cl] covers "bol", "boc", "bal" etc.
  { pattern: /\b[sb]p[aeo]g[\s.\-]*b[oa][cl]|\b[sb]p[aeo]g\b|\bbolognese\b|\bbolog\b|\bspaghetti\b/i, replacement: 'spaghetti bolognese' },
  // Sourdough — includes Vision API transpositions like "sougrdough"
  { pattern: /\b(sourdough|sougrdough|sovennoagu|sourdoag|sourdou)\b/i, replacement: 'sourdough bread' },
  { pattern: /\bsoven.*bae?r|sour.*br[e3]a?d/i, replacement: 'sourdough bread' },
  // Weetabix — Vision sometimes reads final x as t/b
  { pattern: /\b(cereal|ceaen|cecal)\b.*\b(weetab[iyx]|weetabi[tx]|weet|weety|weeny|weetbx)\b/i, replacement: 'cereal weetabix' },
  { pattern: /\b(organic|orgnic|orgamic)\b.*\b(milk|mlk|mik|milke|mick|miik)\b/i, replacement: 'organic milk' },
  { pattern: /\bogre\b.*\b(mik|milk|mlk)\b/i, replacement: 'organic milk' },
  { pattern: /\b(o[ar]?g[a-z]{1,4}c|org[a-z]{0,4}|oagnic|ognanic)\b.*\b(milk|mlk|milke|mick|miik|mlc?k)\b/i, replacement: 'organic milk' },
  { pattern: /\bos\s*ronc.*wm.*tk|org.*mlk|orqanic.*milk/i, replacement: 'organic milk' },
  // Eggs — Vision sometimes reads leading E as C ("Cggs")
  { pattern: /\b(eggs?|cggs?)\b/i, replacement: 'eggs' },
  // Bananas — drawn stars/symbols at the end get read as extra letters ("Bananaa", "Bananaas")
  { pattern: /\bbanana[sa]?\b/i, replacement: 'bananas' },
  { pattern: /\btomh?to|tomhto|tomhrogy|tomat/i, replacement: 'tomatoes' },
  { pattern: /\bonio|ono\b/i, replacement: 'onions' },
  // Green Thai Curry — many OCR variants
  { pattern: /\bgreen\s*thai\b/i, replacement: 'green thai curry' },
  { pattern: /\bgacen.*(thai|tuy|try).*(cur|liney|ciny|loney)\b/i, replacement: 'green thai curry' },
  { pattern: /\bgrae?\s*(thai|try|tuy)/i, replacement: 'green thai curry' },
  { pattern: /\bgecew.*tony|gacen.*tuy|green.*thai.*cur/i, replacement: 'green thai curry' },
  { pattern: /\b(tay|om|ag)\s*(loney|kogy|kogy)\b/i, replacement: 'green thai curry' },
  // Spaghetti Bolognese — Vision sometimes drops the trailing word
  { pattern: /\bspaghetti\b/i, replacement: 'spaghetti bolognese' },
]

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Convert a raw Speech-to-Text transcript into a normalised, deduplicated list
 * of item names ready for `getShopListLinesFromUserInput`.
 *
 * Speech transcripts arrive as a single string (Google STT) or comma-joined
 * utterances (Web Speech API). This function:
 *  1. Splits on commas, periods, " and ", " also " — common spoken delimiters.
 *  2. Strips leading filler phrases ("I need…", "some…", etc.).
 *  3. Applies OCR_ALIAS_REWRITES so spoken abbreviations ("OJ", "spag bol")
 *     expand the same way they do for Vision OCR.
 *  4. Deduplicates and normalises to Title Case.
 *
 * Returns a newline-joined string suitable for setInputValue.
 */

function charBigrams(value: string): Set<string> {
  const s = value.replace(/\s+/g, ' ').trim()
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2))
  return out
}

function bigramSimilarity(a: string, b: string): number {
  const aa = charBigrams(a)
  const bb = charBigrams(b)
  if (aa.size === 0 || bb.size === 0) return 0
  let inter = 0
  for (const g of aa) if (bb.has(g)) inter += 1
  return (2 * inter) / (aa.size + bb.size)
}

function skeleton(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1')
}

function skeletonSimilarity(a: string, b: string): number {
  const sa = skeleton(a)
  const sb = skeleton(b)
  if (!sa || !sb) return 0
  return bigramSimilarity(sa, sb)
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function hasFuzzyKeyword(rawTokens: string[], keyword: string): boolean {
  for (const token of rawTokens) {
    if (token === keyword) return true
    if (token.length < 3 || keyword.length < 3) continue
    if (Math.abs(token.length - keyword.length) > 3) continue
    const maxDist = Math.max(2, Math.floor(Math.max(token.length, keyword.length) * 0.34))
    if (editDistance(token, keyword) <= maxDist) return true
  }
  return false
}

const OCR_TARGET_ITEMS = [
  'organic milk', 'eggs', 'sourdough bread', 'cereal weetabix',
  'orange juice', 'tomatoes', 'onions', 'spaghetti bolognese', 'green thai curry',
]

const OCR_INTENT_ITEMS = [
  'organic milk', 'milk', 'eggs', 'sourdough bread', 'cereal weetabix',
  'orange juice', 'tomatoes', 'onions', 'spaghetti bolognese', 'green thai curry',
]

const OCR_INTENT_PATTERNS: Array<{ intent: string; pattern: RegExp }> = [
  { intent: 'organic milk', pattern: /\b(org|organic|orqanic|orgnic|ogre|os\s*ronc|or\s*ganic).*(milk|mlk|mik|wm\s*tk|milke)\b/i },
  { intent: 'milk', pattern: /\b(milk|mlk|milke)\b/i },
  { intent: 'eggs', pattern: /\b(egg|eggs|egq|eqq)\b/i },
  { intent: 'sourdough bread', pattern: /\b(sour|soven|sourd|dough).*(bread|brad|baer|bre)\b/i },
  { intent: 'cereal weetabix', pattern: /\b(cereal|cecal|ceaen).*(weet|weeta|weetbx|weety)\b/i },
  { intent: 'orange juice', pattern: /\b(oj|o\.j\.|orange).*(juice|jce)?\b/i },
  { intent: 'tomatoes', pattern: /\b(tomato|tomatoes|tomh?to|tomhto|tomat|tomhro|tomhrogy|toma?toe?s?)\b/i },
  { intent: 'onions', pattern: /\b(onion|onions|onio|ono)\b/i },
  { intent: 'spaghetti bolognese', pattern: /\b(sp[aeo]g|spaghetti|jpag).*(bol|bolog|be|bo[li])\b|\bbolognese\b|\bbolog\b/i },
  { intent: 'green thai curry', pattern: /\b(green|grae|gacen).*(thai|tuy|try).*(curry|cur|liney|ciny)\b/i },
]

const OCR_INTENT_KEYWORDS: Record<string, string[]> = {
  'organic milk': ['organic', 'milk', 'orgnic', 'orqanic', 'ogre', 'mlk', 'mik', 'milke', 'mick', 'miik'],
  milk: ['milk', 'mlk', 'milke'],
  eggs: ['egg', 'eggs', 'egq', 'eqq'],
  'sourdough bread': ['sourdough', 'sour', 'dough', 'bread', 'brad', 'baer'],
  'cereal weetabix': ['cereal', 'cecal', 'ceaen', 'weetabix', 'weetbx', 'weety'],
  'orange juice': ['oj', 'orange', 'juice', 'jce'],
  tomatoes: ['tomato', 'tomatoes', 'tomat', 'tomhto', 'tomhrogy'],
  onions: ['onion', 'onions', 'onio', 'ono'],
  'spaghetti bolognese': ['spag', 'spaghetti', 'jpag', 'bol', 'bolognese', 'bolog'],
  'green thai curry': ['green', 'gacen', 'grae', 'thai', 'tuy', 'try', 'curry', 'cur', 'liney', 'ciny'],
}

function hasIntent(detected: Set<string>, intent: string): boolean {
  return detected.has(intent) || detected.has(toTitleCase(intent).toLowerCase())
}

const OCR_FALLBACK_VOCAB = [
  'fruit', 'bread rolls', 'bagels', 'dolmio sauce', 'lasagne sauce', 'lasagne sheets',
  'apples', 'chicken pieces', 'chicken breast', 'chicken thighs', 'mince', 'sausages',
  'bananas', 'cat biscuits', 'scampi fries', 'cheese', 'ham', 'meat', 'coconut milk',
  'grated cheese', 'mozzarella', 'halloumi', 'sour cream', 'taco shells', 'baby corn',
  'cucumber', 'chillies', 'salad', 'tomatoes', 'avocados', 'olives', 'coriander',
  'onions', 'mushrooms', 'peppers',
]

function normalizeOcrLine(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  for (const rule of OCR_ALIAS_REWRITES) {
    if (rule.pattern.test(cleaned)) return toTitleCase(rule.replacement)
  }
  let best = cleaned, bestScore = 0
  for (const target of OCR_TARGET_ITEMS) {
    const s = bigramSimilarity(cleaned, target)
    if (s > bestScore) { best = target; bestScore = s }
  }
  if (bestScore >= 0.45) return toTitleCase(best)
  return toTitleCase(cleaned)
}

function resolveOcrIntentLine(raw: string): string | null {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  for (const rule of OCR_ALIAS_REWRITES) {
    if (rule.pattern.test(cleaned)) return toTitleCase(rule.replacement)
  }
  let bestIntent = '', bestScore = 0
  for (const intent of OCR_INTENT_ITEMS) {
    const s = Math.max(bigramSimilarity(cleaned, intent), skeletonSimilarity(cleaned, intent))
    if (s > bestScore) { bestScore = s; bestIntent = intent }
  }
  if (!bestIntent) return null
  const tokens = cleaned.split(/\s+/).filter((t) => t.length >= 2)
  const intentKeywords = OCR_INTENT_KEYWORDS[bestIntent] ?? []
  const keywordHits = intentKeywords.reduce((n, kw) => (hasFuzzyKeyword(tokens, kw) ? n + 1 : n), 0)
  if (bestScore >= 0.5 || keywordHits >= 1) return toTitleCase(bestIntent)
  return null
}

function extractOcrIntentLines(rawText: string): string[] {
  const lines = parseLinesFromOcrText(rawText)
    .map((line) => normalizeOcrLine(line))
    .map((line) => resolveOcrIntentLine(line))
    .filter((line): line is string => Boolean(line))
  const detected = new Set(lines.map((l) => l.toLowerCase()))

  // Test each individual OCR line against intent patterns and keyword lists.
  // We evaluate PER LINE (not across all tokens) to prevent "coriander" on one line
  // combining with "milk" on another to produce a false "organic milk" match.
  for (const rawLine of parseLinesFromOcrText(rawText)) {
    const cleanedLine = rawLine.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

    for (const { intent, pattern } of OCR_INTENT_PATTERNS) {
      if (pattern.test(cleanedLine)) detected.add(intent)
    }

    const lineTokens = cleanedLine.split(/\s+/).filter((t) => t.length >= 2)
    for (const [intent, keywords] of Object.entries(OCR_INTENT_KEYWORDS)) {
      const hits = keywords.reduce((n, kw) => (hasFuzzyKeyword(lineTokens, kw) ? n + 1 : n), 0)
      // Multi-word intents need 2 keyword hits on the same line; single-word need 1.
      const threshold = intent.includes(' ') ? 2 : 1
      if (hits >= threshold) detected.add(intent)
    }
  }

  if (hasIntent(detected, 'organic milk')) { detected.delete('milk'); detected.delete('Milk') }
  return OCR_INTENT_ITEMS.filter((intent) => detected.has(intent)).map((intent) => toTitleCase(intent))
}

function extractVocabFromNoisyText(rawText: string): string[] {
  const clean = rawText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const tokens = clean.split(/\s+/).filter((t) => t.length >= 2)
  const detected: string[] = []
  for (const term of OCR_FALLBACK_VOCAB) {
    const termTokens = term.split(' ')
    const allMatched = termTokens.every((tt) =>
      tokens.some((tok) =>
        tok === tt ||
        (tok.length >= 3 && tt.length >= 3 && Math.abs(tok.length - tt.length) <= 4 &&
          (editDistance(tok, tt) <= Math.floor(Math.max(tok.length, tt.length) * 0.4) ||
            bigramSimilarity(tok, tt) >= 0.35 ||
            skeletonSimilarity(tok, tt) >= 0.4)),
      ),
    )
    if (allMatched) detected.push(toTitleCase(term))
  }
  return detected
}

function buildConsensusIntentLines(passes: Array<{ text: string; confidence: number }>): string[] {
  const intentVotes = new Map<string, { label: string; votes: number; bestConfidence: number }>()
  const sorted = [...passes].sort((a, b) => b.confidence - a.confidence)
  for (const pass of sorted) {
    const intents = extractOcrIntentLines(pass.text)
    const seenInPass = new Set<string>()
    for (const label of intents) {
      const key = label.toLowerCase()
      if (seenInPass.has(key)) continue
      seenInPass.add(key)
      const prev = intentVotes.get(key)
      if (!prev) intentVotes.set(key, { label, votes: 1, bestConfidence: pass.confidence })
      else { prev.votes += 1; prev.bestConfidence = Math.max(prev.bestConfidence, pass.confidence) }
    }
  }
  const voted = Array.from(intentVotes.values())
    .filter((v) => v.votes >= 2)
    .sort((a, b) => b.votes - a.votes || b.bestConfidence - a.bestConfidence)
    .map((v) => v.label)
  if (voted.length > 0) return voted
  const bestPass = sorted[0]
  return bestPass ? extractOcrIntentLines(bestPass.text) : []
}

function hasOrganicMilkSignalInRawText(rawText: string): boolean {
  // Only fires when there is a strong organic-specific signal on the SAME line as a milk signal.
  // We check line-by-line to avoid "coriander" (elsewhere in text) + "coconut milk" triggering this.
  for (const line of parseLinesFromOcrText(rawText)) {
    const clean = line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    const tokens = clean.split(/\s+/).filter((t) => t.length >= 2)
    const hasOrganicLike = tokens.some((t) =>
      hasFuzzyKeyword([t], 'organic') || hasFuzzyKeyword([t], 'orgnic') ||
      hasFuzzyKeyword([t], 'orqanic') || hasFuzzyKeyword([t], 'ogre') ||
      bigramSimilarity(t, 'organic') >= 0.45,
    )
    const hasMilkLike = tokens.some((t) =>
      hasFuzzyKeyword([t], 'milk') || hasFuzzyKeyword([t], 'mlk') ||
      hasFuzzyKeyword([t], 'mik') || hasFuzzyKeyword([t], 'milke') ||
      hasFuzzyKeyword([t], 'mick') || hasFuzzyKeyword([t], 'miik'),
    )
    if (hasOrganicLike && hasMilkLike) return true
  }
  return false
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode OCR image'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

async function preprocessImageForOcr(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  const cropLeft = Math.floor(bitmap.width * 0.18)
  const cropWidth = Math.max(1, bitmap.width - cropLeft)
  const scale = 2
  canvas.width = cropWidth * scale
  canvas.height = bitmap.height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not prepare OCR canvas')
  // Drop the left tool rail commonly present in photo markup UIs.
  ctx.drawImage(bitmap, cropLeft, 0, cropWidth, bitmap.height, 0, 0, cropWidth * scale, bitmap.height * scale)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    const gray = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])
    const bw = gray > 165 ? 255 : 0
    d[i] = bw
    d[i + 1] = bw
    d[i + 2] = bw
  }
  ctx.putImageData(imageData, 0, 0)
  return await canvasToPngBlob(canvas)
}

async function preprocessImageVariantsForOcr(file: File): Promise<Blob[]> {
  const bitmap = await createImageBitmap(file)
  const scale = 2
  const variants: Blob[] = []

  const drawVariant = async (
    cropLeftFraction: number,
    threshold: number | null,
    contrastBoost: number,
  ) => {
    const cropLeft = Math.floor(bitmap.width * cropLeftFraction)
    const cropWidth = Math.max(1, bitmap.width - cropLeft)
    const canvas = document.createElement('canvas')
    canvas.width = cropWidth * scale
    canvas.height = bitmap.height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not prepare OCR canvas')
    ctx.drawImage(bitmap, cropLeft, 0, cropWidth, bitmap.height, 0, 0, cropWidth * scale, bitmap.height * scale)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = imageData.data
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      const contrasted = Math.max(0, Math.min(255, (gray - 128) * contrastBoost + 128))
      if (threshold == null) {
        d[i] = contrasted; d[i + 1] = contrasted; d[i + 2] = contrasted
      } else {
        const bw = contrasted > threshold ? 255 : 0
        d[i] = bw; d[i + 1] = bw; d[i + 2] = bw
      }
    }
    ctx.putImageData(imageData, 0, 0)
    variants.push(await canvasToPngBlob(canvas))
  }

  // Variants with left-toolbar crop (single-column lists with markup UI chrome)
  await drawVariant(0.18, null, 1.35)
  await drawVariant(0.18, 165, 1.2)
  await drawVariant(0.18, 145, 1.35)
  // Variants WITHOUT left crop (two-column lists, handwritten paper lists)
  await drawVariant(0, null, 1.4)
  await drawVariant(0, 150, 1.3)
  await drawVariant(0, 130, 1.5)
  return variants
}


function buildConsensusOcrText(
  passes: Array<{ text: string; confidence: number }>,
): string {
  const normalizedPasses = passes
    .map((p) => ({ text: p.text ?? '', confidence: Number.isFinite(p.confidence) ? p.confidence : 0 }))
    .filter((p) => p.text.trim().length > 0)
  if (normalizedPasses.length === 0) return ''
  const sorted = [...normalizedPasses].sort((a, b) => b.confidence - a.confidence)
  const bestLines = parseLinesFromOcrText(sorted[0].text)
  const byNorm = new Map<string, { line: string; votes: number; bestConfidence: number; firstSeen: number }>()
  let seenIdx = 0
  for (const pass of normalizedPasses) {
    const seenInPass = new Set<string>()
    for (const line of parseLinesFromOcrText(pass.text)) {
      const norm = line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
      if (!norm || seenInPass.has(norm)) continue
      seenInPass.add(norm)
      const prev = byNorm.get(norm)
      if (!prev) {
        byNorm.set(norm, { line, votes: 1, bestConfidence: pass.confidence, firstSeen: seenIdx++ })
      } else {
        prev.votes += 1
        prev.bestConfidence = Math.max(prev.bestConfidence, pass.confidence)
      }
    }
  }
  const voted = Array.from(byNorm.values())
    .filter((v) => v.votes >= 2)
    .sort((a, b) => b.votes - a.votes || b.bestConfidence - a.bestConfidence || a.firstSeen - b.firstSeen)
    .map((v) => v.line)
  const combined: string[] = []
  const added = new Set<string>()
  for (const line of [...bestLines, ...voted]) {
    const key = line.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key || added.has(key)) continue
    added.add(key)
    combined.push(line)
  }
  return combined.join('\n')
}


function ingredientThumb(hit: WaitroseCatalogItem | null): string {
  return catalogProductImage(hit?.imageUrl)
}

function constrainProductsForQuery(
  query: string,
  products: WaitroseCatalogItem[],
): WaitroseCatalogItem[] {
  const q = query.toLowerCase()
  let filtered = products
  let strict = false

  const recipeCategoryExclusions = [
    'beauty',
    'shampoo',
    'conditioner',
    'shower',
    'showr',
    'soap',
    'deodorant',
    'toothpaste',
    'pet',
    'dog',
    'cat',
    'puppy',
    'kitten',
    'baby',
    'nappy',
    'diaper',
    'formula',
    'wipes',
    'non food',
    'non-food',
    'cleaner',
    'detergent',
    'bleach',
    'bin bag',
  ]

  // Meal ingredient lookups should never resolve into non-cooking categories.
  filtered = filtered.filter((p) => {
    const n = p.name.toLowerCase()
    return !recipeCategoryExclusions.some((token) => n.includes(token))
  })

  const nonFoodTokens = ['shower', 'gel', 'soap', 'conditioner', 'body wash']
  if (q.includes('coconut') || q.includes('curry') || q.includes('paste')) {
    filtered = filtered.filter((p) => {
      const n = p.name.toLowerCase()
      return !nonFoodTokens.some((t) => n.includes(t))
    })
  }

  if (q.includes('thai green curry paste')) {
    strict = true
    filtered = filtered.filter((p) => {
      const n = p.name.toLowerCase()
      return (
        !n.includes('tea') &&
        !n.includes('pasta') &&
        !n.includes('chilli') &&
        (n.includes('curry') || n.includes('paste') || n.includes('thai'))
      )
    })
  }

  if (q.includes('coconut milk')) {
    strict = true
    filtered = filtered.filter((p) => {
      const n = p.name.toLowerCase()
      return (
        !n.includes('shower') &&
        !n.includes('showr') &&
        !n.includes('conditioner') &&
        !n.includes('source') &&
        n.includes('coconut') &&
        n.includes('milk')
      )
    })
  }

  if (strict) return filtered
  return filtered.length > 0 ? filtered : products
}

function resolveCatalogMatch(
  term: string,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
): { hit: WaitroseCatalogItem | null; usedFallback: boolean } {
  const constrainedPrimary = constrainProductsForQuery(term, primaryProducts)
  const constrainedFallback = constrainProductsForQuery(term, fallbackProducts)
  const fromPrimary = bestCatalogMatch(term, constrainedPrimary)
  if (fromPrimary) return { hit: fromPrimary, usedFallback: false }
  const fromFallback = bestCatalogMatch(term, constrainedFallback)
  if (fromFallback) return { hit: fromFallback, usedFallback: true }
  return { hit: null, usedFallback: false }
}

function essentialFromCatalogMatch(
  spec: { id: string; label: string; match: string },
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
): { item: Essential; usedFallback: boolean } {
  const { hit, usedFallback } = resolveCatalogMatch(spec.match, primaryProducts, fallbackProducts)
  if (hit) {
    return {
      usedFallback,
      item: {
        id: spec.id,
        name: hit.name,
        price: hit.price,
        unitPrice: hit.unitPrice?.trim() || '—',
        qty: 1,
        selected: true,
        image: ingredientThumb(hit),
        productType: hit.productType,
      },
    }
  }
  return {
    usedFallback: false,
    item: {
      id: spec.id,
      name: spec.label,
      price: 0,
      unitPrice: '—',
      qty: 1,
      selected: true,
      image: '🛒',
    },
  }
}

function mealIngredientFromCatalog(
  ingId: string,
  fallbackTitle: string,
  match: string,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
): { item: Ingredient; usedFallback: boolean } {
  const { hit, usedFallback } = resolveCatalogMatch(match, primaryProducts, fallbackProducts)
  if (hit) {
    return {
      usedFallback,
      item: {
        id: ingId,
        name: hit.name,
        needText: 'You need: 1 × of',
        price: hit.price,
        unitPrice: hit.unitPrice?.trim() || '—',
        qty: 1,
        selected: true,
        image: ingredientThumb(hit),
        productType: hit.productType,
      },
    }
  }
  return {
    usedFallback: false,
    item: {
      id: ingId,
      name: fallbackTitle,
      needText: 'You need: 1 × meal',
      price: 0,
      unitPrice: '—',
      qty: 1,
      selected: true,
      image: '🛒',
    },
  }
}

const DEBUG_MEAL_RECIPE_BUILD = import.meta.env.DEV

function resolveRecipeIngredient(
  recipeIngredient: RecipeIngredient,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
  originalTextForLogging: string,
  ingredientIndex: number,
  qtyMultiplier: number,
): { item: Ingredient; usedFallback: boolean } {
  const candidateQueries = [...(recipeIngredient.synonyms ?? []), recipeIngredient.name]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)

  for (const q of candidateQueries) {
    const catalogPools: Array<{ products: WaitroseCatalogItem[]; usedFallback: boolean }> = [
      { products: primaryProducts, usedFallback: false },
      { products: fallbackProducts, usedFallback: true },
    ]

    for (const { products, usedFallback } of catalogPools) {
      if (products.length === 0) continue

      const candidates = topCatalogMatches(q, products, 40)
      const suitable = candidates.filter((hit) => isRecipeCatalogHit(recipeIngredient, hit))

      if (DEBUG_MEAL_RECIPE_BUILD) {
        console.debug('[meal-build] ingredient candidate', {
          ingredientIndex,
          ingredient: recipeIngredient.name,
          query: q,
          primaryMatches: candidates.length,
          suitableMatches: suitable.length,
          usedFallback,
        })
      }

      if (suitable.length === 0) continue

      const ranked = rankCatalogHitsWithPersonalization(q, suitable)
      const hit = ranked[0]
      if (!hit) continue

      if (DEBUG_MEAL_RECIPE_BUILD) {
        console.debug('[meal-build] ingredient matched', {
          ingredientIndex,
          ingredient: recipeIngredient.name,
          query: q,
          selected: hit.name,
          usedFallback,
        })
      }

      return {
        usedFallback,
        item: {
          id: `recipe-ing-${ingredientIndex}-${crypto.randomUUID()}`,
          name: hit.name,
          needText: `You need: ${qtyMultiplier} × of`,
          price: hit.price,
          unitPrice: hit.unitPrice?.trim() || '—',
          qty: qtyMultiplier,
          selected: true,
          image: catalogProductImage(hit.imageUrl),
          productType: hit.productType,
          matched: true,
          originalText: originalTextForLogging,
          ingredientIntent: recipeIngredient.name,
        },
      }
    }
  }

  // POPMAS had no suitable match: keep the ingredient visible as an unpriced fallback.
  if (DEBUG_MEAL_RECIPE_BUILD) {
    console.debug('[meal-build] ingredient fallback', {
      ingredientIndex,
      ingredient: recipeIngredient.name,
      originalTextForLogging,
    })
  }
  return {
    usedFallback: false,
    item: {
      id: `recipe-ing-fallback-${ingredientIndex}-${crypto.randomUUID()}`,
      name: recipeIngredient.name,
      needText: `You need: ${qtyMultiplier} × of`,
      price: 0,
      unitPrice: '—',
      qty: qtyMultiplier,
      selected: true,
      image: '🛒',
      matched: false,
      fallbackReason: 'no-popmas-match',
      originalText: originalTextForLogging,
      ingredientIntent: recipeIngredient.name,
    },
  }
}

function normalizeMealName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function mealTemplateIngredients(mealTitle: string): Array<{ label: string; match: string }> {
  const n = normalizeMealName(mealTitle)

  if (n.includes('spag') && n.includes('bol')) {
    return [
      { label: 'Spaghetti', match: 'spaghetti pasta' },
      { label: 'Beef Mince', match: 'beef mince' },
      { label: 'Chopped Tomatoes', match: 'chopped tomatoes' },
      { label: 'Onions', match: 'onions' },
      { label: 'Garlic', match: 'garlic' },
      { label: 'Tomato Puree', match: 'tomato puree' },
    ]
  }

  if (n.includes('shepherd') && n.includes('pie')) {
    return [
      { label: 'Lamb Mince', match: 'lamb mince' },
      { label: 'Potatoes', match: 'potatoes' },
      { label: 'Onions', match: 'onions' },
      { label: 'Carrots', match: 'carrots' },
      { label: 'Peas', match: 'peas' },
      { label: 'Tomato Puree', match: 'tomato puree' },
      { label: 'Stock Cubes', match: 'stock cubes' },
    ]
  }

  if (n.includes('lemon') && (n.includes('drizzle') || n.includes('cake'))) {
    return [
      { label: 'Self Raising Flour', match: 'self raising flour' },
      { label: 'Caster Sugar', match: 'caster sugar' },
      { label: 'Unsalted Butter', match: 'unsalted butter' },
      { label: 'Eggs', match: 'eggs' },
      { label: 'Lemons', match: 'lemons' },
      { label: 'Icing Sugar', match: 'icing sugar' },
    ]
  }

  if (n.includes('fish') && n.includes('pie')) {
    return [
      { label: 'White Fish Fillets', match: 'white fish fillets' },
      { label: 'Potatoes', match: 'potatoes' },
      { label: 'Leeks', match: 'leeks' },
      { label: 'Milk', match: 'milk' },
      { label: 'Butter', match: 'butter' },
      { label: 'Flour', match: 'plain flour' },
      { label: 'Peas', match: 'peas' },
    ]
  }

  if (n.includes('fajita')) {
    return [
      { label: 'Chicken Breast', match: 'chicken breast' },
      { label: 'Tortilla Wraps', match: 'tortilla wraps' },
      { label: 'Fajita Seasoning', match: 'fajita seasoning' },
      { label: 'Onions', match: 'onions' },
      { label: 'Peppers', match: 'peppers' },
      { label: 'Sour Cream', match: 'sour cream' },
      { label: 'Lime', match: 'lime' },
    ]
  }

  if (n.includes('sausage') && n.includes('mash')) {
    return [
      { label: 'Pork Sausages', match: 'pork sausages' },
      { label: 'Potatoes', match: 'potatoes' },
      { label: 'Onions', match: 'onions' },
      { label: 'Unsalted Butter', match: 'unsalted butter' },
      { label: 'Milk', match: 'milk' },
      { label: 'Gravy Granules', match: 'gravy granules' },
    ]
  }

  if (n.includes('pancake')) {
    return [
      { label: 'Self Raising Flour', match: 'self raising flour' },
      { label: 'Eggs', match: 'eggs' },
      { label: 'Milk', match: 'milk' },
      { label: 'Unsalted Butter', match: 'unsalted butter' },
      { label: 'Lemons', match: 'lemons' },
      { label: 'Caster Sugar', match: 'caster sugar' },
    ]
  }

  if (n.includes('omelette') || n.includes('omelet')) {
    return [
      { label: 'Eggs', match: 'eggs' },
      { label: 'Unsalted Butter', match: 'unsalted butter' },
      { label: 'Cheddar Cheese', match: 'cheddar cheese' },
      { label: 'Milk', match: 'milk' },
      { label: 'Onions', match: 'onions' },
      { label: 'Mushrooms', match: 'mushrooms' },
    ]
  }

  if (n.includes('salmon') && (n.includes('veg') || n.includes('vegetable'))) {
    return [
      { label: 'Salmon Fillets', match: 'salmon fillets' },
      { label: 'Broccoli', match: 'broccoli' },
      { label: 'Carrots', match: 'carrots' },
      { label: 'Green Beans', match: 'green beans' },
      { label: 'Potatoes', match: 'potatoes' },
      { label: 'Lemons', match: 'lemons' },
    ]
  }

  if (n.includes('pasta') && n.includes('bake')) {
    return [
      { label: 'Pasta', match: 'pasta' },
      { label: 'Pasta Bake Sauce', match: 'pasta bake sauce' },
      { label: 'Chicken Breast', match: 'chicken breast' },
      { label: 'Onions', match: 'onions' },
      { label: 'Peppers', match: 'peppers' },
      { label: 'Grated Cheese', match: 'grated cheese' },
      { label: 'Garlic', match: 'garlic' },
    ]
  }

  if (n.includes('green') && n.includes('thai') && n.includes('curry')) {
    return [
      { label: 'Thai Green Curry Paste', match: 'thai green curry paste cooking' },
      { label: 'Coconut Milk', match: 'coconut milk' },
      { label: 'Chicken Breast', match: 'chicken breast' },
      { label: 'Jasmine Rice', match: 'jasmine rice' },
      { label: 'Onions', match: 'onions' },
      { label: 'Peppers', match: 'peppers' },
    ]
  }

  if (n.includes('curry')) {
    return [
      { label: 'Chicken Breast', match: 'chicken breast' },
      { label: 'Curry Paste', match: 'curry paste' },
      { label: 'Coconut Milk', match: 'coconut milk' },
      { label: 'Onions', match: 'onions' },
      { label: 'Garlic', match: 'garlic' },
      { label: 'Ginger', match: 'ginger' },
      { label: 'Rice', match: 'basmati rice' },
    ]
  }

  if (n.includes('roast')) {
    return [
      { label: 'Roast Chicken', match: 'whole chicken' },
      { label: 'Potatoes', match: 'potatoes' },
      { label: 'Carrots', match: 'carrots' },
      { label: 'Broccoli', match: 'broccoli' },
      { label: 'Gravy Granules', match: 'gravy granules' },
      { label: 'Stuffing', match: 'stuffing mix' },
    ]
  }

  // Guaranteed multi-ingredient fallback for any other recipe intent.
  return [
    { label: 'Protein', match: 'chicken breast' },
    { label: 'Carbohydrate', match: 'rice' },
    { label: 'Onions', match: 'onions' },
    { label: 'Garlic', match: 'garlic' },
    { label: 'Main Sauce Base', match: 'tomato sauce' },
    { label: 'Fresh Vegetables', match: 'mixed peppers' },
  ]
}

function predictEssentialForLine(
  id: string,
  label: string,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
  dietSelections: DietOption[],
): { item: Essential; usedFallback: boolean } {
  const prediction = rankProductsForEntry(label, primaryProducts, fallbackProducts, {
    preferVegetarian: dietSelections.includes('Vegetarian'),
  })
  if (prediction) {
    return {
      usedFallback: prediction.usedFallback,
      item: {
        id,
        name: prediction.name,
        price: prediction.price,
        unitPrice: prediction.unitPrice,
        qty: 1,
        selected: true,
        image: prediction.image,
        productType: prediction.productType,
        originalText: label,
        selectedProductId: prediction.selectedProductId,
      },
    }
  }
  return essentialFromCatalogMatch({ id, label, match: label }, primaryProducts, fallbackProducts)
}

/** Build meals + essentials only from parsed list lines matched against POPMAS (no full-catalog dump). */
function buildShopFromListLines(
  lines: string[],
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
  serves: string,
  dietSelections: DietOption[],
  itemsOnly: boolean,
  forcedMealLines?: Set<string>,
): { meals: MealGroup[]; essentials: Essential[]; fallbackMatches: number } {
  const meals: MealGroup[] = []
  const essentials: Essential[] = []
  let fallbackMatches = 0
  let mi = 0
  let ei = 0
  const servesNumber = serves.includes('6+') ? 6 : Number(serves.replace(/\D+/g, '')) || 4
  const servesMultiplier = Math.max(1, Math.ceil(servesNumber / 4))

  for (const label of lines) {
    const trimmed = label.trim()
    if (!trimmed) continue
    const forceMeal = forcedMealLines?.has(normalizeMealName(trimmed)) ?? false
    const recipeFromLine = findMealRecipeForLine(trimmed)

    if (forceMeal || isLikelyMealLine(trimmed) || recipeFromLine) {
      if (itemsOnly) {
        const id = `ess-meal-${ei++}`
        const queryCandidates = [
          `${trimmed} ready meal`,
          `${trimmed} meal kit`,
          `${trimmed} kit`,
          trimmed,
        ]
        let resolved: { item: Essential; usedFallback: boolean } | null = null
        for (const query of queryCandidates) {
          const candidate = essentialFromCatalogMatch(
            { id, label: `${trimmed} ready meal`, match: query },
            primaryProducts,
            fallbackProducts,
          )
          if (candidate.item.price > 0 || candidate.item.image !== '🛒') {
            resolved = candidate
            break
          }
          if (!resolved) resolved = candidate
        }
        if (resolved) {
          if (resolved.usedFallback) fallbackMatches += 1
          essentials.push(resolved.item)
        }
        continue
      }
      const id = `meal-list-${mi++}-${Math.random().toString(36).slice(2, 8)}`
      if (recipeFromLine) {
        if (DEBUG_MEAL_RECIPE_BUILD) {
          console.debug('[meal-build] meal selected', {
            line: trimmed,
            fullName: recipeFromLine.fullName,
            cuisine: recipeFromLine.cuisine,
          })
        }
        // Build from explicit recipe ingredient list.
        const requiredIngredients = recipeFromLine.ingredients
        const resolvedIngredients: Ingredient[] = []

        const byKey = new Map<string, Ingredient>()
        requiredIngredients.forEach((ri, idx) => {
          const resolved = resolveRecipeIngredient(
            ri,
            primaryProducts,
            fallbackProducts,
            trimmed,
            idx,
            servesMultiplier,
          )
          if (resolved.usedFallback) fallbackMatches += 1

          const key = resolved.item.matched
            ? normKey(resolved.item.name)
            : `fallback:${normKey(ri.name)}`

          const existing = byKey.get(key)
          if (existing) {
            if (DEBUG_MEAL_RECIPE_BUILD) {
              console.debug('[meal-build] duplicate merged', { meal: recipeFromLine.fullName, key })
            }
            const newQty = existing.qty + resolved.item.qty
            byKey.set(key, {
              ...existing,
              qty: newQty,
              needText: `You need: ${newQty} × of`,
              selected: newQty > 0,
            })
          } else {
            byKey.set(key, resolved.item)
          }
        })

        byKey.forEach((v) => resolvedIngredients.push(v))
        meals.push({
          id,
          title: recipeFromLine.fullName,
          cuisine: recipeFromLine.cuisine,
          chipLabel: recipeFromLine.chipLabel,
          methodUrl: recipeFromLine.methodUrl ?? waitroseRecipeMethodUrl(recipeFromLine.fullName),
          serves,
          removed: false,
          expanded: false,
          ingredients: resolvedIngredients,
        })
        continue
      }

      // Fallback for legacy meal matching (pre-recipe model).
      const ingredientSpecs = mealTemplateIngredients(trimmed)
      meals.push({
        id,
        title: trimmed,
        serves,
        removed: false,
        expanded: false,
        ingredients: ingredientSpecs.map((spec, idx) => {
          const resolved = mealIngredientFromCatalog(
            `${id}-ing-${idx}`,
            spec.label,
            spec.match,
            primaryProducts,
            fallbackProducts,
          )
          if (resolved.usedFallback) fallbackMatches += 1
          return resolved.item
        }),
      })
    } else {
      const id = `ess-list-${ei++}`
      const resolved = predictEssentialForLine(
        id,
        trimmed,
        primaryProducts,
        fallbackProducts,
        dietSelections,
      )
      if (resolved.usedFallback) fallbackMatches += 1
      essentials.push(resolved.item)
    }
  }
  // Deduplicate within this build before merging into existing state.
  // Two input lines resolving to the same catalog product should not create
  // two separate rows — sum their quantities instead.
  const dedupedEssentials = Array.from(
    essentials
      .reduce((map, item) => {
        const key = normKey(item.name)
        const existing = map.get(key)
        if (existing) {
          map.set(key, { ...existing, qty: existing.qty + item.qty })
        } else {
          map.set(key, item)
        }
        return map
      }, new Map<string, Essential>())
      .values(),
  )

  return { meals, essentials: dedupedEssentials, fallbackMatches }
}

function builtShopHasRows(built: { meals: MealGroup[]; essentials: Essential[] }): boolean {
  return built.meals.length > 0 || built.essentials.length > 0
}

function formatCurrency(value: number) {
  return `£${value.toFixed(2)}`
}

function normKey(value: string): string {
  return value
    .normalize('NFKC')          // decompose ligatures, fullwidth chars, etc.
    .toLowerCase()
    .replace(/[\u00A0\u200B\u202F\u2060\uFEFF]/g, ' ')  // non-breaking / zero-width spaces → space
    .replace(/[''‚‛]/g, "'")    // curly / fancy apostrophes → straight
    .replace(/[""„‟]/g, '"')    // curly quotes → straight
    .replace(/[–—‒]/g, '-')     // en/em/figure dashes → hyphen
    .replace(/\s+/g, ' ')
    .trim()
}

function mergeEssentials(existing: Essential[], incoming: Essential[]): Essential[] {
  if (incoming.length === 0) return existing

  // Build a map from the existing list. If `existing` itself somehow contains
  // duplicates (e.g. from a previous stale state), consolidate them now so
  // the output is always clean. Use normKey so Unicode/whitespace variants of
  // the same product name collapse to one entry.
  const byName = new Map<string, Essential>()
  for (const item of existing) {
    const key = normKey(item.name)
    const prev = byName.get(key)
    byName.set(key, prev ? { ...prev, qty: prev.qty + item.qty } : item)
  }

  for (const next of incoming) {
    const key = normKey(next.name)
    const prev = byName.get(key)
    if (prev) {
      // Same catalog product → accumulate quantity.
      byName.set(key, { ...prev, qty: prev.qty + next.qty })
    } else {
      // Different product (e.g. regular vs organic banana) → new row.
      byName.set(key, next)
    }
  }

  return Array.from(byName.values())
}

function mergeMealGroups(existing: MealGroup[], incoming: MealGroup[]): MealGroup[] {
  if (incoming.length === 0) return existing
  const byTitle = new Map(existing.map((meal) => [normKey(meal.title), meal]))
  for (const next of incoming) {
    const key = normKey(next.title)
    const prev = byTitle.get(key)
    if (!prev) {
      byTitle.set(key, next)
      continue
    }
    const ingredientMap = new Map(prev.ingredients.map((i) => [normKey(i.name), i]))
    for (const ing of next.ingredients) {
      const ingKey = normKey(ing.name)
      const prevIng = ingredientMap.get(ingKey)
      if (prevIng) {
        ingredientMap.set(ingKey, { ...prevIng, qty: prevIng.qty + ing.qty })
      } else {
        ingredientMap.set(ingKey, ing)
      }
    }
    byTitle.set(key, {
      ...prev,
      chipLabel: prev.chipLabel ?? next.chipLabel,
      methodUrl: prev.methodUrl ?? next.methodUrl,
      ingredients: Array.from(ingredientMap.values()),
    })
  }
  return Array.from(byTitle.values())
}

function getCatalogErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Could not load POPMAS. Check Supabase configuration and access.'
}

/** Active Build Preferences count from current state (non-default selections only). */
function countActiveBuildPreferences(
  dietSelections: DietOption[],
  rangeSelections: RangeOption[],
  household: HouseholdOption | null,
  itemsOnly: boolean,
): number {
  // Defaults: no diet, no range, household unset, items-only off.
  // Diet/Range are multi-select by design — each selected option counts.
  // Household is single-select — any explicit choice counts as 1.
  // Items only counts when the customer turns the toggle on.
  return (
    dietSelections.length +
    rangeSelections.length +
    (household != null ? 1 : 0) +
    (itemsOnly ? 1 : 0)
  )
}

/** Waitrose & Partners 2018 lockup. Set width or height via className/style. */
function WaitroseLogo({ className = '', title = 'Waitrose & Partners' }: { className?: string; title?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 579 131"
      role="img"
      aria-label={title}
      className={className}
    >
      <g fill="#5C8018" fillRule="evenodd">
        <path d="M546.58.98v55.65h32.3v-7.18h-24.31v-17.3h22.76v-7.1h-22.76V8.08h23.58V.98z" />
        <path
          fillRule="nonzero"
          d="M314.19.98v55.65h8V32.4h3.59c3.91 0 7.42 1.71 13.05 10.53l8.81 13.71h9.46l-9.79-14.85c-5.38-8.16-6.93-9.46-10.2-11.59 6.12-2.45 9.3-7.26 9.3-13.71 0-8.16-5.79-15.5-16.89-15.5h-15.33V.98zm8 7.02h6.77c6.04 0 9.3 3.1 9.3 8.49 0 7.42-5.14 8.89-10.93 8.89h-5.14V8z"
        />
        <path d="M233.78.98V8h19.09v48.63h7.99V8h19.42V.98z" />
        <path
          fillRule="nonzero"
          d="M129.15.65l-23.9 55.97h8.16l7.02-16.4h23.66l7.42 16.4h8.16L134.79.65h-5.64zm2.78 10.85l9.05 21.54h-17.54l8.49-21.54z"
        />
        <path d="M77.11.97l-15.2 38.38L46.4.97h-7.59L23.39 39.35 8.03.97h-8l22.53 56.18h1.55l18.46-45.56 18.29 45.56h1.55L85.03.97zM192 .97h8v55.69h-8z" />
        <path
          fillRule="nonzero"
          d="M415.26.19c8.6 0 15.77 2.72 21.49 8.17 5.72 5.45 8.58 12.28 8.58 20.49 0 8.21-2.89 15.01-8.66 20.39-5.78 5.38-13.06 8.07-21.85 8.07-8.39 0-15.38-2.69-20.97-8.07-5.59-5.38-8.38-12.12-8.38-20.23 0-8.32 2.81-15.2 8.44-20.65 5.63-5.45 12.75-8.17 21.35-8.17zm.32 7.57c-6.37 0-11.61 1.99-15.71 5.98-4.1 3.99-6.15 9.07-6.15 15.27 0 6 2.06 11 6.17 14.99 4.11 3.98 9.26 5.98 15.45 5.98 6.21 0 11.39-2.03 15.55-6.1 4.15-4.07 6.23-9.13 6.23-15.19 0-5.9-2.08-10.86-6.23-14.89-4.15-4.03-9.26-6.04-15.31-6.04z"
        />
        <path d="M495.73 33.36l-6.06-3.68c-3.8-2.32-6.2-4.64-7.93-6.79-1.79-2.23-2.69-4.97-2.69-7.9 0-4.38 1.52-7.95 4.56-10.68 3.04-2.74 7.1-4.06 11.96-4.06 5.13 0 8.92 1.31 12.79 3.92v9.05c-4.01-3.86-8.33-5.79-12.95-5.79-2.61 0-4.74.6-6.42 1.81-1.67 1.2-2.51 2.78-2.51 4.66 0 1.67.41 3.05 1.64 4.51s3.43 3.16 6.16 4.76l6.32 3.6c6.79 4.06 9.96 9.22 9.96 15.49 0 4.46-1.54 8.14-4.53 10.93-2.99 2.79-6.83 4.28-11.61 4.19-5.49-.1-10.4-1.63-15.03-5.13V42.13c4.3 5.45 9.29 8.06 14.95 8.06 2.5 0 4.58-.58 6.24-1.97 1.66-1.39 2.56-3.13 2.56-5.22 0-3.39-2.52-6.6-7.41-9.64z" />
        <g>
          <path
            fillRule="nonzero"
            d="M161.57 129.76V97.15h10.41c3.11 0 5.59.84 7.44 2.52 1.85 1.68 2.77 3.93 2.77 6.76 0 1.9-.43 3.63-1.38 5.09a8.19 8.19 0 0 1-3.93 3.13c-2 .76-3.83 1-7.09.99h-3.53v14.13h-4.69v-.01zm9.6-28.47h-4.91v10.19h5.19c3.5 0 5.92-1.56 5.92-5.18 0-3.34-2.07-5.01-6.2-5.01zM210.42 97h3.28l14.6 32.75h-4.77l-4.34-9.65H205.3l-4.07 9.65h-4.79L210.42 97zm6.85 18.96l-5.25-11.8-4.87 11.8h10.12z"
          />
          <path d="M289.01 97.14h27.34v4.15h-11.32v28.47h-4.69v-28.47h-11.33zM364.1 97.19h4.43v32.57h-4.01l-21.94-25.08v25.08h-4.38V97.19h3.78l22.13 25.3v-25.3zM393.25 97.19h18.46v4.15h-13.8v9.93h13.33v4.17h-13.33v10.12h14.24v4.15h-18.91V97.19z" />
          <path
            fillRule="nonzero"
            d="M249.13 129.76V97.19h8.26c3.29 0 5.91.82 7.84 2.45 1.94 1.63 2.9 3.84 2.9 6.62 0 1.9-.47 3.54-1.42 4.92s-2.22 2.42-3.99 3.1c1.04.68 2.06 1.62 3.05 2.8.99 1.18 2.34 3.24 4.15 6.18 1.13 1.85 2.09 3.24 2.78 4.17l1.72 2.33h-5.61s-1.5-2.36-1.64-2.54l-2.35-3.66-1.74-2.54c-.96-1.34-1.85-2.44-2.65-3.24-.8-.79-1.43-1.32-2.08-1.67-.65-.35-1.82-.52-3.35-.52h-1.21v14.17h-4.66zm6.15-28.61h-1.4v10.28h1.77c2.36 0 3.98-.2 4.86-.61 1.89-.86 2.77-2.68 2.79-4.62.01-2.02-1.13-3.87-3.11-4.55-.99-.32-2.62-.5-4.91-.5zM434.85 129.76V97.19h8.26c3.29 0 5.91.82 7.84 2.45 1.94 1.63 2.9 3.84 2.9 6.62 0 1.9-.47 3.54-1.42 4.92s-2.22 2.42-3.99 3.1c1.04.68 2.06 1.62 3.05 2.8.99 1.18 2.34 3.24 4.15 6.18 1.13 1.85 2.09 3.24 2.78 4.17l1.72 2.33h-5.61s-1.5-2.36-1.64-2.54l-2.35-3.66-1.74-2.54c-.96-1.34-1.85-2.44-2.65-3.24-.8-.79-1.43-1.32-2.08-1.67-.65-.35-1.82-.52-3.35-.52h-1.21v14.17h-4.66zm6.16-28.61h-1.4v10.28h1.77c2.36 0 3.98-.2 4.86-.61 1.89-.86 2.77-2.68 2.79-4.62.01-2.02-1.13-3.87-3.11-4.55-.99-.32-2.63-.5-4.91-.5z"
          />
          <path d="M489.36 116.11l-3.54-2.15c-2.22-1.36-3.8-2.69-4.74-4.01-.94-1.31-1.41-2.82-1.41-4.53 0-2.56.89-4.65 2.67-6.25 1.78-1.6 4.09-2.4 6.94-2.4 2.72 0 5.21.76 7.48 2.29v5.29c-2.35-2.26-4.87-3.39-7.58-3.39-1.52 0-2.77.35-3.75 1.06-.98.71-1.47 1.61-1.47 2.71 0 .98.36 1.89 1.08 2.74.72.85 1.88 1.75 3.48 2.68l3.56 2.11c3.97 2.37 5.96 5.39 5.96 9.06 0 2.61-.87 4.73-2.62 6.36s-4.02 2.45-6.82 2.45c-3.22 0-6.15-.99-8.79-2.97v-5.92c2.52 3.19 5.43 4.79 8.74 4.79 1.46 0 2.68-.41 3.65-1.22.97-.81 1.46-1.83 1.46-3.05-.01-1.99-1.45-3.87-4.3-5.65z" />
          <path
            fillRule="nonzero"
            d="M102.99 122.41c1.98-2.56 3.77-7.29 4.08-9.02-.58 0-4.02.01-4.02.01-.41 1.35-1.45 4.04-2.72 6.14l-5.89-6.42c2.9-1.69 5.82-4.78 5.73-8.39-.05-2.1-.85-3.83-2.41-5.18-1.56-1.35-3.51-2.03-5.87-2.03-2.4 0-4.34.69-5.81 2.08-1.47 1.38-2.28 3.19-2.12 5.41.18 2.6 1.49 4.63 3.99 7.49-.73.41-2.46 1.55-3.07 2.05-2.76 2.28-4.55 4.79-3.89 8.92.44 2.72 2.6 6.19 8.05 6.61 4.48.34 8.2-1.3 11.26-4.14l3.64 3.83h5.89l-6.84-7.36zm-10.93-20.93c1.99-.05 3.63 1.01 3.93 2.74.29 1.67-.67 3.17-1.82 4.29-.63.61-1.44 1.23-2.43 1.87-1.04-.94-1.88-1.96-2.46-2.97-.49-.87-.88-1.87-.88-2.88.01-1.81 1.69-3 3.66-3.05zm-5.85 22.61c-1.87-4.09 1.65-6.76 4.48-8.45 0 0 5.24 5.7 6.82 7.43-2.99 3.42-9.71 4.47-11.3 1.02z"
          />
        </g>
      </g>
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="#333" strokeWidth="1.2" />
      <path d="M10.5 10.5L14 14" stroke="#333" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconCalendar() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" stroke="#333" strokeWidth="1.1" />
      <path d="M2 6.5H14" stroke="#333" strokeWidth="1.1" />
      <path d="M5 2V4.5M11 2V4.5" stroke="#333" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function IconTrolley({ color = '#333' }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3h2l1.5 6h6.8l1.2-4.5H5.2" stroke={color} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="7" cy="12.5" r="1" fill={color} />
      <circle cx="11.5" cy="12.5" r="1" fill={color} />
    </svg>
  )
}

/** Item-count badge on trolley icon — Waitrose green circle, white text (centred on icon). */
function TrolleyIconWithBadge({ count, iconColor = '#333' }: { count: number; iconColor?: string }) {
  const label = count > 99 ? '99+' : String(count)
  const compactText = label.length >= 3
  return (
    <span className="relative inline-flex size-[22px] shrink-0 items-center justify-center">
      <IconTrolley color={iconColor} />
      {count > 0 ? (
        <span
          className={[
            'pointer-events-none absolute left-1/2 top-1/2 z-10 flex size-[18px] shrink-0 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#5B8226] font-medium leading-none text-white tabular-nums shadow-none',
            compactText ? 'text-[7px]' : 'text-[9px]',
          ].join(' ')}
          aria-hidden
        >
          {label}
        </span>
      ) : null}
    </span>
  )
}

function IconMenu() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4h10M3 8h10M3 12h10" stroke="#333" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

const CUISINE_FILTER_OPTIONS = ['All', 'British', 'Chinese', 'Indian', 'Italian', 'Mexican'] as const

function IconChevronDownSmall({ open }: { open?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 text-[#53565A] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
    >
      <path
        d="M3.5 5.25 7 8.75l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Compact inline cuisine control with a popover list. */
function CuisinePicker({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: 'All' | Cuisine
  onChange: (v: 'All' | Cuisine) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false)
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className="flex min-h-11 items-center gap-1 bg-transparent py-2 text-left text-[14px] leading-5 text-[#53565A] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#154734]"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Cuisine: ${value}`}
        onClick={() => onOpenChange(!open)}
      >
        <span className="whitespace-nowrap">Cuisine: {value}</span>
        <IconChevronDownSmall open={open} />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="Cuisine options"
          className="absolute left-0 top-full z-20 max-h-[min(280px,50vh)] min-w-[148px] overflow-y-auto rounded-2xl border border-[#e8e8e8] bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        >
          {CUISINE_FILTER_OPTIONS.map((opt) => {
            const selected = opt === value
            return (
              <li key={opt} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] leading-5 transition-colors ${
                    selected
                      ? 'bg-[#EEF4FF] font-medium text-[#007AFF]'
                      : 'font-normal text-[#53565A] hover:bg-[#fafafa]'
                  }`}
                  onClick={() => {
                    onChange(opt)
                    onOpenChange(false)
                  }}
                >
                  <span>{opt}</span>
                  {selected ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
                      <path
                        d="M3.5 8.2 6.4 11 12.5 4.9"
                        stroke="#007AFF"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden="true" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

function IconSuccessCheck() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" stroke="white" strokeWidth="1.3" />
      <path d="M6.1 10.3 8.6 12.8 13.9 7.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChipSpinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/70 border-t-transparent"
      aria-hidden="true"
    />
  )
}

/** Icons/Small/ImagePlaceholder — matches Figma node 17778:11125 */
function IconUploadImage() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2" width="13" height="11.5" stroke="#333" strokeWidth="1" />
      <circle cx="4.8" cy="5.3" r="1.15" stroke="#333" strokeWidth="1" />
      <path
        d="M2.5 12.7L5.9 9.1 8.05 11.2 11 7.85 13.5 12.7"
        stroke="#333"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}


/** Icons/Small/Entertaining (cloche) — matches Figma node 17778:11127 */
function IconPreferences() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {/* Filter funnel — three lines decreasing in length */}
      <line x1="2"   y1="4"  x2="14"  y2="4"  stroke="#333" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="4"   y1="8"  x2="12"  y2="8"  stroke="#333" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="6.5" y1="12" x2="9.5" y2="12" stroke="#333" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Icons/Small/Alert/Information — allergen disclaimer (swap for asset when provided). */
function IconDisclaimerInfo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="#53565A" strokeWidth="1" />
      <circle cx="8" cy="5.25" r="0.65" fill="#53565A" />
      <path d="M8 7.25v5" stroke="#53565A" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  )
}

function App() {
  const [generated, setGenerated] = useState(false)
  const [inputValue, setInputValueState] = useState('')
  /** Last textarea value, updated synchronously in onChange — avoids controlled-input stale reads on “clear then Build”. */
  const listDraftRef = useRef('')

  function setInputValue(next: string | ((prev: string) => string)) {
    if (typeof next === 'function') {
      setInputValueState((prev) => {
        const resolved = next(prev)
        listDraftRef.current = resolved
        return resolved
      })
    } else {
      listDraftRef.current = next
      setInputValueState(next)
    }
  }
  const [uploadedFileName, setUploadedFileName] = useState('')
  const [showPreferences, setShowPreferences] = useState(false)
  const [toast, setToast] = useState('')
  const [showMoreEssentials, setShowMoreEssentials] = useState(false)
  const [trolleyLines, setTrolleyLines] = useState<TrolleyLine[]>([])
  const [trolleySnackbar, setTrolleySnackbar] = useState('')
  const [swapTarget, setSwapTarget] = useState<SwapTarget | null>(null)
  const [swapAlternativePool, setSwapAlternativePool] = useState<WaitroseCatalogItem[]>([])
  const [swapAltsLoading, setSwapAltsLoading] = useState(false)
  const [swapRefinement, setSwapRefinement] = useState<SwapRefinement>('All')
  const [swapShowAllAlts, setSwapShowAllAlts] = useState(false)
  const swapCatalogRef = useRef<WaitroseCatalogItem[] | null>(null)
  const [autocompleteCatalog, setAutocompleteCatalog] = useState<WaitroseCatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [, setCatalogSourceLabel] = useState('')
  const [listInputError, setListInputError] = useState('')
  const [imageProcessing, setImageProcessing] = useState(false)
  const [forceMultiItemMode, setForceMultiItemMode] = useState(false)
  const [uploadReviewPending, setUploadReviewPending] = useState(false)
  const [autocompleteOpen, setAutocompleteOpen] = useState(false)
  const [autocompleteHighlight, setAutocompleteHighlight] = useState(-1)
  const [viewAllQuery, setViewAllQuery] = useState<string | null>(null)
  const [cuisineSelection, setCuisineSelection] = useState<'All' | Cuisine>('All')
  const [cuisinePickerOpen, setCuisinePickerOpen] = useState(false)
  const [removeConfirmTarget, setRemoveConfirmTarget] = useState<RemoveConfirmTarget | null>(null)
  const [chipSnackbarVisible, setChipSnackbarVisible] = useState(false)
  const [removedEssentialName, setRemovedEssentialName] = useState('')
  const [activeInspirationChip, setActiveInspirationChip] = useState<string | null>(null)

  const [appliedPreferences, setAppliedPreferences] =
    useState<BuildPreferencesState>(emptyBuildPreferences)
  const [draftPreferences, setDraftPreferences] =
    useState<BuildPreferencesState>(emptyBuildPreferences)
  const { dietSelections, rangeSelections, household, itemsOnly } = appliedPreferences
  const [showItemsOnlyTooltip, setShowItemsOnlyTooltip] = useState(false)

  const [mealGroups, setMealGroups] = useState<MealGroup[]>([])
  const [essentials, setEssentials] = useState<Essential[]>([])

  const inspirationSlots = useMemo(
    () => visibleInspirationChips(cuisineSelection, mealGroups),
    [cuisineSelection, mealGroups],
  )

  const activeBuildPreferencesCount = useMemo(
    () => countActiveBuildPreferences(dietSelections, rangeSelections, household, itemsOnly),
    [dietSelections, rangeSelections, household, itemsOnly],
  )

  const availableSwapRefinements = useMemo(
    () =>
      SWAP_REFINEMENT_OPTIONS.filter(
        (refinement) =>
          refinement === 'All'
            ? swapAlternativePool.length > 0
            : filterPoolBySwapRefinement(swapAlternativePool, refinement).length > 0,
      ),
    [swapAlternativePool],
  )
  const filteredSwapAlternatives = useMemo(
    () => filterPoolBySwapRefinement(swapAlternativePool, swapRefinement),
    [swapAlternativePool, swapRefinement],
  )
  const swapAlts = swapShowAllAlts
    ? filteredSwapAlternatives
    : filteredSwapAlternatives.slice(0, 4)
  const swapAltPoolSize = filteredSwapAlternatives.length

  const [appView, setAppView] = useState<AppView>('index')
  const [savedLists, setSavedLists] = useState<SavedList[]>([])
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [isReturningToList, setIsReturningToList] = useState(false)
  const [addItemPanelExpanded, setAddItemPanelExpanded] = useState(true)
  const [listName, setListName] = useState('')
  const [newListNameInput, setNewListNameInput] = useState('')
  const [editingListId, setEditingListId] = useState<string | null>(null)
  const [editingListNameInput, setEditingListNameInput] = useState('')
  const [activeNavTab, setActiveNavTab] = useState<string>('Shopping lists')
  const navCarouselRef = useRef<HTMLDivElement | null>(null)
  const [navChevrons, setNavChevrons] = useState<{ left: boolean; right: boolean }>({ left: false, right: true })
  const [showAutoSaveBanner, setShowAutoSaveBanner] = useState<boolean>(
    () => localStorage.getItem('wtr-autosave-banner-dismissed') !== '1',
  )

  useEffect(() => {
    const checkChevrons = () => {
      const c = navCarouselRef.current
      if (!c) return
      setNavChevrons({
        left: c.scrollLeft > 4,
        right: c.scrollLeft < c.scrollWidth - c.clientWidth - 4,
      })
    }
    checkChevrons()
    window.addEventListener('resize', checkChevrons)
    return () => window.removeEventListener('resize', checkChevrons)
  }, [])

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const listInputRef = useRef<HTMLTextAreaElement | null>(null)
  /** Chip inspiration skips the textarea; don’t auto-hide results while this is true. */
  const resultsFromChipRef = useRef(false)
  /** Lines last chosen from a chip (for Apply / preferences without typed list). */
  const chipSourceLinesRef = useRef<string[]>([])
  /** Bumps when list-building intent changes; stale async catalog work must not apply state. */
  const listBuildGenerationRef = useRef(0)
  /** Bumps per image upload so stale OCR results cannot overwrite newer uploads. */
  const uploadGenerationRef = useRef(0)

  const buildFooterRef = useRef<HTMLElement | null>(null)
  const [buildFooterHeight, setBuildFooterHeight] = useState(0)
  const [buildFooterVisible, setBuildFooterVisible] = useState(false)
  const footerLastScrollYRef = useRef(0)
  const footerRevealTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (!swapTarget) {
      setSwapAlternativePool([])
      return
    }
    if (swapCatalogRef.current) {
      setSwapAlternativePool(buildSwapAlternativePool(swapTarget.item, swapCatalogRef.current))
      setSwapAltsLoading(false)
      return
    }
    setSwapAltsLoading(true)
    void loadCatalogForBuildShop()
      .then((payload) => {
        const swapCatalog = mergeSwapCatalogs(
          payload.primary.products,
          payload.fallback?.products ?? [],
        )
        swapCatalogRef.current = swapCatalog
        setSwapAlternativePool(buildSwapAlternativePool(swapTarget.item, swapCatalog))
        setSwapAltsLoading(false)
      })
      .catch((err) => {
        if (DEBUG_MEAL_RECIPE_BUILD) console.error('[swap] POPMAS error', err)
        setSwapAlternativePool([])
        setSwapAltsLoading(false)
      })
  }, [swapTarget])

  useEffect(() => {
    if (!swapTarget) return
    setSwapRefinement('All')
    setSwapShowAllAlts(false)
  }, [swapTarget])

  useEffect(() => {
    if (!swapTarget) return
    setSwapShowAllAlts(false)
  }, [swapRefinement, swapTarget])

  useEffect(() => {
    if (
      swapRefinement !== 'All' &&
      !availableSwapRefinements.includes(swapRefinement)
    ) {
      setSwapRefinement('All')
    }
  }, [availableSwapRefinements, swapRefinement])

  useEffect(() => {
    if (!swapTarget) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [swapTarget])

  useEffect(() => {
    if (!showPreferences) return
    const prevOverflow = document.body.style.overflow
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setDraftPreferences(copyBuildPreferences(appliedPreferences))
      setShowItemsOnlyTooltip(false)
      setShowPreferences(false)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [showPreferences, appliedPreferences])

  useEffect(() => {
    if (!removeConfirmTarget) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [removeConfirmTarget])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (!chipSnackbarVisible) return
    const timeout = window.setTimeout(() => setChipSnackbarVisible(false), 2200)
    return () => window.clearTimeout(timeout)
  }, [chipSnackbarVisible])

  useEffect(() => {
    if (!trolleySnackbar) return
    const timeout = window.setTimeout(() => setTrolleySnackbar(''), 2200)
    return () => window.clearTimeout(timeout)
  }, [trolleySnackbar])

  useEffect(() => {
    if (!removedEssentialName) return
    const timeout = window.setTimeout(() => setRemovedEssentialName(''), 2200)
    return () => window.clearTimeout(timeout)
  }, [removedEssentialName])

  useEffect(() => {
    if (appView !== 'build') return
    if (autocompleteCatalog.length > 0) return
    void loadCatalogForBuildShop()
      .then((payload) => {
        setAutocompleteCatalog(payload.primary.products)
        if (!swapCatalogRef.current) {
          swapCatalogRef.current = mergeSwapCatalogs(
            payload.primary.products,
            payload.fallback?.products ?? [],
          )
        }
      })
      .catch(() => {
        setAutocompleteCatalog([])
      })
  }, [appView, autocompleteCatalog.length])

  useEffect(() => {
    if (!autocompleteOpen) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (listInputRef.current?.contains(target)) return
      if (document.querySelector('[data-product-autocomplete-panel]')?.contains(target)) return
      setAutocompleteOpen(false)
      setAutocompleteHighlight(-1)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [autocompleteOpen])

  useEffect(() => {
    if (!generated) return
    // Read the live textarea value to avoid a one-frame state lag
    // that can clear freshly built results.
    const lines = getShopListLinesFromUserInput(readListTextareaRaw())
    if (resultsFromChipRef.current) return
    // Preserve generated shop rows after a successful build even when
    // the input is intentionally cleared to show the "Need anything else?" prompt.
    const hasExistingRows =
      mealGroups.some((m) => !m.removed && m.ingredients.length > 0) || essentials.length > 0
    if (hasExistingRows) return
    if (lines.length === 0 && !uploadedFileName) {
      setGenerated(false)
      setListInputError('')
      setMealGroups([])
      setEssentials([])
      chipSourceLinesRef.current = []
    }
  }, [inputValue, uploadedFileName, generated, mealGroups, essentials])

  useEffect(() => {
    if (!generated) return
    // Don't clear the badge while a new image is still being processed —
    // that would immediately wipe the filename the user just selected.
    if (imageProcessing) return
    const hasBuiltRows =
      mealGroups.some((m) => !m.removed && m.ingredients.length > 0) || essentials.length > 0
    if (!hasBuiltRows) return
    if (!uploadedFileName) return
    // If results exist, clear stale upload badge so user can pick a new image immediately.
    resetUploadedFileSelection()
  }, [generated, imageProcessing, mealGroups, essentials, uploadedFileName])


  const visibleUploadedFileName = uploadedFileName

  const helperCopy = generated
    ? 'Need anything else?'
    : SHOP_LIST_HELPER_INITIAL
  const ESSENTIALS_PREVIEW = 6
  const hiddenEssentialsCount = Math.max(0, essentials.length - ESSENTIALS_PREVIEW)
  const visibleEssentials = showMoreEssentials ? essentials : essentials.slice(0, ESSENTIALS_PREVIEW)

  const mealsTotal = mealGroups
    .filter((m) => !m.removed)
    .flatMap((m) => m.ingredients)
    .reduce((sum, i) => (i.selected ? sum + i.price * i.qty : sum), 0)
  const essentialsTotal = essentials.reduce((sum, i) => sum + i.price * i.qty, 0)
  const estimatedTotal = mealsTotal + essentialsTotal
  const displayTotal = generated ? estimatedTotal : 0
  const canAddToTrolley = generated && displayTotal > 0
  const hasBuildProducts =
    generated &&
    (mealGroups.some((meal) => !meal.removed && meal.ingredients.length > 0) || essentials.length > 0)

  useLayoutEffect(() => {
    if (appView !== 'build' || !hasBuildProducts) return
    const el = buildFooterRef.current
    if (!el) return
    const measure = () => setBuildFooterHeight(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [appView, hasBuildProducts])

  useEffect(() => {
    if (appView !== 'build' || !hasBuildProducts) {
      const frame = window.requestAnimationFrame(() => setBuildFooterVisible(false))
      if (footerRevealTimeoutRef.current != null) {
        window.clearTimeout(footerRevealTimeoutRef.current)
        footerRevealTimeoutRef.current = null
      }
      return () => window.cancelAnimationFrame(frame)
    }

    const entryFrame = window.requestAnimationFrame(() => setBuildFooterVisible(true))
    footerLastScrollYRef.current = window.scrollY

    const scheduleReveal = () => {
      if (footerRevealTimeoutRef.current != null) {
        window.clearTimeout(footerRevealTimeoutRef.current)
      }
      footerRevealTimeoutRef.current = window.setTimeout(() => {
        setBuildFooterVisible(true)
        footerRevealTimeoutRef.current = null
      }, 650)
    }

    const onScroll = () => {
      const nextY = window.scrollY
      const delta = nextY - footerLastScrollYRef.current
      if (Math.abs(delta) >= 8) {
        if (delta > 0 && nextY > 24) {
          setBuildFooterVisible(false)
        } else if (delta < 0) {
          setBuildFooterVisible(true)
        }
        footerLastScrollYRef.current = nextY
      }
      scheduleReveal()
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.cancelAnimationFrame(entryFrame)
      window.removeEventListener('scroll', onScroll)
      if (footerRevealTimeoutRef.current != null) {
        window.clearTimeout(footerRevealTimeoutRef.current)
        footerRevealTimeoutRef.current = null
      }
    }
  }, [appView, hasBuildProducts])

  /** Sum of line qty for selected meal ingredients + all essentials (matches trolley monetary total scope). */
  const unitsForTrolleyAdd = (() => {
    let n = 0
    for (const m of mealGroups.filter((x) => !x.removed)) {
      for (const i of m.ingredients) {
        if (i.selected) n += i.qty
      }
    }
    for (const e of essentials) {
      n += e.qty
    }
    return n
  })()

  const trolleyMoneyTotal = trolleyLines.reduce((s, l) => s + l.price * l.qty, 0)
  const trolleyUnitCount = trolleyLines.reduce((s, l) => s + l.qty, 0)

  const visibleMealCount = mealGroups.filter((m) => !m.removed).length
  const hasVisibleMeals = visibleMealCount > 0
  const hasVisibleEssentials = essentials.length > 0
  const essentialsMetaLine = `${essentials.length} items • ${formatCurrency(essentialsTotal)}`

  function openBuildPreferences() {
    setDraftPreferences(copyBuildPreferences(appliedPreferences))
    setShowItemsOnlyTooltip(false)
    setShowPreferences(true)
  }

  function dismissBuildPreferences() {
    setDraftPreferences(copyBuildPreferences(appliedPreferences))
    setShowItemsOnlyTooltip(false)
    setShowPreferences(false)
  }

  function applyPreferences() {
    setAppliedPreferences(copyBuildPreferences(draftPreferences))
    setShowItemsOnlyTooltip(false)
    setShowPreferences(false)
  }

  /** Prefer the live textarea DOM (controlled fields can lag React state one frame). */
  function readListTextareaRaw(): string {
    const el =
      listInputRef.current ??
      (typeof document !== 'undefined' ? (document.getElementById('list-input') as HTMLTextAreaElement | null) : null)
    if (el?.value != null) return el.value
    return listDraftRef.current
  }

  async function handleBuildShop() {
    setListInputError('')
    setAutocompleteOpen(false)
    setAutocompleteHighlight(-1)
    setViewAllQuery(null)
    const rawFromDom = readListTextareaRaw()
    listDraftRef.current = rawFromDom
    if (rawFromDom !== inputValue) setInputValueState(rawFromDom)
    const parsedLines = getShopListLinesFromUserInput(rawFromDom)
    const rawFallbackLines = rawFromDom
      .split(/[\n,;]+/u)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const lines = parsedLines.length > 0 ? parsedLines : rawFallbackLines
    const hasUpload = Boolean(uploadedFileName)
    // UX requirement: clicking Build shop always resets the upload selection.
    if (hasUpload) resetUploadedFileSelection()
    const rawLooksNonEmpty =
      rawFromDom.replace(/[\u200B-\u200D\uFEFF\u00AD\u200E\u200F\u202A-\u202E\u2060]/g, '').trim().length > 0

    if (lines.length === 0 && !hasUpload) {
      listBuildGenerationRef.current += 1
      setCatalogLoading(false)
      chipSourceLinesRef.current = []
      resultsFromChipRef.current = false
      if (rawLooksNonEmpty && isLikelyUiPlaceholderList(rawFromDom)) {
        setInputValue('')
        setListInputError(
          'That text is only the on-screen hint — it is not your shopping list. Type or dictate your own items, upload a list image, or tap a suggestion below.',
        )
      } else {
        setListInputError(
          'Add at least one item (type or paste, use the mic to say your list, or upload an image), or tap a suggestion below — then build your shop.',
        )
      }
      return
    }
    if (lines.length === 0 && hasUpload) {
      listBuildGenerationRef.current += 1
      setCatalogLoading(false)
      chipSourceLinesRef.current = []
      resultsFromChipRef.current = false
      setListInputError('Your list is empty. Type or paste items, use the mic, or upload your image again.')
      return
    }

    const gen = ++listBuildGenerationRef.current
    setCatalogLoading(true)
    setShowMoreEssentials(false)
    try {
      const payload = await loadCatalogForBuildShop()
      if (gen !== listBuildGenerationRef.current) return

      const serves = household ?? 'Serves 4'
      const linesToPredict = lines.filter(
        (line) => !essentials.some((e) => lineMatchesManualEssential(e, line)),
      )
      const built = buildShopFromListLines(
        linesToPredict,
        payload.primary.products,
        payload.fallback?.products ?? [],
        serves,
        dietSelections,
        itemsOnly,
      )

      if (!builtShopHasRows(built) && linesToPredict.length > 0) {
        setListInputError('No new items were found in POPMAS for this update.')
        return
      }

      const newMealGroups = mergeMealGroups(mealGroups, built.meals)
      const newEssentials = mergeEssentials(essentials, built.essentials)
      setGenerated(true)
      setMealGroups(newMealGroups)
      setEssentials(newEssentials)
      // Auto-save to the active list entry
      if (activeListId) {
        setSavedLists((prev) =>
          prev.map((l) =>
            l.id === activeListId
              ? { ...l, mealGroups: newMealGroups, essentials: newEssentials, generated: true }
              : l,
          ),
        )
      }
      // Clear entered list so the post-build helper prompt is visible.
      setInputValue('')
      setForceMultiItemMode(false)
      setUploadReviewPending(false)
      resetUploadedFileSelection()
      setCatalogSourceLabel(
        built.fallbackMatches > 0 && payload.fallback
          ? `${payload.primary.source} (fallback used for ${built.fallbackMatches} item${built.fallbackMatches === 1 ? '' : 's'}: ${payload.fallback.source})`
          : payload.primary.source,
      )
    } catch (error) {
      if (gen !== listBuildGenerationRef.current) return
      if (DEBUG_MEAL_RECIPE_BUILD) console.error('[meal-build] POPMAS error', error)
      setGenerated(mealGroups.length > 0 || essentials.length > 0)
      setCatalogSourceLabel('error: POPMAS unavailable')
      setListInputError(getCatalogErrorMessage(error))
      setToast('Build shop requires POPMAS. Configure Supabase to continue.')
    } finally {
      if (gen === listBuildGenerationRef.current) setCatalogLoading(false)
    }
  }

  function toggleDiet(value: DietOption) {
    setDraftPreferences((prev) => ({
      ...prev,
      dietSelections: prev.dietSelections.includes(value)
        ? prev.dietSelections.filter((option) => option !== value)
        : [...prev.dietSelections, value],
    }))
  }

  function toggleRange(value: RangeOption) {
    setDraftPreferences((prev) => ({
      ...prev,
      rangeSelections: prev.rangeSelections.includes(value)
        ? prev.rangeSelections.filter((option) => option !== value)
        : [...prev.rangeSelections, value],
    }))
  }

  function changeMealQty(mealId: string, ingredientId: string, delta: number) {
    setMealGroups((prev) =>
      prev.map((meal) =>
        meal.id !== mealId
          ? meal
          : {
              ...meal,
              ingredients: meal.ingredients.map((item) => {
                if (item.id !== ingredientId) return item
                const newQty = Math.max(0, item.qty + delta)
                return { ...item, qty: newQty, selected: newQty > 0 }
              }),
            },
      ),
    )
  }

  function changeEssentialQty(id: string, delta: number) {
    setEssentials((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        const newQty = Math.max(0, item.qty + delta)
        return { ...item, qty: newQty, selected: newQty > 0 }
      }),
    )
  }

  function applySwap(choice: WaitroseCatalogItem) {
    if (!swapTarget) return
    if (swapTarget.kind === 'meal') {
      setMealGroups((prev) =>
        prev.map((meal) =>
          meal.id !== swapTarget.mealId
            ? meal
            : {
                ...meal,
                ingredients: meal.ingredients.map((item) =>
                  item.id !== swapTarget.ingredientId
                    ? item
                    : {
                        ...item,
                        name: choice.name,
                        price: choice.price,
                        unitPrice: choice.unitPrice,
                        image: catalogProductImage(choice.imageUrl),
                        productType: choice.productType,
                        matched: true,
                        fallbackReason: undefined,
                        ingredientIntent: item.ingredientIntent,
                      },
                ),
              },
        ),
      )
    } else {
      setEssentials((prev) =>
        prev.map((item) =>
          item.id !== swapTarget.id
            ? item
            : {
                ...item,
                name: choice.name,
                price: choice.price,
                unitPrice: choice.unitPrice,
                image: catalogProductImage(choice.imageUrl),
                productType: choice.productType,
              },
        ),
      )
    }
    setSwapTarget(null)
  }


  function handleUploadFile(file?: File) {
    if (!file) return
    // Reset the input value immediately so re-selecting the same file always fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = ''
    const uploadGen = ++uploadGenerationRef.current
    setListInputError('')
    resultsFromChipRef.current = false
    chipSourceLinesRef.current = []
    setUploadedFileName(file.name)
    setImageProcessing(true)
    void (async () => {
      try {
        // Try Google Vision API first — it handles handwritten and printed lists
        // far more reliably than local Tesseract.  Fall back to Tesseract when
        // Supabase is not configured or the edge function call fails.
        const visionResult = await runVisionOcr(file)
        if (uploadGen !== uploadGenerationRef.current) return

        // ── VISION API PATH ──────────────────────────────────────────────────────
        // When Vision succeeds we parse its text directly and return early.
        // The Tesseract consensus/intent/vocab pipeline below was built to rescue
        // garbled Tesseract output — applying it to Vision's clean text produces
        // false positives (items from previous lists, hallucinated grocery items).
        if (visionResult.ok && visionResult.text.trim().length > 0) {
          console.log('[OCR] Google Vision result:', visionResult.text)

          // Normalise any Cyrillic confusables Vision returned for handwritten Latin text
          const visionText = normaliseCyrillicConfusables(visionResult.text)
          if (visionText !== visionResult.text) {
            console.log('[OCR] After Cyrillic normalisation:', visionText)
          }

          const visionSeen = new Set<string>()
          const visionLines: string[] = []

          for (const raw of visionText.split('\n')) {
            // Skip standalone quantity lines like "× 54" or "x 100,000" written
            // below an item (common in handwritten lists with footnote-style quantities).
            // The item name is already captured from the line above; qty can be set manually.
            if (/^[x×✕]\s*[\d,]+\s*$/i.test(raw.trim())) continue

            let line = raw
              // Strip leading bullets, numbers, punctuation
              .replace(/^[\s\-*•·●▪◦□☐☑✓✔\d().,:;/\\]+/u, '')
              // Strip trailing inline quantity annotations (x 2, × 100,000, x54)
              .replace(/\s*[x×]\s*[\d,]+\s*$/i, '')
              .replace(/\s{2,}/g, ' ')
              .trim()

            if (line.length < 2) continue
            if (!/[\p{L}]/u.test(line)) continue
            if (/^\d+([.,]\d+)?$/.test(line)) continue
            if (/(£\s?\d|[0-9]+[.,][0-9]{2})/u.test(line)) continue

            const cleaned = line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
            if (!cleaned) continue

            // Apply alias rewrites first (e.g. OJ → Orange Juice, Bananaa → Bananas)
            // so short abbreviations are expanded before the token-length filter runs.
            let finalLine = toTitleCase(cleaned)
            for (const rule of OCR_ALIAS_REWRITES) {
              if (rule.pattern.test(cleaned)) {
                finalLine = toTitleCase(rule.replacement)
                break
              }
            }

            // Require at least one word of 3+ letters to filter out noise like
            // "Do", "By", "V2" — checked after alias expansion so "OJ" → "Orange Juice" passes.
            const lineTokens = finalLine.toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/).filter(Boolean)
            if (!lineTokens.some((t) => t.length >= 3)) continue

            const key = finalLine.toLowerCase()
            if (visionSeen.has(key)) continue
            visionSeen.add(key)
            visionLines.push(finalLine)
          }

          // Full-text scan for short abbreviations (e.g. "OJ", "Spag Bol") that Vision may
          // include within a larger text block rather than on their own line.
          const rawVisionLower = visionText.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ')
          if (/\boj\b|\bo\.j\.\b/i.test(rawVisionLower) && !visionSeen.has('orange juice')) {
            visionSeen.add('orange juice')
            visionLines.push('Orange Juice')
          }
          // "Spag Bol" scan — covers:
          //   sp[aeo]g + optional space/dot/hyphen + bol  →  "Spag Bol", "Spag-Bol"
          //   sp[aeo]g alone                              →  "Spag" on its own (bol was on next line)
          //   bolognese or bolog                          →  Vision returned the full/partial word
          //   spaghetti alone                             →  Vision returned full word without "bolognese"
          //   spag? bol  (with optional character noise)  →  "Sp@g bol", "Spg bol"
          if (
            /\b[sb]p[aeo]g[\s.\-]*b[oa][cl]|\b[sb]p[aeo]g\b|\bbolognese\b|\bbolog\b|\bspaghetti\b/i
              .test(rawVisionLower) &&
            !visionSeen.has('spaghetti bolognese')
          ) {
            visionSeen.add('spaghetti bolognese')
            visionLines.push('Spaghetti Bolognese')
          }

          console.log('[OCR] Vision parsed lines:', visionLines)

          if (uploadGen !== uploadGenerationRef.current) return

          if (visionLines.length === 0) {
            setListInputError(
              'I could not read a clear list from that image. Try a clearer photo, then type or dictate any missing items.',
            )
            return
          }

          const parsedLines = getShopListLinesFromUserInput(visionLines.join('\n'))
          const extracted = (parsedLines.length > 0 ? parsedLines : visionLines).join('\n')
          setInputValue(extracted)
          setUploadReviewPending(true)
          setForceMultiItemMode(true)
          return
        }

        // ── TESSERACT FALLBACK PATH ───────────────────────────────────────────────
        // Vision API was unavailable or returned no text — fall back to the
        // multi-pass Tesseract consensus + intent + vocab pipeline.
        if (visionResult.error) {
          console.warn('[OCR] Vision API unavailable, falling back to Tesseract:', visionResult.error)
        }

        const preprocessed = await preprocessImageForOcr(file)
        const variantPreprocessed = await preprocessImageVariantsForOcr(file)
        if (uploadGen !== uploadGenerationRef.current) return
        const ocrInputs: Array<File | Blob> = [file, preprocessed, ...variantPreprocessed]
        const passes = await Promise.all(ocrInputs.map((input) => recognize(input, 'eng')))
        if (uploadGen !== uploadGenerationRef.current) return
        const passSummaries = passes.map((pass) => ({
          text: pass.data?.text ?? '',
          confidence: pass.data?.confidence ?? 0,
        }))

        const combinedText = buildConsensusOcrText(passSummaries)

        // Log raw OCR output for each pass to help diagnose misreads.
        console.group('[OCR] Raw pass output')
        passSummaries.forEach((p, i) => {
          console.log(`Pass ${i} (confidence ${p.confidence.toFixed(0)}):`, p.text)
        })
        console.log('[OCR] Combined consensus text:', combinedText)
        console.groupEnd()

        // Step 1: Extract raw lines and apply alias/distortion rewrites.
        const rawLines = parseLinesFromOcrText(combinedText)
        console.log('[OCR] Raw lines before rewrite:', rawLines)

        const seen = new Set<string>()
        const deduped: string[] = []
        const rewrittenLines = rawLines
          .map((line) => {
            const cleaned = line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
            for (const rule of OCR_ALIAS_REWRITES) {
              if (rule.pattern.test(cleaned)) return toTitleCase(rule.replacement)
            }
            return toTitleCase(cleaned.replace(/\s*[x×]\s*\d+\s*$/i, '').trim())
          })
          .filter((line) => {
            if (line.length <= 2) return false
            const tokens = line.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
            return tokens.some((t) => t.length >= 4 && /^[a-z]+$/.test(t))
          })

        for (const line of rewrittenLines) {
          const key = line.toLowerCase().trim()
          if (!key || seen.has(key)) continue
          seen.add(key)
          deduped.push(line)
        }

        // Step 2: Merge intent consensus lines (catches complex multi-word OCR distortions).
        const allPassText = passSummaries.map((p) => p.text).join('\n')

        // Sweep ALL pass lines through alias rewrites — catches items that appear in only
        // one pass and were therefore dropped from the consensus text.
        for (const line of parseLinesFromOcrText(allPassText)) {
          const cleaned = line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
          for (const rule of OCR_ALIAS_REWRITES) {
            if (rule.pattern.test(cleaned)) {
              const key = rule.replacement
              if (!seen.has(key)) { seen.add(key); deduped.push(toTitleCase(rule.replacement)) }
              break
            }
          }
        }

        // Full raw-text scan for short abbreviations that may not survive line splitting.
        const rawAllText = allPassText.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ')
        if (!seen.has('orange juice') && /\boj\b|\bo\.j\.\b/i.test(rawAllText)) {
          seen.add('orange juice')
          deduped.push('Orange Juice')
        }

        const intentLines = buildConsensusIntentLines(passSummaries)
        if (hasOrganicMilkSignalInRawText(allPassText) &&
            !deduped.some((l) => l.toLowerCase().includes('organic milk'))) {
          deduped.unshift('Organic Milk')
          seen.add('organic milk')
        }
        for (const intent of intentLines) {
          const key = intent.toLowerCase()
          if (!seen.has(key)) { seen.add(key); deduped.push(intent) }
        }

        // Step 3: Last resort — only if very few items found, scan all pass text for vocab matches.
        if (deduped.length < 4) {
          const vocabItems = extractVocabFromNoisyText(allPassText)
          for (const item of vocabItems) {
            const key = item.toLowerCase()
            if (!seen.has(key)) { seen.add(key); deduped.push(item) }
          }
        }

        // Post-filter: remove noise lines that slipped past alias/intent matching.
        const allVocabTerms = [...OCR_FALLBACK_VOCAB, ...OCR_INTENT_ITEMS]
        const filteredDeduped = deduped.filter((item) => {
          const key = item.toLowerCase()
          if (OCR_INTENT_ITEMS.includes(key)) return true
          const words = key.split(/\s+/).filter((t) => t.length >= 3)
          for (const intent of OCR_INTENT_ITEMS) {
            if (!deduped.some((d) => d.toLowerCase() === intent)) continue
            const intentWords = intent.split(/\s+/).filter((t) => t.length >= 3)
            const isDuplicate = words.some((w) =>
              intentWords.some(
                (iw) =>
                  w.length >= 4 && iw.length >= 4 &&
                  (bigramSimilarity(w, iw) >= 0.4 || skeletonSimilarity(w, iw) >= 0.4),
              ),
            )
            if (isDuplicate) return false
          }
          return allVocabTerms.some((term) =>
            term.split(' ').some(
              (termWord) =>
                termWord.length >= 4 &&
                words.some(
                  (w) =>
                    w.length >= 4 &&
                    (w === termWord ||
                      bigramSimilarity(w, termWord) >= 0.4 ||
                      skeletonSimilarity(w, termWord) >= 0.4),
                ),
            ),
          )
        })

        console.log('[OCR] Tesseract deduped lines:', deduped)
        console.log('[OCR] After noise post-filter:', filteredDeduped)

        const parsedLines = getShopListLinesFromUserInput(filteredDeduped.join('\n'))
        if (parsedLines.length === 0) {
          if (uploadGen !== uploadGenerationRef.current) return
          setListInputError(
            'I could not read a clear list from that image. Try a clearer photo, then type or dictate any missing items.',
          )
          return
        }
        const extracted = parsedLines.join('\n')
        // Replace textarea with the uploaded image interpretation for user review.
        if (uploadGen !== uploadGenerationRef.current) return
        setInputValue(extracted)
        setUploadReviewPending(true)
        setForceMultiItemMode(true)
      } catch {
        if (uploadGen !== uploadGenerationRef.current) return
        setListInputError(
          'Could not read text from that image. Try another image, or type/dictate your list.',
        )
      } finally {
        if (uploadGen === uploadGenerationRef.current) setImageProcessing(false)
      }
    })()
  }

  function clearUploadedFile() {
    uploadGenerationRef.current += 1
    setUploadedFileName('')
    if (fileInputRef.current) fileInputRef.current.value = ''
    setInputValue('')
    setListInputError('')
    setImageProcessing(false)
    setUploadReviewPending(false)
    setForceMultiItemMode(false)
  }

  function resetUploadedFileSelection() {
    setUploadedFileName('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function suggestionToEssential(suggestion: ProductSuggestion, originalText: string): Essential {
    const enriched = enrichSuggestionFromCatalog(suggestion, autocompleteCatalog, originalText)
    return {
      id: crypto.randomUUID(),
      name: enriched.size ? `${enriched.title} (${enriched.size})` : enriched.title,
      price: enriched.price ?? 0,
      unitPrice: enriched.unitPrice ?? '—',
      qty: 1,
      selected: true,
      image: enriched.image,
      originalText,
      selectedProductId: enriched.id,
      manuallySelected: true,
    }
  }

  function addProductFromSuggestion(suggestion: ProductSuggestion) {
    const originalText = getActiveInputLine(readListTextareaRaw()) || autocompleteQuery
    setEssentials((prev) => mergeEssentials(prev, [suggestionToEssential(suggestion, originalText)]))
    setGenerated(true)
    setInputValue('')
    setAutocompleteOpen(false)
    setAutocompleteHighlight(-1)
    setViewAllQuery(null)
    setForceMultiItemMode(false)
    window.setTimeout(() => listInputRef.current?.focus(), 0)
  }

  function handleListInputChange(nextValue: string) {
    setListInputError('')
    resultsFromChipRef.current = false
    if (!nextValue.trim()) {
      setUploadReviewPending(false)
      setForceMultiItemMode(false)
    }
    setInputValue(nextValue)

    const mode = deriveInputMode({
      text: nextValue,
      imageProcessing,
      catalogLoading,
      uploadReviewPending,
      generated,
      forceMultiItem: forceMultiItemMode,
    })

    if (mode === 'multi-item-entry' || mode === 'processing-upload' || mode === 'building-shop') {
      setAutocompleteOpen(false)
      setAutocompleteHighlight(-1)
      return
    }

    const activeLine = getActiveInputLine(nextValue)
    const canShow = shouldShowAutocomplete({
      text: nextValue,
      imageProcessing,
      catalogLoading,
      forceMultiItem: forceMultiItemMode,
    })
    setAutocompleteOpen(canShow && activeLine.length >= 1)
    setAutocompleteHighlight(-1)
    if (!canShow) setViewAllQuery(null)
  }

  function handleListInputPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = e.clipboardData.getData('text')
    if (!detectPastedMultiItemList(pasted)) return
    setForceMultiItemMode(true)
    setAutocompleteOpen(false)
    setAutocompleteHighlight(-1)
    setUploadReviewPending(false)
  }

  function handleListInputKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!showAutocompletePanel) {
      if (e.key === 'Escape') {
        setAutocompleteOpen(false)
        setAutocompleteHighlight(-1)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setAutocompleteHighlight((i) => {
        const next = i < 0 ? 0 : Math.min(i + 1, autocompleteSuggestions.length - 1)
        return next
      })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setAutocompleteHighlight((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && autocompleteHighlight >= 0) {
      e.preventDefault()
      const pick = autocompleteSuggestions[autocompleteHighlight]
      if (pick) addProductFromSuggestion(pick)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setAutocompleteOpen(false)
      setAutocompleteHighlight(-1)
    }
  }

  function expandAddItemPanel() {
    setAddItemPanelExpanded(true)
    window.setTimeout(() => listInputRef.current?.focus(), 0)
  }

  function scrollToAddMoreInput() {
    const run = () => {
      const input = listInputRef.current
      const section = document.getElementById('create-list-input')
      if (!input || !section) return

      const stickyHeader = document.querySelector('[data-sticky-site-header]')
      const getScrollTop = () => {
        const headerOffset =
          stickyHeader instanceof HTMLElement ? stickyHeader.getBoundingClientRect().height : 0
        return Math.max(0, section.getBoundingClientRect().top + window.scrollY - headerOffset - 16)
      }

      input.focus({ preventScroll: true })
      window.scrollTo({ top: getScrollTop(), behavior: 'smooth' })

      window.setTimeout(() => {
        window.scrollTo({ top: getScrollTop(), behavior: 'auto' })
      }, 400)
    }

    if (!addItemPanelExpanded) {
      setAddItemPanelExpanded(true)
      window.setTimeout(run, 0)
      return
    }

    run()
  }

  function addSuggestionToMeals(tag: string) {
    if (activeInspirationChip) return
    setListInputError('')
    resultsFromChipRef.current = true
    chipSourceLinesRef.current = [tag]
    setActiveInspirationChip(tag)
    setShowMoreEssentials(false)

    const serves = household ?? 'Serves 4'
    const gen = ++listBuildGenerationRef.current
    void (async () => {
      try {
        const payload = await loadCatalogForBuildShop()
        if (gen !== listBuildGenerationRef.current) return
        const built = buildShopFromListLines(
          [tag],
          payload.primary.products,
          payload.fallback?.products ?? [],
          serves,
          dietSelections,
          itemsOnly,
        )

        setCatalogSourceLabel(
          built.fallbackMatches > 0 && payload.fallback
            ? `${payload.primary.source} (fallback used for ${built.fallbackMatches} item${built.fallbackMatches === 1 ? '' : 's'}: ${payload.fallback.source})`
            : payload.primary.source,
        )

        if (!builtShopHasRows(built)) {
          setListInputError(
            'That suggestion did not match anything in the product catalog. Try another chip or type a specific item.',
          )
          resultsFromChipRef.current = false
          chipSourceLinesRef.current = []
          return
        }

        setGenerated(true)
        setMealGroups((prev) => mergeMealGroups(prev, built.meals))
        setEssentials((prev) => mergeEssentials(prev, built.essentials))
      } catch (error) {
        if (gen !== listBuildGenerationRef.current) return
        setGenerated(mealGroups.length > 0 || essentials.length > 0)
        setCatalogSourceLabel('error: POPMAS unavailable')
        setListInputError(getCatalogErrorMessage(error))
        setToast('Build shop requires POPMAS. Configure Supabase to continue.')
      } finally {
        if (gen === listBuildGenerationRef.current) resultsFromChipRef.current = false
        setActiveInspirationChip(null)
        window.setTimeout(() => listInputRef.current?.focus(), 0)
      }
    })()
  }

  // Per-list derived values are computed inline when rendering each list card

  function createNewList() {
    const name = newListNameInput.trim()
    if (!name) return
    const newList: SavedList = {
      id: crypto.randomUUID(),
      name,
      mealGroups: [],
      essentials: [],
      generated: false,
      hasLeftAndReturned: false,
    }
    setSavedLists((prev) => [...prev, newList])
    setNewListNameInput('')
    // Stay on index — user clicks the card to open it
  }

  function openList(list: SavedList) {
    // Auto-save the currently open list before switching
    if (activeListId) {
      setSavedLists((prev) =>
        prev.map((l) =>
          l.id === activeListId ? { ...l, mealGroups, essentials, generated } : l,
        ),
      )
    }
    const returning = Boolean(list.hasLeftAndReturned)
    setActiveListId(list.id)
    setListName(list.name)
    setMealGroups(list.mealGroups)
    setEssentials(list.essentials)
    setGenerated(list.generated)
    setIsReturningToList(returning)
    setAddItemPanelExpanded(!returning)
    setShowMoreEssentials(false)
    setInputValue('')
    setListInputError('')
    setAppView('build')
  }

  function confirmListItemRemoval() {
    if (!removeConfirmTarget) return
    if (removeConfirmTarget.kind === 'meal') {
      setMealGroups((prev) =>
        prev.map((m) => (m.id === removeConfirmTarget.mealId ? { ...m, removed: true } : m)),
      )
    } else {
      setRemovedEssentialName(removeConfirmTarget.name)
      setEssentials((prev) => prev.filter((e) => e.id !== removeConfirmTarget.id))
    }
    setRemoveConfirmTarget(null)
  }

  function goToIndex() {
    // Auto-save current build state before leaving
    if (activeListId) {
      setSavedLists((prev) =>
        prev.map((l) =>
          l.id === activeListId
            ? { ...l, mealGroups, essentials, generated, hasLeftAndReturned: true }
            : l,
        ),
      )
    }
    setAppView('index')
    setActiveNavTab('Shopping lists')
  }

  function deleteList(id: string) {
    setSavedLists((prev) => prev.filter((l) => l.id !== id))
    if (activeListId === id) {
      setActiveListId(null)
      setListName('')
      setMealGroups([])
      setEssentials([])
      setGenerated(false)
    }
  }

  function startEditingListName(list: SavedList) {
    setEditingListId(list.id)
    setEditingListNameInput(list.name)
  }

  function cancelEditingListName() {
    setEditingListId(null)
    setEditingListNameInput('')
  }

  function commitListNameEdit(listId: string) {
    const nextName = editingListNameInput.trim()
    if (!nextName) {
      cancelEditingListName()
      return
    }
    setSavedLists((prev) => prev.map((l) => (l.id === listId ? { ...l, name: nextName } : l)))
    if (activeListId === listId) setListName(nextName)
    cancelEditingListName()
  }

  function resetPrototype() {
    // Clear the dismissal flag so the auto-save info banner reappears, then
    // hard-reload to wipe all in-memory state for a fresh-start experience.
    try {
      localStorage.removeItem('wtr-autosave-banner-dismissed')
    } catch {
      // Ignore storage failures (e.g. private mode); the reload alone still resets state.
    }
    if (typeof window !== 'undefined') window.location.reload()
  }

  function changeTrolleyLineQty(id: string, delta: number) {
    setTrolleyLines((prev) =>
      prev
        .map((l) => (l.id === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l))
        .filter((l) => l.qty > 0),
    )
  }

  function removeTrolleyLine(id: string) {
    setTrolleyLines((prev) => prev.filter((l) => l.id !== id))
  }

  function emptyTrolley() {
    setTrolleyLines([])
  }

  function toggleTrolleySubstitute(id: string) {
    setTrolleyLines((prev) =>
      prev.map((l) => (l.id === id ? { ...l, allowSubstitute: !l.allowSubstitute } : l)),
    )
  }

  function setAllTrolleySubstitute(value: boolean) {
    setTrolleyLines((prev) => prev.map((l) => ({ ...l, allowSubstitute: value })))
  }

  const bottomSnackbarBottomPx =
    appView === 'build' && buildFooterHeight > 0 ? buildFooterHeight + 20 : 32

  const bottomSnackbarBarClass =
    'fixed left-1/2 z-40 -translate-x-1/2 bg-[#1f1f1f] px-5 py-3 text-white shadow-[0px_2px_8px_rgba(0,0,0,0.35)]'
  const suppressStickyHeader = showPreferences || Boolean(swapTarget) || Boolean(removeConfirmTarget)

  const inputMode: InputMode = deriveInputMode({
    text: inputValue,
    imageProcessing,
    catalogLoading,
    uploadReviewPending,
    generated,
    forceMultiItem: forceMultiItemMode,
  })

  const autocompleteQuery = getActiveInputLine(inputValue)
  const autocompleteSuggestions = searchProductSuggestions(
    viewAllQuery ?? autocompleteQuery,
    autocompleteCatalog,
    viewAllQuery ? 12 : 6,
  )
  const showAutocompletePanel =
    autocompleteOpen &&
    inputMode === 'single-item-search' &&
    shouldShowAutocomplete({
      text: inputValue,
      imageProcessing,
      catalogLoading,
      forceMultiItem: forceMultiItemMode,
    }) &&
    autocompleteSuggestions.length > 0

  const addPanelTitle = generated || isReturningToList ? 'ADD TO YOUR LIST' : 'CREATE YOUR LIST'
  const autocompleteListId = 'product-suggestion-listbox'

  useLayoutEffect(() => {
    if (appView !== 'build') return
    const el = listInputRef.current
    if (!el) return
    el.style.height = '0px'
    const maxHeight = 144
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 72), maxHeight)}px`
  }, [appView, inputValue, helperCopy, showAutocompletePanel, inputMode])

  const allEssentialsVisible = !hasVisibleEssentials || hiddenEssentialsCount === 0 || showMoreEssentials

  const addMoreCta = (
    <div className="mt-2 flex items-center justify-between py-3">
      <p className="text-[16px] font-medium leading-6 text-[#333]">Need anything else?</p>
      <button
        type="button"
        className="flex h-10 shrink-0 items-center justify-center border border-[#333] bg-white px-5 py-2 text-[16px] font-medium leading-6 text-[#333]"
        onClick={scrollToAddMoreInput}
      >
        Add
      </button>
    </div>
  )

  return (
    <main
      className="app-shell min-h-screen bg-[#fafafa] font-normal text-[#333] [font-family:'Gill_Sans_Nova_for_JL',_'Gill_Sans',_'Gill_Sans_MT',sans-serif]"
      style={{
        paddingBottom:
          appView === 'build' && hasBuildProducts
            ? `${Math.max(buildFooterHeight + 20, 32)}px`
            : '32px',
      }}
    >
      <div
        data-sticky-site-header
        className={suppressStickyHeader ? 'relative z-50 bg-white' : 'sticky top-0 z-50 bg-white'}
      >
        <div className="mx-auto hidden max-w-[1260px] lg:block">
          <div className="flex h-10 items-center justify-between px-8 text-[14px] text-[#333]">
            <div className="flex items-center gap-4">
              <span className="font-light">More from Waitrose:</span>
              <span>Cellar</span>
              <span>Florist</span>
              <span>Garden</span>
            </div>
            <div className="flex items-center gap-8">
              <span>Our shops</span>
              <span>Customer service</span>
            </div>
          </div>

          <div className="flex min-h-20 items-center gap-8 px-8">
            <button
              type="button"
              onClick={resetPrototype}
              aria-label="Waitrose & Partners — reset prototype"
              className="shrink-0 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#154734]"
            >
              <WaitroseLogo className="h-[60px] w-auto" />
            </button>
            <div className="ml-auto flex flex-1 items-center justify-end gap-4">
              <div className="flex h-10 w-full max-w-[475px] items-center border border-[#333] bg-white">
                <input className="h-full flex-1 px-3 text-[16px] outline-none" placeholder="Search..." />
                <button className="pr-3 text-[14px] underline">Multi-search</button>
                <button className="h-10 w-10 bg-[#eee]" aria-label="Search">⌕</button>
              </div>
              <button className="h-10 bg-[#53565A] px-5 text-white">📅&nbsp; Sun 24 Aug, 11am</button>
              <button
                type="button"
                className="flex h-10 min-w-[9rem] items-center justify-center gap-2.5 border border-[#333] bg-white px-3 text-[#333]"
                aria-label={`Trolley, ${trolleyUnitCount} items, ${formatCurrency(trolleyMoneyTotal)}`}
                onClick={() => setAppView('trolley')}
              >
                <TrolleyIconWithBadge count={trolleyUnitCount} />
                <span className="text-[16px] font-medium tabular-nums">{formatCurrency(trolleyMoneyTotal)}</span>
              </button>
            </div>
          </div>

          <div className="flex h-12 items-center justify-between border-b border-[#ddd] px-7 text-[16px]">
            <div className="flex items-center gap-5">
              <button className="px-1 py-2">Groceries ▾</button>
              <button className="px-1 py-2">Valentine&apos;s Day ▾</button>
              <button className="px-1 py-2 text-[#A6192E]">Offers</button>
              <button className="px-1 py-2">Entertaining</button>
              <button className="px-1 py-2">New</button>
              <button className="px-1 py-2">Recipes</button>
            </div>
            <div className="flex items-center gap-5">
              <button
                type="button"
                className="px-1 py-2"
                onClick={() => {
                  setActiveNavTab('Favourites')
                  setAppView('favourites')
                }}
              >
                ♡ Favourites
              </button>
              <button className="px-1 py-2">👤 My account ▾</button>
            </div>
          </div>
          </div>

          <div className="border-b border-[#ddd] lg:hidden">
            <div className="flex h-[50px] items-center justify-between px-4">
            <button
              type="button"
              onClick={resetPrototype}
              aria-label="Waitrose & Partners — reset prototype"
              className="shrink-0 leading-none focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#154734]"
            >
              <WaitroseLogo className="h-[36px] w-auto" />
            </button>
              <div className="flex items-center gap-4 text-[12px] font-normal leading-5 text-[#333]">
              <button className="flex min-w-[28px] flex-col items-center">
                <span className="block h-4 leading-none"><IconSearch /></span>
                <span>Search</span>
              </button>
              <button className="flex min-w-[28px] flex-col items-center">
                <span className="block h-4 leading-none"><IconCalendar /></span>
                <span>{generated ? '30 Wed' : 'Book a slot'}</span>
              </button>
              <button
                type="button"
                className="flex min-w-[28px] flex-col items-center"
                aria-label={`Trolley, ${trolleyUnitCount} items, ${formatCurrency(trolleyMoneyTotal)}`}
                onClick={() => setAppView('trolley')}
              >
                <span className="flex min-h-[22px] items-center justify-center leading-none">
                  <TrolleyIconWithBadge count={trolleyUnitCount} />
                </span>
                <span>{formatCurrency(trolleyMoneyTotal)}</span>
              </button>
              <button className="flex min-w-[28px] flex-col items-center">
                <span className="block h-4 leading-none"><IconMenu /></span>
                <span>Menu</span>
              </button>
              </div>
            </div>
          </div>
      </div>
      <header className="border-b border-[#ddd] bg-white">
        <div className="bg-[#C4D600] py-2 text-center text-[16px] font-normal text-[#154734]">New lower prices on even more everyday items | <u>Shop now</u></div>
        {appView !== 'build' ? (
          <div className="border-b border-[#ddd] relative lg:flex lg:justify-center">
            {/* Left chevron — shown when scrolled right */}
            {navChevrons.left && (
              <button
                aria-label="Scroll tabs left"
                onClick={() => {
                  const c = navCarouselRef.current
                  if (c) c.scrollBy({ left: -160, behavior: 'smooth' })
                }}
                className="lg:hidden absolute left-0 top-0 z-10 flex h-full items-center pl-[4px] pr-[44px]"
                style={{ background: 'linear-gradient(to right, #fff 30%, rgba(255,255,255,0))' }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M7.5 2.5 3.5 6l4 3.5" stroke="#333" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}

            {/* Scrollable tab row */}
            <div
              ref={navCarouselRef}
              onScroll={() => {
                const c = navCarouselRef.current
                if (!c) return
                setNavChevrons({
                  left: c.scrollLeft > 4,
                  right: c.scrollLeft < c.scrollWidth - c.clientWidth - 4,
                })
              }}
              className="flex overflow-x-auto scroll-smooth lg:justify-center [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
            >
              {(['Favourites', 'Previous orders', 'Quick Shop', 'Bought in-store', 'Shopping lists'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveNavTab(tab)
                    if (tab === 'Shopping lists') {
                      goToIndex()
                    } else if (tab === 'Favourites') {
                      setAppView('favourites')
                    }
                    const container = navCarouselRef.current
                    const btn = container?.querySelector(`[data-nav-tab="${tab}"]`) as HTMLElement | null
                    if (container && btn) {
                      container.scrollTo({ left: btn.offsetLeft - 16, behavior: 'smooth' })
                    }
                  }}
                  data-nav-tab={tab}
                  className={`flex-shrink-0 flex h-[52px] items-center justify-center px-4 text-[16px] whitespace-nowrap transition-colors ${
                    activeNavTab === tab
                      ? 'border-b-2 border-[#333] text-[#333]'
                      : 'border-b-2 border-transparent text-[#555] hover:border-[#bbb]'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Right chevron — shown when more tabs are off-screen to the right */}
            {navChevrons.right && (
              <button
                aria-label="Scroll tabs right"
                onClick={() => {
                  const c = navCarouselRef.current
                  if (c) c.scrollBy({ left: 160, behavior: 'smooth' })
                }}
                className="lg:hidden absolute right-0 top-0 z-10 flex h-full items-center pl-[44px] pr-[4px]"
                style={{ background: 'linear-gradient(to left, #fff 30%, rgba(255,255,255,0))' }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M4.5 2.5 8.5 6l-4 3.5" stroke="#333" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[1260px] gap-2 border-t border-[#ddd] px-4 py-3 text-[14px]">
            <button className="underline" onClick={goToIndex}>Home</button>
            <span>&gt;</span>
            <button className="underline" onClick={goToIndex}>Shopping lists</button>
            <span>&gt;</span>
          </div>
        )}
      </header>

      <section className="mx-auto mt-4 w-full max-w-[1260px] px-4 lg:mt-6 lg:px-8">

        {/* ── INDEX VIEW ── */}
        {appView === 'index' && (
          <>
            <div
              className="mb-6 text-center uppercase text-[20px] tracking-[4px] text-[#333] sm:text-[28px] sm:tracking-[7px]"
              style={{ fontFamily: '"Gill Sans Nova for JL","Gill Sans","Gill Sans MT",Calibri,"Trebuchet MS",sans-serif', fontWeight: 500, fontStyle: 'normal' }}
            >
              Shopping Lists
            </div>
            <div className="mx-auto flex w-full max-w-[768px] flex-wrap gap-6 items-start">
              {/* Create a list tile (Figma List card) */}
              <div className="flex w-full max-w-[382.333px] shrink-0 items-start border border-[#ddd] bg-white p-6">
                <form
                  className="flex w-full flex-wrap items-start content-start gap-5"
                  onSubmit={(e) => { e.preventDefault(); createNewList() }}
                >
                  <label className="w-full text-[16px] font-medium text-[#333]" htmlFor="new-list-name">
                    Enter list name
                  </label>
                  <div className="flex w-full flex-col gap-1">
                    <input
                      id="new-list-name"
                      type="text"
                      maxLength={20}
                      value={newListNameInput}
                      onChange={(e) => setNewListNameInput(e.target.value)}
                      className="w-full border-b border-[#a9a9a9] bg-transparent pb-3 text-[16px] outline-none placeholder:text-[#a9a9a9] focus:border-[#154734]"
                      placeholder="eg weekly shop or Birthday lunch"
                      autoComplete="off"
                    />
                    <span className="text-right text-[12px] text-[#333]">{newListNameInput.length}/20</span>
                  </div>
                  <button
                    type="submit"
                    disabled={!newListNameInput.trim()}
                    className="w-full bg-[#53565A] px-5 py-2 text-[16px] text-white disabled:bg-[#eeeeee] disabled:text-[#a9a9a9]"
                  >
                    Create list
                  </button>
                </form>
              </div>

              {/* One card per saved list */}
              {savedLists.map((list) => {
                const activeMeals = list.mealGroups.filter((m) => !m.removed)
                const previewImages = [
                  ...activeMeals.flatMap((m) => m.ingredients).map((i) => i.image),
                  ...list.essentials.map((e) => e.image),
                ].filter(Boolean).slice(0, 4)
                const isEditingThisList = editingListId === list.id
                const mealCount = activeMeals.length
                const itemCount =
                  activeMeals.reduce((s, m) => s + m.ingredients.length, 0) +
                  list.essentials.length
                const metaLine =
                  mealCount > 0
                    ? `${mealCount} meal${mealCount === 1 ? '' : 's'}, ${itemCount} item${itemCount === 1 ? '' : 's'}`
                    : `${itemCount} item${itemCount === 1 ? '' : 's'}`
                return (
                  <div key={list.id} className="w-full bg-white shadow-[0px_2px_1px_rgba(0,0,0,0.02)] sm:w-[343px]">
                    <div className="flex items-center justify-between border-b border-[#ddd] p-4">
                      <div className="flex min-w-0 flex-1 items-center gap-3 text-[16px]">
                        {isEditingThisList ? (
                          <input
                            value={editingListNameInput}
                            onChange={(e) => setEditingListNameInput(e.target.value)}
                            onBlur={() => commitListNameEdit(list.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitListNameEdit(list.id)
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelEditingListName()
                              }
                            }}
                            className="min-w-0 flex-1 border-b border-[#333] bg-transparent font-medium text-[#333] outline-none"
                            aria-label={`Edit ${list.name}`}
                            autoFocus
                          />
                        ) : (
                          <>
                            <span className="truncate font-medium">{list.name}</span>
                            <button
                              type="button"
                              aria-label={`Edit ${list.name}`}
                              className="shrink-0 text-[#757575]"
                              onClick={() => startEditingListName(list)}
                            >
                              <IconPen />
                            </button>
                          </>
                        )}
                        <span className="shrink-0 font-light text-[#53565A]">{metaLine}</span>
                      </div>
                      <button
                        aria-label={`Delete ${list.name}`}
                        className="ml-2 shrink-0 text-[#757575]"
                        onClick={() => deleteList(list.id)}
                      >
                        <IconBin />
                      </button>
                    </div>
                    {previewImages.length > 0 ? (
                      <div className="flex items-center px-4 py-4">
                        {previewImages.map((src, i) => (
                          <button
                            key={i}
                            className="size-[70px] shrink-0 overflow-hidden bg-[#fafafa]"
                            onClick={() => openList(list)}
                            aria-label={`Open ${list.name}`}
                          >
                            {/^https?:\/\//i.test(src) ? (
                              <img src={src} alt="" className="size-full object-cover" loading="lazy" />
                            ) : (
                              <span className="flex size-full items-center justify-center text-[22px]">{src}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="px-4 py-4">
                        <button
                          className="text-[16px] font-medium underline"
                          onClick={() => openList(list)}
                        >
                          Start building your list
                        </button>
                      </div>
                    )}
                    {previewImages.length > 0 && (
                      <div className="flex justify-end px-4 pb-4">
                        <button
                          className="text-[16px] font-medium underline"
                          onClick={() => openList(list)}
                        >
                          View
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── BUILD VIEW ── */}
        {appView === 'build' && (
          <>
            {/* Back arrow + list name heading */}
            <div className="relative mb-6 flex items-center min-h-[40px]">
              <button
                aria-label="Back to shopping lists"
                className="absolute left-0 flex items-center p-1 text-[#333]"
                onClick={goToIndex}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M12 4L6 10l6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <div
                className="w-full text-center uppercase text-[20px] tracking-[4px] text-[#333] sm:text-[28px] sm:tracking-[7px]"
                style={{ fontFamily: '"Gill Sans Nova for JL","Gill Sans","Gill Sans MT",Calibri,"Trebuchet MS",sans-serif', fontWeight: 500, fontStyle: 'normal' }}
              >
                {listName || 'LIST NAME'}
              </div>
            </div>

            {/* Auto-save info banner — shown once per user until dismissed */}
            {addItemPanelExpanded && showAutoSaveBanner && (
              <div className="mx-auto mb-4 w-full max-w-[768px] flex items-stretch bg-[#e5f1fc]">
                {/* Blue left accent bar */}
                <div className="w-[4px] shrink-0 bg-[#0074e8]" />
                {/* Content */}
                <div className="flex flex-1 items-center gap-4 px-4 py-[10px]">
                  {/* Info icon */}
                  <span className="shrink-0" aria-hidden="true">
                    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                      <circle cx="16" cy="16" r="14" stroke="#0074e8" strokeWidth="2" />
                      <path d="M16 14v8" stroke="#0074e8" strokeWidth="2" strokeLinecap="round" />
                      <circle cx="16" cy="10.5" r="1.25" fill="#0074e8" />
                    </svg>
                  </span>
                  {/* Message */}
                  <p className="flex-1 text-[16px] leading-6 text-[#333]">Your list will be saved when you select 'Build shop'</p>
                  {/* Dismiss */}
                  <button
                    type="button"
                    aria-label="Dismiss"
                    className="shrink-0 flex items-center justify-center p-1 text-[#333]"
                    onClick={() => {
                      localStorage.setItem('wtr-autosave-banner-dismissed', '1')
                      setShowAutoSaveBanner(false)
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {!addItemPanelExpanded ? (
              <div className="mx-auto mb-6 flex w-full max-w-[768px] items-center justify-center gap-4">
                <p className="text-[16px] font-medium leading-6 text-[#333]">Need anything else?</p>
                <button
                  type="button"
                  className="flex h-10 shrink-0 items-center justify-center border border-[#333] bg-white px-5 py-2 text-[16px] font-medium leading-6 text-[#333]"
                  onClick={expandAddItemPanel}
                >
                  Add
                </button>
              </div>
            ) : (
              <>
        <div id="create-list-input" className="mx-auto w-full max-w-[768px] border border-[#ddd] bg-white p-3 sm:p-4">
          <form
            className="block"
            onSubmit={(e) => {
              e.preventDefault()
              resetUploadedFileSelection()
              void handleBuildShop()
            }}
          >
            <div className="mb-2 text-[14px] font-medium tracking-[2.8px] text-[#53565A]">{addPanelTitle}</div>
            <label htmlFor="list-input" className="sr-only">
              List input
            </label>
            <div className="relative">
              <textarea
                ref={listInputRef}
                id="list-input"
                name="shop-list"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showAutocompletePanel}
                aria-controls={showAutocompletePanel ? autocompleteListId : undefined}
                aria-activedescendant={
                  showAutocompletePanel && autocompleteHighlight >= 0
                    ? `${autocompleteListId}-option-${autocompleteHighlight}`
                    : undefined
                }
                autoComplete="off"
                rows={2}
                className={`web-paragraph-heading min-h-[72px] max-h-[144px] w-full overflow-y-auto border bg-[#fafafa] p-3 text-[#333] placeholder:text-[#53565A] focus:outline focus:outline-2 focus:outline-[#154734] ${showAutocompletePanel ? 'resize-none border-b-0' : 'resize-y'} ${listInputError ? 'border-[#a6192e]' : 'border-[#a9a9a9]'}`}
                value={inputValue}
                placeholder={helperCopy}
                onChange={(e) => handleListInputChange(e.target.value)}
                onPaste={handleListInputPaste}
                onKeyDown={handleListInputKeyDown}
                onFocus={() => {
                  setListInputError('')
                  if (isLikelyUiPlaceholderList(inputValue)) {
                    setInputValue('')
                  }
                  const activeLine = getActiveInputLine(inputValue)
                  if (
                    shouldShowAutocomplete({
                      text: inputValue,
                      imageProcessing,
                      catalogLoading,
                      forceMultiItem: forceMultiItemMode,
                    }) &&
                    activeLine.length >= 1
                  ) {
                    setAutocompleteOpen(true)
                  }
                }}
                aria-invalid={listInputError ? true : undefined}
                aria-describedby={
                  listInputError ? 'list-input-error' : undefined
                }
                aria-label="Build a shop list input"
              />
              <ProductAutocomplete
                query={autocompleteQuery}
                suggestions={autocompleteSuggestions}
                highlightedIndex={autocompleteHighlight}
                open={showAutocompletePanel}
                onHighlight={setAutocompleteHighlight}
                onSelect={addProductFromSuggestion}
                onViewAll={(q) => {
                  setViewAllQuery(q)
                  setAutocompleteHighlight(0)
                }}
                listId={autocompleteListId}
              />
            </div>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="grid w-full min-w-0 grid-cols-1 items-center gap-2 min-[360px]:grid-cols-[minmax(0,1fr)_max-content] sm:w-auto sm:grid-cols-[180px_max-content]">
                <div className="flex h-[28px] min-w-0 items-stretch overflow-hidden border border-solid border-[#333] bg-white text-[16px] leading-6 text-[#333]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center justify-start gap-2 overflow-hidden py-0.5 pl-2 text-left focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#154734]"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={visibleUploadedFileName ? `Replace uploaded file ${visibleUploadedFileName}` : 'Upload a list'}
                  >
                    <span className="shrink-0">
                      <IconUploadImage />
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate whitespace-nowrap"
                      title={visibleUploadedFileName || undefined}
                    >
                      {visibleUploadedFileName || 'Upload a list'}
                    </span>
                  </button>
                  {visibleUploadedFileName ? (
                    <button
                      type="button"
                      aria-label={`Remove uploaded file ${visibleUploadedFileName}`}
                      className="inline-flex w-7 shrink-0 items-center justify-center text-[14px] leading-none focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#154734]"
                      onClick={clearUploadedFile}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleUploadFile(e.target.files?.[0])} />
                <button
                  type="button"
                  className="flex h-[28px] shrink-0 items-center gap-2 border border-solid border-[#333] bg-white py-0.5 pl-2 pr-[7px] text-[16px] leading-6 text-[#333] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#154734]"
                  aria-label={`Build Preferences, ${activeBuildPreferencesCount} selected`}
                  onClick={openBuildPreferences}
                >
                  <span className="shrink-0">
                    <IconPreferences />
                  </span>
                  <span className="whitespace-nowrap">
                    Build Preferences ({activeBuildPreferencesCount})
                  </span>
                </button>
              </div>
              <button
                type="submit"
                className="w-full shrink-0 px-6 py-2.5 text-[16px] sm:w-auto sm:py-2 enabled:bg-[#53565A] enabled:text-white disabled:bg-[#eeeeee] disabled:text-[#a9a9a9]"
                disabled={
                  catalogLoading ||
                  imageProcessing ||
                  (getShopListLinesFromUserInput(inputValue).length === 0 && !uploadedFileName)
                }
              >
                {catalogLoading
                  ? 'Building your draft shop…'
                  : imageProcessing
                    ? 'Analysing your list…'
                    : '✦ Build shop'}
              </button>
            </div>
          </form>
          {listInputError ? (
            <p id="list-input-error" className="mt-3 text-[14px] leading-5 text-[#a6192e]" role="alert">
              {listInputError}
            </p>
          ) : null}
        </div>

        <div
          className="mx-auto mt-4 flex w-full max-w-[768px] items-start justify-center gap-2 self-stretch px-1 sm:items-center sm:mt-3"
          role="note"
          aria-label="Disclaimer"
        >
          <span className="inline-flex shrink-0 pt-[3px] text-[#53565A] sm:pt-0" aria-hidden="true">
            <IconDisclaimerInfo />
          </span>
          <p className="max-w-[min(100%,544px)] text-left text-[14px] font-medium leading-5 text-[#333] sm:max-w-none sm:text-center">
            Always check labels for allergens and verify quantities before adding to trolley.
          </p>
        </div>

        <div className="mx-auto mt-12 w-full max-w-[768px]">
          <div className="mb-1 flex flex-wrap items-center gap-x-4">
            <div className="text-[14px] font-medium uppercase tracking-[2.8px] text-[#53565A]">Need inspiration?</div>
            <CuisinePicker
              value={cuisineSelection}
              onChange={setCuisineSelection}
              open={cuisinePickerOpen}
              onOpenChange={setCuisinePickerOpen}
            />
          </div>
          <div className="flex flex-wrap gap-2 sm:gap-2">
            {inspirationSlots.map((chip) => (
              <button
                key={chip}
                type="button"
                className="inline-flex items-center gap-2 rounded-full bg-[#53565A] px-3 py-1 text-[14px] text-white disabled:opacity-70"
                onClick={() => addSuggestionToMeals(chip)}
                disabled={Boolean(activeInspirationChip)}
              >
                {activeInspirationChip === chip ? <ChipSpinner /> : null}
                <span>{chip}</span>
              </button>
            ))}
          </div>
        </div>
              </>
            )}

        {generated && (hasVisibleMeals || hasVisibleEssentials) && (
          <div className="mx-auto mt-10 w-full max-w-[1195px] px-0">
            {hasVisibleMeals && (
              <>
                <h2 className="mb-2 text-[14px] font-medium uppercase tracking-[2.8px] text-[#53565A]">Meals</h2>
                <div className="flex flex-col gap-2">
                  {mealGroups.filter((meal) => !meal.removed).map((meal) => {
                const mealItems = meal.ingredients.length
                const mealPrice = meal.ingredients.reduce((sum, i) => (i.selected ? sum + i.price * i.qty : sum), 0)
                const methodUrl = methodUrlForMeal(meal)
                const metaLead = `${mealItems} items`
                return (
                  <article key={meal.id} className="border border-[#ddd] bg-white">
                    <div className="flex items-start gap-3 px-4 py-3 md:px-5 md:py-3.5">
                      <button
                        type="button"
                        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[#53565A]"
                        aria-label={`${meal.expanded ? 'Collapse' : 'Expand'} ${meal.title}`}
                        aria-expanded={meal.expanded}
                        onClick={() => setMealGroups((prev) => prev.map((m) => (m.id === meal.id ? { ...m, expanded: !m.expanded } : m)))}
                      >
                        <IconChevronMeal expanded={meal.expanded} />
                      </button>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <p className="text-[16px] font-medium leading-snug text-[#333]">{meal.title}</p>
                        <div className="mt-1.5 flex flex-wrap items-center text-[16px] font-light leading-6 text-[#53565A]">
                          {metaLead ? <span>{metaLead}</span> : null}
                          {metaLead ? (
                            <span className="mx-1.5" aria-hidden="true">
                              •
                            </span>
                          ) : null}
                          <span>{formatCurrency(mealPrice)}</span>
                          {methodUrl ? (
                            <a
                              href={methodUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ml-3 shrink-0 font-medium text-[#53565A] underline decoration-solid underline-offset-[3px]"
                            >
                              view method
                            </a>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="mt-0.5 inline-flex shrink-0 items-center gap-2 p-0.5 text-[#757575]"
                        aria-label={`Remove ${meal.title}`}
                        onClick={() =>
                          setRemoveConfirmTarget({ kind: 'meal', mealId: meal.id, name: meal.title })
                        }
                      >
                        <span className="hidden text-[14px] leading-5 text-[#53565A] lg:inline">Remove meal</span>
                        <IconBin />
                      </button>
                    </div>
                    {meal.expanded && (
                      <div className="flex flex-col border-t border-[#ddd]">
                        {meal.ingredients.length > 0 && (() => {
                          const allSelected = meal.ingredients.every((i) => i.selected)
                          const anySelected = meal.ingredients.some((i) => i.selected)
                          return (
                            <div className="flex items-center self-stretch bg-white px-4 py-3 md:px-4">
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={anySelected}
                                aria-label={`Select all ingredients in ${meal.title}`}
                                onClick={() => {
                                  const next = !allSelected
                                  setMealGroups((prev) =>
                                    prev.map((m) =>
                                      m.id !== meal.id
                                        ? m
                                        : {
                                            ...m,
                                            ingredients: m.ingredients.map((i) => ({ ...i, selected: next })),
                                          },
                                    ),
                                  )
                                }}
                                className="flex w-full items-center gap-4 rounded-sm text-left focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#154734]"
                              >
                                <span
                                  className={`flex size-5 shrink-0 items-center justify-center border border-[#333] p-0.5 ${anySelected ? 'bg-[#333]' : 'bg-white'}`}
                                  aria-hidden="true"
                                >
                                  {anySelected ? (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                      <path
                                        d="M3.5 8.2 6.4 11 12.5 4.9"
                                        stroke="white"
                                        strokeWidth="1.6"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  ) : null}
                                </span>
                                <span className="min-w-0 flex-1 text-[16px] font-medium leading-6 text-[#333]">
                                  Select all ingredients
                                </span>
                              </button>
                            </div>
                          )
                        })()}
                        <div className="flex flex-col divide-y divide-[#ddd] border-t border-[#ddd]">
                          {meal.ingredients.map((item) => (
                            <RecipeProductPod
                              key={item.id}
                              grouped
                              needText={item.needText}
                              name={item.name}
                              image={item.image}
                              price={item.matched === false ? '—' : formatCurrency(item.price)}
                              unitPrice={item.unitPrice}
                              qty={item.qty}
                              selected={item.selected}
                              onToggleSelected={() =>
                                setMealGroups((prev) =>
                                  prev.map((m) =>
                                    m.id !== meal.id
                                      ? m
                                      : {
                                          ...m,
                                          ingredients: m.ingredients.map((i) =>
                                            i.id === item.id ? { ...i, selected: !i.selected } : i,
                                          ),
                                        },
                                  ),
                                )
                              }
                              onSwap={() =>
                                setSwapTarget({
                                  kind: 'meal',
                                  mealId: meal.id,
                                  ingredientId: item.id,
                                  item: {
                                    name: item.name,
                                    image: item.image,
                                    price: item.price,
                                    unitPrice: item.unitPrice,
                                    productType: item.productType,
                                    ingredientIntent: item.ingredientIntent,
                                    intentQuery: item.originalText || item.name,
                                  },
                                })
                              }
                              onQtyDelta={(d) => changeMealQty(meal.id, item.id, d)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                )
                  })}
                </div>
                {!hasVisibleEssentials && allEssentialsVisible ? addMoreCta : null}
              </>
            )}

            {hasVisibleEssentials && (
              <section className={hasVisibleMeals ? 'mt-10' : ''}>
                <h2 className="text-[14px] font-medium uppercase tracking-[2.8px] text-[#53565A]">Your items</h2>
                <p className="mb-3 mt-2 text-[16px] font-light leading-6 text-[#53565A]">{essentialsMetaLine}</p>
                <div className="border border-[#ddd] bg-white">
                  {visibleEssentials.map((item, idx) => (
                    <div key={item.id} className={idx > 0 ? 'border-[#ddd] border-t max-[544px]:border-t-0' : ''}>
                      <EssentialProductPod
                        name={item.name}
                        image={item.image}
                        price={formatCurrency(item.price)}
                        unitPrice={item.unitPrice}
                        qty={item.qty}
                        selected={item.selected}
                        onToggleSelected={() =>
                          setEssentials((prev) =>
                            prev.map((e) => (e.id === item.id ? { ...e, selected: !e.selected } : e)),
                          )
                        }
                        onSwap={() =>
                          setSwapTarget({
                            kind: 'essential',
                            id: item.id,
                            item: {
                              name: item.name,
                              image: item.image,
                              price: item.price,
                              unitPrice: item.unitPrice,
                              productType: item.productType,
                              intentQuery: item.originalText || item.name,
                            },
                          })
                        }
                        onQtyDelta={(d) => changeEssentialQty(item.id, d)}
                        onRemove={() =>
                          setRemoveConfirmTarget({ kind: 'essential', id: item.id, name: item.name })
                        }
                      />
                    </div>
                  ))}
                </div>
                {!showMoreEssentials && hiddenEssentialsCount > 0 ? (
                  <div className="mt-4 text-center">
                    <button
                      type="button"
                      className="border border-[#333] bg-white px-8 py-2 text-[16px] text-[#333]"
                      onClick={() => setShowMoreEssentials(true)}
                    >
                      View {hiddenEssentialsCount} more {hiddenEssentialsCount === 1 ? 'item' : 'items'}
                    </button>
                  </div>
                ) : (
                  addMoreCta
                )}
              </section>
            )}
          </div>
        )}
          </>
        )}

        {appView === 'trolley' && (
          <MyTrolleyView
            lines={trolleyLines}
            formatCurrency={formatCurrency}
            onQuantityDelta={changeTrolleyLineQty}
            onRemoveLine={removeTrolleyLine}
            onEmptyTrolley={emptyTrolley}
            onToggleSubstitute={toggleTrolleySubstitute}
            onSetAllSubstitute={setAllTrolleySubstitute}
            onNavigateFavourites={() => {
              setActiveNavTab('Favourites')
              setAppView('favourites')
            }}
            onNavigateShoppingLists={goToIndex}
          />
        )}

        {appView === 'favourites' && (
          <div className="mx-auto max-w-[768px] px-4 py-12 text-center">
            <h1
              className="mb-4 uppercase tracking-[4px] text-[#333] sm:text-[28px] sm:tracking-[7px]"
              style={{ fontFamily: '"Gill Sans Nova for JL","Gill Sans","Gill Sans MT",Calibri,"Trebuchet MS",sans-serif', fontWeight: 500, fontSize: 'clamp(20px,4vw,28px)' }}
            >
              Favourites
            </h1>
            <p className="text-[16px] leading-6 text-[#53565A]">
              Your saved favourites will appear here. Use the navigation tabs above and choose{' '}
              <button type="button" className="font-medium underline" onClick={goToIndex}>
                Shopping lists
              </button>{' '}
              to return to your lists.
            </p>
          </div>
        )}
      </section>

      {appView === 'build' && hasBuildProducts && (
      <footer
        ref={buildFooterRef}
        className={`fixed bottom-0 left-0 right-0 z-30 border-t border-[#ddd] bg-white shadow-[0px_-2px_4px_0px_rgba(0,0,0,0.05)] transition-[transform,opacity] duration-300 ease-out ${
          buildFooterVisible
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-full opacity-0'
        }`}
        aria-hidden={!buildFooterVisible}
      >
        <div className="mx-auto flex w-full max-w-[1259px] flex-col items-center">
          <div
            className="flex w-full max-w-[768px] items-center justify-center gap-3 px-4 pt-3 max-md:flex-col max-md:items-center max-md:justify-end max-md:gap-3 max-md:px-4 max-md:pt-4"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          >
            <div className="flex w-full items-center justify-between self-stretch text-[16px] leading-6 lg:justify-start">
              <span className="flex items-center gap-2">
                <span>Estimated total</span>
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#53565A] text-[12px]">?</span>
              </span>
              <span className="ml-auto flex items-center lg:ml-2">
                <span>{formatCurrency(displayTotal)}</span>
                {generated && unitsForTrolleyAdd > 0 ? (
                  <span className="ml-2">({unitsForTrolleyAdd})</span>
                ) : null}
              </span>
            </div>
            <div className="flex w-full items-stretch">
              <button
                className={`flex w-full flex-col items-center justify-center self-stretch px-5 py-2 text-[16px] leading-6 ${canAddToTrolley ? 'bg-[#5B8226] text-white' : 'bg-[#eeeeee] text-[#a9a9a9]'}`}
                disabled={!canAddToTrolley}
                tabIndex={buildFooterVisible ? 0 : -1}
                onClick={() => {
                  const added = unitsForTrolleyAdd
                  setTrolleyLines((prev) => mergeAppendBuildOntoTrolley(prev, mealGroups, essentials))
                  setTrolleySnackbar(
                    `${added} item${added === 1 ? '' : 's'} added to trolley`,
                  )
                }}
              >
                <span className="flex items-center justify-center gap-4">
                  <span className="inline-flex h-4 w-4 items-center justify-center">
                    <IconTrolley color={canAddToTrolley ? '#fff' : '#a9a9a9'} />
                  </span>
                  <span>Add selected items to trolley</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </footer>
      )}

      {removeConfirmTarget && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRemoveConfirmTarget(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-item-dialog-title"
            className="w-full max-w-[544px] bg-white p-6"
          >
            <p id="remove-item-dialog-title" className="text-[16px] leading-6 text-[#333]">
              This item will be removed from this list
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="border border-[#333] bg-white px-5 py-2 text-[16px] text-[#333]"
                onClick={() => setRemoveConfirmTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bg-[#53565A] px-5 py-2 text-[16px] text-white"
                onClick={confirmListItemRemoval}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {showPreferences && (
        <div
          className="fixed inset-0 z-20 flex bg-black/30 sm:items-center sm:justify-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) dismissBuildPreferences()
          }}
        >
          {/* Modal panel — full-screen on mobile, centred sheet on sm+ */}
          <div className="flex h-full w-full flex-col bg-white sm:h-auto sm:min-h-[677px] sm:max-h-[90vh] sm:max-w-[544px]">

            {/* ── Title bar ── */}
            <div className="shrink-0 bg-white">
              <div className="flex items-center gap-2 px-5 py-4">
                {/* Invisible spacer keeps title truly centred */}
                <span className="w-4 shrink-0" />
                <p className="flex-1 text-center text-[16px] leading-6 text-[#333]">Preferences</p>
                <button
                  aria-label="Close"
                  className="flex shrink-0 items-center justify-center text-[#333]"
                  onClick={dismissBuildPreferences}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
              <div className="border-t border-[#ddd]" />
            </div>

            {/* ── Scrollable content ── */}
            <div className="flex flex-1 flex-col gap-10 overflow-y-auto bg-[#f5f5f5] px-4 py-6 sm:px-5">
              <p className="text-[16px] leading-6 text-[#333]">
                Set your filters and start listing! We'll learn from your activity to automatically suggest the best matches for your household.
              </p>

              {/* Type */}
              <div className="flex flex-col gap-2">
                <p className="text-[14px] uppercase tracking-[2.8px] text-[#53565a]">Type</p>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[16px] leading-6 text-[#333]">Items only</span>
                    <div className="relative">
                      <button
                        type="button"
                        aria-label="What does items only mean?"
                        className="text-[#53565A]"
                        onClick={() => setShowItemsOnlyTooltip((v) => !v)}
                      >
                        <IconDisclaimerInfo />
                      </button>
                      {showItemsOnlyTooltip ? (
                        <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-[244px]">
                          <div className="bg-[#333] p-4">
                            <div className="flex items-start gap-3">
                              <p className="flex-1 text-[14px] leading-5 text-white">
                                Only show individual item essential products.
                              </p>
                              <button
                                type="button"
                                aria-label="Dismiss items only tooltip"
                                className="text-white"
                                onClick={() => setShowItemsOnlyTooltip(false)}
                              >
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                                  <path d="M9 3L3 9M3 3l6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          <div className="absolute left-[-1px] top-full">
                            <div className="h-0 w-0 border-l-[9px] border-r-[9px] border-t-[10px] border-l-transparent border-r-transparent border-t-[#333]" />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draftPreferences.itemsOnly}
                    aria-label="Items only"
                    onClick={() =>
                      setDraftPreferences((prev) => ({ ...prev, itemsOnly: !prev.itemsOnly }))
                    }
                    className={`inline-flex min-w-[52px] flex-col justify-center rounded-[16px] p-[2px] transition-colors ${draftPreferences.itemsOnly ? 'items-end bg-[#78BE20]' : 'items-start bg-[#A9A9A9]'}`}
                  >
                    <span
                      className={`flex size-6 items-center justify-center rounded-[16px] transition-colors ${draftPreferences.itemsOnly ? 'bg-[#333] shadow-[0px_2px_1px_rgba(51,51,51,0.2)]' : 'bg-white shadow-[0px_2px_2px_rgba(51,51,51,0.2)]'}`}
                    >
                      {draftPreferences.itemsOnly ? (
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <path d="M2.6 6.2 4.9 8.4 9.4 3.7" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : null}
                    </span>
                  </button>
                </div>
              </div>

              {/* Diet */}
              <div className="flex flex-col gap-2">
                <p className="text-[14px] uppercase tracking-[2.8px] text-[#53565a]">Diet</p>
                <div className="flex flex-wrap gap-2">
                  {(['Vegetarian', 'Vegan', 'Gluten free', 'Pescatarian'] as DietOption[]).map((option) => {
                    const sel = draftPreferences.dietSelections.includes(option)
                    return (
                      <button
                        key={option}
                        onClick={() => toggleDiet(option)}
                        className={`flex items-center gap-3 rounded-full border px-3 py-1 text-[16px] leading-6 transition-colors ${sel ? 'border-[#333] bg-[#333] text-white' : 'border-[#a9a9a9] bg-white text-[#333]'}`}
                      >
                        {option}
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          {sel
                            ? <path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                            : <><path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></>
                          }
                        </svg>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Range */}
              <div className="flex flex-col gap-2">
                <p className="text-[14px] uppercase tracking-[2.8px] text-[#53565a]">Range</p>
                <div className="flex flex-wrap gap-2">
                  {(['No 1 Range', 'Essentials', 'Organic'] as RangeOption[]).map((option) => {
                    const sel = draftPreferences.rangeSelections.includes(option)
                    return (
                      <button
                        key={option}
                        onClick={() => toggleRange(option)}
                        className={`flex items-center gap-3 rounded-full border px-3 py-1 text-[16px] leading-6 transition-colors ${sel ? 'border-[#333] bg-[#333] text-white' : 'border-[#a9a9a9] bg-white text-[#333]'}`}
                      >
                        {option}
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          {sel
                            ? <path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                            : <><path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></>
                          }
                        </svg>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Household */}
              <div className="flex flex-col gap-2">
                <p className="text-[14px] uppercase tracking-[2.8px] text-[#53565a]">Household</p>
                <div className="flex flex-wrap gap-2">
                  {(['Serves 1', 'Serves 2', 'Serves 3', 'Serves 4', 'Serves 5', 'Serves 6+'] as HouseholdOption[]).map((option) => {
                    const sel = draftPreferences.household === option
                    return (
                      <button
                        key={option}
                        onClick={() =>
                          setDraftPreferences((prev) => ({
                            ...prev,
                            household: prev.household === option ? null : option,
                          }))
                        }
                        className={`flex items-center gap-3 rounded-full border px-3 py-1 text-[16px] leading-6 transition-colors ${sel ? 'border-[#333] bg-[#333] text-white' : 'border-[#a9a9a9] bg-white text-[#333]'}`}
                      >
                        {option}
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          {sel
                            ? <path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                            : <><path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></>
                          }
                        </svg>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* ── Footer CTAs ── */}
            <div className="shrink-0 bg-white">
              <div className="border-t border-[#ddd]" />
              <div className="flex gap-5 p-5">
                <button
                  className="flex flex-1 items-center justify-center border border-[#333] px-5 py-2 text-[16px] leading-6 text-[#333]"
                  onClick={() => {
                    setDraftPreferences(emptyBuildPreferences())
                    setShowItemsOnlyTooltip(false)
                  }}
                >
                  Clear
                </button>
                <button
                  className="flex flex-1 items-center justify-center bg-[#53565a] px-5 py-2 text-[16px] leading-6 text-white"
                  onClick={applyPreferences}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {swapTarget && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/30 p-0 md:items-center md:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="swap-modal-title"
            className="relative h-[100dvh] w-full min-h-0 overflow-y-auto bg-white md:h-auto md:max-h-[90vh] md:max-w-[720px]"
          >
            <div className="sticky top-0 z-30 flex h-16 items-center justify-center border-b border-[#ddd] bg-white">
              {/* X close button */}
              <button
                className="absolute right-0 top-0 z-10 flex h-16 w-16 items-center justify-center text-[#53565A]"
                onClick={() => setSwapTarget(null)}
                aria-label="Close"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>

              <h2 id="swap-modal-title" className="text-center tracking-[3px] text-[#53565A]" style={{ fontSize: '20px' }}>
                Swap item
              </h2>
            </div>

            {/* Current Selection header */}
            <div className="bg-[#53565A] px-4 py-3">
              <span className="text-sm tracking-[2px] text-white">Current Selection</span>
            </div>

            {/* Current item card */}
            <div className="mx-4 mt-4 mb-4 border border-[#154734]">
              <div className="md:grid md:grid-cols-2 md:divide-x md:divide-[#ddd]">
                <div className="flex items-center gap-3 p-4">
                  {swapTarget.item.image.startsWith('http') ? (
                    <img src={swapTarget.item.image} alt={swapTarget.item.name} className="h-14 w-14 flex-shrink-0 object-contain" />
                  ) : (
                    <span className="flex-shrink-0 text-3xl">{swapTarget.item.image}</span>
                  )}
                  <span className="text-sm font-medium text-[#1a1a1a]">{swapTarget.item.name}</span>
                </div>
                <div className="border-t border-[#ddd] p-4 md:border-t-0">
                  <p className="font-medium text-[#1a1a1a]">{formatCurrency(swapTarget.item.price)}</p>
                  <p className="text-sm text-[#757575]">{swapTarget.item.unitPrice}</p>
                </div>
              </div>
            </div>

            {/* You need: header + swap refinements in one grey block */}
            <div className="sticky top-16 z-20 mx-4 border-y border-[#ddd] bg-[#f5f5f5] px-4 py-3 shadow-[0_2px_2px_rgba(0,0,0,0.04)]">
              <span className="text-sm text-[#53565A]">You need:</span>
              {/* Local swap refinements (apply only to this modal) */}
              <div
                role="radiogroup"
                aria-label="Refine swap alternatives"
                className="mt-2 flex max-w-full items-center gap-[8px] overflow-x-auto whitespace-nowrap pb-1"
              >
                {availableSwapRefinements.map((opt) => {
                  const selected = swapRefinement === opt
                  return (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-pressed={selected}
                      tabIndex={0}
                      onClick={() => {
                        setSwapShowAllAlts(false)
                        setSwapRefinement(opt)
                      }}
                      className={`shrink-0 rounded-full border px-3 py-1 text-[14px] leading-6 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#154734] ${
                        selected
                          ? 'border-[#53565A] bg-[#53565A] text-white'
                          : 'border-[#a9a9a9] bg-white text-[#333]'
                      }`}
                    >
                      {opt}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Alternatives list */}
            <div
              className="pt-4"
              style={{
                paddingBottom: `calc(${buildFooterHeight}px + env(safe-area-inset-bottom) + 24px)`,
              }}
            >
              {swapAltsLoading ? (
                <div className="px-4 py-8 text-center text-sm text-[#757575]">Finding alternatives…</div>
              ) : swapAlts.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[#757575]">No alternatives available.</div>
              ) : (
                swapAlts.map((choice) => (
                  <div key={choice.id} className="mx-4 mb-2 last:mb-0 border border-[#ddd] bg-white">
                    <div className="md:grid md:grid-cols-2 md:divide-x md:divide-[#ddd]">
                      <div className="flex items-center gap-3 p-4">
                        {choice.imageUrl.startsWith('http') ? (
                          <img src={choice.imageUrl} alt={choice.name} className="h-12 w-12 flex-shrink-0 object-contain" />
                        ) : (
                          <span className="flex-shrink-0 text-2xl">🛒</span>
                        )}
                        <span className="text-sm text-[#1a1a1a]">{choice.name}</span>
                      </div>
                      <div className="flex items-center justify-between border-t border-[#ddd] px-4 py-3 md:border-t-0">
                        <div>
                          <p className="font-medium text-[#1a1a1a]">{formatCurrency(choice.price)}</p>
                          <p className="text-sm text-[#757575]">{choice.unitPrice}</p>
                        </div>
                        <button
                          className="bg-[#53565A] px-6 py-2 text-sm text-white"
                          onClick={() => applySwap(choice)}
                        >
                          Select
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
              {!swapAltsLoading && !swapShowAllAlts && swapAltPoolSize > 4 && swapAlts.length > 0 ? (
                <div className="px-4 pb-3 pt-2 text-center">
                  <button
                    type="button"
                    className="text-[14px] font-medium text-[#53565A] underline decoration-solid underline-offset-[3px]"
                    onClick={() => setSwapShowAllAlts(true)}
                  >
                    View all items
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fixed right-4 top-4 z-30 bg-[#154734] px-4 py-2 text-white">{toast}</div>}
      {chipSnackbarVisible && (
        <div className={bottomSnackbarBarClass} style={{ bottom: bottomSnackbarBottomPx }}>
          <span className="flex items-center gap-3 text-[16px] leading-6">
            <IconSuccessCheck />
            <span>Item has been added to essentials list</span>
          </span>
        </div>
      )}

      {trolleySnackbar ? (
        <div className={bottomSnackbarBarClass} style={{ bottom: bottomSnackbarBottomPx }}>
          <span className="flex items-center gap-3 text-[16px] leading-6">
            <IconSuccessCheck />
            <span>{trolleySnackbar}</span>
          </span>
        </div>
      ) : null}

      {removedEssentialName && (
        <div
          className={`${bottomSnackbarBarClass} whitespace-nowrap`}
          style={{ bottom: bottomSnackbarBottomPx }}
        >
          <span className="flex items-center gap-3 text-[16px] leading-6">
            <IconBin />
            <span>
              Removed{' '}
              <span className="font-medium">
                {removedEssentialName.length > 20
                  ? `${removedEssentialName.slice(0, 20)}…`
                  : removedEssentialName}
              </span>
            </span>
          </span>
        </div>
      )}

      <div className="hidden">{visibleMealCount}</div>
    </main>
  )
}

export default App
