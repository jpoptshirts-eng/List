import { useEffect, useRef, useState } from 'react'

type RecipePodProps = {
  needText?: string
  name: string
  image: string
  price: string
  unitPrice: string
  qty: number
  selected: boolean
  onToggleSelected: () => void
  onSwap: () => void
  onQtyDelta: (d: number) => void
  /** Inside an expanded meal: only horizontal dividers, no outer card border. */
  grouped?: boolean
}

type EssentialPodProps = {
  name: string
  image: string
  price: string
  unitPrice: string
  qty: number
  selected: boolean
  onToggleSelected: () => void
  onSwap: () => void
  onQtyDelta: (d: number) => void
  onRemove: () => void
}

function IconTick({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.2 6.4 11 12.5 4.9"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Figma: [ qty ] [ − ] [ + ] — dark grey steppers, editable qty field. */
export function QuantityNumerator({
  qty,
  onDelta,
  idPrefix,
}: {
  qty: number
  onDelta: (d: number) => void
  idPrefix: string
}) {
  const [inputVal, setInputVal] = useState(String(qty))
  const editingRef = useRef(false)

  // Keep display in sync when qty changes externally (stepper buttons).
  useEffect(() => {
    if (!editingRef.current) setInputVal(String(qty))
  }, [qty])

  function commit(raw: string) {
    editingRef.current = false
    const parsed = parseInt(raw, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      const delta = parsed - qty
      if (delta !== 0) onDelta(delta)
      setInputVal(String(parsed))
    } else {
      setInputVal(String(qty))
    }
  }

  return (
    <div className="inline-flex items-stretch" style={{ gap: '8px' }}>
      <input
        id={`${idPrefix}-qty`}
        type="number"
        inputMode="numeric"
        pattern="[0-9]*"
        min="1"
        aria-label="Quantity"
        className="m-0 h-10 w-[50px] shrink-0 appearance-none border border-[#a9a9a9] bg-white p-0 text-center text-[22px] font-light leading-none text-[#333] outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={inputVal}
        onChange={(e) => {
          editingRef.current = true
          setInputVal(e.target.value)
        }}
        onFocus={(e) => {
          editingRef.current = true
          e.target.select()
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            editingRef.current = false
            setInputVal(String(qty))
            e.currentTarget.blur()
          }
        }}
      />
      <button
        type="button"
        aria-label="Decrease quantity"
        className="m-0 flex h-10 w-10 shrink-0 items-center justify-center border border-[#53565A] bg-[#53565A] p-0 text-[34px] font-light leading-none text-white"
        onClick={() => onDelta(-1)}
      >
        −
      </button>
      <button
        type="button"
        aria-label="Increase quantity"
        className="m-0 flex h-10 w-10 shrink-0 items-center justify-center border border-[#53565A] bg-[#53565A] p-0 text-[34px] font-light leading-none text-white"
        onClick={() => onDelta(1)}
      >
        +
      </button>
    </div>
  )
}

function ProductThumb({ label, className }: { label: string; className?: string }) {
  const isUrl = /^https?:\/\//i.test(label)
  const isEmoji = !isUrl && label.length <= 8 && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(label)
  const base = className ?? 'relative size-9 shrink-0 overflow-hidden bg-[#fafafa] md:size-10'
  return (
    <div className={base}>
      {isUrl ? (
        <img src={label} alt="" className="size-full object-cover" loading="lazy" />
      ) : isEmoji ? (
        <span className="flex size-full items-center justify-center text-[22px] leading-none" aria-hidden>
          {label}
        </span>
      ) : (
        <span className="flex size-full items-center justify-center text-center text-[10px] text-[#757575]">{label}</span>
      )}
    </div>
  )
}

function SwapLink({ onSwap }: { onSwap: () => void }) {
  return (
    <button
      type="button"
      className="w-fit p-0 text-left text-[16px] leading-6 text-[#53565A] underline decoration-solid underline-offset-[3px]"
      onClick={onSwap}
    >
      Swap
    </button>
  )
}

/** Recipe line item: checkbox, thumb, copy, Swap; divider; qty (− / val / +) + price. Desktop + mobile per hybrid Figma. */
export function RecipeProductPod({
  needText,
  name,
  image,
  price,
  unitPrice,
  qty,
  selected,
  onToggleSelected,
  onSwap,
  onQtyDelta,
  grouped = false,
}: RecipePodProps) {
  const idPrefix = `recipe-${name}`.replace(/\s+/g, '-').slice(0, 48)

  const checkbox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onToggleSelected}
      className={`flex size-5 shrink-0 items-center justify-center border border-[#333] p-0.5 ${selected ? 'bg-[#333]' : 'bg-white'}`}
    >
      {selected ? <IconTick /> : null}
    </button>
  )

  const textBlock = (
    <div className="min-w-0 flex-1">
      {needText ? <p className="text-[14px] leading-5 text-[#53565A]">{needText}</p> : null}
      <p className="text-[16px] leading-6 text-[#333]">{name}</p>
    </div>
  )

  const priceBlock = (
    <div className="shrink-0 text-right text-[#333] md:text-left">
      <p className="text-[16px] font-medium leading-6">{price}</p>
      <p className="font-light text-[16px] leading-6 text-[#53565A]">{unitPrice}</p>
    </div>
  )

  const dividerH = <div className="h-px w-full bg-[#ddd]" aria-hidden />

  const dividerV = <div className="hidden h-10 w-px shrink-0 bg-[#ddd] md:block" aria-hidden />

  const shell = grouped ? 'border-0 bg-white' : 'border border-[#ddd] bg-white'

  return (
    <div className={shell}>
      {/* Mobile */}
      <div className="flex flex-col gap-4 px-4 py-4 md:hidden">
        <div className="flex gap-4">
          {checkbox}
          <div className="flex min-w-0 flex-1 gap-4">
            <ProductThumb label={image} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {textBlock}
              <SwapLink onSwap={onSwap} />
            </div>
          </div>
        </div>
        {dividerH}
        <div className="flex items-center justify-between gap-4">
          <QuantityNumerator qty={qty} onDelta={onQtyDelta} idPrefix={idPrefix} />
          {priceBlock}
        </div>
      </div>

      {/* Desktop */}
      <div className="hidden min-h-[72px] items-center gap-4 px-4 py-3 md:flex">
        <div className="flex min-w-0 flex-1 items-center gap-5">
          {checkbox}
          <div className="flex min-w-0 flex-1 items-center gap-5">
            <ProductThumb label={image} />
            {textBlock}
          </div>
          <SwapLink onSwap={onSwap} />
        </div>
        {dividerV}
        <QuantityNumerator qty={qty} onDelta={onQtyDelta} idPrefix={`${idPrefix}-d`} />
        <div className="w-[120px] shrink-0">{priceBlock}</div>
      </div>
    </div>
  )
}

/** Essentials: checkbox + thumb + name + Swap; qty + price + bin. Mobile + Desktop per Figma. */
export function EssentialProductPod({ name, image, price, unitPrice, qty, selected, onToggleSelected, onSwap, onQtyDelta, onRemove }: EssentialPodProps) {
  const idPrefix = `ess-${name}`.replace(/\s+/g, '-').slice(0, 48)

  const checkbox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onToggleSelected}
      className={`flex size-5 shrink-0 items-center justify-center border border-[#333] p-0.5 ${selected ? 'bg-[#333]' : 'bg-white'}`}
    >
      {selected ? <IconTick /> : null}
    </button>
  )

  const nameBlock = (
    <div className="min-w-0 flex-1">
      <p className="text-[16px] leading-6 text-[#333]">{name}</p>
    </div>
  )

  const priceBlock = (
    <div className="shrink-0 text-[#333]">
      <p className="text-[16px] font-medium leading-6">{price}</p>
      <p className="font-light text-[16px] leading-6 text-[#53565A]">{unitPrice}</p>
    </div>
  )

  const removeBtn = (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      className="flex shrink-0 items-center justify-center p-0.5 text-[#757575]"
      onClick={onRemove}
    >
      <IconBin />
    </button>
  )

  return (
    <div className="bg-white">
      {/* Mobile Figma layout: ≤544px */}
      {/* Left column: checkbox stacked above image. Right: name+bin header / swap / price+qty row */}
      <div className="flex min-[545px]:hidden px-4">
        <div className="flex flex-1 items-start gap-4 border-b border-[#ddd] py-4">
          {/* Left: checkbox above image */}
          <div className="flex shrink-0 flex-col items-start gap-8 self-stretch">
            {checkbox}
            <ProductThumb label={image} className="relative size-12 shrink-0 overflow-hidden bg-[#fafafa]" />
          </div>
          {/* Right: content */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 items-start">
            {/* Name + bin */}
            <div className="flex w-full items-start gap-4">
              {nameBlock}
              {removeBtn}
            </div>
            <SwapLink onSwap={onSwap} />
            {/* Price + qty stepper */}
            <div className="flex w-full items-center gap-3">
              <div className="min-w-0 flex-1">{priceBlock}</div>
              <QuantityNumerator qty={qty} onDelta={onQtyDelta} idPrefix={idPrefix} />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile fallback: 545px–767px (existing layout) */}
      <div className="hidden min-[545px]:flex items-start gap-3 px-4 py-4 md:hidden">
        {checkbox}
        <ProductThumb label={image} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {nameBlock}
          <SwapLink onSwap={onSwap} />
          {priceBlock}
        </div>
        <div className="flex shrink-0 items-center self-center pt-1" style={{ gap: '16px' }}>
          <QuantityNumerator qty={qty} onDelta={onQtyDelta} idPrefix={`${idPrefix}-m`} />
          {removeBtn}
        </div>
      </div>

      {/* Desktop: ≥768px */}
      <div className="hidden min-h-[72px] items-center gap-4 px-4 py-3 md:flex">
        {checkbox}
        <div className="flex min-w-0 flex-1 items-center gap-5">
          <ProductThumb label={image} />
          {nameBlock}
        </div>
        <div className="h-10 w-px shrink-0 bg-[#ddd]" aria-hidden />
        <div className="flex shrink-0 items-center" style={{ gap: '16px' }}>
          <SwapLink onSwap={onSwap} />
          <div className="w-[120px] shrink-0 text-right">{priceBlock}</div>
          <QuantityNumerator qty={qty} onDelta={onQtyDelta} idPrefix={`${idPrefix}-d`} />
          {removeBtn}
        </div>
      </div>
    </div>
  )
}

export function IconChevronMeal({ expanded }: { expanded: boolean }) {
  return (
    <span
      className={`inline-flex transition-transform duration-150 ${expanded ? 'rotate-0' : '-rotate-90'}`}
      aria-hidden
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M3 4.5 6 7.5 9 4.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function IconBin() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 5h8l-.7 8.1a1 1 0 0 1-1 .9H5.7a1 1 0 0 1-1-.9L4 5Zm2-2h4l.5 1H5.5L6 3Z"
        stroke="#757575"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M2 5h12" stroke="#757575" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}
