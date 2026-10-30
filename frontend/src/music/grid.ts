/** Beat grid: detected beats extended to the song start/end at the average interval. */
export interface BeatGrid {
  beats: number[] // beats extended from <= 0 to >= duration
  firstIndex: number // index of the original beat[0] (bar numbering origin)
  period: number
}

export function makeGrid(detected: number[], duration: number): BeatGrid {
  if (detected.length < 2) {
    const period = 0.5
    const beats = Array.from({ length: Math.ceil(duration / period) + 2 }, (_, i) => i * period)
    return { beats, firstIndex: 0, period }
  }
  const diffs = detected.slice(1).map((b, i) => b - detected[i]).sort((a, b) => a - b)
  const period = diffs[Math.floor(diffs.length / 2)]
  const before: number[] = []
  for (let t = detected[0] - period; t > -period; t -= period) before.unshift(t)
  const after: number[] = []
  for (let t = detected[detected.length - 1] + period; t < duration + period; t += period) after.push(t)
  return { beats: [...before, ...detected, ...after], firstIndex: before.length, period }
}

/** Start index of the beat interval containing t */
export function beatIndex(grid: BeatGrid, t: number): number {
  const b = grid.beats
  let lo = 0
  let hi = b.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (b[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Nearest position on the grid dividing each beat into div parts (unchanged if div=0) */
export function snapTime(grid: BeatGrid, t: number, div: number): number {
  if (div <= 0) return t
  const i = beatIndex(grid, t)
  const b0 = grid.beats[i]
  const b1 = grid.beats[i + 1] ?? b0 + grid.period
  const step = (b1 - b0) / div
  return b0 + Math.round((t - b0) / step) * step
}

/** Length of one grid cell (beat/div) at t */
export function stepAt(grid: BeatGrid, t: number, div: number): number {
  const i = beatIndex(grid, t)
  const b0 = grid.beats[i]
  const b1 = grid.beats[i + 1] ?? b0 + grid.period
  return (b1 - b0) / Math.max(1, div)
}
