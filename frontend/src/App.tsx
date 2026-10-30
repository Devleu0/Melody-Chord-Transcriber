import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AudioEngine } from './audio/engine'
import { PianoRoll, fmtTime, pitchName } from './components/PianoRoll'
import { TrackPanel } from './components/TrackPanel'
import type { Job, Note, Result, Separator, TrackState } from './types'

const TRACK_META: Record<string, { label: string; color: string }> = {
  mix: { label: '원곡', color: '#adb5bd' },
  vocals: { label: '보컬', color: '#ff6b8b' },
  accompaniment: { label: '반주', color: '#4dabf7' },
  bass: { label: '베이스', color: '#ffd43b' },
  other: { label: '기타 악기', color: '#69db7c' },
  drums: { label: '드럼', color: '#868e96' },
}
// 피아노롤에서 아래→위 순서로 그려짐 (보컬이 맨 위)
const ORDER = ['mix', 'drums', 'accompaniment', 'bass', 'other', 'vocals']

const STAGES: Job['status'][] = ['queued', 'downloading', 'separating', 'transcribing', 'finalizing', 'done']
const STAGE_LABEL: Record<string, string> = {
  queued: '대기',
  downloading: '다운로드',
  separating: '음원 분리',
  transcribing: '채보',
  finalizing: '마무리',
  done: '완료',
}

export default function App() {
  const [url, setUrl] = useState('')
  const [separator, setSeparator] = useState<Separator>('roformer')
  const [jobs, setJobs] = useState<Job[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [states, setStates] = useState<TrackState[]>([])
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [follow, setFollow] = useState(true)
  const [selected, setSelected] = useState<{ note: Note; track: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const engineRef = useRef<AudioEngine | null>(null)
  const [engine, setEngine] = useState<AudioEngine | null>(null)

  const job = jobs.find((j) => j.id === jobId) ?? null
  const running = !!job && job.status !== 'done' && job.status !== 'error'

  const refreshJobs = useCallback(() => api.listJobs().then(setJobs).catch(() => {}), [])

  useEffect(() => {
    void refreshJobs()
  }, [refreshJobs])

  // 진행 중 작업 폴링
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(refreshJobs, 1000)
    return () => window.clearInterval(t)
  }, [running, refreshJobs])

  // 완료되면 결과 + 오디오 로드
  useEffect(() => {
    if (!job || job.status !== 'done' || result?.job_id === job.id) return
    let cancelled = false
    ;(async () => {
      const res = await api.getResult(job.id)
      if (cancelled) return
      engineRef.current?.dispose()
      const eng = new AudioEngine()
      eng.onEnded = () => setPlaying(false)
      engineRef.current = eng
      setEngine(eng)
      setResult(res)
      setSelected(null)
      setTime(0)
      setPlaying(false)
      const sorted = [...res.tracks].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
      setStates(
        sorted.map((t) => ({
          id: t.id,
          label: TRACK_META[t.id]?.label ?? t.id,
          color: TRACK_META[t.id]?.color ?? '#ced4da',
          hasNotes: !!t.notes,
          showNotes: !!t.notes,
          audioOn: t.id === 'mix',
          solo: false,
          volume: 0.9,
          synthOn: false,
        })),
      )
      setLoadingAudio(true)
      try {
        await Promise.all(res.tracks.map((t) => eng.loadAudio(t.id, api.fileUrl(res.job_id, t.audio))))
        res.tracks.forEach((t) => t.notes && eng.setNotes(t.id, t.notes))
      } finally {
        if (!cancelled) setLoadingAudio(false)
      }
    })().catch((e) => setError(String(e)))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status])

  // 믹서 상태 → 엔진 게인
  useEffect(() => {
    if (!engine || loadingAudio) return
    const anySolo = states.some((s) => s.solo)
    for (const s of states) {
      const audible = anySolo ? s.solo : s.audioOn
      engine.setAudioGain(s.id, audible ? s.volume : 0)
      engine.setSynthGain(s.id, s.synthOn && (!anySolo || s.solo) ? s.volume : 0)
    }
  }, [states, engine, loadingAudio])

  // 시간 표시 갱신
  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => setTime(engineRef.current?.currentTime ?? 0), 100)
    return () => window.clearInterval(t)
  }, [playing])

  const togglePlay = useCallback(() => {
    const eng = engineRef.current
    if (!eng || loadingAudio) return
    if (eng.isPlaying) {
      eng.pause()
      setPlaying(false)
    } else {
      void eng.play()
      setPlaying(true)
    }
    setTime(eng.currentTime)
  }, [loadingAudio])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Home') {
        engineRef.current?.seek(0)
        setTime(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const j = await api.createJob(url.trim(), separator)
      setJobs((js) => [j, ...js])
      setJobId(j.id)
    } catch (err) {
      setError(String(err))
    }
  }

  const patchTrack = (id: string, patch: Partial<TrackState>) =>
    setStates((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">♪ yt-amt</div>
        <form className="url-form" onSubmit={submit}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="YouTube 음악 링크를 붙여넣으세요"
            required
          />
          <div className="seg">
            <button type="button" className={separator === 'roformer' ? 'on' : ''} onClick={() => setSeparator('roformer')}>
              RoFormer <small>보컬/반주</small>
            </button>
            <button type="button" className={separator === 'demucs' ? 'on' : ''} onClick={() => setSeparator('demucs')}>
              Demucs <small>4분리</small>
            </button>
          </div>
          <button className="primary" disabled={running}>
            채보 시작
          </button>
        </form>
        <select className="history" value={jobId ?? ''} onChange={(e) => setJobId(e.target.value || null)}>
          <option value="">작업 기록 ({jobs.length})</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.status === 'done' ? '✓' : j.status === 'error' ? '✗' : '…'} {j.meta?.title ?? j.url} [{j.separator}]
            </option>
          ))}
        </select>
      </header>

      {error && <div className="banner error">{error}</div>}

      {job && job.status !== 'done' && (
        <div className={`banner ${job.status === 'error' ? 'error' : ''}`}>
          <div className="stages">
            {STAGES.map((s) => (
              <span
                key={s}
                className={`stage ${STAGES.indexOf(s) < STAGES.indexOf(job.status) ? 'past' : ''} ${s === job.status ? 'cur' : ''}`}
              >
                {STAGE_LABEL[s]}
              </span>
            ))}
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <div className="msg">{job.status === 'error' ? `오류: ${job.error}` : job.message}</div>
        </div>
      )}

      <div className="transport">
        <button className="play" onClick={togglePlay} disabled={!engine || loadingAudio}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="time">
          {fmtTime(time)} / {fmtTime(engine?.duration ?? 0)}
        </span>
        {result && <span className="chip">♩ {result.tempo.toFixed(1)} BPM</span>}
        <label className="chip check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 따라가기
        </label>
        {loadingAudio && <span className="chip">오디오 로딩 중…</span>}
        {selected && (
          <span className="chip sel">
            {pitchName(selected.note.pitch)} · {selected.note.start.toFixed(2)}s ~ {selected.note.end.toFixed(2)}s · vel{' '}
            {selected.note.velocity} · {TRACK_META[selected.track]?.label}
          </span>
        )}
        <div className="spacer" />
        {result && (
          <>
            <span className="title" title={result.meta.title}>
              {result.meta.title}
            </span>
            <a className="chip link" href={api.fileUrl(result.job_id, 'midi/all.mid')} download="all.mid">
              전체 MIDI ↓
            </a>
          </>
        )}
        <span className="hint">Space 재생 · 휠 세로 · Shift+휠 가로 · Ctrl+휠 줌 · Alt+휠 건반높이</span>
      </div>

      <main className="workspace">
        {result ? (
          <>
            <TrackPanel
              states={states}
              tracks={result.tracks}
              onChange={patchTrack}
              midiUrl={(p) => api.fileUrl(result.job_id, p)}
            />
            <PianoRoll
              engine={engine}
              tracks={result.tracks}
              states={states}
              beats={result.beats}
              duration={engine?.duration ?? 0}
              follow={follow}
              selected={selected?.note ?? null}
              onSelect={(note, track) => setSelected(note && track ? { note, track } : null)}
            />
          </>
        ) : (
          <div className="empty">
            <p>YouTube 링크를 넣고 분리 엔진을 고른 뒤 <b>채보 시작</b>을 누르세요.</p>
            <p className="sub">RoFormer: 보컬/반주 2트랙 · Demucs: 보컬/베이스/기타/드럼 4트랙</p>
          </div>
        )}
      </main>
    </div>
  )
}
