#!/usr/bin/env node
/**
 * Upsert rows into public.grocery_products from public/data/waitrose-groceries.json
 *
 * Requires env (not Vite-prefixed):
 *   SUPABASE_URL=https://dncwllpqoomdcovudmww.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role secret from Dashboard → API>
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/push-catalog-to-supabase.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const jsonPath = join(__dirname, '../public/data/waitrose-groceries.json')

const url = process.env.SUPABASE_URL?.trim()
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

if (!url || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const raw = JSON.parse(await readFile(jsonPath, 'utf8'))
const products = raw.products ?? []
if (!Array.isArray(products) || products.length === 0) {
  console.error('No products in', jsonPath)
  process.exit(1)
}

const rows = products.map((p) => ({
  id: String(p.id),
  name: String(p.name),
  price: Number(p.price) || 0,
  unit_price: String(p.unitPrice ?? ''),
  image_url: String(p.imageUrl ?? ''),
  product_url: String(p.productUrl ?? ''),
  updated_at: new Date().toISOString(),
}))

const db = createClient(url, serviceKey, { auth: { persistSession: false } })
const { error } = await db.from('grocery_products').upsert(rows, { onConflict: 'id' })

if (error) {
  console.error(error)
  process.exit(1)
}

console.log(`Upserted ${rows.length} rows into grocery_products`)
