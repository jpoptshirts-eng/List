import { isLikelyUiPlaceholderList } from './parseShopList'

export type InputMode =
  | 'idle'
  | 'single-item-search'
  | 'multi-item-entry'
  | 'processing-upload'
  | 'review-recognised-items'
  | 'building-shop'
  | 'review-draft'

export type ProductSuggestionSource = 'favourite' | 'previous-purchase' | 'catalogue'

export type ProductSuggestion = {
  id: string
  title: string
  size: string
  image: string
  price?: number
  unitPrice?: string
  source: ProductSuggestionSource
}

export type ListEntry = {
  id: string
  originalText: string
  source: 'typed' | 'pasted' | 'uploaded'
  selectedProductId?: string
  status: 'unresolved' | 'resolved' | 'needs-review'
}

const AMBIGUOUS_TERMS = new Set([
  'snacks',
  'snack',
  'bread',
  'milk',
  'cereal',
  'drinks',
  'drink',
  'fruit',
  'veg',
  'vegetables',
  'cheese',
  'yogurt',
  'yoghurt',
  'butter',
  'juice',
  'water',
  'crisps',
  'biscuits',
])

export function isAmbiguousListLine(line: string): boolean {
  const t = line.trim().toLowerCase()
  if (!t) return false
  if (AMBIGUOUS_TERMS.has(t)) return true
  const words = t.split(/\s+/).filter(Boolean)
  return words.length === 1 && words[0].length <= 10 && AMBIGUOUS_TERMS.has(words[0])
}

export function getActiveInputLine(text: string): string {
  const lines = text.split('\n')
  return (lines[lines.length - 1] ?? '').trim()
}

export function detectPastedMultiItemList(pastedText: string): boolean {
  const raw = pastedText.trim()
  if (!raw) return false

  const nonEmptyLines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  if (nonEmptyLines.length >= 2) return true

  const commaItems = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (commaItems.length >= 3) return true

  if (/^[\s]*[-•·*▪]\s+\S/m.test(raw)) return true
  if (/^[\s]*\d+[.)]\s+\S/m.test(raw)) return true

  return false
}

export function shouldShowAutocomplete(params: {
  text: string
  imageProcessing: boolean
  catalogLoading: boolean
  forceMultiItem: boolean
}): boolean {
  const { text, imageProcessing, catalogLoading, forceMultiItem } = params
  if (imageProcessing || catalogLoading || forceMultiItem) return false
  if (!text.trim() || isLikelyUiPlaceholderList(text)) return false

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const activeLine = getActiveInputLine(text)

  if (lines.length >= 3) return false
  if (lines.length === 2 && lines.every((l) => l.length >= 2)) return false

  const commaParts = activeLine.split(',').map((s) => s.trim()).filter(Boolean)
  if (commaParts.length >= 3) return false

  return activeLine.length >= 1
}

export function deriveInputMode(params: {
  text: string
  imageProcessing: boolean
  catalogLoading: boolean
  uploadReviewPending: boolean
  generated: boolean
  forceMultiItem: boolean
}): InputMode {
  if (params.catalogLoading) return 'building-shop'
  if (params.imageProcessing) return 'processing-upload'
  if (params.uploadReviewPending && params.text.trim()) return 'review-recognised-items'
  if (params.generated && !params.text.trim()) return 'review-draft'

  const text = params.text.trim()
  if (!text) return 'idle'

  if (params.forceMultiItem) return 'multi-item-entry'

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const commaItems = text.includes(',')
    ? text.split(',').map((s) => s.trim()).filter((s) => s.length >= 2)
    : []

  if (lines.length >= 3 || commaItems.length >= 3) return 'multi-item-entry'
  if (lines.length === 2 && lines.every((l) => l.length >= 2)) return 'multi-item-entry'

  if (
    shouldShowAutocomplete({
      text: params.text,
      imageProcessing: params.imageProcessing,
      catalogLoading: params.catalogLoading,
      forceMultiItem: params.forceMultiItem,
    })
  ) {
    return 'single-item-search'
  }

  if (text) return 'multi-item-entry'
  return 'idle'
}
