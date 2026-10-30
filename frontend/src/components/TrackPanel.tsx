import { useState } from 'react'
import type { ChordResult, TrackData, TrackState } from '../types'

interface ParamDef {
  key: string
  label: string
  min: number
  max: number
  step: number
}

const VOCAL_PARAMS: ParamDef[] = [
  { key: 'conf_threshold', label: '음정 신뢰도 하한', min: 0.05, max: 0.9, step: 0.05 },
  { key: 'min_note_sec', label: '최소 노트 길이 (s)', min: 0.03, max: 0.4, step: 0.01 },
  { key: 'silence_db', label: '무음 기준 (dB)', min: -70, max: -15, step: 1 },
]
const POLY_PARAMS: ParamDef[] = [
  { key: 'onset_threshold', label: '온셋 임계값 (↑ 적게)', min: 0.1, max: 0.9, step: 0.05 },
  { key: 'frame_threshold', label: '프레임 임계값 (↑ 적게)', min: 0.1, max: 0.9, step: 0.05 },
  { key: 'minimum_note_length', label: '최소 노트 길이 (ms)', min: 30, max: 300, step: 10 },
]
const VOCAL_DEFAULT = { conf_threshold: 0.3, min_note_sec: 0.08, silence_db: -40 }
const POLY_DEFAULT = { onset_threshold: 0.5, frame_threshold: 0.3, minimum_note_length: 80 }

interface Props {
  states: TrackState[]
  tracks: TrackData[]
  onChange: (id: string, patch: Partial<TrackState>) => void
  midiUrl: (path: string) => string
  editMode: boolean
  editTrack: string | null
  onEditTrack: (id: string) => void
  busy: string | null // 재채보/재분석 중인 트랙 id
  onRetranscribe: (track: string, params: Record<string, number>) => void
  chords: ChordResult | null
  onReanalyzeChords: (penalty: number) => void
}

function ParamPanel({
  defs,
  initial,
  defaults,
  busy,
  onRun,
  runLabel,
}: {
  defs: ParamDef[]
  initial: Record<string, number>
  defaults: Record<string, number>
  busy: boolean
  onRun: (p: Record<string, number>) => void
  runLabel: string
}) {
  const [vals, setVals] = useState<Record<string, number>>({ ...defaults, ...initial })
  return (
    <div className="params">
      {defs.map((d) => (
        <label key={d.key} className="param">
          <span>
            {d.label} <b>{vals[d.key]}</b>
          </span>
          <input
            type="range"
            min={d.min}
            max={d.max}
            step={d.step}
            value={vals[d.key]}
            onChange={(e) => setVals((v) => ({ ...v, [d.key]: Number(e.target.value) }))}
          />
        </label>
      ))}
      <div className="param-btns">
        <button className="tbtn" onClick={() => setVals({ ...defaults })} disabled={busy}>
          기본값
        </button>
        <button className="tbtn on" onClick={() => onRun(vals)} disabled={busy}>
          {busy ? '처리 중…' : runLabel}
        </button>
      </div>
    </div>
  )
}

export function TrackPanel(p: Props) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <aside className="tracks">
      <div className="tracks-head">트랙</div>
      {p.states.map((s) => {
        const data = p.tracks.find((t) => t.id === s.id)
        const isChord = s.id === 'chords'
        const isTarget = p.editMode && p.editTrack === s.id
        return (
          <div key={s.id} className={`track ${isTarget ? 'target' : ''}`} style={{ borderLeftColor: s.color }}>
            <div className="track-top">
              <span className="track-name">
                {s.label}
                {data?.edited && <span className="badge">편집됨</span>}
              </span>
              {s.hasNotes && <span className="track-count">{data?.notes?.length ?? 0} notes</span>}
              {isChord && p.chords && (
                <span className="track-count">
                  {p.chords.chords.length}개 · {p.chords.engine === 'btc' ? 'BTC' : '템플릿'}
                </span>
              )}
            </div>
            <div className="track-btns">
              {!isChord && (
                <>
                  <button
                    className={`tbtn ${!s.audioOn ? 'on-red' : ''}`}
                    title="오디오 음소거"
                    onClick={() => p.onChange(s.id, { audioOn: !s.audioOn })}
                  >
                    M
                  </button>
                  <button
                    className={`tbtn ${s.solo ? 'on-yellow' : ''}`}
                    title="솔로"
                    onClick={() => p.onChange(s.id, { solo: !s.solo })}
                  >
                    S
                  </button>
                </>
              )}
              {(s.hasNotes || isChord) && (
                <>
                  <button
                    className={`tbtn wide ${s.showNotes ? 'on' : ''}`}
                    title={isChord ? '코드 레인 표시' : '피아노롤에 노트 표시'}
                    onClick={() => p.onChange(s.id, { showNotes: !s.showNotes })}
                  >
                    {isChord ? '레인' : '노트'}
                  </button>
                  <button
                    className={`tbtn wide ${s.synthOn ? 'on' : ''}`}
                    title={isChord ? '코드를 신스로 재생' : '채보된 노트를 신스로 재생'}
                    onClick={() => p.onChange(s.id, { synthOn: !s.synthOn })}
                  >
                    신스
                  </button>
                </>
              )}
              {s.hasNotes && p.editMode && (
                <button
                  className={`tbtn ${isTarget ? 'on-yellow' : ''}`}
                  title="편집 대상 트랙"
                  onClick={() => p.onEditTrack(s.id)}
                >
                  ✎
                </button>
              )}
              {(s.hasNotes || (isChord && p.chords)) && (
                <button
                  className={`tbtn ${open === s.id ? 'on' : ''}`}
                  title={isChord ? '코드 분석 설정' : '채보 민감도 설정'}
                  onClick={() => setOpen(open === s.id ? null : s.id)}
                >
                  ⚙
                </button>
              )}
            </div>
            <div className="track-bottom">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.volume}
                onChange={(e) => p.onChange(s.id, { volume: Number(e.target.value) })}
              />
              {data?.midi && (
                <a className="midi-link" href={p.midiUrl(data.midi)} download={`${s.id}.mid`}>
                  .mid
                </a>
              )}
            </div>
            {open === s.id && s.hasNotes && (
              <ParamPanel
                defs={s.id === 'vocals' ? VOCAL_PARAMS : POLY_PARAMS}
                defaults={s.id === 'vocals' ? VOCAL_DEFAULT : POLY_DEFAULT}
                initial={data?.params ?? {}}
                busy={p.busy === s.id}
                runLabel="다시 채보"
                onRun={(params) => p.onRetranscribe(s.id, params)}
              />
            )}
            {open === s.id && isChord && p.chords && (
              <ParamPanel
                defs={[{ key: 'change_penalty', label: '코드 변경 억제 (↑ 덜 바뀜)', min: 0.5, max: 10, step: 0.5 }]}
                defaults={{ change_penalty: 3 }}
                initial={p.chords.change_penalty != null ? { change_penalty: p.chords.change_penalty } : {}}
                busy={p.busy === 'chords'}
                runLabel="다시 분석"
                onRun={(params) => p.onReanalyzeChords(params.change_penalty)}
              />
            )}
            {open === s.id && data?.edited && (
              <div className="param-warn">다시 채보하면 직접 편집한 내용은 덮어씁니다 (Ctrl+Z로 복구 가능)</div>
            )}
          </div>
        )
      })}
    </aside>
  )
}
