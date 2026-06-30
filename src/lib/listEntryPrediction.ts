import { ALL_MOCK_SUGGESTIONS } from '../data/productSuggestions'
import type { ProductSuggestion } from './inputExperience'
import { bestCatalogMatch, topCatalogMatches } from './catalogMatch'
import { catalogProductImage, type WaitroseCatalogItem } from './waitroseCatalog'

export type PredictableProduct = ProductSuggestion & {
  category: string
  keywords: string[]
  popularity?: number
}

const PREDICTION_CATALOG: PredictableProduct[] = ALL_MOCK_SUGGESTIONS.map((p) => ({
  ...p,
  category: inferCategoryFromProduct(p.title, p.size),
  keywords: buildKeywords(p.title, p.size),
  popularity: p.source === 'favourite' ? 10 : p.source === 'previous-purchase' ? 8 : 5,
}))

const CATEGORY_DEFAULTS: Record<string, string> = {
  milk: 'milk',
  bread: 'bread',
  butter: 'butter',
  tea: 'tea',
  coffee: 'coffee',
  eggs: 'eggs',
  juice: 'juice',
  cereal: 'cereal',
  cheese: 'cheese',
  snacks: 'snacks',
}

function buildKeywords(title: string, size: string): string[] {
  return `${title} ${size}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
}

function inferCategoryFromProduct(title: string, size: string): string {
  const hay = `${title} ${size}`.toLowerCase()
  if (/\bmilk\b/.test(hay) && !/oat|almond|coconut/.test(hay)) return 'milk'
  if (/\bbread\b/.test(hay) && !/flour|crumb/.test(hay)) return 'bread'
  if (/\bbutter\b/.test(hay) && !/croissant|pastry/.test(hay)) return 'butter'
  if (/\btea\b/.test(hay)) return 'tea'
  if (/\bcoffee\b/.test(hay)) return 'coffee'
  if (/\begg/.test(hay)) return 'eggs'
  if (/\bjuice\b/.test(hay)) return 'juice'
  if (/\bcereal|weetabix|cornflake/.test(hay)) return 'cereal'
  if (/\bcheese\b/.test(hay)) return 'cheese'
  if (/\bcrisp|snack/.test(hay)) return 'snacks'
  return 'grocery'
}

export function inferCategory(term: string): string | null {
  const t = term.toLowerCase().trim()
  if (CATEGORY_DEFAULTS[t]) return CATEGORY_DEFAULTS[t]
  for (const [key, category] of Object.entries(CATEGORY_DEFAULTS)) {
    if (t.includes(key)) return category
  }
  return null
}

function isExcludedForCategory(productName: string, category: string | null): boolean {
  if (!category) return false
  const n = productName.toLowerCase()
  switch (category) {
    case 'milk':
      return (
        n.includes('oat') ||
        n.includes('almond') ||
        n.includes('coconut') ||
        n.includes('formula') ||
        n.includes('shake')
      )
    case 'bread':
      return n.includes('flour') || n.includes('crumb') || n.includes('mix') || n.includes('sourdough starter')
    case 'butter':
      return (
        n.includes('croissant') ||
        n.includes('pastry') ||
        n.includes('brioche') ||
        (n.includes('spread') && !n.includes('butter'))
      )
    case 'tea':
      return n.includes('coffee') || n.includes('meal')
    case 'coffee':
      return n.includes('tea bag') || n.includes('hot chocolate')
    default:
      return false
  }
}

function scorePredictableProduct(product: PredictableProduct, query: string): number {
  const q = query.toLowerCase().trim()
  const category = inferCategory(q)
  let score = 0
  const hay = `${product.title} ${product.size} ${product.keywords.join(' ')}`.toLowerCase()

  if (category && product.category === category) score += 40
  if (category && isExcludedForCategory(product.title, category)) score -= 100

  if (hay.includes(q)) score += 25
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (hay.includes(token)) score += token.length >= 4 ? 10 : 6
  }

  if (product.source === 'favourite') score += 12
  if (product.source === 'previous-purchase') score += 8
  score += product.popularity ?? 0

  return score
}

function personalizationBoost(mock: PredictableProduct, hit: WaitroseCatalogItem): number {
  const mockHay = `${mock.title} ${mock.size}`.toLowerCase()
  const hitHay = hit.name.toLowerCase()
  let boost = 0
  if (mock.source === 'favourite') boost += 14
  if (mock.source === 'previous-purchase') boost += 9
  for (const token of mockHay.split(/\s+/).filter((t) => t.length >= 4)) {
    if (hitHay.includes(token)) boost += 6
  }
  if (mock.category && hitHay.includes(mock.category)) boost += 8
  return boost
}

export type PredictionResult = {
  name: string
  price: number
  unitPrice: string
  image: string
  productType?: string
  usedFallback: boolean
  selectedProductId?: string
}

function hitToPrediction(
  hit: WaitroseCatalogItem,
  usedFallback: boolean,
  selectedProductId?: string,
): PredictionResult {
  return {
    name: hit.name,
    price: hit.price,
    unitPrice: hit.unitPrice?.trim() || '—',
    image: catalogProductImage(hit.imageUrl),
    productType: hit.productType,
    usedFallback,
    selectedProductId,
  }
}

function findCatalogHitForMock(
  mock: PredictableProduct,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
): { hit: WaitroseCatalogItem; usedFallback: boolean } | null {
  const queries = [`${mock.title} ${mock.size}`, mock.title, mock.size]
  for (const q of queries) {
    const fromPrimary = bestCatalogMatch(q, primaryProducts)
    if (fromPrimary) return { hit: fromPrimary, usedFallback: false }
  }
  for (const q of queries) {
    const fromFallback = bestCatalogMatch(q, fallbackProducts)
    if (fromFallback) return { hit: fromFallback, usedFallback: true }
  }
  return null
}

function findCatalogHitById(
  selectedProductId: string,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
): { hit: WaitroseCatalogItem; usedFallback: boolean } | null {
  const catalogKey = selectedProductId.startsWith('catalog-')
    ? selectedProductId.slice('catalog-'.length)
    : selectedProductId
  const fromPrimary = primaryProducts.find((p) => p.id === catalogKey)
  if (fromPrimary) return { hit: fromPrimary, usedFallback: false }
  const fromFallback = fallbackProducts.find((p) => p.id === catalogKey)
  if (fromFallback) return { hit: fromFallback, usedFallback: true }
  return null
}

function filterCatalogByCategory(
  query: string,
  catalogPool: WaitroseCatalogItem[],
): WaitroseCatalogItem[] {
  const category = inferCategory(query)
  if (!category || catalogPool.length === 0) return catalogPool
  return catalogPool.filter((p) => {
    const n = p.name.toLowerCase()
    if (isExcludedForCategory(p.name, category)) return false
    if (category === 'milk') return n.includes('milk')
    if (category === 'bread') return n.includes('bread') && !n.includes('flour')
    if (category === 'butter') return n.includes('butter')
    if (category === 'tea') return n.includes('tea')
    if (category === 'coffee') return n.includes('coffee')
    if (category === 'eggs') return n.includes('egg')
    if (category === 'juice') return n.includes('juice')
    return n.includes(category) || n.includes(query.toLowerCase())
  })
}

function rankCatalogCandidates(
  query: string,
  catalogHits: WaitroseCatalogItem[],
  personalizationMocks: PredictableProduct[],
  catalogFiltered: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
): WaitroseCatalogItem | null {
  const candidates =
    catalogHits.length > 0
      ? catalogHits
      : [
          bestCatalogMatch(query, catalogFiltered),
          bestCatalogMatch(query, fallbackProducts),
        ].filter((h): h is WaitroseCatalogItem => h != null)

  if (candidates.length === 0) return null

  let bestHit: WaitroseCatalogItem | null = null
  let bestScore = -Infinity
  for (let i = 0; i < candidates.length; i++) {
    const hit = candidates[i]
    let score = (candidates.length - i) * 10
    for (const mock of personalizationMocks) {
      score += personalizationBoost(mock, hit)
    }
    if (score > bestScore) {
      bestScore = score
      bestHit = hit
    }
  }
  return bestHit
}

function getCategoryFallbackFromPopmas(
  query: string,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
): PredictionResult | null {
  const category = inferCategory(query)
  const catalogPool = primaryProducts.length > 0 ? primaryProducts : fallbackProducts
  if (!category || catalogPool.length === 0) return null

  const filtered = filterCatalogByCategory(query, catalogPool)
  const hit =
    bestCatalogMatch(query, filtered.length > 0 ? filtered : catalogPool) ??
    filtered[0] ??
    null
  if (!hit) return null
  const usedFallback = primaryProducts.length === 0 || !primaryProducts.some((p) => p.id === hit.id)
  return hitToPrediction(hit, usedFallback)
}

export function rankProductsForEntry(
  originalText: string,
  primaryProducts: WaitroseCatalogItem[],
  fallbackProducts: WaitroseCatalogItem[],
  options?: {
    selectedProductId?: string
    preferVegetarian?: boolean
  },
): PredictionResult | null {
  const query = originalText.trim()
  if (!query) return null

  const catalogPool = primaryProducts.length > 0 ? primaryProducts : fallbackProducts

  if (options?.selectedProductId) {
    const byId = findCatalogHitById(options.selectedProductId, primaryProducts, fallbackProducts)
    if (byId) {
      return hitToPrediction(byId.hit, byId.usedFallback, options.selectedProductId)
    }
    const mock = PREDICTION_CATALOG.find((p) => p.id === options.selectedProductId)
    if (mock) {
      const resolved = findCatalogHitForMock(mock, primaryProducts, fallbackProducts)
      if (resolved) return hitToPrediction(resolved.hit, resolved.usedFallback, mock.id)
    }
  }

  const mockRanked = PREDICTION_CATALOG.map((p) => ({ p, score: scorePredictableProduct(p, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  const category = inferCategory(query)
  const filteredMocks = mockRanked.filter(
    (x) => !category || x.p.category === category || x.score >= 30,
  )
  const personalizationMocks = filteredMocks.slice(0, 5).map((x) => x.p)

  const catalogFiltered = filterCatalogByCategory(query, catalogPool)
  const catalogHits = topCatalogMatches(
    query,
    catalogFiltered.length > 0 ? catalogFiltered : catalogPool,
    8,
    query,
  )

  const bestHit = rankCatalogCandidates(
    query,
    catalogHits,
    personalizationMocks,
    catalogFiltered,
    fallbackProducts,
  )

  if (bestHit) {
    const usedFallback = primaryProducts.length === 0 || !primaryProducts.some((p) => p.id === bestHit.id)
    return hitToPrediction(bestHit, usedFallback)
  }

  if (filteredMocks.length > 0) {
    const resolved = findCatalogHitForMock(filteredMocks[0].p, primaryProducts, fallbackProducts)
    if (resolved) return hitToPrediction(resolved.hit, resolved.usedFallback)
  }

  return getCategoryFallbackFromPopmas(query, primaryProducts, fallbackProducts)
}

export function lineMatchesManualEssential(
  essential: { originalText?: string; name: string; manuallySelected?: boolean },
  line: string,
): boolean {
  if (!essential.manuallySelected) return false
  const lk = line.toLowerCase().trim()
  const ok = (essential.originalText || '').toLowerCase().trim()
  if (ok && (ok.includes(lk) || lk.includes(ok))) return true
  const cat = inferCategory(lk)
  if (cat && essential.name.toLowerCase().includes(cat)) return true
  return false
}
