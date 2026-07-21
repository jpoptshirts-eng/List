import type { RecipeIngredient } from '../data/mealRecipes'
import type { WaitroseCatalogItem } from './waitroseCatalog'

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function productHay(product: WaitroseCatalogItem): string {
  return norm(`${product.name} ${product.productType ?? ''}`)
}

type IngredientRule = {
  match: (ingredientNorm: string) => boolean
  suitable: (product: WaitroseCatalogItem) => boolean
}

const READY_MEAL_HINTS = [
  'ready meal',
  'bolognese',
  'carbonara',
  'meatball',
  'bigham',
  'microwave',
]

const CANNED_HINTS = ['canned meal', 'canned vegetable', 'heinz', 'hoops', 'alphabetti']

const INGREDIENT_RULES: IngredientRule[] = [
  {
    match: (i) => i === 'spaghetti' || i.includes('spaghetti pasta'),
    suitable: (p) => {
      const hay = productHay(p)
      if (!hay.includes('spaghetti')) return false
      if (CANNED_HINTS.some((h) => hay.includes(h))) return false
      if (READY_MEAL_HINTS.some((h) => hay.includes(h))) return false
      if (hay.includes('in tomato sauce') || hay.includes('tinned')) return false
      return hay.includes('pasta') || hay.includes('fresh pasta') || hay.includes('free from')
    },
  },
  {
    match: (i) => i.includes('italian herbs') || i === 'mixed herbs',
    suitable: (p) => {
      const hay = productHay(p)
      if (!hay.includes('herb')) return false
      if (hay.includes('sausage') || hay.includes('mozzarella') || hay.includes('torinesi')) return false
      return hay.includes('mixed herb') || hay.includes('dried herb') || hay.includes('italian herb')
    },
  },
  {
    match: (i) => i.includes('parmesan') || i.includes('parmigiano'),
    suitable: (p) => {
      const hay = productHay(p)
      if (hay.includes('torinesi') || hay.includes('breadstick') || hay.includes('sauce') || hay.includes('kiev')) {
        return false
      }
      return hay.includes('parmesan') || hay.includes('parmigiano') || hay.includes('reggiano')
    },
  },
  {
    match: (i) => i.includes('beef mince') || i.includes('minced beef'),
    suitable: (p) => {
      const hay = productHay(p)
      if (hay.includes('stock') || hay.includes('cube') || hay.includes('gravy')) return false
      return hay.includes('mince') || hay.includes('minced')
    },
  },
  {
    match: (i) => i.includes('chopped tomatoes'),
    suitable: (p) => {
      const hay = productHay(p)
      if (hay.includes('puree') || hay.includes('purée') || hay.includes('passata')) return false
      return hay.includes('chopped') && hay.includes('tomato')
    },
  },
  {
    match: (i) => i.includes('tomato puree') || i.includes('tomato purée'),
    suitable: (p) => {
      const hay = productHay(p)
      return hay.includes('puree') || hay.includes('purée') || hay.includes('passata')
    },
  },
]

export function ingredientNamesNorm(ingredient: RecipeIngredient): string[] {
  return [ingredient.name, ...(ingredient.synonyms ?? [])].map(norm).filter(Boolean)
}

/** Key tokens from the canonical ingredient name (synonyms are search-only). */
export function ingredientKeyTokens(ingredient: RecipeIngredient): string[] {
  const exclude = new Set([
    'sauce',
    'oil',
    'mix',
    'paste',
    'cooking',
    'masala',
    'seasoning',
    'seasonings',
    'spice',
    'spices',
    'spicy',
    'tinned',
  ])

  const tokens = norm(ingredient.name)
    .split(' ')
    .filter((t) => t.length >= 3 && !exclude.has(t))

  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function hasSpecificIngredientRule(ingredient: RecipeIngredient): boolean {
  const names = ingredientNamesNorm(ingredient)
  return INGREDIENT_RULES.some((rule) => names.some((n) => rule.match(n)))
}

/** Whether a POPMAS product is a valid match for a recipe ingredient row. */
export function isRecipeCatalogHit(
  ingredient: RecipeIngredient,
  product: WaitroseCatalogItem,
): boolean {
  if (!isRecipeProductSuitable(ingredient, product)) return false
  if (hasSpecificIngredientRule(ingredient)) return true
  return productNameMatchesIngredientIntent(product.name, ingredientKeyTokens(ingredient))
}

export function productNameMatchesIngredientIntent(
  productName: string,
  keyTokens: string[],
): boolean {
  const hay = norm(productName)
  if (keyTokens.length === 0) return false
  if (keyTokens.length >= 2) return keyTokens.every((t) => hay.includes(t))
  return keyTokens.some((t) => hay.includes(t))
}

export function isRecipeProductSuitable(
  ingredient: RecipeIngredient,
  product: WaitroseCatalogItem,
): boolean {
  const names = ingredientNamesNorm(ingredient)
  for (const rule of INGREDIENT_RULES) {
    if (names.some((n) => rule.match(n))) {
      return rule.suitable(product)
    }
  }
  return true
}

const SWAP_SEARCH_QUERY: Record<string, string> = {
  spaghetti: 'spaghetti pasta',
  'italian herbs': 'mixed herbs',
  parmesan: 'parmigiano reggiano',
}

/** Best POPMAS search query for swap alternatives from a recipe ingredient intent. */
export function swapSearchQuery(ingredientIntent: string): string {
  const key = norm(ingredientIntent)
  return SWAP_SEARCH_QUERY[key] ?? ingredientIntent
}

/** Infer recipe ingredient intent from a wrongly matched product name (legacy rows). */
export function inferIngredientIntentFromProductName(productName: string): string | null {
  const hay = norm(productName)
  if (/\bmilk\b/.test(hay)) return 'milk'
  if (/\beggs?\b/.test(hay)) return 'egg'
  if (/\bspaghetti\b/.test(hay)) return 'spaghetti'
  if (/\bparmesan\b|\bparmigiano\b|\breggiano\b/.test(hay)) return 'parmesan'
  if (/\bmixed herbs\b|\bitalian herbs\b/.test(hay)) return 'italian herbs'
  if (/\bmince\b|\bminced beef\b/.test(hay)) return 'beef mince'
  if (/\bchopped tomato/.test(hay)) return 'chopped tomatoes'
  if (/\btomato puree\b|\btomato purée\b/.test(hay)) return 'tomato puree'
  return null
}

export function resolveSwapIngredientIntent(
  ingredientIntent: string | undefined,
  intentQuery: string | undefined,
  productName: string,
): string {
  if (ingredientIntent?.trim()) return ingredientIntent.trim()
  const inferred = inferIngredientIntentFromProductName(productName)
  if (inferred) return inferred
  if (intentQuery?.trim() && norm(intentQuery) !== norm(productName)) return intentQuery.trim()
  return intentQuery?.trim() ?? productName
}

/** Keep swap alternatives in the same ingredient category (e.g. dry spaghetti, not ready meals). */
export function filterSwapAlternatives(
  ingredientIntent: string,
  products: WaitroseCatalogItem[],
): WaitroseCatalogItem[] {
  const ingredient: RecipeIngredient = { name: ingredientIntent, required: true }
  return products.filter((product) => isRecipeCatalogHit(ingredient, product))
}
