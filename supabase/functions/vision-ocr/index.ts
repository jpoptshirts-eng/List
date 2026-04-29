import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ServiceAccount {
  client_email: string
  private_key: string
  private_key_id: string
}

/**
 * Encode a Uint8Array to base64url (no padding).
 */
function toBase64Url(buf: Uint8Array): string {
  let binary = ''
  for (const byte of buf) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Build and sign a Google service-account JWT, then exchange it for an
 * OAuth2 access token that can be used with the Vision REST API.
 */
async function getGoogleAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  const headerB64 = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
  )
  const claimB64 = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-vision',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  )

  const signingInput = `${headerB64}.${claimB64}`

  // Import the PEM private key for RS256 signing.
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const keyDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput)),
  )

  const jwt = `${signingInput}.${toBase64Url(signatureBytes)}`

  // Exchange the self-signed JWT for a short-lived access token.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    throw new Error(`Google token exchange failed: ${err}`)
  }

  const { access_token } = await tokenRes.json() as { access_token: string }
  return access_token
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const rawCreds = Deno.env.get('GOOGLE_VISION_CREDENTIALS')
    if (!rawCreds) {
      return new Response(
        JSON.stringify({ error: 'GOOGLE_VISION_CREDENTIALS secret is not set' }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      )
    }

    const sa = JSON.parse(rawCreds) as ServiceAccount
    const { imageBase64 } = await req.json() as { imageBase64: string }

    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: 'imageBase64 is required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      )
    }

    const accessToken = await getGoogleAccessToken(sa)

    const visionRes = await fetch(
      'https://vision.googleapis.com/v1/images:annotate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            {
              image: { content: imageBase64 },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
            },
          ],
        }),
      },
    )

    if (!visionRes.ok) {
      const err = await visionRes.text()
      throw new Error(`Vision API error: ${err}`)
    }

    const visionData = await visionRes.json() as {
      responses: Array<{
        fullTextAnnotation?: { text: string }
        error?: { message: string }
      }>
    }

    const response = visionData.responses[0]
    if (response?.error) {
      throw new Error(`Vision API returned error: ${response.error.message}`)
    }

    const text = response?.fullTextAnnotation?.text ?? ''

    return new Response(
      JSON.stringify({ text }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[vision-ocr] error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    )
  }
})
