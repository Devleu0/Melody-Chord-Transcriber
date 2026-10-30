import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { AudioEngine, type LoopRange } from './audio/engine'
import { HistoryPanel } from './components/HistoryPanel'
import { PianoRoll, type PianoRollHandle } from './components/PianoRoll'
import { TrackPanel } from './components/TrackPanel'
import { chordToNotes, leadSheet } from './music/chords'
import { fmtTime, pitchName } from './music/format'
import { beatIndex, makeGrid, snapTime, stepAt } from './music/grid'
import { ALL_KEYS, detectKey, keyId, keyName, parseKeyId } from './music/key'
import type { Job, Note, Result, Separator, TrackData, TrackState } from './types'

const TRACK_META: Record<string, { label: string; color: string }> = {
  mix: { label: '원곡', color: '#adb5bd' },
  chords: { label: '코드', color: '#b197fc' },
  vocals: { label: '보컬', color: '#ff6b8b' },
  accompaniment: { label: '반주', color: '#4dabf7' },
  bass: { label: '베이스', color: '#ffd43b' },
  other: { label: '기타 악기', color: '#69db7c' },
  drums: { label: '드럼', color: '#868e96' },
}
// 피아노롤에서 아래→위 순서로 그려짐 (보컬이 맨 위)
const ORDER = ['mix', 'chords', 'drums', 'accompaniment', 'bass', 'other', 'vocals']

const STAGES: Job['status'][] = ['queued', 'downloading', 'separating', 'transcribing', 'chords', 'finalizing', 'done']
const STAGE_LABEL: Record<string, string> = {
  queued: '대기',
  downloading: '다운로드',
  separating: '음원 분리',
  transcribing: '채보',
  chords: '코드 분석',
  finalizing: '마무리',
  done: '완료',
}

const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1]
const SNAPS = [
  { div: 0, label: '스냅 끔' },
  { div: 1, label: '1박' },
  { div: 2, label: '1/2박' },
  { div: 4, label: '1/4박' },
]
const PEAKS_RATE = 200

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`yt-amt.${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`yt-amt.${key}`, JSON.stringify(value))
  } catch {
    /* 저장 불가 환경 */
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error'

export default function App() {
  const [url, setUrl] = useState('')
  const [separator, setSeparator] = useState<Separator>('roformer')
  const [jobs, setJobs] = useState<Job[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const resultRef = useRef<Result | null>(null)
  resultRef.current = result
  const [states, setStates] = useState<TrackState[]>([])
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [follow, setFollow] = useState(true)
  const [selected, setSelected] = useState<{ note: Note; track: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const engineRef = useRef<AudioEngine | null>(null)
  const [engine, setEngine] = useState<AudioEngine | null>(null)
  const rollRef = useRef<PianoRollHandle>(null)
  const [loop, setLoop] = useState<LoopRange | null>(null)
  const [loopOn, setLoopOn] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [speedLoading, setSpeedLoading] = useState(false)
  const [master, setMaster] = useState(() => loadPref('master', 0.8))
  const [showWave, setShowWave] = useState(() => loadPref('showWave', true))
  const [keyChoice, setKeyChoice] = useState<string>('auto') // 'auto' | 'off' | keyId
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // 편집
  const [editMode, setEditMode] = useState(false)
  const [editTrack, setEditTrack] = useState<string | null>('vocals')
  const [snapDiv, setSnapDiv] = useState(() => loadPref('snapDiv', 4))
  const undoStack = useRef<{ track: string; notes: Note[] }[]>([])
  const redoStack = useRef<{ track: string; notes: Note[] }[]>([])
  const [, setStackVersion] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const pendingSave = useRef(new Set<string>())
  const saveTimer = useRef<number | undefined>(undefined)

  const job = jobs.find((j) => j.id === jobId) ?? null
  const running = !!job && job.status !== 'done' && job.status !== 'error'
  const chords = result?.chords?.chords ?? []

  const grid = useMemo(() => makeGrid(result?.beats ?? [], duration || 1), [result?.beats, duration])
  // 전체 채보 노트로 조성 추정
  const detectedKey = useMemo(
    () => (result ? detectKey(result.tracks.flatMap((t) => t.notes ?? [])) : null),
    [result],
  )
  const scaleKey = keyChoice === 'off' ? null : keyChoice === 'auto' ? detectedKey : parseKeyId(keyChoice)
  const nameKey = scaleKey ?? detectedKey

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

  // --- 저장 (편집 후 자동) ---
  const flushSave = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const r = resultRef.current
    if (!r || pendingSave.current.size === 0) return
    const tracks = [...pendingSave.current]
    pendingSave.current.clear()
    setSaveState('saving')
    try {
      for (const id of tracks) {
        const notes = r.tracks.find((t) => t.id === id)?.notes
        if (notes) await api.saveNotes(r.job_id, id, notes)
      }
      setSaveState(pendingSave.current.size ? 'pending' : 'saved')
    } catch (e) {
      tracks.forEach((id) => pendingSave.current.add(id))
      setSaveState('error')
      setError(`저장 실패: ${e}`)
    }
  }, [])

  const scheduleSave = useCallback(
    (track: string) => {
      pendingSave.current.add(track)
      setSaveState('pending')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void flushSave(), 600)
    },
    [flushSave],
  )

  /** 트랙 데이터 교체 (+실행 취소 기록) */
  const replaceTrack = useCallback((track: string, patch: Partial<TrackData>, record = true) => {
    const r = resultRef.current
    if (!r) return
    const prev = r.tracks.find((t) => t.id === track)
    if (!prev?.notes) return
    if (record) {
      undoStack.current.push({ track, notes: prev.notes })
      if (undoStack.current.length > 200) undoStack.current.shift()
      redoStack.current = []
    }
    const next = { ...r, tracks: r.tracks.map((t) => (t.id === track ? { ...t, ...patch } : t)) }
    resultRef.current = next
    setResult(next)
    setStackVersion((v) => v + 1)
  }, [])

  const editNotes = useCallback(
    (track: string, notes: Note[]) => {
      replaceTrack(track, { notes: [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch), edited: true })
      scheduleSave(track)
    },
    [replaceTrack, scheduleSave],
  )

  const onEditNote = useCallback(
    (track: string, before: Note | null, after: Note | null) => {
      const notes = resultRef.current?.tracks.find((t) => t.id === track)?.notes
      if (!notes) return
      const next = before ? notes.filter((n) => n !== before) : [...notes]
      if (after) next.push(after)
      editNotes(track, next)
      setSelected(after ? { note: after, track } : null)
    },
    [editNotes],
  )

  const undoRedo = useCallback(
    (dir: 'undo' | 'redo') => {
      const from = dir === 'undo' ? undoStack.current : redoStack.current
      const to = dir === 'undo' ? redoStack.current : undoStack.current
      const entry = from.pop()
      const r = resultRef.current
      if (!entry || !r) return
      const cur = r.tracks.find((t) => t.id === entry.track)?.notes ?? []
      to.push({ track: entry.track, notes: cur })
      replaceTrack(entry.track, { notes: entry.notes, edited: true }, false)
      scheduleSave(entry.track)
      setSelected(null)
    },
    [replaceTrack, scheduleSave],
  )

  const quantize = useCallback(() => {
    const r = resultRef.current
    const notes = r?.tracks.find((t) => t.id === editTrack)?.notes
    if (!editTrack || !notes || !snapDiv) return
    editNotes(
      editTrack,
      notes.map((n) => {
        const start = Math.max(0, snapTime(grid, n.start, snapDiv))
        let end = snapTime(grid, n.end, snapDiv)
        if (end <= start + 1e-3) end = start + stepAt(grid, start, snapDiv)
        return { ...n, start: +start.toFixed(3), end: +end.toFixed(3) }
      }),
    )
    setSelected(null)
  }, [editTrack, snapDiv, grid, editNotes])

  // --- 결과 로드 ---
  useEffect(() => {
    if (!job || job.status !== 'done' || result?.job_id === job.id) return
    let cancelled = false
    ;(async () => {
      await flushSave()
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
      setLoop(null)
      setLoopOn(false)
      setSpeed(1)
      setKeyChoice('auto')
      setPeaks(null)
      setDuration(res.meta.duration ?? 0)
      setEditMode(false)
      undoStack.current = []
      redoStack.current = []
      const ids = ['chords', ...res.tracks.map((t) => t.id)]
      const sorted = ids.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
      setStates(
        sorted.map((id) => {
          const t = res.tracks.find((d) => d.id === id)
          return {
            id,
            label: TRACK_META[id]?.label ?? id,
            color: TRACK_META[id]?.color ?? '#ced4da',
            hasNotes: !!t?.notes,
            showNotes: id === 'chords' || !!t?.notes,
            audioOn: id === 'mix',
            solo: false,
            volume: id === 'chords' ? 0.6 : 0.9,
            synthOn: false,
          }
        }),
      )
      setLoadingAudio(true)
      try {
        await Promise.all(res.tracks.map((t) => eng.loadAudio(t.id, api.fileUrl(res.job_id, t.audio))))
        if (cancelled) return
        setDuration(eng.duration)
        setPeaks(eng.peaks('mix', PEAKS_RATE))
      } finally {
        if (!cancelled) setLoadingAudio(false)
      }
    })().catch((e) => setError(String(e)))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status])

  // 채보/코드 → 엔진 신스 노트
  useEffect(() => {
    if (!engine || !result) return
    for (const t of result.tracks) if (t.notes) engine.setNotes(t.id, t.notes)
    engine.setNotes('chords', chordToNotes(result.chords?.chords ?? []))
  }, [engine, result])

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

  useEffect(() => {
    engine?.setLoop(loopOn ? loop : null)
  }, [engine, loop, loopOn])

  useEffect(() => {
    engine?.setMasterVolume(master)
    savePref('master', master)
  }, [engine, master])

  useEffect(() => savePref('showWave', showWave), [showWave])
  useEffect(() => savePref('snapDiv', snapDiv), [snapDiv])

  async function changeSpeed(next: number) {
    const eng = engineRef.current
    if (!eng || !result) return
    setSpeedLoading(true)
    setError(null)
    try {
      const urls = new Map(
        result.tracks.map((t) => [
          t.id,
          next === 1 ? api.fileUrl(result.job_id, t.audio) : api.stretchUrl(result.job_id, t.audio, next),
        ]),
      )
      await eng.setRate(next, urls)
      setSpeed(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setSpeedLoading(false)
    }
  }

  async function retranscribe(track: string, params: Record<string, number>) {
    const r = resultRef.current
    if (!r) return
    setBusy(track)
    setError(null)
    try {
      await flushSave()
      const data = await api.retranscribe(r.job_id, track, params)
      replaceTrack(track, { notes: data.notes, pitch_curve: data.pitch_curve, params: data.params, edited: false })
      setSelected(null)
    } catch (e) {
      setError(`재채보 실패: ${e}`)
    } finally {
      setBusy(null)
    }
  }

  async function reanalyzeChords(penalty: number) {
    const r = resultRef.current
    if (!r) return
    setBusy('chords')
    setError(null)
    try {
      const c = await api.reanalyzeChords(r.job_id, penalty)
      const next = { ...(resultRef.current ?? r), chords: c }
      resultRef.current = next
      setResult(next)
    } catch (e) {
      setError(`코드 분석 실패: ${e}`)
    } finally {
      setBusy(null)
    }
  }

  async function deleteJob(id: string) {
    try {
      await api.deleteJob(id)
      if (id === jobId) {
        engineRef.current?.dispose()
        engineRef.current = null
        setEngine(null)
        setResult(null)
        setJobId(null)
      }
      await refreshJobs()
    } catch (e) {
      setError(`삭제 실패: ${e}`)
    }
  }

  const changeLoop = useCallback((r: LoopRange | null) => {
    setLoop(r)
    setLoopOn(!!r)
  }, [])

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

  const seekTo = useCallback((t: number) => {
    engineRef.current?.seek(t)
    setTime(engineRef.current?.currentTime ?? t)
  }, [])

  // 단축키
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
      const ctrl = e.ctrlKey || e.metaKey
      const eng = engineRef.current
      if (ctrl && e.code === 'KeyZ') {
        e.preventDefault()
        undoRedo(e.shiftKey ? 'redo' : 'undo')
      } else if (ctrl && e.code === 'KeyY') {
        e.preventDefault()
        undoRedo('redo')
      } else if (ctrl) {
        return
      } else if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Home') {
        seekTo(loopOn && loop ? loop.start : 0)
      } else if (e.code === 'KeyL' && loop) {
        setLoopOn((v) => !v)
      } else if (e.code === 'Escape') {
        if (selected) setSelected(null)
        else changeLoop(null)
      } else if (e.code === 'KeyE' && result) {
        setEditMode((v) => !v)
      } else if (e.code === 'KeyQ' && editMode) {
        quantize()
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && editMode && selected && selected.track === editTrack) {
        e.preventDefault()
        onEditNote(selected.track, selected.note, null)
      } else if (e.code === 'KeyF') {
        rollRef.current?.fitPitch()
      } else if (e.key === '+' || e.key === '=') {
        rollRef.current?.zoomTime(1.4)
      } else if (e.key === '-' || e.key === '_') {
        rollRef.current?.zoomTime(1 / 1.4)
      } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && eng) {
        // ← → 한 마디(4박) 이동
        e.preventDefault()
        const i = beatIndex(grid, eng.currentTime + 0.01)
        const target = grid.beats[Math.max(0, i + (e.code === 'ArrowRight' ? 4 : -4))] ?? 0
        seekTo(Math.max(0, target))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekTo, loop, loopOn, selected, editMode, editTrack, result, grid, undoRedo, quantize, onEditNote, changeLoop])

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

  const chordState = states.find((s) => s.id === 'chords')
  const editable = result?.tracks.filter((t) => t.notes) ?? []

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
        <button className="history-btn" onClick={() => setHistoryOpen(true)}>
          📁 작업 기록 <span>{jobs.length}</span>
        </button>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError(null)} title="클릭해서 닫기">
          {error}
        </div>
      )}

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
          {fmtTime(time)} / {fmtTime(duration)}
        </span>
        {result && <span className="chip">♩ {result.tempo.toFixed(1)} BPM</span>}
        <button
          className={`chip btn ${loopOn ? 'active' : ''}`}
          disabled={!loop}
          title="반복 (L) · 룰러 드래그 또는 코드 클릭으로 구간 지정 · Esc 해제"
          onClick={() => setLoopOn((v) => !v)}
        >
          ⟲ 반복{loop ? ` ${fmtTime(loop.start)}–${fmtTime(loop.end)}` : ''}
        </button>
        <label className="chip" title="음정 유지 재생 속도">
          속도{' '}
          <select
            value={speed}
            disabled={!engine || loadingAudio || speedLoading}
            onChange={(e) => void changeSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          {speedLoading && ' …'}
        </label>
        <label className="chip" title="스케일 밖 음을 어둡게 표시 · 코드 철자/로마숫자 기준">
          키{' '}
          <select value={keyChoice} onChange={(e) => setKeyChoice(e.target.value)} disabled={!result}>
            <option value="auto">자동{detectedKey ? `: ${keyName(detectedKey)}` : ''}</option>
            <option value="off">끄기</option>
            {ALL_KEYS.map((k) => (
              <option key={keyId(k)} value={keyId(k)}>
                {keyName(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="chip check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 따라가기
        </label>
        <label className="chip check">
          <input type="checkbox" checked={showWave} onChange={(e) => setShowWave(e.target.checked)} /> 파형
        </label>
        <button className="chip btn" disabled={!result} onClick={() => rollRef.current?.fitPitch()} title="화면 맞춤 (F)">
          ⤢ 맞춤
        </button>
        <button
          className={`chip btn ${editMode ? 'active' : ''}`}
          disabled={!result}
          onClick={() => setEditMode((v) => !v)}
          title="노트 편집 모드 (E)"
        >
          ✎ 편집
        </button>
        <label className="chip master" title="마스터 볼륨">
          🔊
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={master}
            onChange={(e) => setMaster(Number(e.target.value))}
          />
          <span>{Math.round(master * 100)}%</span>
        </label>
        {loadingAudio && <span className="chip">오디오 로딩 중…</span>}
        <div className="spacer" />
        {result && (
          <>
            <span className="title" title={result.meta.title}>
              {result.meta.title}
            </span>
            <details className="export">
              <summary className="chip btn">내보내기 ▾</summary>
              <div className="menu">
                <a href={api.fileUrl(result.job_id, 'midi/all.mid')} download="all.mid">
                  전체 MIDI (모든 트랙 + 코드)
                </a>
                <a href={api.fileUrl(result.job_id, 'midi/chords.mid')} download="chords.mid">
                  코드 MIDI
                </a>
                <button
                  onClick={() =>
                    download(
                      'leadsheet.txt',
                      leadSheet(chords, grid, nameKey, { title: result.meta.title, tempo: result.tempo }),
                    )
                  }
                >
                  코드 리드시트 (.txt)
                </button>
                {editable.map((t) => (
                  <a key={t.id} href={api.musicxmlUrl(result.job_id, t.id)} download={`${t.id}.musicxml`}>
                    MusicXML · {TRACK_META[t.id]?.label ?? t.id} + 코드
                  </a>
                ))}
              </div>
            </details>
          </>
        )}
      </div>

      {editMode && result && (
        <div className="editbar">
          <span className="chip">
            편집 대상
            <select value={editTrack ?? ''} onChange={(e) => setEditTrack(e.target.value)}>
              {editable.map((t) => (
                <option key={t.id} value={t.id}>
                  {TRACK_META[t.id]?.label ?? t.id}
                </option>
              ))}
            </select>
          </span>
          <span className="chip">
            격자
            <select value={snapDiv} onChange={(e) => setSnapDiv(Number(e.target.value))}>
              {SNAPS.map((s) => (
                <option key={s.div} value={s.div}>
                  {s.label}
                </option>
              ))}
            </select>
          </span>
          <button className="chip btn" disabled={!snapDiv} onClick={quantize} title="편집 대상 트랙 전체를 격자에 맞춤 (Q)">
            퀀타이즈
          </button>
          <button className="chip btn" disabled={!undoStack.current.length} onClick={() => undoRedo('undo')} title="Ctrl+Z">
            ↶ 실행 취소
          </button>
          <button className="chip btn" disabled={!redoStack.current.length} onClick={() => undoRedo('redo')} title="Ctrl+Shift+Z">
            ↷ 다시 실행
          </button>
          <span className={`chip save ${saveState}`}>
            {saveState === 'saved' ? '✓ 저장됨' : saveState === 'saving' ? '저장 중…' : saveState === 'pending' ? '● 변경됨' : '저장 실패'}
          </span>
          <span className="hint">드래그: 이동 · 끝 드래그: 길이 · 더블클릭: 추가 · 우클릭/Delete: 삭제 · Shift: 스냅 해제</span>
        </div>
      )}

      {selected && (
        <div className="selbar">
          {pitchName(selected.note.pitch)} · {selected.note.start.toFixed(2)}s ~ {selected.note.end.toFixed(2)}s · vel{' '}
          {selected.note.velocity} · {TRACK_META[selected.track]?.label}
        </div>
      )}

      <main className="workspace">
        {result ? (
          <>
            <TrackPanel
              states={states}
              tracks={result.tracks}
              onChange={patchTrack}
              midiUrl={(p) => api.fileUrl(result.job_id, p)}
              editMode={editMode}
              editTrack={editTrack}
              onEditTrack={setEditTrack}
              busy={busy}
              onRetranscribe={(t, p) => void retranscribe(t, p)}
              chords={result.chords ?? null}
              onReanalyzeChords={(p) => void reanalyzeChords(p)}
            />
            <PianoRoll
              ref={rollRef}
              viewKey={result.job_id}
              engine={engine}
              tracks={result.tracks}
              states={states.filter((s) => s.id !== 'chords')}
              grid={grid}
              duration={duration}
              follow={follow}
              selected={selected?.note ?? null}
              onSelect={(note, track) => setSelected(note && track ? { note, track } : null)}
              scaleKey={scaleKey}
              nameKey={nameKey}
              loop={loop}
              loopOn={loopOn}
              onLoopChange={changeLoop}
              chords={chords}
              showChords={chordState?.showNotes ?? true}
              peaks={peaks}
              peaksRate={PEAKS_RATE}
              showWave={showWave}
              editMode={editMode}
              editTrack={editTrack}
              snapDiv={snapDiv}
              onEditNote={onEditNote}
            />
          </>
        ) : (
          <div className="empty">
            <p>
              YouTube 링크를 넣고 분리 엔진을 고른 뒤 <b>채보 시작</b>을 누르세요.
            </p>
            <p className="sub">RoFormer: 보컬/반주 2트랙 · Demucs: 보컬/베이스/기타/드럼 4트랙 · 코드 진행은 자동 분석</p>
            {jobs.some((j) => j.status === 'done') && (
              <button className="tbtn on" onClick={() => setHistoryOpen(true)}>
                이전 작업 열기
              </button>
            )}
          </div>
        )}
      </main>

      <footer className="statusbar">
        Space 재생 · ←/→ 마디 이동 · L 반복 · E 편집 · F 맞춤 · +/− 줌 · Ctrl+휠 줌 · Alt+휠 건반 높이 · 미니맵 클릭/드래그 이동
      </footer>

      {historyOpen && (
        <HistoryPanel
          jobs={jobs}
          current={jobId}
          onOpen={(id) => {
            setJobId(id)
            setHistoryOpen(false)
          }}
          onDelete={(id) => void deleteJob(id)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  )
}
