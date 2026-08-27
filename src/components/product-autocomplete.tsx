import { useEffect, useId, useRef } from 'react'
import type { ProductSuggestion } from '../lib/inputExperience'

type Props = {
  query: string
  suggestions: ProductSuggestion[]
  highlightedIndex: number
  open: boolean
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
    // Scroll the page (not an inner panel) so keyboard users can see the active option.
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [highlightedIndex, open])

  if (!open || suggestions.length === 0) return null

  return (
    <div
      ref={panelRef}
      id={listId}
      role="listbox"
      aria-label="Product suggestions"
      className="relative w-full border border-t-0 border-[#a9a9a9] bg-white"
      data-product-autocomplete-panel
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'} available
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
            className={`flex items-center gap-3 border-b border-[#eee] px-3 py-3 last:border-b-0 ${selected ? 'bg-[#f5f5f5]' : 'bg-white'}`}
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
      {onViewAll && query.trim().length >= 2 ? (
        <button
          type="button"
          role="option"
          aria-selected={false}
          className="w-full border-t border-[#eee] px-3 py-3 text-left text-[16px] leading-6 text-[#333] underline decoration-solid underline-offset-[3px] hover:bg-[#fafafa]"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onViewAll(query)}
        >
          View all results for &lsquo;{query.trim()}&rsquo;
        </button>
      ) : null}
    </div>
  )
}
