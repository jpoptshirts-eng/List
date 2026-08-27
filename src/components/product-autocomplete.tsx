import { useEffect, useId, useRef } from 'react'
import type { ProductSuggestion } from '../lib/inputExperience'

type Props = {
  query: string
  suggestions: ProductSuggestion[]
  highlightedIndex: number
  open: boolean
  /** When true, the View All control is hidden (results already expanded). */
  viewAllExpanded?: boolean
  /** Mobile: dynamic max height in px from visualViewport. Desktop uses CSS fallback. */
  maxHeightPx?: number | null
  onHighlight: (index: number) => void
  onSelect: (suggestion: ProductSuggestion) => void
  onViewAll?: (query: string) => void
  listId?: string
}

function SuggestionThumb({ image }: { image: string }) {
  const isUrl = /^https?:\/\//i.test(image)
  return (
    <div className="relative size-10 shrink-0 overflow-hidden bg-[#fafafa]">
      {isUrl ? (
        <img src={image} alt="" className="size-full object-cover" loading="lazy" onError={(e) => {
          ;(e.target as HTMLImageElement).style.display = 'none'
        }} />
      ) : (
        <span className="flex size-full items-center justify-center text-[20px] leading-none" aria-hidden>
          {image || '🛒'}
        </span>
      )}
    </div>
  )
}

export function ProductAutocomplete({
  query,
  suggestions,
  highlightedIndex,
  open,
  viewAllExpanded = false,
  maxHeightPx = null,
  onHighlight,
  onSelect,
  onViewAll,
  listId: listIdProp,
}: Props) {
  const generatedListId = useId()
  const listId = listIdProp ?? generatedListId
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open || highlightedIndex < 0) return
    const el = panelRef.current?.querySelector(`[data-suggestion-index="${highlightedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, open])

  if (!open || suggestions.length === 0) return null

  const showViewAll =
    Boolean(onViewAll) && !viewAllExpanded && query.trim().length >= 2

  return (
    <div
      ref={panelRef}
      id={listId}
      role="listbox"
      aria-label="Product suggestions"
      data-product-autocomplete-panel
      className="absolute left-0 right-0 top-full z-30 overflow-y-auto overscroll-contain border border-t-0 border-[#a9a9a9] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)] max-md:touch-pan-y md:max-h-[min(320px,50vh)]"
      style={
        maxHeightPx != null
          ? { maxHeight: `${maxHeightPx}px`, WebkitOverflowScrolling: 'touch' }
          : { WebkitOverflowScrolling: 'touch' }
      }
      onTouchMove={(e) => {
        // Keep vertical scrolling inside the panel; stop the page from dragging.
        e.stopPropagation()
      }}
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'} available
        {viewAllExpanded ? ', showing all results' : ''}
      </p>
      {suggestions.map((suggestion, index) => {
        const selected = index === highlightedIndex
        return (
          <div
            key={suggestion.id}
            data-suggestion-index={index}
            id={`${listId}-option-${index}`}
            role="option"
            aria-selected={selected}
            className={`flex items-center gap-3 border-b border-[#eee] px-3 py-3 ${selected ? 'bg-[#f5f5f5]' : 'bg-white'}`}
            onMouseEnter={() => onHighlight(index)}
          >
            <SuggestionThumb image={suggestion.image} />
            <div className="min-w-0 flex-1">
              <p className="text-[16px] leading-6 text-[#333]">
                {suggestion.title}
                {suggestion.size ? ` ${suggestion.size}` : ''}
              </p>
              {suggestion.unitPrice ? (
                <p className="text-[14px] leading-5 text-[#53565A]">{suggestion.unitPrice}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="min-h-[44px] shrink-0 self-center p-0 text-[16px] leading-6 text-[#333] underline decoration-solid underline-offset-[3px]"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(suggestion)}
            >
              Add to list
            </button>
          </div>
        )
      })}
      {showViewAll ? (
        <button
          type="button"
          role="option"
          aria-selected={false}
          className="w-full border-t border-[#eee] px-3 py-3 text-left text-[16px] leading-6 text-[#333] underline decoration-solid underline-offset-[3px] hover:bg-[#fafafa]"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onViewAll?.(query)}
        >
          View all results for &lsquo;{query.trim()}&rsquo;
        </button>
      ) : null}
    </div>
  )
}
