import type { WaitroseCatalogItem } from './waitroseCatalog'

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const GROCERY_CANONICAL_TERMS = [
  'milk',
  'bread',
  'eggs',
  'juice',
  'pasta',
  'tomatoes',
  'onions',
  'cereal',
  'weetabix',
  'spaghetti',
  'bolognese',
  'curry',
]

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i += 1) dp[i][0] = i
  for (let j = 0; j <= n; j += 1) dp[0][j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[m][n]
}

function correctCommonTypos(raw: string): string {
  const tokens = normalize(raw).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return raw
  const corrected = tokens.map((token) => {
    if (token.length < 4) return token
    let best = token
    let bestDist = Number.POSITIVE_INFINITY
    for (const candidate of GROCERY_CANONICAL_TERMS) {
      const d = levenshtein(token, candidate)
      if (d < bestDist) {
        bestDist = d
        best = candidate
      }
    }
    return bestDist <= 1 ? best : token
  })
  return corrected.join(' ')
}

const QUERY_ALIASES: Record<string, string[]> = {
  oj: ['orange juice'],
  juice: ['orange juice', 'apple juice', 'fruit juice'],
  'organic milk': ['organic milk', 'semi skimmed milk', 'whole milk', 'fresh milk', 'milk'],
  milk: ['semi skimmed milk', 'whole milk', 'fresh milk', 'milk'],
  'french bread': ['french bread', 'baguette', 'bread loaf', 'sliced bread'],
  bread: ['bread', 'loaf', 'sliced', 'wholemeal'],
  pasta: ['pasta', 'spaghetti', 'penne', 'fusilli', 'tagliatelle'],
  'cereal weetabix': ['weetabix', 'breakfast cereal', 'cereal'],
  'spag bol': ['spaghetti bolognese'],
  spagbol: ['spaghetti bolognese'],
  'green thai curry': ['green thai curry', 'thai green curry', 'thai curry'],
}

function expandQuery(raw: string): string[] {
  const corrected = correctCommonTypos(raw)
  const t = corrected.trim().toLowerCase()
  const expanded = QUERY_ALIASES[t]
  if (!expanded) return [corrected, raw].filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i)
  return [...expanded, corrected, raw].filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i)
}

function tokenSet(s: string): Set<string> {
  // Exclude size/weight tokens like "500g", otherwise unrelated products can share them.
  return new Set(
    normalize(s)
      .split(/\s+/)
      .filter((w) => w.length > 1 && !/\d/.test(w)),
  )
}

const INTENT_RULES: Record<
  string,
  {
    includeAny: string[]
    excludeAny: string[]
    preferAny: string[]
    bonus: number
    penalty: number
    preferBonus: number
  }
> = {
  milk: {
    includeAny: ['milk', 'semi', 'skimmed', 'whole', 'uht', 'oat', 'soya', 'soy', 'almond', 'coconut', 'drink'],
    excludeAny: ['conditioner', 'shampoo', 'body', 'lotion', 'soap', 'cream', 'cleaner'],
    preferAny: ['semi skimmed', 'semi-skimmed', 'skimmed', 'whole milk', 'essential', '2l', '1l', 'fresh milk'],
    bonus: 0.45,
    penalty: 0.7,
    preferBonus: 0.5,
  },
  bread: {
    includeAny: ['bread', 'loaf', 'sliced', 'wholemeal', 'white', 'brown', 'toastie', 'farmhouse'],
    excludeAny: ['bagel', 'bagels', 'wrap', 'roll', 'bap', 'bun', 'pitta', 'naan'],
    preferAny: ['sliced', 'loaf', 'wholemeal', 'white bread', 'soft white', 'medium sliced', 'thick sliced', 'essential'],
    bonus: 0.4,
    penalty: 0.45,
    preferBonus: 0.45,
  },
  juice: {
    includeAny: ['juice', 'smoothie', 'apple', 'orange', 'fruit'],
    excludeAny: ['cheesecake', 'dessert', 'cake', 'yogurt', 'yoghurt'],
    preferAny: ['orange juice', 'apple juice', 'not from concentrate', 'chilled', 'essential'],
    bonus: 0.35,
    penalty: 0.5,
    preferBonus: 0.4,
  },
  eggs: {
    includeAny: ['egg', 'eggs'],
    excludeAny: [
      'noodle', 'pasta', 'sauce', 'mini eggs', 'chocolate', 'easter', 'creme egg',
      // Specialty / prepared egg products — not what a user means by plain "eggs"
      'scotch', 'picnic', 'cumberland', 'pork', 'party', 'sausage', 'quail',
    ],
    preferAny: ['free range eggs', 'large eggs', 'medium eggs', '6 eggs', '12 eggs', 'essential', 'organic'],
    bonus: 0.4,
    penalty: 0.5,
    preferBonus: 0.5,
  },
  pasta: {
    includeAny: ['pasta', 'spaghetti', 'penne', 'fusilli', 'tagliatelle', 'linguine', 'macaroni'],
    excludeAny: ['sauce', 'bake', 'ready meal', 'meal', 'salad'],
    preferAny: ['spaghetti', 'penne', 'fusilli', 'dry pasta', 'essential'],
    bonus: 0.4,
    penalty: 0.35,
    preferBonus: 0.4,
  },
}

function intentAdjustment(query: string, productName: string): number {
  const q = normalize(query)
  const firstToken = q.split(/\s+/)[0] ?? ''
  const rule = INTENT_RULES[firstToken]
  if (!rule) return 0
  const pn = normalize(productName)

  for (const token of rule.excludeAny) {
    if (pn.includes(token)) return -rule.penalty
  }
  for (const token of rule.includeAny) {
    if (pn.includes(token)) return rule.bonus
  }
  return 0
}

function staplePreferenceAdjustment(query: string, productName: string): number {
  const q = normalize(query)
  const firstToken = q.split(/\s+/)[0] ?? ''
  const rule = INTENT_RULES[firstToken]
  if (!rule) return 0
  const pn = normalize(productName)
  for (const token of rule.preferAny) {
    if (pn.includes(token)) return rule.preferBonus
  }
  return 0
}

function querySpecificAdjustment(query: string, productName: string): number {
  const q = normalize(query)
  const pn = normalize(productName)

  // If user explicitly says Weetabix, prioritize true Weetabix items.
  if (q.includes('weetabix')) {
    if (pn.includes('weetabix')) return 1.2
    if (pn.includes('muesli') || pn.includes('granola')) return -1
    return -0.55
  }

  if (q.includes('french bread')) {
    if (
      pn.includes('bread') ||
      pn.includes('baguette') ||
      pn.includes('french stick') ||
      pn.includes('baton')
    )
      return 1
    if (pn.includes('fries') || pn.includes('chips')) return -1.2
    return -0.35
  }

  return 0
}

function scoreMatch(query: string, productName: string): number {
  const productNorm = normalize(productName)
  let best = 0

  for (const q of expandQuery(query)) {
    const qt = tokenSet(q)
    const pt = tokenSet(productName)
    if (qt.size === 0) continue

    let inter = 0
    for (const w of qt) {
      if (pt.has(w)) inter++
    }
    const union = new Set([...qt, ...pt]).size
    const jaccard = inter / Math.max(1, union)
    const qn = normalize(q)
    let bonus = 0
    if (productNorm.includes(qn) || qn.includes(productNorm)) bonus = 0.35
    if (inter >= 1 && qn.length >= 4 && productNorm.includes(qn.slice(0, 6))) bonus += 0.15

    best = Math.max(best, jaccard + bonus)
  }

  return best
}

function effectiveMinScore(query: string, baseMin: number): number {
  const queryVariants = expandQuery(query.trim())
  const tokens = queryVariants
    .flatMap((variant) => normalize(variant).split(/\s+/))
    .filter((w) => w.length > 1)
  if (tokens.length <= 1) return Math.max(baseMin, 0.2)
  return baseMin
}

/**
 * Top-N catalog matches for swap alternatives.
 * Scores every product against the query and returns the highest-scoring ones,
 * optionally excluding the product whose name matches `excludeName` exactly.
 */
export function topCatalogMatches(
  query: string,
  products: WaitroseCatalogItem[],
  limit = 4,
  excludeName?: string,
  preferredProductType?: string,
): WaitroseCatalogItem[] {
  const excludeNorm = excludeName ? normalize(excludeName) : undefined

  // If the query contains a known canonical term (e.g. "spaghetti", "onions"),
  // require candidates to include the same term; this prevents broad matches
  // like "mayonnaise" when the size (e.g. 500g) matches.
  const qNorm = normalize(query)
  const requiredTerm = GROCERY_CANONICAL_TERMS
    .filter((t) => qNorm.includes(t))
    .sort((a, b) => b.length - a.length)[0]

  const baseCandidates = products.filter((p) => !excludeNorm || normalize(p.name) !== excludeNorm)

  const matchRequiredTerm = (productName: string) => {
    if (!requiredTerm) return true
    const pn = normalize(productName)
    if (pn.includes(requiredTerm)) return true
    // Handle simple plural forms (onions vs onion).
    if (requiredTerm.endsWith('s') && pn.includes(requiredTerm.slice(0, -1))) return true
    return false
  }

  const scored = baseCandidates
    .map((p) => ({
      p,
      score:
        scoreMatch(query, p.name) +
        intentAdjustment(query, p.name) +
        staplePreferenceAdjustment(query, p.name) +
        querySpecificAdjustment(query, p.name),
    }))
    .filter(({ score }) => score > 0.05)

  const requiredScored = requiredTerm ? scored.filter(({ p }) => matchRequiredTerm(p.name)) : scored
  const finalPool = requiredScored.length > 0 ? requiredScored : scored
  const preferredTypeNorm = preferredProductType ? normalize(preferredProductType) : ''

  const typeFilteredPool =
    preferredTypeNorm.length > 0
      ? finalPool.filter(({ p }) => {
          const itemType = normalize(p.productType ?? '')
          return (
            itemType.length > 0 &&
            (itemType === preferredTypeNorm ||
              itemType.includes(preferredTypeNorm) ||
              preferredTypeNorm.includes(itemType))
          )
        })
      : finalPool

  const rankedPool = typeFilteredPool.length > 0 ? typeFilteredPool : finalPool

  return rankedPool
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p }) => p)
}

/** Best POPMAS / catalog row for a free-text line (e.g. from a handwritten list). */
export function bestCatalogMatch(
  query: string,
  products: WaitroseCatalogItem[],
  minScore = 0.22,
): WaitroseCatalogItem | null {
  let best: WaitroseCatalogItem | null = null
  let bestScore = 0
  const threshold = effectiveMinScore(query, minScore)
  const queryTokens = new Set(
    expandQuery(query)
      .flatMap((variant) => normalize(variant).split(/\s+/))
      .filter((w) => w.length > 1),
  )

  for (const p of products) {
    const s =
      scoreMatch(query, p.name) +
      intentAdjustment(query, p.name) +
      staplePreferenceAdjustment(query, p.name) +
      querySpecificAdjustment(query, p.name)
    if (s > bestScore) {
      bestScore = s
      best = p
    }
  }

  if (best && bestScore >= threshold) return best

  // Last-resort fallback for generic list words (e.g. "bread", "juice"):
  // return the first catalog item that contains any expanded query token.
  if (queryTokens.size > 0) {
    for (const p of products) {
      const productTokens = tokenSet(p.name)
      for (const token of queryTokens) {
        if (productTokens.has(token)) return p
      }
    }
  }

  return null
}
