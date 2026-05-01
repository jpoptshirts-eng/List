import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { recognize } from 'tesseract.js'
import { MyTrolleyView, type TrolleyLine } from './components/my-trolley-view'
import { EssentialProductPod, IconBin, IconChevronMeal, RecipeProductPod } from './components/shopping-list-pods'
import { runVisionOcr } from './lib/visionOcr'
import { bestCatalogMatch, topCatalogMatches } from './lib/catalogMatch'
import { getShopListLinesFromUserInput, isLikelyMealLine, isLikelyUiPlaceholderList } from './lib/parseShopList'
import {
  SHOP_LIST_HELPER_INITIAL,
} from './lib/shopInputCopy'
import { loadCatalogForBuildShop, type WaitroseCatalogItem } from './lib/waitroseCatalog'

type DietOption = 'Vegetarian' | 'Vegan' | 'Gluten free' | 'Pescatarian'
type RangeOption = 'No 1 Range' | 'Essentials' | 'Organic'
type HouseholdOption = 'Serves 1' | 'Serves 2' | 'Serves 3' | 'Serves 4' | 'Serves 5' | 'Serves 6+'

type Ingredient = {
  id: string
  name: string
  needText: string
  price: number
  unitPrice: string
  qty: number
  selected: boolean
  image: string
}

type MealGroup = {
  id: string
  title: string
  dietLabel?: string
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
}

type SavedList = {
  id: string
  name: string
  mealGroups: MealGroup[]
  essentials: Essential[]
  generated: boolean
}

type SwapItem = { name: string; image: string; price: number; unitPrice: string }
type SwapTarget =
  | { kind: 'meal'; mealId: string; ingredientId: string; item: SwapItem }
  | { kind: 'essential'; id: string; item: SwapItem }

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

const defaultInspiration = ['Spaghetti Bolognese', 'Shepherd’s Pie', 'Salmon & veg', 'Japanese pancakes', 'Lemon drizzle']

const PERSONALISED_POOL = [
  'Shepherd’s Pie',
  'Green Thai Curry',
  'Spaghetti Bolognese',
  'Chicken Fajitas',
  'Pasta Bake',
  'Tomato Soup',
  'Greek Yoghurt',
  'Orange Juice',
  'Basmati Rice',
  'Broccoli',
  'Garlic',
  'Bananas',
]


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
  if (hit?.imageUrl?.startsWith('http')) return hit.imageUrl
  return '🛒'
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
    'snack',
    'crisps',
    'chips',
    'walkers',
    'sensations',
    'chocolate',
    'sweets',
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
      { label: 'Roasting Joint', match: 'chicken whole' },
      { label: 'Potatoes', match: 'potatoes' },
      { label: 'Carrots', match: 'carrots' },
      { label: 'Broccoli', match: 'broccoli' },
      { label: 'Gravy Granules', match: 'gravy granules' },
      { label: 'Stuffing', match: 'stuffing mix' },
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

/** Build meals + essentials only from parsed list lines matched against POPMAS (no full-catalog dump). */
function buildShopFromListLines(
  lines: string[],
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
  serves: string,
  dietSelections: DietOption[],
): { meals: MealGroup[]; essentials: Essential[]; fallbackMatches: number } {
  const meals: MealGroup[] = []
  const essentials: Essential[] = []
  let fallbackMatches = 0
  let mi = 0
  let ei = 0
  const dietLabel = dietSelections.includes('Vegetarian') ? 'Vegetarian' : undefined

  for (const label of lines) {
    const trimmed = label.trim()
    if (!trimmed) continue

    if (isLikelyMealLine(trimmed)) {
      const id = `meal-list-${mi++}-${Math.random().toString(36).slice(2, 8)}`
      const ingredientSpecs = mealTemplateIngredients(trimmed)
      meals.push({
        id,
        title: trimmed,
        dietLabel,
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
      const resolved = essentialFromCatalogMatch(
        { id, label: trimmed, match: trimmed },
        primaryProducts,
        fallbackProducts,
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
    byTitle.set(key, { ...prev, ingredients: Array.from(ingredientMap.values()) })
  }
  return Array.from(byTitle.values())
}

function derivePersonalisedChips(params: {
  meals: MealGroup[]
  essentials: Essential[]
  dietSelections: DietOption[]
  rangeSelections: RangeOption[]
}): string[] {
  const { meals, essentials, dietSelections, rangeSelections } = params
  const mealTitles = meals.filter((m) => !m.removed).map((m) => m.title.toLowerCase())
  const essentialNames = essentials.map((e) => e.name.toLowerCase())
  const suggestions: string[] = []

  const hasAny = (terms: string[]) =>
    terms.some(
      (t) => mealTitles.some((m) => m.includes(t)) || essentialNames.some((e) => e.includes(t)),
    )

  if (hasAny(['spaghetti', 'pasta'])) suggestions.push('Garlic Bread', 'Pasta Bake')
  if (hasAny(['curry', 'thai'])) suggestions.push('Basmati Rice', 'Naan Bread')
  if (hasAny(['chicken'])) suggestions.push('Chicken Fajitas')
  if (hasAny(['milk', 'yoghurt'])) suggestions.push('Greek Yoghurt', 'Bananas')
  if (hasAny(['bread'])) suggestions.push('Tomato Soup')
  if (hasAny(['orange', 'juice', 'fruit'])) suggestions.push('Broccoli')
  if (dietSelections.includes('Vegetarian')) suggestions.push('Lentil Dhal', 'Vegetable Stir Fry')
  if (rangeSelections.includes('Organic')) suggestions.push('Organic Eggs', 'Organic Carrots')

  const ordered = [...suggestions, ...PERSONALISED_POOL]
  const unique = Array.from(new Set(ordered))
  return unique.slice(0, 6)
}

function getCatalogErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Could not load POPMAS. Check Supabase configuration and access.'
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
  const [inputFocused, setInputFocused] = useState(false)
  const [uploadedFileName, setUploadedFileName] = useState('')
  const [showPreferences, setShowPreferences] = useState(false)
  const [toast, setToast] = useState('')
  const [showMoreEssentials, setShowMoreEssentials] = useState(false)
  const [trolleyLines, setTrolleyLines] = useState<TrolleyLine[]>([])
  const [trolleySnackbar, setTrolleySnackbar] = useState('')
  const [swapTarget, setSwapTarget] = useState<SwapTarget | null>(null)
  const [swapAlts, setSwapAlts] = useState<WaitroseCatalogItem[]>([])
  const [swapAltsLoading, setSwapAltsLoading] = useState(false)
  const swapCatalogRef = useRef<WaitroseCatalogItem[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [, setCatalogSourceLabel] = useState('')
  const [listInputError, setListInputError] = useState('')
  const [imageProcessing, setImageProcessing] = useState(false)
  const [usedInspirationChips, setUsedInspirationChips] = useState<string[]>([])
  const [chipSnackbarVisible, setChipSnackbarVisible] = useState(false)
  const [removedEssentialName, setRemovedEssentialName] = useState('')
  const [activeInspirationChip, setActiveInspirationChip] = useState<string | null>(null)

  const [dietSelections, setDietSelections] = useState<DietOption[]>([])
  const [rangeSelections, setRangeSelections] = useState<RangeOption[]>([])
  const [household, setHousehold] = useState<HouseholdOption | null>(null)

  const [mealGroups, setMealGroups] = useState<MealGroup[]>([])
  const [essentials, setEssentials] = useState<Essential[]>([])

  const [appView, setAppView] = useState<AppView>('index')
  const [savedLists, setSavedLists] = useState<SavedList[]>([])
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [listName, setListName] = useState('')
  const [newListNameInput, setNewListNameInput] = useState('')
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

  useEffect(() => {
    if (!swapTarget) {
      setSwapAlts([])
      return
    }
    if (swapCatalogRef.current) {
      setSwapAlts(topCatalogMatches(swapTarget.item.name, swapCatalogRef.current, 4, swapTarget.item.name))
      return
    }
    setSwapAltsLoading(true)
    void loadCatalogForBuildShop()
      .then((payload) => {
        swapCatalogRef.current = payload.primary.products
        setSwapAlts(topCatalogMatches(swapTarget.item.name, payload.primary.products, 4, swapTarget.item.name))
        setSwapAltsLoading(false)
      })
      .catch(() => {
        setSwapAlts([])
        setSwapAltsLoading(false)
      })
  }, [swapTarget])

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

  useLayoutEffect(() => {
    if (appView !== 'build') {
      setBuildFooterHeight(0)
      return
    }
    const el = buildFooterRef.current
    if (!el) return
    const measure = () => setBuildFooterHeight(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [appView])

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


  const hasEnoughSignalsForPersonalisedChips =
    mealGroups.filter((m) => !m.removed).length + essentials.length >= 4 ||
    dietSelections.length + rangeSelections.length >= 2

  const inspirationBase = (() => {
    if (!hasEnoughSignalsForPersonalisedChips) return defaultInspiration
    return derivePersonalisedChips({
      meals: mealGroups,
      essentials,
      dietSelections,
      rangeSelections,
    })
  })()

  const inspirationChips = inspirationBase.filter((chip) => !usedInspirationChips.includes(chip))
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
  const essentialsMetaLine = (() => {
    const prefs = [...dietSelections, ...rangeSelections]
    const prefix = prefs.length ? `${prefs.join(' • ')} • ` : ''
    return `${prefix}${essentials.length} items • ${formatCurrency(essentialsTotal)}`
  })()

  async function applyPreferences() {
    const raw = readListTextareaRaw()
    listDraftRef.current = raw
    const lines = getShopListLinesFromUserInput(raw)
    const chipLines = chipSourceLinesRef.current
    const serves = household ?? 'Serves 4'

    if (lines.length > 0) {
      const gen = ++listBuildGenerationRef.current
      try {
        const payload = await loadCatalogForBuildShop()
        if (gen !== listBuildGenerationRef.current) return
        const built = buildShopFromListLines(lines, payload.primary.products, payload.fallback?.products ?? [], serves, dietSelections)
        setCatalogSourceLabel(
          built.fallbackMatches > 0 && payload.fallback
            ? `${payload.primary.source} (fallback used for ${built.fallbackMatches} item${built.fallbackMatches === 1 ? '' : 's'}: ${payload.fallback.source})`
            : payload.primary.source,
        )
        if (!builtShopHasRows(built)) {
          setListInputError('No new items were found in POPMAS for this update.')
        } else {
          setGenerated(true)
          setMealGroups((prev) => mergeMealGroups(prev, built.meals))
          setEssentials((prev) => mergeEssentials(prev, built.essentials))
        }
      } catch (error) {
        setListInputError(getCatalogErrorMessage(error))
      }
    } else if (chipLines.length > 0) {
      const gen = ++listBuildGenerationRef.current
      try {
        const payload = await loadCatalogForBuildShop()
        if (gen !== listBuildGenerationRef.current) return
        const built = buildShopFromListLines(
          chipLines,
          payload.primary.products,
          payload.fallback?.products ?? [],
          serves,
          dietSelections,
        )
        setCatalogSourceLabel(
          built.fallbackMatches > 0 && payload.fallback
            ? `${payload.primary.source} (fallback used for ${built.fallbackMatches} item${built.fallbackMatches === 1 ? '' : 's'}: ${payload.fallback.source})`
            : payload.primary.source,
        )
        if (!builtShopHasRows(built)) {
          setListInputError('No new items were found in POPMAS for this update.')
        } else {
          setGenerated(true)
          setMealGroups((prev) => mergeMealGroups(prev, built.meals))
          setEssentials((prev) => mergeEssentials(prev, built.essentials))
        }
      } catch (error) {
        setListInputError(getCatalogErrorMessage(error))
      }
    }
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
      const built = buildShopFromListLines(
        lines,
        payload.primary.products,
        payload.fallback?.products ?? [],
        serves,
        dietSelections,
      )

      if (!builtShopHasRows(built)) {
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
      resetUploadedFileSelection()
      setCatalogSourceLabel(
        built.fallbackMatches > 0 && payload.fallback
          ? `${payload.primary.source} (fallback used for ${built.fallbackMatches} item${built.fallbackMatches === 1 ? '' : 's'}: ${payload.fallback.source})`
          : payload.primary.source,
      )
    } catch (error) {
      if (gen !== listBuildGenerationRef.current) return
      setGenerated(mealGroups.length > 0 || essentials.length > 0)
      setCatalogSourceLabel('error: POPMAS unavailable')
      setListInputError(getCatalogErrorMessage(error))
      setToast('Build shop requires POPMAS. Configure Supabase to continue.')
    } finally {
      if (gen === listBuildGenerationRef.current) setCatalogLoading(false)
    }
  }

  function toggleDiet(value: DietOption) {
    setDietSelections((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
  }

  function toggleRange(value: RangeOption) {
    setRangeSelections((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
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
                    : { ...item, name: choice.name, price: choice.price, unitPrice: choice.unitPrice, image: choice.imageUrl },
                ),
              },
        ),
      )
    } else {
      setEssentials((prev) =>
        prev.map((item) =>
          item.id !== swapTarget.id
            ? item
            : { ...item, name: choice.name, price: choice.price, unitPrice: choice.unitPrice, image: choice.imageUrl },
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
  }

  function resetUploadedFileSelection() {
    setUploadedFileName('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function addSuggestionToMeals(tag: string) {
    if (activeInspirationChip) return
    const gen = ++listBuildGenerationRef.current
    void (async () => {
      setListInputError('')
      resultsFromChipRef.current = true
      chipSourceLinesRef.current = [tag]
      setActiveInspirationChip(tag)
      setShowMoreEssentials(false)
      const serves = household ?? 'Serves 4'
      try {
        const payload = await loadCatalogForBuildShop()
        if (gen !== listBuildGenerationRef.current) return
        const built = buildShopFromListLines(
          [tag],
          payload.primary.products,
          payload.fallback?.products ?? [],
          serves,
          dietSelections,
        )
        setCatalogSourceLabel(
          built.fallbackMatches > 0 && payload.fallback
            ? `${payload.primary.source} (fallback used for ${built.fallbackMatches} item${built.fallbackMatches === 1 ? '' : 's'}: ${payload.fallback.source})`
            : payload.primary.source,
        )
        if (!builtShopHasRows(built)) {
          setListInputError('That suggestion did not match anything in the product catalog. Try another chip or type a specific item.')
          resultsFromChipRef.current = false
          chipSourceLinesRef.current = []
          return
        }
        setGenerated(true)
        setMealGroups((prev) => mergeMealGroups(prev, built.meals))
        setEssentials((prev) => mergeEssentials(prev, built.essentials))
        if (built.meals.length === 0 && built.essentials.length > 0) {
          setChipSnackbarVisible(true)
        }
        setUsedInspirationChips((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
      } catch (error) {
        if (gen !== listBuildGenerationRef.current) return
        setGenerated(mealGroups.length > 0 || essentials.length > 0)
        setCatalogSourceLabel('error: POPMAS unavailable')
        setListInputError(getCatalogErrorMessage(error))
        setToast('Build shop requires POPMAS. Configure Supabase to continue.')
      } finally {
        if (gen === listBuildGenerationRef.current) setActiveInspirationChip(null)
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
    setActiveListId(list.id)
    setListName(list.name)
    setMealGroups(list.mealGroups)
    setEssentials(list.essentials)
    setGenerated(list.generated)
    setShowMoreEssentials(false)
    setInputValue('')
    setListInputError('')
    setAppView('build')
  }

  function goToIndex() {
    // Auto-save current build state before leaving
    if (activeListId) {
      setSavedLists((prev) =>
        prev.map((l) =>
          l.id === activeListId ? { ...l, mealGroups, essentials, generated } : l,
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

  return (
    <main className="app-shell min-h-screen bg-[#fafafa] pb-32 font-normal text-[#333] [font-family:'Gill_Sans_Nova_for_JL',_'Gill_Sans',_'Gill_Sans_MT',sans-serif]">
      <header className="border-b border-[#ddd] bg-white">
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
            <div className="text-[42px] leading-none tracking-[5px] text-[#5B8226]">WAITROSE</div>
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
            <div className="leading-none">
              <div className="text-[24px] font-normal tracking-[3px] text-[#5B8226]">WAITROSE</div>
              <div className="mt-0.5 text-[9px] font-normal tracking-[2px] text-[#5B8226]">&amp; PARTNERS</div>
            </div>
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
              {/* Create a list tile */}
              <div className="flex w-full shrink-0 items-center justify-center border border-dashed border-[#a9a9a9] bg-white p-6 sm:w-[343px] sm:min-h-[184px]">
                <form
                  className="flex w-full flex-col gap-3"
                  onSubmit={(e) => { e.preventDefault(); createNewList() }}
                >
                  <label className="text-[14px] font-medium text-[#53565A]" htmlFor="new-list-name">
                    List name
                  </label>
                  <div className="flex flex-col gap-1">
                    <input
                      id="new-list-name"
                      type="text"
                      maxLength={20}
                      value={newListNameInput}
                      onChange={(e) => setNewListNameInput(e.target.value)}
                      className="w-full border-b border-[#a9a9a9] bg-transparent pb-1 text-[16px] outline-none focus:border-[#154734]"
                      placeholder=""
                      autoComplete="off"
                    />
                    <span className="text-right text-[12px] text-[#a9a9a9]">{newListNameInput.length}/20</span>
                  </div>
                  <button
                    type="submit"
                    disabled={!newListNameInput.trim()}
                    className="mt-1 bg-[#53565A] px-5 py-2 text-[16px] text-white disabled:bg-[#eeeeee] disabled:text-[#a9a9a9]"
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
                      <div className="flex min-w-0 items-center gap-4 text-[16px]">
                        <span className="truncate font-medium">{list.name}</span>
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
                    <div className="flex justify-end px-4 pb-4">
                      <button
                        className="text-[16px] font-medium underline"
                        onClick={() => openList(list)}
                      >
                        View
                      </button>
                    </div>
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
            {showAutoSaveBanner && (
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
                  <p className="flex-1 text-[16px] leading-6 text-[#333]">
                    Lists are automatically saved every time meals/items are generated
                  </p>
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

        <div className="mx-auto w-full max-w-[768px] border border-[#ddd] bg-white p-3 sm:p-4">
          <form
            className="block"
            onSubmit={(e) => {
              e.preventDefault()
              resetUploadedFileSelection()
              void handleBuildShop()
            }}
          >
            <div className="mb-2 text-[14px] font-medium tracking-[2.8px] text-[#53565A]">TELL US WHAT YOU NEED</div>
            <label htmlFor="list-input" className="sr-only">
              List input
            </label>
            <div className="relative">
              {!inputFocused && !inputValue.trim() && (
                <div className="web-paragraph-heading pointer-events-none absolute left-3 top-3 right-3 whitespace-pre-line">
                  {helperCopy}
                </div>
              )}
              <textarea
                ref={listInputRef}
                id="list-input"
                name="shop-list"
                autoComplete="off"
                className={`web-paragraph-heading h-[140px] w-full border bg-[#fafafa] p-3 sm:h-28 sm:leading-7 focus:outline focus:outline-2 focus:outline-[#154734] ${listInputError ? 'border-[#a6192e]' : 'border-[#a9a9a9]'}`}
                value={inputValue}
                placeholder=""
                onChange={(e) => {
                  setListInputError('')
                  resultsFromChipRef.current = false
                  setInputValue(e.target.value)
                }}
                onFocus={() => {
                  setInputFocused(true)
                  setListInputError('')
                  // Clear any old helper text that may have been stored as actual input value.
                  if (isLikelyUiPlaceholderList(inputValue)) {
                    setInputValue('')
                  }
                }}
                onBlur={() => setInputFocused(false)}
                aria-invalid={listInputError ? true : undefined}
                aria-describedby={listInputError ? 'list-input-error' : undefined}
                aria-label="Build a shop list input"
              />
            </div>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={`flex h-[28px] items-center justify-start gap-2 border border-solid border-[#333] bg-white py-0.5 pl-2 pr-[7px] text-[16px] leading-6 text-[#333] ${visibleUploadedFileName ? 'max-w-[200px] overflow-hidden' : 'min-w-0 w-auto max-w-full'}`}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="shrink-0">
                    <IconUploadImage />
                  </span>
                  {visibleUploadedFileName ? (
                    <>
                      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{visibleUploadedFileName}</span>
                      <span
                        role="button"
                        aria-label="Remove uploaded image"
                        className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center text-[14px] leading-none"
                        onClick={(e) => {
                          e.stopPropagation()
                          clearUploadedFile()
                        }}
                      >
                        ×
                      </span>
                    </>
                  ) : (
                    <span className="whitespace-nowrap">Upload an image</span>
                  )}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleUploadFile(e.target.files?.[0])} />
                <button
                  type="button"
                  className="flex h-[28px] items-center gap-2 border border-solid border-[#333] bg-white py-0.5 pl-2 pr-[7px] text-[16px] leading-6 text-[#333]"
                  onClick={() => setShowPreferences(true)}
                >
                  <span className="shrink-0">
                    <IconPreferences />
                  </span>
                  <span className="whitespace-nowrap">Filter preferences</span>
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
                {catalogLoading ? 'Loading…' : imageProcessing ? 'Reading image…' : '✦ Build shop'}
              </button>
            </div>
          </form>
          {listInputError ? (
            <p id="list-input-error" className="mt-3 text-[14px] leading-5 text-[#a6192e]" role="alert">
              {listInputError}
            </p>
          ) : null}
        </div>

        <div className="mx-auto mt-10 w-full max-w-[768px] sm:mt-8">
          <div className="mb-2 text-[14px] tracking-[2.8px]">NEED INSPIRATION?</div>
          <div className="flex flex-wrap gap-2 sm:gap-2">
            {inspirationChips.map((chip) => (
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

        {generated && (hasVisibleMeals || hasVisibleEssentials) && (
          <div className="mx-auto mt-10 w-full max-w-[1195px] px-0">
            {hasVisibleMeals && (
              <>
                <h2 className="mb-2 text-[14px] font-medium uppercase tracking-[2.8px] text-[#53565A]">Meals</h2>
                <div className="flex flex-col gap-2">
                  {mealGroups.filter((meal) => !meal.removed).map((meal) => {
                const mealItems = meal.ingredients.length
                const mealPrice = meal.ingredients.reduce((sum, i) => (i.selected ? sum + i.price * i.qty : sum), 0)
                const metaParts = [meal.dietLabel, `${mealItems} items`, meal.serves, formatCurrency(mealPrice)].filter(Boolean) as string[]
                const metaLine = metaParts.join(' • ')
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
                        <p className="mt-1.5 text-[16px] font-light leading-6 text-[#53565A]">{metaLine}</p>
                      </div>
                      <button
                        type="button"
                        className="mt-0.5 inline-flex shrink-0 items-center gap-2 p-0.5 text-[#757575]"
                        aria-label={`Remove ${meal.title}`}
                        onClick={() => setMealGroups((prev) => prev.map((m) => (m.id === meal.id ? { ...m, removed: true } : m)))}
                      >
                        <span className="hidden text-[14px] leading-5 text-[#53565A] lg:inline">Remove meal</span>
                        <IconBin />
                      </button>
                    </div>
                    {meal.expanded && (
                      <div className="flex flex-col divide-y divide-[#ddd] border-t border-[#ddd]">
                        {meal.ingredients.map((item) => (
                          <RecipeProductPod
                            key={item.id}
                            grouped
                            needText={item.needText}
                            name={item.name}
                            image={item.image}
                            price={formatCurrency(item.price)}
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
                            onSwap={() => setSwapTarget({ kind: 'meal', mealId: meal.id, ingredientId: item.id, item: { name: item.name, image: item.image, price: item.price, unitPrice: item.unitPrice } })}
                            onQtyDelta={(d) => changeMealQty(meal.id, item.id, d)}
                          />
                        ))}
                      </div>
                    )}
                  </article>
                )
                  })}
                </div>
              </>
            )}

            {hasVisibleEssentials && (
              <section className={hasVisibleMeals ? 'mt-10' : ''}>
                <h2 className="text-[14px] font-medium uppercase tracking-[2.8px] text-[#53565A]">Your essentials</h2>
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
                        onSwap={() => setSwapTarget({ kind: 'essential', id: item.id, item: { name: item.name, image: item.image, price: item.price, unitPrice: item.unitPrice } })}
                        onQtyDelta={(d) => changeEssentialQty(item.id, d)}
                        onRemove={() => {
                          setRemovedEssentialName(item.name)
                          setEssentials((prev) => prev.filter((e) => e.id !== item.id))
                        }}
                      />
                    </div>
                  ))}
                </div>
                {!showMoreEssentials && hiddenEssentialsCount > 0 && (
                  <div className="mt-4 text-center">
                    <button
                      type="button"
                      className="border border-[#333] bg-white px-8 py-2 text-[16px] text-[#333]"
                      onClick={() => setShowMoreEssentials(true)}
                    >
                      View {hiddenEssentialsCount} more {hiddenEssentialsCount === 1 ? 'item' : 'items'}
                    </button>
                  </div>
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

      {appView === 'build' && (
      <footer
        ref={buildFooterRef}
        className="fixed bottom-0 left-0 right-0 border-t border-[#ddd] bg-white shadow-[0px_-2px_4px_0px_rgba(0,0,0,0.05)]"
      >
        <div className="mx-auto flex w-full max-w-[1259px] flex-col items-center">
          <div className="flex w-full max-w-[768px] items-center justify-center gap-3 px-4 pb-4 pt-3 max-md:flex-col max-md:items-center max-md:justify-end max-md:gap-3 max-md:p-4">
            <div className="flex w-full items-center justify-between self-stretch text-[16px] leading-6 lg:justify-start">
              <span className="flex items-center gap-2">
                <span>Estimated total</span>
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#53565A] text-[12px]">?</span>
              </span>
              <span className="ml-auto lg:ml-2">{formatCurrency(displayTotal)}</span>
            </div>
            <div className="flex w-full items-stretch">
              <button
                className={`flex w-full flex-col items-center justify-center self-stretch px-5 py-2 text-[16px] leading-6 ${canAddToTrolley ? 'bg-[#5B8226] text-white' : 'bg-[#eeeeee] text-[#a9a9a9]'}`}
                disabled={!canAddToTrolley}
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

      {showPreferences && (
        <div
          className="fixed inset-0 z-20 flex bg-black/30 sm:items-center sm:justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) setShowPreferences(false) }}
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
                  onClick={() => setShowPreferences(false)}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
              <div className="border-t border-[#ddd]" />
            </div>

            {/* ── Scrollable content ── */}
            <div className="flex flex-1 flex-col gap-10 overflow-y-auto bg-[#fafafa] px-4 py-6">
              <p className="text-[16px] leading-6 text-[#333]">
                Set your filters and start listing! We'll learn from your activity to automatically suggest the best matches for your household.
              </p>

              {/* Diet */}
              <div className="flex flex-col gap-2">
                <p className="text-[14px] uppercase tracking-[2.8px] text-[#53565a]">Diet</p>
                <div className="flex flex-wrap gap-2">
                  {(['Vegetarian', 'Vegan', 'Gluten free', 'Pescatarian'] as DietOption[]).map((option) => {
                    const sel = dietSelections.includes(option)
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
                    const sel = rangeSelections.includes(option)
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
                    const sel = household === option
                    return (
                      <button
                        key={option}
                        onClick={() => setHousehold(option)}
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
                  onClick={() => { setDietSelections([]); setRangeSelections([]); setHousehold(null) }}
                >
                  Clear
                </button>
                <button
                  className="flex flex-1 items-center justify-center bg-[#53565a] px-5 py-2 text-[16px] leading-6 text-white"
                  onClick={() => void applyPreferences()}
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
          <div className="relative w-full overflow-auto bg-white pb-4 md:max-h-[90vh] md:max-w-[720px]">
            {/* X close button */}
            <button
              className="absolute right-0 top-0 z-10 pr-[20px] pt-[20px] text-[#53565A]"
              onClick={() => setSwapTarget(null)}
              aria-label="Close"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>

            <h2 className="mb-6 mt-4 text-center tracking-[3px] text-[#53565A]" style={{ fontSize: '20px' }}>
              Swap item
            </h2>

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

            {/* You need: header */}
            <div className="mx-4 bg-[#f5f5f5] px-4 py-3">
              <span className="text-sm text-[#53565A]">You need:</span>
            </div>

            {/* Alternatives list */}
            <div className="overflow-auto pb-4">
              {swapAltsLoading ? (
                <div className="px-4 py-8 text-center text-sm text-[#757575]">Finding alternatives…</div>
              ) : swapAlts.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[#757575]">No alternatives found.</div>
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
