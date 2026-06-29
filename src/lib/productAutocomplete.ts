import { ALL_MOCK_SUGGESTIONS } from '../data/productSuggestions'
import type { ProductSuggestion } from './inputExperience'
import { topCatalogMatches } from './catalogMatch'
import type { WaitroseCatalogItem } from './waitroseCatalog'

const SOURCE_RANK: Record<ProductSuggestion['source'], number> = {
  favourite: 0,
  'previous-purchase': 1,
  catalogue: 2,
}

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

function catalogToSuggestion(hit: WaitroseCatalogItem): ProductSuggestion {
  const sizeMatch = hit.name.match(/\([^)]+\)\s*$/)
  const size = sizeMatch ? sizeMatch[0].replace(/[()]/g, '') : hit.unitPrice || ''
  return {
    id: `catalog-${hit.id}`,
    title: hit.name.replace(/\s*\([^)]+\)\s*$/, '').trim() || hit.name,
    size,
    image: hit.imageUrl || '🛒',
    price: hit.price,
    unitPrice: hit.unitPrice,
    source: 'catalogue',
  }
}

export function searchProductSuggestions(
  query: string,
  catalogProducts: WaitroseCatalogItem[] = [],
  limit = 6,
): ProductSuggestion[] {
  const q = query.trim()
  if (q.length < 2) return []

  const scoredMocks = ALL_MOCK_SUGGESTIONS.map((s) => ({
    suggestion: s,
    score: scoreMockSuggestion(s, q),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  const catalogHits =
    catalogProducts.length > 0
      ? topCatalogMatches(q, catalogProducts, limit + 4, q).map((hit) => ({
          suggestion: catalogToSuggestion(hit),
          score: scoreMockSuggestion(catalogToSuggestion(hit), q) + 4,
        }))
      : []

  const merged = new Map<string, { suggestion: ProductSuggestion; score: number }>()
  for (const row of [...scoredMocks, ...catalogHits]) {
    const key = row.suggestion.title.toLowerCase()
    const existing = merged.get(key)
    if (!existing || row.score > existing.score) {
      merged.set(key, row)
    }
  }

  const ranked = Array.from(merged.values())
    .sort((a, b) => {
      const sourceDiff = SOURCE_RANK[a.suggestion.source] - SOURCE_RANK[b.suggestion.source]
      if (sourceDiff !== 0) return sourceDiff
      return b.score - a.score
    })
    .map((x) => x.suggestion)

  return ranked.slice(0, limit)
}

export function searchAmbiguousOptions(term: string, catalogProducts: WaitroseCatalogItem[] = []): ProductSuggestion[] {
  return searchProductSuggestions(term, catalogProducts, 3)
}
