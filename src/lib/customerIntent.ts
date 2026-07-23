/**
 * Shared customer-input normalisation for list build, search, and Swap.
 * Prefer selected product category metadata when available; aliases are a fallback.
 */

export type ProductIntentSource = {
  name: string
  productType?: string
  grouping?: string
  popmasType?: string
}

export type ResolvedItemIntent = {
  originalInput: string
  normalisedInput: string
  canonicalIntent: string
  selectedProductId?: string
  selectedProductCategoryId?: string
  selectedProductSubcategoryId?: string
}

/** Strip punctuation/case/spacing so "O.J.", "oj", "OJ" collapse to the same key. */
export function normaliseCustomerInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.'’‘]/g, '')
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function slugifyIntent(value: string): string {
  return normaliseCustomerInput(value).replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Informal abbreviations / synonyms → canonical grocery intent.
 * Only used when structured product category data is missing or weaker.
 */
const INPUT_ALIASES: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /^(oj|o\s*j)$/, canonical: 'orange juice' },
  { pattern: /^orange\s*juice$/, canonical: 'orange juice' },
  { pattern: /^(semi[\s-]*skimmed)(\s*milk)?$/, canonical: 'semi-skimmed milk' },
  { pattern: /^(wholemeal|whole\s*meal)(\s*(loaf|bread))?$/, canonical: 'wholemeal bread' },
  { pattern: /^(spag(\s*bol)?|spagbol|spaghetti\s*bolognese)$/, canonical: 'spaghetti bolognese' },
  { pattern: /^(toms|tomatoes?|tomato)$/, canonical: 'tomatoes' },
  { pattern: /^(eggs?)$/, canonical: 'eggs' },
  { pattern: /^(org(anic)?\s*milk)$/, canonical: 'organic milk' },
]

/** Expand a normalised input string to its canonical intent when an alias matches. */
export function aliasCanonicalIntent(normalisedInput: string): string | null {
  const key = normalisedInput.trim()
  if (!key) return null
  for (const rule of INPUT_ALIASES) {
    if (rule.pattern.test(key)) return rule.canonical
  }
  return null
}

/**
 * Infer a stable grocery intent from a selected product's title / type / grouping.
 * Strongest source of truth once a product has been chosen.
 */
export function inferCanonicalIntentFromProduct(product: ProductIntentSource): string | null {
  const hay = normaliseCustomerInput(
    [product.name, product.productType, product.grouping, product.popmasType].filter(Boolean).join(' '),
  )
  if (!hay) return null

  if (/\borange\b/.test(hay) && /\bjuice\b/.test(hay)) return 'orange juice'
  if (/\bapple\b/.test(hay) && /\bjuice\b/.test(hay)) return 'apple juice'
  if (/\bjuice\b/.test(hay) && !/\bsmoothie\b/.test(hay)) return 'fruit juice'
  if (/\bsemi\b/.test(hay) && /\bskimmed\b/.test(hay) && /\bmilk\b/.test(hay)) return 'semi-skimmed milk'
  if (/\bwhole\b/.test(hay) && /\bmilk\b/.test(hay) && !/\bmeal\b/.test(hay)) return 'whole milk'
  if (/\borganic\b/.test(hay) && /\bmilk\b/.test(hay)) return 'organic milk'
  if (/\bmilk\b/.test(hay) && !/\bchocolate\b|\bcoconut\b|\boat\b|\balmond\b|\bconditioner\b/.test(hay)) {
    return 'milk'
  }
  if (/\bwholemeal\b/.test(hay) && /\b(bread|loaf)\b/.test(hay)) return 'wholemeal bread'
  if (/\bbread\b|\bloaf\b/.test(hay) && !/\bflour\b|\bcrumb\b/.test(hay)) return 'bread'
  if (/\beggs?\b/.test(hay) && !/\bnoodle\b|\bpasta\b|\bscotch\b/.test(hay)) return 'eggs'
  if (/\btomatoes?\b/.test(hay) && !/\bpuree\b|\bpurée\b|\bpassata\b|\bsauce\b/.test(hay)) return 'tomatoes'
  if (/\bspaghetti\b/.test(hay) && !/\bbolognese\b|\bready meal\b/.test(hay)) return 'spaghetti'
  if (/\bbolognese\b/.test(hay)) return 'spaghetti bolognese'
  if (/\bparmesan\b|\bparmigiano\b|\breggiano\b/.test(hay)) return 'parmesan'
  if (/\bmixed herbs\b|\bitalian herbs\b/.test(hay)) return 'italian herbs'
  if (/\b(mince|minced beef)\b/.test(hay)) return 'beef mince'
  if (/\bchopped\b/.test(hay) && /\btomato/.test(hay)) return 'chopped tomatoes'
  if (/\btomato puree\b|\btomato purée\b/.test(hay)) return 'tomato puree'

  const type = product.productType?.trim()
  if (type) return normaliseCustomerInput(type)
  return null
}

export function categoryIdsFromProduct(product: ProductIntentSource): {
  selectedProductCategoryId?: string
  selectedProductSubcategoryId?: string
} {
  const fromIntent = inferCanonicalIntentFromProduct(product)
  const categoryId =
    (fromIntent ? slugifyIntent(fromIntent) : undefined) ||
    (product.productType ? slugifyIntent(product.productType) : undefined)
  const subcategoryId = product.grouping ? slugifyIntent(product.grouping) : undefined
  return {
    selectedProductCategoryId: categoryId || undefined,
    selectedProductSubcategoryId: subcategoryId || undefined,
  }
}

/**
 * Resolve the canonical shopping intent for a line after a product is selected.
 * Product metadata wins over customer wording.
 */
export function resolveItemIntent(args: {
  originalInput: string
  product?: ProductIntentSource | null
  selectedProductId?: string
  recipeIngredientIntent?: string
}): ResolvedItemIntent {
  const originalInput = args.originalInput.trim()
  const normalisedInput = normaliseCustomerInput(originalInput)
  const fromAlias = aliasCanonicalIntent(normalisedInput)
  const fromProduct = args.product ? inferCanonicalIntentFromProduct(args.product) : null
  const fromRecipe = args.recipeIngredientIntent?.trim() || null

  const canonicalIntent =
    fromRecipe ||
    fromProduct ||
    fromAlias ||
    normalisedInput ||
    originalInput

  const cats = args.product ? categoryIdsFromProduct(args.product) : {}

  return {
    originalInput,
    normalisedInput: fromAlias || normalisedInput || originalInput.toLowerCase(),
    canonicalIntent,
    selectedProductId: args.selectedProductId,
    selectedProductCategoryId: cats.selectedProductCategoryId,
    selectedProductSubcategoryId: cats.selectedProductSubcategoryId,
  }
}

export type SwapIntentFields = {
  selectedProductSubcategoryId?: string
  selectedProductCategoryId?: string
  canonicalIntent?: string
  ingredientIntent?: string
  normalisedInput?: string
  originalInput?: string
  intentQuery?: string
  productName?: string
  productType?: string
  grouping?: string
}

/**
 * Priority for Swap retrieval:
 * subcategory → category → canonicalIntent → normalisedInput → originalInput
 */
export function pickSwapRetrievalIntent(fields: SwapIntentFields): string {
  const fromProduct =
    fields.productName
      ? inferCanonicalIntentFromProduct({
          name: fields.productName,
          productType: fields.productType,
          grouping: fields.grouping,
        })
      : null

  const candidates = [
    fields.selectedProductSubcategoryId?.replace(/-/g, ' '),
    fields.selectedProductCategoryId?.replace(/-/g, ' '),
    fields.canonicalIntent,
    fields.ingredientIntent,
    fromProduct,
    fields.normalisedInput,
    fields.intentQuery,
    fields.originalInput,
  ]

  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (!trimmed) continue
    const normalised = normaliseCustomerInput(trimmed)
    const aliased = aliasCanonicalIntent(normalised)
    if (aliased) return aliased
    // Prefer human-readable intents over slug-like leftovers
    if (normalised.length >= 2) return aliased || normalised
  }

  return fields.productName?.trim() || 'product'
}
