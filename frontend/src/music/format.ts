const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`

export function fmtTime(s: number) {
  const total = Math.floor(Math.max(0, s))
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${sec < 10 ? '0' : ''}${sec}`
}
