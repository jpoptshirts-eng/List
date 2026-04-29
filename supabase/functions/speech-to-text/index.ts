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

function toBase64Url(buf: Uint8Array): string {
  let binary = ''
  for (const byte of buf) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function getGoogleAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  const headerB64 = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
  )
  const claimB64 = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  )

  const signingInput = `${headerB64}.${claimB64}`

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

/**
 * Map a browser MediaRecorder MIME type to a Google Speech-to-Text encoding enum.
 * Returns null when the MIME type is unsupported (caller should fall back to browser STT).
 */
function resolveEncoding(mimeType: string): string | null {
  const m = mimeType.toLowerCase()
  if (m.includes('webm') && m.includes('opus')) return 'WEBM_OPUS'
  if (m.includes('webm')) return 'WEBM_OPUS'
  if (m.includes('ogg') && m.includes('opus')) return 'OGG_OPUS'
  if (m.includes('ogg')) return 'OGG_OPUS'
  if (m.includes('mp3') || m.includes('mpeg')) return 'MP3'
  // MP4/AAC is not supported by STT v1 — signal unsupported so caller falls back.
  return null
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
    const { audioBase64, mimeType } = await req.json() as { audioBase64: string; mimeType: string }

    if (!audioBase64) {
      return new Response(
        JSON.stringify({ error: 'audioBase64 is required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      )
    }

    const encoding = resolveEncoding(mimeType ?? '')
    if (!encoding) {
      return new Response(
        JSON.stringify({ error: `Unsupported audio format: ${mimeType}` }),
        { status: 422, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      )
    }

    const accessToken = await getGoogleAccessToken(sa)

    const sttRes = await fetch(
      'https://speech.googleapis.com/v1/speech:recognize',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: {
            encoding,
            languageCode: 'en-GB',
            // latest_short is optimised for short mic recordings (< 1 min) and
            // produces more reliable comma/punctuation between spoken list items.
            model: 'latest_short',
            enableAutomaticPunctuation: true,
            profanityFilter: false,
          },
          audio: { content: audioBase64 },
        }),
      },
    )

    if (!sttRes.ok) {
      const err = await sttRes.text()
      throw new Error(`Speech-to-Text API error: ${err}`)
    }

    const sttData = await sttRes.json() as {
      results?: Array<{
        alternatives?: Array<{ transcript: string; confidence: number }>
      }>
      error?: { message: string }
    }

    if (sttData.error) {
      throw new Error(`Speech-to-Text API returned error: ${sttData.error.message}`)
    }

    // Each STT "result" is a separate speech segment (split by natural pauses).
    // Join them with newlines so the client parser treats each as a distinct item.
    const transcript = (sttData.results ?? [])
      .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? '')
      .filter(Boolean)
      .join('\n')

    return new Response(
      JSON.stringify({ text: transcript }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[speech-to-text] error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    )
  }
})
