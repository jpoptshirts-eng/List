/**
 * Parse Waitrose grocery browse HTML (e.g. /ecom/shop/browse/groceries).
 * Primary: embedded Redux/SSR JSON (product tiles with displayPrice, images).
 * Fallbacks: __NEXT_DATA__ walk, JSON-LD, then product hrefs.
 */

export const WAITROSE_GROCERIES_BROWSE =
  'https://www.waitrose.com/ecom/shop/browse/groceries'

export function titleFromSlug(slug) {
  try {
    slug = decodeURIComponent(slug)
  } catch {
    /* ignore */
  }
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parsePriceToNumber(raw) {
  if (raw == null || raw === '') return 0
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw
  const s = String(raw).replace(/,/g, '').replace(/\s/g, '').trim()
  if (!s) return 0
  if (s.startsWith('£')) return parseFloat(s.slice(1)) || 0
  if (s.endsWith('p')) return (parseFloat(s.slice(0, -1)) || 0) / 100
  const n = parseFloat(s)
  return Number.isNaN(n) ? 0 : n
}

function decodeJsonString(s) {
  if (!s) return ''
  return s
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
}

const REDUX_ID_NAME_RE =
  /"id":"([0-9]+(?:-[0-9]+)+)","leadTime":\d+,"lineNumber":"[^"]+","maxPersonalisedMessageLength":\d+,"name":"((?:[^"\\]|\\.)+)"/g

/** Canonical /ecom/products/{slug}/{id} paths appear elsewhere in the HTML */
function findProductUrl(html, compoundId) {
  const esc = compoundId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const r = new RegExp(`/ecom/products/([a-z0-9-]+)/${esc}(?=")`, 'i')
  const m = html.match(r)
  if (m) return `https://www.waitrose.com/ecom/products/${m[1]}/${compoundId}`
  return ''
}

function extractEmbeddedReduxProducts(html) {
  const products = []
  let m
  while ((m = REDUX_ID_NAME_RE.exec(html)) !== null) {
    const compoundId = m[1]
    const name = decodeJsonString(m[2])
    const back = html.slice(Math.max(0, m.index - 1200), m.index)
    const priceBlocks = [
      ...back.matchAll(/"displayPrice":"([^"]+)","displayPriceEstimated":[^,]+,"displayPriceQualifier":"([^"]*)"/g),
    ]
    const pb = priceBlocks[priceBlocks.length - 1]
    const displayPrice = pb?.[1] ?? '£0'
    const unitEnc = pb?.[2] ?? ''
    const unitPrice = decodeJsonString(unitEnc).replace(/\\\//g, '/')
    const price = parsePriceToNumber(displayPrice)
    const forward = html.slice(m.index, m.index + 900)
    const imgM = forward.match(/"extraLarge":"((?:[^"\\]|\\.)+)"/)
    const imageUrl = imgM ? decodeJsonString(imgM[1]) : ''
    const productUrl = findProductUrl(html, compoundId)
    products.push({
      id: `wr-${compoundId}`,
      name,
      price,
      unitPrice: unitPrice || '—',
      imageUrl,
      productUrl,
    })
  }
  return products
}

function stringifyUnitPrice(u) {
  if (u == null || u === '') return ''
  if (typeof u === 'string') return u
  if (typeof u === 'object') {
    if (u.formatted) return String(u.formatted)
    if (u.price != null && u.unit) return `${u.price}/${u.unit}`
  }
  return String(u)
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

function collectProductLikeNodes(obj, acc, seen, depth) {
  if (depth > 30 || obj == null || typeof obj !== 'object') return
  if (seen.has(obj)) return
  seen.add(obj)

  if (Array.isArray(obj)) {
    for (const el of obj) collectProductLikeNodes(el, acc, seen, depth + 1)
    return
  }

  const name =
    obj.name ||
    obj.productName ||
    obj.title ||
    obj.displayName ||
    obj.productTitle ||
    obj.product?.name ||
    obj.product?.productName

  const priceRaw =
    obj.price ??
    obj.currentPrice ??
    obj.sellingPrice ??
    obj.salePrice ??
    obj.nowPrice ??
    obj.product?.price ??
    obj.product?.currentPrice

  const unitRaw =
    obj.unitPrice ??
    obj.pricePerUnit ??
    obj.saleUnitPrice ??
    obj.displayPricePerUnit ??
    obj.formattedUnitPrice ??
    obj.product?.unitPrice

  const id =
    obj.productId ??
    obj.id ??
    obj.product?.id ??
    obj.product?.productId ??
    obj.sku ??
    obj.productCode

  const imgRaw = obj.image ?? obj.imageUrl ?? obj.thumbnailUrl ?? obj.thumbnail ?? obj.product?.image
  const urlRaw = obj.url ?? obj.productUrl ?? obj.link ?? obj.product?.url

  if (typeof name === 'string' && name.length > 2 && name.length < 280 && priceRaw != null) {
    const price = parsePriceToNumber(priceRaw)
    const unitPrice = stringifyUnitPrice(unitRaw) || ''
    let imageUrl = ''
    if (typeof imgRaw === 'string') imageUrl = imgRaw
    else if (imgRaw && typeof imgRaw === 'object' && typeof imgRaw.url === 'string') imageUrl = imgRaw.url
    let productUrl = ''
    if (typeof urlRaw === 'string') {
      productUrl = urlRaw.startsWith('http') ? urlRaw : `https://www.waitrose.com${urlRaw.startsWith('/') ? '' : '/'}${urlRaw}`
    }

    acc.push({
      id: String(id || productUrl || name)
        .replace(/\s+/g, '-')
        .slice(0, 120),
      name: name.trim(),
      price,
      unitPrice: unitPrice || '—',
      imageUrl,
      productUrl,
    })
  }

  for (const v of Object.values(obj)) collectProductLikeNodes(v, acc, seen, depth + 1)
}

function extractJsonLdProducts(html) {
  const out = []
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    let data
    try {
      data = JSON.parse(m[1])
    } catch {
      continue
    }
    const blocks = Array.isArray(data) ? data : [data]
    for (const block of blocks) {
      if (block['@type'] === 'ItemList' && Array.isArray(block.itemListElement)) {
        for (const el of block.itemListElement) {
          const item = el.item || el
          if (!item || typeof item !== 'object') continue
          const name = item.name
          const offers = item.offers
          let price = 0
          let unitPrice = ''
          if (offers && typeof offers === 'object') {
            price = parsePriceToNumber(offers.price)
            unitPrice = offers.priceSpecification?.priceCurrency
              ? `${offers.price} ${offers.priceSpecification?.unitText || ''}`.trim()
              : ''
          }
          if (typeof name === 'string' && name.length > 1) {
            out.push({
              id: `ld-${String(item.sku || item['@id'] || name).slice(0, 80)}`,
              name: name.trim(),
              price,
              unitPrice: unitPrice || '—',
              imageUrl: typeof item.image === 'string' ? item.image : '',
              productUrl: typeof item.url === 'string' ? item.url : '',
            })
          }
        }
      }
    }
  }
  return out
}

function extractHrefProducts(html) {
  const products = []
  const re = /href="(https:\/\/www\.waitrose\.com)?(\/ecom\/products\/[^"]+)"/g
  const seen = new Set()
  let m
  while ((m = re.exec(html)) !== null) {
    const path = m[2].split('"')[0].split('?')[0]
    if (seen.has(path)) continue
    seen.add(path)
    const parts = path.split('/').filter(Boolean)
    const ids = parts[parts.length - 1] || ''
    const slug = parts[parts.length - 2] || 'product'
    products.push({
      id: `wr-${ids.replace(/[^0-9-]/g, '-') || slug}`,
      name: titleFromSlug(slug),
      price: 0,
      unitPrice: 'See product on waitrose.com',
      imageUrl: '',
      productUrl: `https://www.waitrose.com${path}`,
    })
  }
  return products
}

/** @param {string} html */
export function parseWaitroseBrowseHtml(html) {
  const embed = extractEmbeddedReduxProducts(html)
  if (embed.length >= 8) return dedupeById(embed)

  const fromNext = []
  const data = extractNextData(html)
  if (data) collectProductLikeNodes(data, fromNext, new WeakSet(), 0)

  const fromLd = extractJsonLdProducts(html)
  const fromHref = extractHrefProducts(html)

  const withPrices = fromNext.filter((p) => p.price > 0)
  if (withPrices.length >= 8) return dedupeById(fromNextDataDedupe(fromNext))
  if (fromLd.length >= 8) return dedupeById(dedupeByUrl(fromLd))
  return dedupeById(dedupeByUrl(fromHref))
}

function dedupeById(arr) {
  const m = new Map()
  for (const p of arr) {
    if (!m.has(p.id)) m.set(p.id, p)
  }
  return [...m.values()].filter((p) => p.name)
}

function fromNextDataDedupe(arr) {
  const m = new Map()
  for (const p of arr) {
    const key = p.productUrl || p.name
    const prev = m.get(key)
    if (!prev || (p.price > 0 && prev.price === 0)) m.set(key, p)
  }
  return [...m.values()].filter((p) => p.name)
}

function dedupeByUrl(arr) {
  const m = new Map()
  for (const p of arr) {
    const key = p.productUrl || p.name
    if (!m.has(key)) m.set(key, p)
  }
  return [...m.values()]
}
