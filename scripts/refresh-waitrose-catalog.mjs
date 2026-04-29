#!/usr/bin/env node
/**
 * Fetches https://www.waitrose.com/ecom/shop/browse/groceries and writes
 * public/data/waitrose-groceries.json for static hosting / Supabase seeding.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWaitroseBrowseHtml, WAITROSE_GROCERIES_BROWSE } from './waitrose/parseBrowseHtml.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = join(__dirname, '../public/data/waitrose-groceries.json')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function main() {
  const res = await fetch(WAITROSE_GROCERIES_BROWSE, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9',
      'User-Agent': UA,
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Waitrose HTTP ${res.status}`)
  const html = await res.text()
  const products = parseWaitroseBrowseHtml(html)
  await mkdir(dirname(outPath), { recursive: true })
  const payload = {
    source: WAITROSE_GROCERIES_BROWSE,
    fetchedAt: new Date().toISOString(),
    count: products.length,
    products,
  }
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`Wrote ${products.length} products to ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
