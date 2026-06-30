import { ALL_MOCK_SUGGESTIONS } from '../data/productSuggestions'
import type { ProductSuggestion } from './inputExperience'
import { topCatalogMatches } from './catalogMatch'
import { catalogProductImage, type WaitroseCatalogItem } from './waitroseCatalog'

const SOURCE_RANK: Record<ProductSuggestion['source'], number> = {
  favourite: 0,
  'previous-purchase': 1,
  catalogue: 2,
}

const ENRICHMENT_SKIP_TOKENS = new Set([
  'duchy',
  'organic',
  'essential',
  'waitrose',
  'no1',
  'wr',
  'the',
  'waitrose',
])

const CATEGORY_TERMS = [
  'milk',
  'bread',
  'butter',
  'tea',
  'coffee',
  'egg',
  'juice',
  'cereal',
  'cheese',
  'yogurt',
  'yoghurt',
]

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function scoreMockSuggestion(suggestion: ProductSuggestion, query: string): number {
  const tokens = tokenize(query)
  if (tokens.length === 0) return 0
  const hay = `${suggestion.title} ${suggestion.size}`.toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (hay.includes(t)) score += t.length >= 4 ? 12 : 8
  }
  if (hay.startsWith(query.toLowerCase())) score += 20
  score -= SOURCE_RANK[suggestion.source] * 2
  return score
}

function personalizationBoost(mock: ProductSuggestion, hit: WaitroseCatalogItem): number {
  const mockHay = `${mock.title} ${mock.size}`.toLowerCase()
  const hitHay = hit.name.toLowerCase()
  let boost = 0
  if (mock.source === 'favourite') boost += 12
  if (mock.source === 'previous-purchase') boost += 8
  for (const token of mockHay.split(/\s+/).filter((t) => t.length >= 4 && !ENRICHMENT_SKIP_TOKENS.has(t))) {
    if (hitHay.includes(token)) boost += 5
  }
  return boost
}

function catalogToSuggestion(hit: WaitroseCatalogItem): ProductSuggestion {
  const sizeMatch = hit.name.match(/\([^)]+\)\s*$/)
  const size = sizeMatch ? sizeMatch[0].replace(/[()]/g, '') : hit.unitPrice || ''
  return {
    id: `catalog-${hit.id}`,
    title: hit.name.replace(/\s*\([^)]+\)\s*$/, '').trim() || hit.name,
    size,
    image: catalogProductImage(hit.imageUrl),
    price: hit.price,
    unitPrice: hit.unitPrice,
    source: 'catalogue',
  }
}

function enrichmentCompatible(
  suggestion: ProductSuggestion,
  hit: WaitroseCatalogItem,
  query: string,
): boolean {
  const hitHay = hit.name.toLowerCase()
  const q = query.toLowerCase().trim()

  for (const term of CATEGORY_TERMS) {
    if (q.includes(term) && !hitHay.includes(term)) return false
  }

  const mockTokens = `${suggestion.title} ${suggestion.size}`
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !ENRICHMENT_SKIP_TOKENS.has(t))

  if (mockTokens.length === 0) return true
  return mockTokens.some((t) => hitHay.includes(t))
}

/** Narrow POPMAS before full scoring so autocomplete stays responsive on each keystroke. */
function narrowCatalogForQuery(query: string, products: WaitroseCatalogItem[]): WaitroseCatalogItem[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  let filtered = products
  for (const token of tokens) {
    filtered = filtered.filter((p) => {
      const words = p.name.toLowerCase().split(/\s+/)
      if (token.length === 1) {
        return words.some((w) => w.startsWith(token))
      }
      return p.name.toLowerCase().includes(token)
    })
  }

  if (filtered.length > 500) return filtered.slice(0, 500)
  return filtered
}

/** Enrich a mock suggestion with live POPMAS name, price, and image when available. */
export function enrichSuggestionFromCatalog(
  suggestion: ProductSuggestion,
  catalogProducts: WaitroseCatalogItem[],
  query = '',
): ProductSuggestion {
  if (catalogProducts.length === 0) return suggestion

  if (suggestion.id.startsWith('catalog-')) {
    const catalogKey = suggestion.id.slice('catalog-'.length)
    const hit = catalogProducts.find((p) => p.id === catalogKey)
    return hit ? catalogToSuggestion(hit) : suggestion
  }

  const q = query.trim() || `${suggestion.title} ${suggestion.size}`
  const pool = narrowCatalogForQuery(q, catalogProducts)
  const hits = topCatalogMatches(q, pool.length > 0 ? pool : catalogProducts.slice(0, 500), 6, undefined)
  const compatible = hits.find((hit) => enrichmentCompatible(suggestion, hit, q))
  if (!compatible) return suggestion

  const enriched = catalogToSuggestion(compatible)
  return {
    ...enriched,
    id: suggestion.id,
    source: suggestion.source,
  }
}

export function searchProductSuggestions(
  query: string,
  catalogProducts: WaitroseCatalogItem[] = [],
  limit = 6,
): ProductSuggestion[] {
  const q = query.trim()
  if (q.length < 1) return []

  const personalizationMocks = ALL_MOCK_SUGGESTIONS.map((s) => ({
    suggestion: s,
    score: scoreMockSuggestion(s, q),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.suggestion)

  if (catalogProducts.length > 0) {
    const pool = narrowCatalogForQuery(q, catalogProducts)
    const hits = topCatalogMatches(q, pool.length > 0 ? pool : catalogProducts.slice(0, 500), limit + 6, q)

    const scored = hits.map((hit, index) => {
      const suggestion = catalogToSuggestion(hit)
      let score = (hits.length - index) * 12 + scoreMockSuggestion(suggestion, q)
      for (const mock of personalizationMocks) {
        score += personalizationBoost(mock, hit)
      }
      return { suggestion, score }
    })

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.suggestion)
  }

  return personalizationMocks
    .map((s) => ({ suggestion: s, score: scoreMockSuggestion(s, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.suggestion)
}

export function searchAmbiguousOptions(term: string, catalogProducts: WaitroseCatalogItem[] = []): ProductSuggestion[] {
  return searchProductSuggestions(term, catalogProducts, 3)
}
