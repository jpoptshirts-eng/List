/** Web Speech API (Chrome / Edge / Safari with webkit prefix). */

export function getSpeechRecognitionConstructor(): (new () => SpeechRecognition) | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition }
  return w.webkitSpeechRecognition ?? window.SpeechRecognition
}
