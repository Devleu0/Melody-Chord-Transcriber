import type { TrackData, TrackState } from '../types'

interface Props {
  states: TrackState[]
  tracks: TrackData[]
  onChange: (id: string, patch: Partial<TrackState>) => void
  midiUrl: (path: string) => string
}

export function TrackPanel({ states, tracks, onChange, midiUrl }: Props) {
  return (
    <aside className="tracks">
      <div className="tracks-head">트랙</div>
      {states.map((s) => {
        const data = tracks.find((t) => t.id === s.id)
        return (
          <div key={s.id} className="track" style={{ borderLeftColor: s.color }}>
            <div className="track-top">
              <span className="track-name">{s.label}</span>
              {s.hasNotes && <span className="track-count">{data?.notes?.length ?? 0} notes</span>}
            </div>
            <div className="track-btns">
              <button
                className={`tbtn ${!s.audioOn ? 'on-red' : ''}`}
                title="오디오 음소거"
                onClick={() => onChange(s.id, { audioOn: !s.audioOn })}
              >
                M
              </button>
              <button
                className={`tbtn ${s.solo ? 'on-yellow' : ''}`}
                title="솔로"
                onClick={() => onChange(s.id, { solo: !s.solo })}
              >
                S
              </button>
              {s.hasNotes && (
                <>
                  <button
                    className={`tbtn wide ${s.showNotes ? 'on' : ''}`}
                    title="피아노롤에 노트 표시"
                    onClick={() => onChange(s.id, { showNotes: !s.showNotes })}
                  >
                    노트
                  </button>
                  <button
                    className={`tbtn wide ${s.synthOn ? 'on' : ''}`}
                    title="채보된 노트를 신스로 재생"
                    onClick={() => onChange(s.id, { synthOn: !s.synthOn })}
                  >
                    신스
                  </button>
                </>
              )}
            </div>
            <div className="track-bottom">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.volume}
                onChange={(e) => onChange(s.id, { volume: Number(e.target.value) })}
              />
              {data?.midi && (
                <a className="midi-link" href={midiUrl(data.midi)} download={`${s.id}.mid`}>
                  .mid
                </a>
              )}
            </div>
          </div>
        )
      })}
    </aside>
  )
}
