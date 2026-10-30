import type { Note } from '../types'

const LOOKAHEAD = 0.15 // 스케줄 선행 시간(s, 오디오 클럭 기준)
const START_DELAY = 0.05

export interface LoopRange {
  start: number
  end: number
}

interface AudioTrack {
  buffer: AudioBuffer
  gain: GainNode
}

interface SynthTrack {
  notes: Note[] // start 오름차순
  gain: GainNode
}

/** 재생 구간: 오디오 클럭 ctx0 에 곡 시각 song0 부터 songEnd 까지 재생 */
interface Segment {
  ctx0: number
  song0: number
  songEnd: number
  loops: boolean // songEnd 에서 루프 시작점으로 되돌아가는지
  sources: AudioBufferSourceNode[]
  schedUntil: number // 신스 노트를 예약한 곡 시각
}

const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12)

/** start >= t 인 첫 노트 인덱스 */
function lowerBound(notes: Note[], t: number) {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].start < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 여러 stem 을 샘플 단위로 동기 재생하고, 채보된 노트를 간단한 신스로 함께 재생한다.
 * - 구간 반복: 다음 구간을 오디오 클럭 기준으로 미리 예약해 끊김 없이 되감는다.
 * - 속도: 서버에서 음정 유지 변환된 버퍼를 받아 곡 시각 = 버퍼 시각 × rate 로 매핑한다.
 */
export class AudioEngine {
  readonly ctx = new AudioContext()
  private master = this.ctx.createGain()
  private audio = new Map<string, AudioTrack>()
  private synth = new Map<string, SynthTrack>()
  private segs: Segment[] = []
  private offset = 0 // 정지 상태의 곡 시각
  private timer: number | undefined
  private rate = 1
  private loopRange: LoopRange | null = null
  duration = 0
  onEnded?: () => void

  constructor() {
    this.master.connect(this.ctx.destination)
  }

  private async fetchBuffer(url: string) {
    const data = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`오디오 로드 실패: ${url}`)
      return r.arrayBuffer()
    })
    return this.ctx.decodeAudioData(data)
  }

  async loadAudio(id: string, url: string) {
    const buffer = await this.fetchBuffer(url)
    const gain = this.ctx.createGain()
    gain.connect(this.master)
    this.audio.set(id, { buffer, gain })
    this.duration = Math.max(this.duration, buffer.duration)
  }

  /** 재생 속도 변경. urls 는 해당 속도로 변환된 각 트랙의 오디오 */
  async setRate(rate: number, urls: Map<string, string>) {
    if (rate === this.rate) return
    const wasPlaying = this.isPlaying
    const buffers = await Promise.all([...urls].map(async ([id, url]) => [id, await this.fetchBuffer(url)] as const))
    const pos = this.currentTime
    if (wasPlaying) this.stopAll()
    for (const [id, buffer] of buffers) {
      const t = this.audio.get(id)
      if (t) t.buffer = buffer
    }
    this.rate = rate
    this.offset = pos
    if (wasPlaying) void this.play()
  }

  get playbackRate() {
    return this.rate
  }

  setNotes(id: string, notes: Note[]) {
    const gain = this.ctx.createGain()
    gain.gain.value = 0
    gain.connect(this.master)
    this.synth.set(id, { notes: [...notes].sort((a, b) => a.start - b.start), gain })
  }

  setAudioGain(id: string, v: number) {
    this.audio.get(id)?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setSynthGain(id: string, v: number) {
    this.synth.get(id)?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  /** 반복 구간 설정/해제. 재생 중이면 현재 위치에서 다시 예약한다. */
  setLoop(range: LoopRange | null) {
    this.loopRange = range && range.end - range.start >= 0.1 ? range : null
    if (this.isPlaying) this.seek(this.currentTime)
  }

  get loop() {
    return this.loopRange
  }

  get isPlaying() {
    return this.segs.length > 0
  }

  get currentTime() {
    if (!this.isPlaying) return this.offset
    const now = this.ctx.currentTime
    // 이미 시작된 가장 늦은 구간 기준
    let seg = this.segs[0]
    for (const s of this.segs) if (s.ctx0 <= now) seg = s
    const t = seg.song0 + Math.max(0, now - seg.ctx0) * this.rate
    return Math.min(seg.songEnd, t)
  }

  async play() {
    if (this.isPlaying) return
    await this.ctx.resume()
    if (this.offset >= this.duration - 0.01) this.offset = this.loopRange?.start ?? 0
    this.startSegment(this.ctx.currentTime + START_DELAY, this.offset)
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  pause() {
    if (!this.isPlaying) return
    this.offset = this.currentTime
    this.stopAll()
  }

  seek(time: number) {
    const wasPlaying = this.isPlaying
    if (wasPlaying) this.stopAll()
    this.offset = Math.max(0, Math.min(time, this.duration))
    if (wasPlaying) void this.play()
  }

  private startSegment(ctx0: number, song0: number) {
    const loop = this.loopRange
    // 루프 끝 이전에서 시작하면 루프 끝에서 되감고, 그 뒤면 곡 끝까지 재생
    const loops = !!loop && song0 < loop.end - 0.01
    const seg: Segment = {
      ctx0,
      song0,
      songEnd: loops ? loop!.end : this.duration,
      loops,
      sources: [],
      schedUntil: song0,
    }
    for (const t of this.audio.values()) {
      const src = this.ctx.createBufferSource()
      src.buffer = t.buffer
      src.connect(t.gain)
      src.start(ctx0, song0 / this.rate)
      seg.sources.push(src)
    }
    // 구간 시작 시점에 이미 울리고 있어야 하는 노트
    for (const s of this.synth.values()) {
      for (const n of s.notes) {
        if (n.start >= song0) break
        if (n.end > song0) this.voice(n.pitch, ctx0, (Math.min(n.end, seg.songEnd) - song0) / this.rate, n.velocity, s.gain)
      }
    }
    this.segs.push(seg)
    return seg
  }

  private stopAll() {
    for (const seg of this.segs) {
      for (const src of seg.sources) {
        try {
          src.stop()
        } catch {
          /* 아직 시작 전인 소스 */
        }
        src.disconnect()
      }
    }
    this.segs = []
    window.clearInterval(this.timer)
  }

  private tick() {
    const now = this.ctx.currentTime
    // 끝난 구간 정리
    while (this.segs.length > 1 && this.segs[1].ctx0 <= now) {
      this.segs.shift()
    }
    const cur = this.segs[0]
    const endCtx = cur.ctx0 + (cur.songEnd - cur.song0) / this.rate

    if (!cur.loops && now >= endCtx) {
      this.stopAll()
      this.offset = this.duration
      this.onEnded?.()
      return
    }
    // 루프 끝이 다가오면 다음 구간을 정확한 시각에 예약
    if (cur.loops && this.segs.length === 1 && endCtx - now < LOOKAHEAD && this.loopRange) {
      for (const src of cur.sources) src.stop(endCtx)
      this.startSegment(endCtx, this.loopRange.start)
    }

    for (const seg of this.segs) {
      const horizon = Math.min(seg.songEnd, seg.song0 + (now + LOOKAHEAD - seg.ctx0) * this.rate)
      if (horizon <= seg.schedUntil) continue
      for (const s of this.synth.values()) {
        for (let i = lowerBound(s.notes, seg.schedUntil); i < s.notes.length && s.notes[i].start < horizon; i++) {
          const n = s.notes[i]
          const at = seg.ctx0 + (n.start - seg.song0) / this.rate
          const dur = (Math.min(n.end, seg.songEnd) - n.start) / this.rate
          this.voice(n.pitch, Math.max(at, now), dur, n.velocity, s.gain)
        }
      }
      seg.schedUntil = horizon
    }
  }

  /** 신스 한 음 (트라이앵글 + 짧은 엔벨로프) */
  private voice(pitch: number, at: number, dur: number, velocity: number, out: AudioNode) {
    const osc = this.ctx.createOscillator()
    const env = this.ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = midiToHz(pitch)
    const peak = 0.25 * (velocity / 127)
    const end = at + Math.max(0.05, dur)
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(peak, at + 0.01)
    env.gain.setTargetAtTime(peak * 0.6, at + 0.01, 0.1)
    env.gain.setTargetAtTime(0, end, 0.03)
    osc.connect(env).connect(out)
    osc.start(at)
    osc.stop(end + 0.2)
  }

  /** 건반/노트 클릭 미리듣기 */
  preview(pitch: number, dur = 0.4) {
    void this.ctx.resume()
    this.voice(pitch, this.ctx.currentTime, dur, 100, this.master)
  }

  dispose() {
    this.stopAll()
    void this.ctx.close()
  }
}
