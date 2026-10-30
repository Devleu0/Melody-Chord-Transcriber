/** 박 격자: 감지된 비트를 곡 시작/끝까지 평균 간격으로 연장한 전체 비트 목록. */
export interface BeatGrid {
  beats: number[] // 0 이하 ~ duration 이상까지 연장된 비트
  firstIndex: number // 원래 비트[0] 의 인덱스 (마디 번호 기준점)
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

/** t 가 속한 비트 구간의 시작 인덱스 */
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

/** 박을 div 등분한 격자 중 가장 가까운 위치 (div=0 이면 그대로) */
export function snapTime(grid: BeatGrid, t: number, div: number): number {
  if (div <= 0) return t
  const i = beatIndex(grid, t)
  const b0 = grid.beats[i]
  const b1 = grid.beats[i + 1] ?? b0 + grid.period
  const step = (b1 - b0) / div
  return b0 + Math.round((t - b0) / step) * step
}

/** t 위치의 한 칸(박/div) 길이 */
export function stepAt(grid: BeatGrid, t: number, div: number): number {
  const i = beatIndex(grid, t)
  const b0 = grid.beats[i]
  const b1 = grid.beats[i + 1] ?? b0 + grid.period
  return (b1 - b0) / Math.max(1, div)
}
