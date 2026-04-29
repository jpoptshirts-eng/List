import { getSupabase, isSupabaseConfigured } from './supabaseClient'

export interface SpeechRecordingHandle {
  /** Call to stop recording and await the transcript. */
  stop: () => void
  /** Promise that resolves with the transcribed text once recording ends. */
  result: Promise<SpeechToTextResult>
  /**
   * The live mic MediaStream — connect to AudioContext/AnalyserNode for
   * reactive visualisation. Tracks are stopped automatically after
   * recording ends — the caller should clear any AudioContext by then.
   * null when MediaRecorder is unavailable.
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
 * Attempt to transcribe audio via the Supabase cloud STT edge function.
 * Returns null if Supabase is unavailable or the call fails.
 */
async function tryCloudStt(chunks: Blob[], mimeType: string): Promise<string | null> {
  const supabase = getSupabase()
  if (!supabase) return null
  try {
    const audioBase64 = await blobToBase64(new Blob(chunks, { type: mimeType }))
    const { data, error } = await supabase.functions.invoke<{ text: string; error?: string }>(
      'speech-to-text',
      { body: { audioBase64, mimeType } },
    )
    if (error || data?.error) return null
    const text = data?.text?.trim() ?? ''
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * Start recording microphone audio and return a handle.
 *
 * Strategy:
 *  1. If MediaRecorder is available, open a real mic stream so the AnalyserNode
 *     equaliser reacts to live audio.
 *  2. The Web Speech API runs simultaneously for transcription (reliable, no
 *     server required).
 *  3. When Supabase is configured, the cloud STT result is also attempted and
 *     preferred if it succeeds; Web Speech is always the fallback.
 */
export async function startSpeechRecording(
  onInterimText?: (text: string) => void,
): Promise<SpeechRecordingHandle | null> {
  const SpeechRecognition =
    (window as unknown as { SpeechRecognition?: typeof window.SpeechRecognition })
      .SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition })
      .webkitSpeechRecognition

  const mimeType = detectMimeType()

  // ── Hybrid: MediaRecorder (equaliser stream) + Web Speech (transcription) ──
  if (mimeType && SpeechRecognition) {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      // No mic permission — fall through to Web Speech only
      return startWebSpeechOnly(SpeechRecognition, onInterimText)
    }

    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

    // Web Speech API for transcription
    const rec = new SpeechRecognition()
    rec.lang = 'en-GB'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    let wsBuffer = ''
    let resolveResult!: (r: SpeechToTextResult) => void
    const result = new Promise<SpeechToTextResult>((res) => { resolveResult = res })
    let resolved = false

    const settle = (r: SpeechToTextResult) => {
      if (resolved) return
      resolved = true
      resolveResult(r)
    }

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = r[0]?.transcript?.trim() ?? ''
        if (r.isFinal) {
          wsBuffer = wsBuffer ? `${wsBuffer}, ${t}` : t
        } else {
          interim = t
        }
      }
      if (onInterimText) onInterimText(interim || wsBuffer)
    }

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'aborted') return
      // Don't reject entirely — we may still get a cloud result
    }

    rec.onend = async () => {
      // Web Speech finished — try cloud STT first, fall back to Web Speech buffer
      if (isSupabaseConfigured() && chunks.length > 0) {
        const cloudText = await tryCloudStt(chunks, mimeType)
        if (cloudText) {
          settle({ ok: true, text: cloudText, usedCloudApi: true })
          return
        }
      }
      const text = wsBuffer.trim()
      settle({ ok: text.length > 0, text, usedCloudApi: false })
    }

    try {
      rec.start()
      recorder.start()
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      return null
    }

    return {
      stop: () => {
        try { rec.stop() } catch { /* noop */ }
        if (recorder.state !== 'inactive') {
          recorder.onstop = () => { stream.getTracks().forEach((t) => t.stop()) }
          recorder.stop()
        } else {
          stream.getTracks().forEach((t) => t.stop())
        }
      },
      result,
      stream,
    }
  }

  // ── Web Speech only (no MediaRecorder available) ───────────────────────────
  if (SpeechRecognition) {
    return startWebSpeechOnly(SpeechRecognition, onInterimText)
  }

  return null
}

function startWebSpeechOnly(
  SpeechRecognition: typeof window.SpeechRecognition,
  onInterimText?: (text: string) => void,
): SpeechRecordingHandle | null {
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
    stop: () => { try { rec.stop() } catch { /* noop */ } },
    result,
    stream: null,
  }
}
