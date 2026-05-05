import { getSupabase, isSupabaseConfigured } from './supabaseClient'

export type WaitroseCatalogItem = {
  id: string
  name: string
  price: number
  unitPrice: string
  imageUrl: string
  productUrl: string
  productType?: string
}

export type WaitroseCatalogPayload = {
  source: string
  fetchedAt: string
  count: number
  products: WaitroseCatalogItem[]
}

export type BuildShopCatalogPayload = {
  primary: WaitroseCatalogPayload
  fallback: WaitroseCatalogPayload | null
}

export type EssentialFromCatalog = {
  id: string
  name: string
  price: number
  unitPrice: string
  qty: number
  selected: boolean
  image: string
}

const STATIC_CATALOG = '/data/waitrose-groceries.json'

const POPMAS_TABLE = 'POPMAS'
const DEV_POPMAS = '/api/popmas'

function parsePriceText(raw: string | null | undefined): number {
  if (raw == null || raw === '') return 0
  const s = String(raw).replace(/,/g, '').replace(/\s/g, '').trim()
  if (s.startsWith('£')) return Number.parseFloat(s.slice(1)) || 0
  if (s.endsWith('p')) return (Number.parseFloat(s.slice(0, -1)) || 0) / 100
  return Number.parseFloat(s) || 0
}

/** Dev-only: Vite middleware serves live-parsed groceries */
const DEV_LIVE = '/api/waitrose/groceries'

function isDevLiveAvailable(): boolean {
  return import.meta.env.DEV
}

type PopMasCatalogRow = {
  id: number
  imageUrl: string | null
  Name: string | null
  Size: string | null
  Price: string | null
  'Formatted PPU': string | null
  'Product Type': string | null
}

function mapPopMasRowsToProducts(rows: PopMasCatalogRow[]): WaitroseCatalogItem[] {
  return rows.map((row) => {
    const name = (row.Name ?? '').trim()
    const size = (row.Size ?? '').trim()
    const unit = row['Formatted PPU']?.trim()
    const displayName = size ? `${name} (${size})` : name
    return {
      id: `${POPMAS_TABLE}-${row.id}`,
      name: displayName,
      price: parsePriceText(row.Price),
      unitPrice: unit || size || '—',
      imageUrl: row.imageUrl?.trim() || '',
      productUrl: '',
      productType: row['Product Type']?.trim() || undefined,
    }
  })
}

async function loadPopMasCatalog(): Promise<WaitroseCatalogPayload | null> {
  if (import.meta.env.DEV) {
    try {
      const r = await fetch(DEV_POPMAS)
      if (r.ok) {
        const rows = (await r.json()) as PopMasCatalogRow[]
        if (rows.length > 0) {
          return {
            source: `supabase:public.${POPMAS_TABLE}`,
            fetchedAt: new Date().toISOString(),
            count: rows.length,
            products: mapPopMasRowsToProducts(rows),
          }
        }
      }
    } catch {
      /* continue to browser client path */
    }
  }

  if (!isSupabaseConfigured()) return null
  const db = getSupabase()
  if (!db) return null

  const { data, error } = await db
    .from(POPMAS_TABLE)
    .select('id, imageUrl, Name, Size, Price, "Formatted PPU", "Product Type"')
    .order('id', { ascending: true })

  if (error) return null
  const rows = (data ?? []) as PopMasCatalogRow[]
  if (rows.length === 0) return null

  return {
    source: `supabase:public.${POPMAS_TABLE}`,
    fetchedAt: new Date().toISOString(),
    count: rows.length,
    products: mapPopMasRowsToProducts(rows),
  }
}

async function loadStaticOrDevCatalog(): Promise<WaitroseCatalogPayload> {
  if (isDevLiveAvailable()) {
    try {
      const r = await fetch(DEV_LIVE)
      if (r.ok) return (await r.json()) as WaitroseCatalogPayload
    } catch {
      /* continue */
    }
  }

  const r = await fetch(STATIC_CATALOG)
  if (!r.ok) throw new Error(`Catalog fetch failed: ${r.status}`)
  return (await r.json()) as WaitroseCatalogPayload
}

/**
 * With Supabase configured: **POPMAS** only (deduped master). No merged POP* tables or `grocery_products`.
 * Without Supabase: static JSON and (in dev) the local Waitrose scrape for prototyping.
 */
export async function loadWaitroseGroceriesCatalog(): Promise<WaitroseCatalogPayload> {
  if (isSupabaseConfigured()) {
    try {
      const popmas = await loadPopMasCatalog()
      if (popmas && popmas.products.length > 0) return popmas
    } catch {
      /* fall through to error below */
    }
    throw new Error(
      'POPMAS is empty or unavailable. Check Supabase data, RLS, and VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.',
    )
  }

  return loadStaticOrDevCatalog()
}

/**
 * Build-shop retrieval policy:
 * 1) Always use POPMAS as primary when Supabase is configured and available.
 * 2) Only consult static/dev-link catalog as fallback for items missing in POPMAS.
 */
export async function loadCatalogForBuildShop(): Promise<BuildShopCatalogPayload> {
  const popmas = await loadPopMasCatalog()
  if (!popmas || popmas.products.length === 0) {
    throw new Error(
      'POPMAS is empty or unavailable. Check Supabase data, RLS, and VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.',
    )
  }

  try {
    const fallback = await loadStaticOrDevCatalog()
    return { primary: popmas, fallback }
  } catch {
    return { primary: popmas, fallback: null }
  }
}

/** Map catalog rows into essentials. Large lists are capped only by maxItems (default: show many rows). */
export function mapWaitroseCatalogToEssentials(
  products: WaitroseCatalogItem[],
  maxItems = 4000,
): EssentialFromCatalog[] {
  return products.slice(0, maxItems).map((p, i) => ({
    id:
      String(p.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120) || `row-${i}`,
    name: p.name,
    price: Math.max(0, p.price),
    unitPrice: p.unitPrice?.trim() || '—',
    qty: 1,
    selected: true,
    image: p.imageUrl?.startsWith('http') ? p.imageUrl : '🛒',
  }))
}
