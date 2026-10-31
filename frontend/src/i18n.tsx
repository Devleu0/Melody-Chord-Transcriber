import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Lang = 'ko' | 'en'

const ko = {
  'app.placeholder': '음악 링크(YouTube, SoundCloud 등)를 붙여넣거나 오디오 파일을 끌어다 놓으세요',
  'app.file.pick': '오디오 파일 선택',
  'app.file.remove': '파일 선택 취소',
  'app.drop': '여기에 오디오 파일을 놓으세요',
  'app.uploading': '업로드 중 {pct}%',
  'err.fileType': '지원하지 않는 파일 형식입니다: {ext}',
  'stage.importing': '불러오기',
  'msg.importing': '오디오 파일 변환 중',
  'pv.loading': '링크 확인 중…',
  'pv.length': '길이',
  'pv.invalidUrl': 'http:// 또는 https:// 로 시작하는 링크를 넣어 주세요',
  'pv.otherSite': '{site} 링크입니다. yt-dlp로 받아 처리합니다 (YouTube 외 사이트는 테스트가 적습니다).',
  'pv.playlist': '재생목록 링크입니다. 이 영상 하나만 처리합니다.',
  'pv.error': '링크를 확인할 수 없습니다: {e}',
  'pv.live': '라이브 스트림은 처리할 수 없습니다',
  'pv.tooBig': '파일이 {max}MB를 넘습니다',
  'pv.tooShort': '{min}초보다 짧은 오디오는 분석할 수 없습니다',
  'pv.tooLong': '{max}분을 넘는 오디오는 처리할 수 없습니다. 곡을 잘라서 넣어 주세요.',
  'pv.longWarn': '긴 곡입니다. 처리 시간이 길고 GPU 메모리가 부족할 수 있습니다.',
  'pv.unknownDuration': '브라우저에서 길이를 읽을 수 없는 형식입니다. 업로드 후 서버에서 확인합니다.',
  'pv.estimate': '예상 처리 시간 {time} ({gpu} 기준 대략치)',
  'pv.minutes': '약 {m}분',
  'pv.underMinute': '1분 미만',
  'pv.cpu': 'GPU가 없어 CPU로 처리합니다. 수 배 더 오래 걸릴 수 있습니다.',
  'pv.dup': '이미 처리한 영상입니다',
  'pv.dupOpen': '기존 결과 열기',
  'pv.dupRunning': '처리 중',
  'pv.dupHint': '채보 시작을 누르면 새로 처리합니다',
  'app.sep.roformer': '보컬/반주',
  'app.sep.demucs': '4분리',
  'app.start': '채보 시작',
  'app.history': '작업 기록',
  'app.dismiss': '클릭해서 닫기',
  'app.empty.1': '음악 링크(yt-dlp 지원 사이트)를 넣거나 오디오 파일(📎 또는 끌어다 놓기)을 고르고, 분리 엔진을 선택한 뒤 <b>채보 시작</b>을 누르세요.',
  'app.empty.2': 'RoFormer: 보컬/반주 2트랙 · Demucs: 보컬/베이스/기타/드럼 4트랙 · 코드 진행은 자동 분석',
  'app.empty.open': '이전 작업 열기',
  'app.shortcuts':
    'Space 재생 · ←/→ 마디 이동 · L 반복 · E 편집 · F 맞춤 · +/− 줌 · Ctrl+휠 줌 · Alt+휠 건반 높이 · 미니맵 클릭/드래그 이동',

  'stage.queued': '대기',
  'stage.downloading': '다운로드',
  'stage.separating': '음원 분리',
  'stage.transcribing': '채보',
  'stage.chords': '코드 분석',
  'stage.finalizing': '마무리',
  'stage.done': '완료',
  'stage.error': '오류',
  'msg.queued': '대기 중',
  'msg.downloading': '오디오 다운로드 중',
  'msg.separating': '음원 분리 중 ({detail})',
  'msg.transcribing': '채보 중: {detail}',
  'msg.chords': '비트 / 코드 진행 분석 중',
  'msg.finalizing': 'MIDI 생성 중',
  'msg.error': '오류: {error}',

  'tp.loop': '⟲ 반복',
  'tp.loop.title': '반복 (L) · 룰러 드래그 또는 코드 클릭으로 구간 지정 · Esc 해제',
  'tp.speed': '속도',
  'tp.speed.title': '음정 유지 재생 속도',
  'tp.key': '키',
  'tp.key.title': '스케일 밖 음을 어둡게 표시 · 코드 철자/로마숫자 기준',
  'tp.key.auto': '자동',
  'tp.key.off': '끄기',
  'tp.follow': '따라가기',
  'tp.wave': '파형',
  'tp.fit': '⤢ 맞춤',
  'tp.fit.title': '화면 맞춤 (F)',
  'tp.edit': '✎ 편집',
  'tp.edit.title': '노트 편집 모드 (E)',
  'tp.master': '마스터 볼륨',
  'tp.loadingAudio': '오디오 로딩 중…',
  'tp.export': '내보내기 ▾',
  'ex.allMidi': '전체 MIDI (모든 트랙 + 코드)',
  'ex.chordMidi': '코드 MIDI',
  'ex.leadSheet': '코드 리드시트 (.txt)',
  'ex.musicxml': 'MusicXML · {track} + 코드',

  'ed.target': '편집 대상',
  'ed.grid': '격자',
  'ed.snap.0': '스냅 끔',
  'ed.snap.1': '1박',
  'ed.snap.2': '1/2박',
  'ed.snap.4': '1/4박',
  'ed.quantize': '퀀타이즈',
  'ed.quantize.title': '편집 대상 트랙 전체를 격자에 맞춤 (Q)',
  'ed.undo': '↶ 실행 취소',
  'ed.redo': '↷ 다시 실행',
  'ed.saved': '✓ 저장됨',
  'ed.saving': '저장 중…',
  'ed.pending': '● 변경됨',
  'ed.saveError': '저장 실패',
  'ed.hint': '드래그: 이동 · 끝 드래그: 길이 · 더블클릭: 추가 · 우클릭/Delete: 삭제 · Shift: 스냅 해제',

  'err.save': '저장 실패: {e}',
  'err.retranscribe': '재채보 실패: {e}',
  'err.chords': '코드 분석 실패: {e}',
  'err.delete': '삭제 실패: {e}',

  'track.mix': '원곡',
  'track.chords': '코드',
  'track.vocals': '보컬',
  'track.accompaniment': '반주',
  'track.bass': '베이스',
  'track.other': '기타 악기',
  'track.drums': '드럼',

  'tr.head': '트랙',
  'tr.notes': '{n} notes',
  'tr.chords': '{n}개 · {engine}',
  'tr.engine.btc': 'BTC',
  'tr.engine.template': '템플릿',
  'tr.edited': '편집됨',
  'tr.mute': '오디오 음소거',
  'tr.solo': '솔로',
  'tr.lane': '레인',
  'tr.lane.title': '코드 레인 표시',
  'tr.showNotes': '노트',
  'tr.showNotes.title': '피아노롤에 노트 표시',
  'tr.synth': '신스',
  'tr.synth.title': '채보된 노트를 신스로 재생',
  'tr.synth.chordTitle': '코드를 신스로 재생',
  'tr.target': '편집 대상 트랙',
  'tr.settings': '채보 민감도 설정',
  'tr.settings.chord': '코드 분석 설정',
  'tr.p.conf_threshold': '음정 신뢰도 하한',
  'tr.p.min_note_sec': '최소 노트 길이 (s)',
  'tr.p.silence_db': '무음 기준 (dB)',
  'tr.p.onset_threshold': '온셋 임계값 (↑ 적게)',
  'tr.p.frame_threshold': '프레임 임계값 (↑ 적게)',
  'tr.p.minimum_note_length': '최소 노트 길이 (ms)',
  'tr.p.change_penalty': '코드 변경 억제 (↑ 덜 바뀜)',
  'tr.defaults': '기본값',
  'tr.busy': '처리 중…',
  'tr.retranscribe': '다시 채보',
  'tr.reanalyze': '다시 분석',
  'tr.warnEdited': '다시 채보하면 직접 편집한 내용은 덮어씁니다 (Ctrl+Z로 복구 가능)',

  'hist.title': '작업 기록',
  'hist.close': '닫기',
  'hist.empty': '아직 작업이 없습니다.',
  'hist.source': '원곡',
  'hist.open': '열기',
  'hist.delete': '삭제',
  'hist.confirm': '"{title}" 작업과 모든 파일을 삭제할까요?',

  'roll.bars': '마디',
  'roll.chords': '코드',
  'roll.wave': '파형',
  'roll.tones': '구성음',
  'roll.clickLoop': '클릭: 구간 반복',
}

type Dict = Record<keyof typeof ko, string>

const en: Dict = {
  'app.placeholder': 'Paste a music link (YouTube, SoundCloud, …) or drop an audio file',
  'app.file.pick': 'Choose an audio file',
  'app.file.remove': 'Remove file',
  'app.drop': 'Drop an audio file here',
  'app.uploading': 'Uploading {pct}%',
  'err.fileType': 'Unsupported file type: {ext}',
  'stage.importing': 'Import',
  'msg.importing': 'Converting the audio file',
  'pv.loading': 'Checking the link…',
  'pv.length': 'length',
  'pv.invalidUrl': 'Enter a link that starts with http:// or https://',
  'pv.otherSite': '{site} link: downloaded with yt-dlp (sites other than YouTube are less tested).',
  'pv.playlist': 'Playlist link: only this video will be processed.',
  'pv.error': 'Could not check the link: {e}',
  'pv.live': 'Live streams are not supported',
  'pv.tooBig': 'The file is larger than {max} MB',
  'pv.tooShort': 'Audio shorter than {min} s cannot be analyzed',
  'pv.tooLong': 'Audio longer than {max} min is not supported. Trim it first.',
  'pv.longWarn': 'Long track: processing takes a while and may run out of GPU memory.',
  'pv.unknownDuration': "The browser can't read this format's length; the server will check it after upload.",
  'pv.estimate': 'Estimated processing time {time} (rough, on {gpu})',
  'pv.minutes': '~{m} min',
  'pv.underMinute': 'under a minute',
  'pv.cpu': 'No GPU detected: running on the CPU can take several times longer.',
  'pv.dup': 'Already transcribed',
  'pv.dupOpen': 'Open result',
  'pv.dupRunning': 'In progress',
  'pv.dupHint': 'Press Transcribe to process it again',
  'app.sep.roformer': 'vocals/accomp.',
  'app.sep.demucs': '4 stems',
  'app.start': 'Transcribe',
  'app.history': 'History',
  'app.dismiss': 'Click to dismiss',
  'app.empty.1': 'Paste a music link (any site yt-dlp supports) or pick an audio file (📎 or drag and drop), choose a separation engine and press <b>Transcribe</b>.',
  'app.empty.2': 'RoFormer: vocals + accompaniment · Demucs: vocals/bass/other/drums · chords are analyzed automatically',
  'app.empty.open': 'Open a previous job',
  'app.shortcuts':
    'Space play · ←/→ bar · L loop · E edit · F fit · +/− zoom · Ctrl+wheel zoom · Alt+wheel key height · click/drag minimap to scroll',

  'stage.queued': 'Queued',
  'stage.downloading': 'Download',
  'stage.separating': 'Separation',
  'stage.transcribing': 'Transcription',
  'stage.chords': 'Chords',
  'stage.finalizing': 'Finalize',
  'stage.done': 'Done',
  'stage.error': 'Error',
  'msg.queued': 'Waiting in queue',
  'msg.downloading': 'Downloading audio',
  'msg.separating': 'Separating stems ({detail})',
  'msg.transcribing': 'Transcribing: {detail}',
  'msg.chords': 'Analyzing beats and chord progression',
  'msg.finalizing': 'Writing MIDI',
  'msg.error': 'Error: {error}',

  'tp.loop': '⟲ Loop',
  'tp.loop.title': 'Loop (L) · drag on the ruler or click a chord to set a region · Esc to clear',
  'tp.speed': 'Speed',
  'tp.speed.title': 'Pitch-preserving playback speed',
  'tp.key': 'Key',
  'tp.key.title': 'Dims out-of-scale notes · used for chord spelling and roman numerals',
  'tp.key.auto': 'Auto',
  'tp.key.off': 'Off',
  'tp.follow': 'Follow',
  'tp.wave': 'Waveform',
  'tp.fit': '⤢ Fit',
  'tp.fit.title': 'Fit to notes (F)',
  'tp.edit': '✎ Edit',
  'tp.edit.title': 'Note edit mode (E)',
  'tp.master': 'Master volume',
  'tp.loadingAudio': 'Loading audio…',
  'tp.export': 'Export ▾',
  'ex.allMidi': 'Full MIDI (all tracks + chords)',
  'ex.chordMidi': 'Chord MIDI',
  'ex.leadSheet': 'Chord lead sheet (.txt)',
  'ex.musicxml': 'MusicXML · {track} + chords',

  'ed.target': 'Target',
  'ed.grid': 'Grid',
  'ed.snap.0': 'No snap',
  'ed.snap.1': '1 beat',
  'ed.snap.2': '1/2 beat',
  'ed.snap.4': '1/4 beat',
  'ed.quantize': 'Quantize',
  'ed.quantize.title': 'Snap every note of the target track to the grid (Q)',
  'ed.undo': '↶ Undo',
  'ed.redo': '↷ Redo',
  'ed.saved': '✓ Saved',
  'ed.saving': 'Saving…',
  'ed.pending': '● Modified',
  'ed.saveError': 'Save failed',
  'ed.hint': 'Drag: move · drag end: length · double-click: add · right-click/Delete: remove · Shift: no snap',

  'err.save': 'Save failed: {e}',
  'err.retranscribe': 'Re-transcription failed: {e}',
  'err.chords': 'Chord analysis failed: {e}',
  'err.delete': 'Delete failed: {e}',

  'track.mix': 'Mix',
  'track.chords': 'Chords',
  'track.vocals': 'Vocals',
  'track.accompaniment': 'Accompaniment',
  'track.bass': 'Bass',
  'track.other': 'Other',
  'track.drums': 'Drums',

  'tr.head': 'Tracks',
  'tr.notes': '{n} notes',
  'tr.chords': '{n} chords · {engine}',
  'tr.engine.btc': 'BTC',
  'tr.engine.template': 'template',
  'tr.edited': 'edited',
  'tr.mute': 'Mute audio',
  'tr.solo': 'Solo',
  'tr.lane': 'Lane',
  'tr.lane.title': 'Show chord lane',
  'tr.showNotes': 'Notes',
  'tr.showNotes.title': 'Show notes in the piano roll',
  'tr.synth': 'Synth',
  'tr.synth.title': 'Play transcribed notes with a synth',
  'tr.synth.chordTitle': 'Play chords with a synth',
  'tr.target': 'Edit target track',
  'tr.settings': 'Transcription sensitivity',
  'tr.settings.chord': 'Chord analysis settings',
  'tr.p.conf_threshold': 'Min pitch confidence',
  'tr.p.min_note_sec': 'Min note length (s)',
  'tr.p.silence_db': 'Silence threshold (dB)',
  'tr.p.onset_threshold': 'Onset threshold (↑ fewer)',
  'tr.p.frame_threshold': 'Frame threshold (↑ fewer)',
  'tr.p.minimum_note_length': 'Min note length (ms)',
  'tr.p.change_penalty': 'Chord change penalty (↑ fewer changes)',
  'tr.defaults': 'Defaults',
  'tr.busy': 'Working…',
  'tr.retranscribe': 'Re-transcribe',
  'tr.reanalyze': 'Re-analyze',
  'tr.warnEdited': 'Re-transcribing overwrites your manual edits (Ctrl+Z restores them)',

  'hist.title': 'History',
  'hist.close': 'Close',
  'hist.empty': 'No jobs yet.',
  'hist.source': 'source',
  'hist.open': 'Open',
  'hist.delete': 'Delete',
  'hist.confirm': 'Delete "{title}" and all of its files?',

  'roll.bars': 'Bars',
  'roll.chords': 'Chords',
  'roll.wave': 'Wave',
  'roll.tones': 'Tones',
  'roll.clickLoop': 'click: loop',
}

const DICTS: Record<Lang, Dict> = { ko, en }
export type MsgKey = keyof Dict
export type TFn = (key: MsgKey, vars?: Record<string, string | number>) => string

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem('mct.lang') ?? localStorage.getItem('yt-amt.lang') // old prefix before the rename
    if (saved === 'ko' || saved === 'en') return saved
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

const I18nContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: TFn } | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang)
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem('mct.lang', l)
    } catch {
      /* storage unavailable */
    }
  }, [])
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const t = useCallback<TFn>(
    (key, vars) => {
      let s: string = DICTS[lang][key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
      return s
    },
    [lang],
  )
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider')
  return ctx
}
