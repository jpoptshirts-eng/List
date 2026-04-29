import { getSupabase, isSupabaseConfigured } from './supabaseClient'

export interface SpeechRecordingHandle {
  /** Call to stop recording and await the transcript. */
  stop: () => void
  /** Promise that resolves with the transcribed text once recording ends. */
  result: Promise<SpeechToTextResult>
  /**
   * The live mic MediaStream (MediaRecorder path only).
   * The caller can connect this to an AudioContext/AnalyserNode for
   * reactive visualisation. Tracks are stopped automatically after
   * recording ends — the caller should clear any AudioContext by then.
   * null on the Web Speech API fallback path.
   */
  stream: MediaStream | null
}

export interface SpeechToTextResult {
  text: string
  ok: boolean
  error?: string
  /** true when Google Cloud STT was used; false when Web Speech API was used */
  usedCloudApi: boolean
}

/**
 * Convert an audio Blob to a plain base64 string (no data-URL prefix).
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Detect the best supported MIME type for MediaRecorder in this browser.
 * Prefers WebM/Opus (Chrome/Edge) then Ogg/Opus (Firefox).
 * Returns null when MediaRecorder is not available.
 */
export function detectMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ]
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return null
}

/**
 * Start recording microphone audio and return a handle that lets the caller
 * stop recording and get back a transcript.
 *
 * The transcript is produced by Google Cloud Speech-to-Text via the Supabase
 * edge function when possible.  Falls back to the browser Web Speech API when:
 *   - Supabase is not configured
 *   - The edge function call fails
 *   - MediaRecorder is not supported (Safari older than 14.1)
 *   - The detected MIME type is unsupported by Google STT
 *
 * @param onInterimText  Optional callback for real-time interim text from the
 *                       Web Speech API fallback path.
 */
// Prefer the Supabase + MediaRecorder path when Supabase is configured;
// fall back to Web Speech API elsewhere.
const USE_CLOUD_STT = true

export async function startSpeechRecording(
  onInterimText?: (text: string) => void,
): Promise<SpeechRecordingHandle | null> {
  const mimeType = detectMimeType()

  // ── MediaRecorder path (primary — feeds Google Cloud STT) ────────────────
  if (USE_CLOUD_STT && mimeType && isSupabaseConfigured()) {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return null
    }

    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks: Blob[] = []

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    let resolveResult!: (r: SpeechToTextResult) => void
    const result = new Promise<SpeechToTextResult>((res) => { resolveResult = res })

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())

      const audioBlob = new Blob(chunks, { type: mimeType })

      const supabase = getSupabase()
      if (!supabase) {
        resolveResult({ ok: false, text: '', error: 'Supabase client unavailable', usedCloudApi: false })
        return
      }

      try {
        const audioBase64 = await blobToBase64(audioBlob)
        const { data, error } = await supabase.functions.invoke<{ text: string; error?: string }>(
          'speech-to-text',
          { body: { audioBase64, mimeType } },
        )

        if (error) {
          resolveResult({ ok: false, text: '', error: error.message, usedCloudApi: true })
          return
        }
        if (data?.error) {
          resolveResult({ ok: false, text: '', error: data.error, usedCloudApi: true })
          return
        }

        const text = data?.text?.trim() ?? ''
        resolveResult({ ok: text.length > 0, text, usedCloudApi: true })
      } catch (err) {
        resolveResult({
          ok: false,
          text: '',
          error: err instanceof Error ? err.message : String(err),
          usedCloudApi: true,
        })
      }
    }

    recorder.start()

    return {
      stop: () => {
        if (recorder.state !== 'inactive') recorder.stop()
      },
      result,
      stream,
    }
  }

  // ── Web Speech API fallback ───────────────────────────────────────────────
  const SpeechRecognition =
    (window as unknown as { SpeechRecognition?: typeof window.SpeechRecognition })
      .SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition })
      .webkitSpeechRecognition

  if (!SpeechRecognition) return null

  const rec = new SpeechRecognition()
  rec.lang = 'en-GB'
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1

  let buffer = ''
  let resolveResult!: (r: SpeechToTextResult) => void
  const result = new Promise<SpeechToTextResult>((res) => { resolveResult = res })

  rec.onresult = (event: SpeechRecognitionEvent) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i]
      const t = r[0]?.transcript?.trim() ?? ''
      if (r.isFinal) {
        buffer = buffer ? `${buffer}, ${t}` : t
      } else {
        interim = t
      }
    }
    if (onInterimText) onInterimText(interim || buffer)
  }

  rec.onerror = (event: SpeechRecognitionErrorEvent) => {
    if (event.error === 'aborted') return
    resolveResult({ ok: false, text: '', error: event.error, usedCloudApi: false })
  }

  rec.onend = () => {
    const text = buffer.trim()
    resolveResult({ ok: text.length > 0, text, usedCloudApi: false })
  }

  try {
    rec.start()
  } catch {
    return null
  }

  return {
    stop: () => {
      try { rec.stop() } catch { /* noop */ }
    },
    result,
    stream: null,
  }
}
