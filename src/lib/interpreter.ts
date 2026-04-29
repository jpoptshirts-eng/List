import { products } from '../data/products'
import type {
  Confidence,
  CustomerMode,
  DietaryTag,
  ParsedItem,
  Product,
} from '../types'

const ambiguousDictionary: Record<string, string[]> = {
  milk: ['dairy-milk-semi-2l', 'dairy-milk-whole-2l', 'dairy-oat-milk-1l'],
  bread: ['bakery-white-sliced', 'bakery-seeded-loaf'],
  toms: ['produce-tomatoes-salad', 'produce-cherry-tomatoes'],
  tomatoes: ['produce-tomatoes-salad', 'produce-cherry-tomatoes'],
  pasta: ['cupboard-spaghetti', 'cupboard-penne'],
  cheese: ['cupboard-cheddar'],
  cereal: ['cupboard-cereal-cornflakes'],
  apples: ['produce-apples-gala'],
  wine: ['wine-sauvignon'],
  'bin bags': ['house-bin-bags-50'],
  potatoes: ['produce-potatoes-marispiper'],
}

const mealTemplates: Record<
  string,
  { productId: string; baseQty: number; vegetarianAlt?: string }[]
> = {
  'spaghetti bolognese': [
    { productId: 'cupboard-spaghetti', baseQty: 1 },
    { productId: 'produce-tomatoes-salad', baseQty: 2 },
    { productId: 'produce-onion-default', baseQty: 1 },
  ],
}

const onionFallback: Product = {
  id: 'produce-onion-default',
  name: 'Brown Onions',
  category: 'Fresh Produce',
  subcategory: 'Vegetables',
  size: '3 Pack',
  price: 1.2,
  dietaryTags: ['vegan', 'gluten-free', 'dairy-free'],
  popularity: 85,
  imagePlaceholder: '🧅',
}

const fullCatalog = [...products, onionFallback]

const byId = new Map(fullCatalog.map((product) => [product.id, product]))

const trendingDefaults: Record<string, string> = {
  milk: 'dairy-milk-semi-2l',
  bread: 'bakery-white-sliced',
  pasta: 'cupboard-spaghetti',
  apples: 'produce-apples-gala',
  'bin bags': 'house-bin-bags-50',
}

const returningDefaults: Record<string, string> = {
  milk: 'dairy-oat-milk-1l',
  bread: 'bakery-seeded-loaf',
  pasta: 'cupboard-penne',
  apples: 'produce-apples-gala',
  'bin bags': 'house-bin-bags-50',
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ')
}

function parseInputLines(input: string): string[] {
  return input
    .split(/\n|,/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
}

function inferConfidence(candidateCount: number): Confidence {
  if (candidateCount <= 1) return 'high'
  if (candidateCount <= 3) return 'medium'
  return 'low'
}

function applyDietaryFilter(list: Product[], preferences: DietaryTag[]): Product[] {
  if (!preferences.length) return list
  return list.filter((product) =>
    preferences.every((tag) => product.dietaryTags.includes(tag)),
  )
}

export function interpretShoppingIntent(params: {
  input: string
  mealInput?: string
  customerMode: CustomerMode
  dietaryPreferences: DietaryTag[]
}): ParsedItem[] {
  const { input, mealInput, customerMode, dietaryPreferences } = params
  const lines = parseInputLines(input)
  const generated: ParsedItem[] = []
  const seen = new Set<string>()

  // This step turns rough language into likely products and deduplicates repeated terms.
  for (const rawLine of lines) {
    const term = normalizeTerm(rawLine)
    if (seen.has(term)) continue
    seen.add(term)

    const ids = ambiguousDictionary[term] ?? []
    let candidates = ids.map((id) => byId.get(id)).filter(Boolean) as Product[]

    if (!candidates.length) {
      candidates = fullCatalog.filter((product) => {
        const haystack = `${product.name} ${product.subcategory}`.toLowerCase()
        return haystack.includes(term)
      })
    }

    candidates = applyDietaryFilter(candidates, dietaryPreferences)
    const confidence = inferConfidence(candidates.length)
    const defaultMap = customerMode === 'returning' ? returningDefaults : trendingDefaults
    const preferredId = defaultMap[term]

    const chosen =
      candidates.find((product) => product.id === preferredId) ??
      [...candidates].sort((a, b) => b.popularity - a.popularity)[0] ??
      null

    generated.push({
      sourceTerm: rawLine.trim(),
      chosen,
      confidence,
      quantity: term === 'milk' ? (customerMode === 'returning' ? 2 : 1) : 1,
      candidates: candidates.slice(0, 3).map((product) => ({
        product,
        reason: product.popularity > 85 ? 'Popular with shoppers' : 'Likely match',
      })),
      requiresReview: confidence !== 'high',
      group: chosen?.category ?? 'Cupboard',
      whySuggested:
        customerMode === 'returning'
          ? 'Based on your previous shopping habits and popular alternatives.'
          : 'Based on bestsellers and typical shopping patterns.',
    })
  }

  if (mealInput?.trim()) {
    const match = normalizeTerm(mealInput).match(/spaghetti bolognese(?: for (\d+))?/)
    if (match) {
      const servings = Number(match[1] ?? 4)
      const scale = Math.max(1, Math.round(servings / 4))
      for (const ingredient of mealTemplates['spaghetti bolognese']) {
        if (generated.some((item) => item.chosen?.id === ingredient.productId)) continue
        const product = byId.get(ingredient.productId)
        if (!product) continue
        generated.push({
          sourceTerm: `${product.name} (meal suggestion)`,
          chosen: product,
          confidence: 'medium',
          quantity: ingredient.baseQty * scale,
          candidates: [{ product, reason: 'Included for selected meal plan' }],
          requiresReview: false,
          group: product.category,
          whySuggested: `Added from meal intent for ${servings} servings.`,
        })
      }
    }
  }

  return generated
}
