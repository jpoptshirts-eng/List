import type { RecipeIngredient } from '../data/mealRecipes'
import {
  aliasCanonicalIntent,
  inferCanonicalIntentFromProduct,
  normaliseCustomerInput,
} from './customerIntent'
import type { WaitroseCatalogItem } from './waitroseCatalog'

function norm(value: string): string {
  return normaliseCustomerInput(value)
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
  {
    match: (i) => i === 'orange juice' || i.includes('orange juice'),
    suitable: (p) => {
      const hay = productHay(p)
      if (!hay.includes('orange') || !hay.includes('juice')) return false
      if (hay.includes('apple') || hay.includes('squash') || hay.includes('cordial')) return false
      if (hay.includes('cheesecake') || hay.includes('dessert') || hay.includes('yogurt') || hay.includes('yoghurt')) {
        return false
      }
      return true
    },
  },
  {
    match: (i) => i === 'semi-skimmed milk' || i.includes('semi skimmed milk'),
    suitable: (p) => {
      const hay = productHay(p)
      if (!hay.includes('milk')) return false
      if (hay.includes('oat') || hay.includes('almond') || hay.includes('coconut') || hay.includes('conditioner')) {
        return false
      }
      return hay.includes('semi') && hay.includes('skimmed')
    },
  },
  {
    match: (i) => i === 'wholemeal bread' || i.includes('wholemeal bread'),
    suitable: (p) => {
      const hay = productHay(p)
      if (hay.includes('flour') || hay.includes('crumb')) return false
      return hay.includes('wholemeal') && (hay.includes('bread') || hay.includes('loaf'))
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
  'orange juice': 'orange juice',
  'semi-skimmed milk': 'semi skimmed milk',
  'wholemeal bread': 'wholemeal bread',
  tomatoes: 'tomatoes',
  'spaghetti bolognese': 'spaghetti bolognese',
}

/** Best POPMAS search query for swap alternatives from a recipe ingredient intent. */
export function swapSearchQuery(ingredientIntent: string): string {
  const key = norm(ingredientIntent)
  const aliased = aliasCanonicalIntent(key)
  const resolved = aliased ?? key
  return SWAP_SEARCH_QUERY[resolved] ?? SWAP_SEARCH_QUERY[key] ?? resolved
}

/** Infer recipe ingredient intent from a wrongly matched product name (legacy rows). */
export function inferIngredientIntentFromProductName(productName: string): string | null {
  return inferCanonicalIntentFromProduct({ name: productName })
}

export function resolveSwapIngredientIntent(
  ingredientIntent: string | undefined,
  intentQuery: string | undefined,
  productName: string,
): string {
  if (ingredientIntent?.trim()) {
    const normalised = norm(ingredientIntent)
    return aliasCanonicalIntent(normalised) ?? ingredientIntent.trim()
  }
  const inferred = inferIngredientIntentFromProductName(productName)
  if (inferred) return inferred
  if (intentQuery?.trim()) {
    const normalised = norm(intentQuery)
    const aliased = aliasCanonicalIntent(normalised)
    if (aliased) return aliased
    if (normalised !== norm(productName)) return intentQuery.trim()
  }
  return intentQuery?.trim() ?? productName
}

/** Keep swap alternatives in the same ingredient category (e.g. dry spaghetti, not ready meals). */
export function filterSwapAlternatives(
  ingredientIntent: string,
  products: WaitroseCatalogItem[],
): WaitroseCatalogItem[] {
  const resolved = resolveSwapIngredientIntent(ingredientIntent, ingredientIntent, ingredientIntent)
  const ingredient: RecipeIngredient = { name: resolved, required: true }
  return products.filter((product) => isRecipeCatalogHit(ingredient, product))
}
