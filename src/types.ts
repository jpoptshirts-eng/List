export type DietaryTag = 'vegetarian' | 'vegan' | 'gluten-free' | 'dairy-free'

export type CustomerMode = 'new' | 'returning'

export type Confidence = 'high' | 'medium' | 'low'

export type Category =
  | 'Essentials'
  | 'Fresh Produce'
  | 'Cupboard'
  | 'Household'
  | 'Frozen'
  | 'Snacks'

export interface Product {
  id: string
  name: string
  category: Category
  subcategory: string
  size: string
  price: number
  dietaryTags: DietaryTag[]
  popularity: number
  brand?: string
  imagePlaceholder: string
  unavailable?: boolean
}

export interface InterpretationCandidate {
  product: Product
  reason: string
}

export interface ParsedItem {
  sourceTerm: string
  chosen: Product | null
  confidence: Confidence
  quantity: number
  candidates: InterpretationCandidate[]
  requiresReview: boolean
  group: Category
  whySuggested: string
}
