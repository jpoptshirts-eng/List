import { getSupabase, isSupabaseConfigured } from './supabaseClient'

export interface SpeechRecordingHandle {
  stop: () => void
  result: Promise<SpeechToTextResult>
  stream: MediaStream | null
}

export interface SpeechToTextResult {
  text: string
  ok: boolean
  error?: string
  usedCloudApi: boolean
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve((reader.result as string).split(',')[1] ?? '') }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function detectMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return null
}

/**
 * Start mic recording. Uses MediaRecorder + Supabase cloud STT when available
 * (gives the live AnalyserNode stream for the reactive equaliser). Falls back
 * to the browser Web Speech API otherwise.
 */
export async function startSpeechRecording(): Promise<SpeechRecordingHandle | null> {
  const mimeType = detectMimeType()

  // ── MediaRecorder + Supabase cloud STT ────────────────────────────────────
  if (mimeType && isSupabaseConfigured()) {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return null
    }

    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

    let resolveResult!: (r: SpeechToTextResult) => void
    const result = new Promise<SpeechToTextResult>((res) => { resolveResult = res })

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())

      const supabase = getSupabase()
      if (!supabase) {
        resolveResult({ ok: false, text: '', error: 'Supabase client unavailable', usedCloudApi: false })
        return
      }

      try {
        const audioBase64 = await blobToBase64(new Blob(chunks, { type: mimeType }))
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
        resolveResult({ ok: false, text: '', error: err instanceof Error ? err.message : String(err), usedCloudApi: true })
      }
    }

    recorder.start()
    return {
      stop: () => { if (recorder.state !== 'inactive') recorder.stop() },
      result,
      stream,
    }
  }

  // ── Web Speech API fallback ───────────────────────────────────────────────
  const SpeechRecognition =
    (window as unknown as { SpeechRecognition?: typeof window.SpeechRecognition }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition }).webkitSpeechRecognition

  if (!SpeechRecognition) return null

  const rec = new SpeechRecognition()
  rec.lang = 'en-GB'
  rec.continuous = true
  rec.interimResults = false
  rec.maxAlternatives = 1

  let buffer = ''
  let resolveResult!: (r: SpeechToTextResult) => void
  const result = new Promise<SpeechToTextResult>((res) => { resolveResult = res })

  rec.onresult = (event: SpeechRecognitionEvent) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i]
      if (r.isFinal) {
        const t = r[0]?.transcript?.trim() ?? ''
        buffer = buffer ? `${buffer}, ${t}` : t
      }
    }
  }

  rec.onerror = (event: SpeechRecognitionErrorEvent) => {
    if (event.error === 'aborted') return
    resolveResult({ ok: false, text: '', error: event.error, usedCloudApi: false })
  }

  rec.onend = () => {
    const text = buffer.trim()
    resolveResult({ ok: text.length > 0, text, usedCloudApi: false })
  }

  try { rec.start() } catch { return null }

  return {
    stop: () => { try { rec.stop() } catch { /* noop */ } },
    result,
    stream: null,
  }
}
