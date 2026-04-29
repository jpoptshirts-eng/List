import { getSupabase, isSupabaseConfigured } from './supabaseClient'

/**
 * Convert an image File or Blob to a base64 string (without the data-URL prefix).
 */
async function toBase64(file: File | Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the "data:<mime>;base64," prefix
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export interface VisionOcrResult {
  text: string
  /** true when the call succeeded and returned non-empty text */
  ok: boolean
  /** populated when the call failed or returned no text */
  error?: string
}

/**
 * Run Google Vision DOCUMENT_TEXT_DETECTION on an image via the Supabase
 * edge function.  Returns { ok: false } if Supabase is not configured so the
 * caller can fall back to Tesseract transparently.
 */
export async function runVisionOcr(file: File | Blob): Promise<VisionOcrResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, text: '', error: 'Supabase not configured — skipping Vision OCR' }
  }

  const supabase = getSupabase()
  if (!supabase) {
    return { ok: false, text: '', error: 'Could not initialise Supabase client' }
  }

  try {
    const imageBase64 = await toBase64(file)

    const { data, error } = await supabase.functions.invoke<{ text: string; error?: string }>(
      'vision-ocr',
      { body: { imageBase64 } },
    )

    if (error) {
      return { ok: false, text: '', error: error.message }
    }

    if (data?.error) {
      return { ok: false, text: '', error: data.error }
    }

    const text = data?.text ?? ''
    return { ok: text.trim().length > 0, text }
  } catch (err) {
    return {
      ok: false,
      text: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
