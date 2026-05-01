import { useMemo, useState } from 'react'
import { IconBin, QuantityNumerator } from './shopping-list-pods'

export type TrolleyLine = {
  id: string
  name: string
  image: string
  price: number
  unitPrice: string
  qty: number
  allowSubstitute: boolean
}

function Thumb({ label }: { label: string }) {
  const isUrl = /^https?:\/\//i.test(label)
  const isEmoji = !isUrl && label.length <= 8 && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(label)
  return (
    <div className="relative size-14 shrink-0 overflow-hidden bg-[#fafafa] sm:size-16">
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

type Props = {
  lines: TrolleyLine[]
  formatCurrency: (n: number) => string
  onQuantityDelta: (id: string, delta: number) => void
  onRemoveLine: (id: string) => void
  onEmptyTrolley: () => void
  onToggleSubstitute: (id: string) => void
  onSetAllSubstitute: (value: boolean) => void
  onNavigateFavourites: () => void
  onNavigateShoppingLists: () => void
}

const MIN_CHECKOUT_GBP = 40

export function MyTrolleyView({
  lines,
  formatCurrency,
  onQuantityDelta,
  onRemoveLine,
  onEmptyTrolley,
  onToggleSubstitute,
  onSetAllSubstitute,
  onNavigateFavourites,
  onNavigateShoppingLists,
}: Props) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'recent' | 'az'>('recent')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = q ? lines.filter((l) => l.name.toLowerCase().includes(q)) : [...lines]
    if (sort === 'az') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    }
    return list
  }, [lines, search, sort])

  const unitCount = lines.reduce((s, l) => s + l.qty, 0)
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0)
  const offerSavings = 0
  const estimated = subtotal + offerSavings
  const canCheckout = estimated >= MIN_CHECKOUT_GBP && lines.length > 0
  const allSubs = lines.length > 0 && lines.every((l) => l.allowSubstitute)

  const summaryBlock = (
    <div className="border border-[#ddd] bg-white p-4">
      <p className="mb-4 text-[18px] font-medium text-[#333]">Total</p>
      <div className="flex flex-col gap-2 text-[16px] leading-6">
        <div className="flex justify-between">
          <span>Sub-total</span>
          <span className="tabular-nums">{formatCurrency(subtotal)}</span>
        </div>
        {offerSavings !== 0 ? (
          <div className="flex justify-between text-[#a6192e]">
            <span>Offer savings</span>
            <span className="tabular-nums">-{formatCurrency(Math.abs(offerSavings))}</span>
          </div>
        ) : null}
        <div className="flex justify-between font-medium">
          <span className="flex items-center gap-2">
            Estimated total
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#53565A] text-[12px] font-normal">
              ?
            </span>
          </span>
          <span className="tabular-nums">{formatCurrency(estimated)}</span>
        </div>
      </div>
      <button
        type="button"
        disabled={!canCheckout}
        className={`mt-4 w-full px-5 py-3 text-[16px] font-medium leading-6 ${
          canCheckout ? 'bg-[#5B8226] text-white' : 'bg-[#eeeeee] text-[#a9a9a9]'
        }`}
      >
        Checkout
      </button>
      {!canCheckout && lines.length > 0 ? (
        <div className="mt-4 border border-[#f5a623] border-l-4 bg-[#fff9e6] px-3 py-3 text-[14px] leading-5 text-[#333]">
          <span className="mr-2 inline-block align-middle text-[#f5a623]" aria-hidden>
            ▲
          </span>
          To check out, please meet our £40 minimum spend (excluding delivery charge if applicable).
        </div>
      ) : null}
    </div>
  )

  if (lines.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[768px] py-10 text-center">
        <h1
          className="mb-2 uppercase tracking-[4px] text-[#333] sm:tracking-[7px]"
          style={{ fontFamily: '"Gill Sans Nova for JL","Gill Sans","Gill Sans MT",Calibri,"Trebuchet MS",sans-serif', fontWeight: 500, fontSize: 'clamp(20px,4vw,28px)' }}
        >
          My trolley
        </h1>
        <div className="mx-auto mb-8 h-px w-16 bg-[#333]" aria-hidden />
        <p className="mb-6 text-[16px] leading-6 text-[#53565A]">Your trolley is empty.</p>
        <button type="button" className="text-[16px] font-medium underline" onClick={onNavigateShoppingLists}>
          Continue shopping lists
        </button>
        <p className="mt-6 text-[14px] text-[#53565A]">
          Browse{' '}
          <button type="button" className="font-medium underline" onClick={onNavigateFavourites}>
            Favourites
          </button>
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1260px] pb-24 lg:pb-8">
      <h1
        className="mb-2 text-center uppercase tracking-[4px] text-[#333] sm:tracking-[7px]"
        style={{ fontFamily: '"Gill Sans Nova for JL","Gill Sans","Gill Sans MT",Calibri,"Trebuchet MS",sans-serif', fontWeight: 500, fontSize: 'clamp(20px,4vw,28px)' }}
      >
        My trolley
      </h1>
      <div className="mx-auto mb-6 h-px w-16 bg-[#333]" aria-hidden />

      {/* Mobile: summary first */}
      <div className="mb-6 lg:hidden">{summaryBlock}</div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-[16px]">
        <span className="font-medium text-[#333]">
          {unitCount} item{unitCount === 1 ? '' : 's'}
        </span>
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" className="font-medium underline" onClick={onNavigateFavourites}>
            Favourites
          </button>
          <button type="button" className="font-medium underline" onClick={onEmptyTrolley}>
            Empty trolley
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-md flex-1">
          <label className="mb-1 block text-[14px] text-[#53565A]" htmlFor="trolley-search">
            Search trolley
          </label>
          <div className="flex h-10 items-center border border-[#a9a9a9] bg-white px-3">
            <span className="mr-2 text-[#757575]" aria-hidden>
              ⌕
            </span>
            <input
              id="trolley-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-full flex-1 border-0 bg-transparent text-[16px] outline-none"
              placeholder=""
              autoComplete="off"
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="flex cursor-pointer items-center gap-2 text-[16px]">
            <button
              type="button"
              role="checkbox"
              aria-checked={allSubs}
              className={`flex size-5 shrink-0 items-center justify-center border border-[#333] p-0.5 ${allSubs ? 'bg-[#333]' : 'bg-white'}`}
              onClick={() => onSetAllSubstitute(!allSubs)}
            >
              {allSubs ? (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M3.5 8.2 6.4 11 12.5 4.9" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </button>
            Allow substitutions
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#53565A] text-[11px]" aria-hidden>
              ?
            </span>
          </label>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="trolley-sort">
              Sort
            </label>
            <select
              id="trolley-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as 'recent' | 'az')}
              className="h-10 border border-[#333] bg-white px-3 text-[16px] text-[#333]"
            >
              <option value="recent">Recently added</option>
              <option value="az">A–Z</option>
            </select>
          </div>
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-[1fr_340px] lg:gap-10 lg:items-start">
        <div>
          <div className="bg-[#eeeeee] px-4 py-2 text-[14px] font-medium uppercase tracking-[1px] text-[#333]">Groceries</div>
          <ul className="divide-y divide-[#ddd] border border-t-0 border-[#ddd] bg-white">
            {filtered.map((line) => (
              <li key={line.id} className="p-4">
                <div className="flex gap-4">
                  <Thumb label={line.image} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[16px] leading-6 text-[#333]">{line.name}</p>
                      <button
                        type="button"
                        aria-label={`Remove ${line.name}`}
                        className="shrink-0 text-[#757575]"
                        onClick={() => onRemoveLine(line.id)}
                      >
                        <IconBin />
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-4">
                      <QuantityNumerator
                        qty={line.qty}
                        idPrefix={`trolley-${line.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`}
                        onDelta={(d) => onQuantityDelta(line.id, d)}
                      />
                      <div className="text-[#333]">
                        <p className="text-[16px] font-medium leading-6 tabular-nums">{formatCurrency(line.price * line.qty)}</p>
                        <p className="text-[16px] font-light leading-6 text-[#53565A]">{line.unitPrice}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-[14px]">
                      <button type="button" className="text-[#53565A] underline">
                        Add note
                      </button>
                      <label className="flex cursor-pointer items-center gap-2">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={line.allowSubstitute}
                          className={`flex size-5 shrink-0 items-center justify-center border border-[#333] p-0.5 ${line.allowSubstitute ? 'bg-[#333]' : 'bg-white'}`}
                          onClick={() => onToggleSubstitute(line.id)}
                        >
                          {line.allowSubstitute ? (
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                              <path d="M3.5 8.2 6.4 11 12.5 4.9" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : null}
                        </button>
                        Allow substitute
                      </label>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {filtered.length === 0 ? <p className="border border-t-0 border-[#ddd] bg-white p-6 text-[16px] text-[#757575]">No items match your search.</p> : null}
        </div>

        {/* Desktop sidebar */}
        <div className="mt-8 hidden lg:sticky lg:top-24 lg:mt-0 lg:block">{summaryBlock}</div>
      </div>
    </div>
  )
}
