import { useI18n } from '../i18n'
import { fmtTime } from '../music/format'
import type { Separator, ServerInfo } from '../types'
import { assess, type Level, type Preview } from '../validate'

const ICON: Record<Level, string> = { info: 'ℹ', warn: '⚠', error: '⛔' }

interface Props {
  preview: Preview
  info: ServerInfo | null
  separator: Separator
  onOpenJob: (id: string) => void
}

export function InputPreview({ preview: p, info, separator, onOpenJob }: Props) {
  const { t, lang } = useI18n()
  const { msgs } = assess(p, info, separator, t)
  const dups = p.duplicates ?? []
  const meta = [
    p.uploader,
    p.duration ? `${t('pv.length')} ${fmtTime(p.duration)}` : null,
    p.size != null ? `${(p.size / 1024 / 1024).toFixed(1)} MB` : null,
  ].filter(Boolean)

  return (
    <div className="preview" aria-live="polite">
      {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <div className="thumb">{p.kind === 'file' ? '🎵' : '🔗'}</div>}
      <div className="preview-body">
        {p.loading ? (
          <div className="preview-title muted">{t('pv.loading')}</div>
        ) : (
          (p.title || meta.length > 0) && (
            <>
              {p.title && <div className="preview-title">{p.title}</div>}
              {meta.length > 0 && <div className="preview-meta">{meta.join(' · ')}</div>}
            </>
          )
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`preview-msg ${m.level}`}>
            <span aria-hidden>{ICON[m.level]}</span> {m.text}
          </div>
        ))}
        {dups.length > 0 && (
          <div className="preview-msg warn">
            <span aria-hidden>↺</span> {t('pv.dup')}
            {dups.slice(0, 3).map((d) => (
              <button key={d.id} type="button" className="tbtn on" disabled={d.status !== 'done'} onClick={() => onOpenJob(d.id)}>
                {d.status === 'done' ? t('pv.dupOpen') : t('pv.dupRunning')} · {d.separator === 'roformer' ? 'RoFormer' : 'Demucs'} ·{' '}
                {new Date(d.created_at * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US')}
              </button>
            ))}
            <small>{t('pv.dupHint')}</small>
          </div>
        )}
      </div>
    </div>
  )
}
