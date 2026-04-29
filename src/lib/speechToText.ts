import { getSupabase, isSupabaseConfigured } from './supabaseClient'

export interface SpeechRecordingHandle {
  stop: () => void
  result: Promise<SpeechToTextResult>
  /**
   * The live mic MediaStream connected to the AnalyserNode for the reactive
   * equaliser. Tracks are stopped when recording ends.
   * null when getUserMedia is unavailable.
   */
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
 * Start recording:
 *  - getUserMedia → provides the MediaStream for the reactive equaliser.
 *  - Web Speech API → provides the transcript (no Supabase dependency).
 *  - If Supabase cloud STT is configured, it is also tried on stop and its
 *    result is preferred when it succeeds, for higher accuracy.
 */
export async function startSpeechRecording(
  onInterimText?: (text: string) => void,
): Promise<SpeechRecordingHandle | null> {
  const SpeechRecognition =
    (window as unknown as { SpeechRecognition?: typeof window.SpeechRecognition }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition }).webkitSpeechRecognition

  if (!SpeechRecognition) return null

  // ── Set up Web Speech API (transcription) ──────────────────────────────────
  const rec = new SpeechRecognition()
  rec.lang = 'en-GB'
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1

  let wsBuffer = ''
  let resolveResult!: (r: SpeechToTextResult) => void
  const result = new Promise<SpeechToTextResult>((res) => { resolveResult = res })
  let settled = false
  const settle = (r: SpeechToTextResult) => { if (!settled) { settled = true; resolveResult(r) } }

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
    settle({ ok: false, text: '', error: event.error, usedCloudApi: false })
  }

  rec.onend = () => {
    const text = wsBuffer.trim()
    settle({ ok: text.length > 0, text, usedCloudApi: false })
  }

  // ── Get mic stream for equaliser first, then start Web Speech ───────────────
  // Acquiring the stream before rec.start() avoids Chrome interrupting Web
  // Speech when getUserMedia fires mid-recognition.
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    // No permission — equaliser falls back to CSS pulse, Web Speech still works
  }

  try { rec.start() } catch { return null }

  // ── Optional: also record via MediaRecorder for cloud STT on stop ──────────
  const mimeType = detectMimeType()
  let recorder: MediaRecorder | null = null
  const chunks: Blob[] = []

  if (stream && mimeType && isSupabaseConfigured()) {
    try {
      recorder = new MediaRecorder(stream, { mimeType })
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      recorder.start()
    } catch {
      recorder = null
    }
  }

  return {
    stop: () => {
      // Stop transcription first — fires rec.onend which settles the promise
      try { rec.stop() } catch { /* noop */ }

      // Stop MediaRecorder and attempt cloud STT upgrade if available
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = async () => {
          if (chunks.length > 0) {
            const supabase = getSupabase()
            if (supabase) {
              try {
                const audioBase64 = await blobToBase64(new Blob(chunks, { type: mimeType! }))
                const { data, error } = await supabase.functions.invoke<{ text: string; error?: string }>(
                  'speech-to-text',
                  { body: { audioBase64, mimeType } },
                )
                if (!error && !data?.error) {
                  const cloudText = data?.text?.trim() ?? ''
                  if (cloudText) settle({ ok: true, text: cloudText, usedCloudApi: true })
                }
              } catch { /* cloud STT failed — Web Speech result already settled */ }
            }
          }
          stream?.getTracks().forEach((t) => t.stop())
        }
        recorder.stop()
      } else {
        stream?.getTracks().forEach((t) => t.stop())
      }
    },
    result,
    stream,
  }
}
