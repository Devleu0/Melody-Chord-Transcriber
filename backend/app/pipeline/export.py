from pathlib import Path

import librosa
import numpy as np
import pretty_midi

GM_PROGRAMS = {"vocals": 0, "accompaniment": 0, "other": 0, "bass": 33, "chords": 0}

# 악보/MusicXML 용 근음 표기 (대중음악에서 흔한 철자)
ROOT_NAMES = ["C", "D-", "D", "E-", "E", "F", "F#", "G", "A-", "A", "B-", "B"]
M21_SUFFIX = {
    "maj": "", "min": "m", "dim": "dim", "aug": "+", "min6": "m6", "maj6": "6", "min7": "m7",
    "minmaj7": "mM7", "maj7": "maj7", "7": "7", "dim7": "dim7", "hdim7": "m7b5", "sus2": "sus2", "sus4": "sus4",
}


def analyze_beats(wav: Path) -> dict:
    """타임라인 격자용 템포/비트 위치."""
    y, sr = librosa.load(str(wav), sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    tempo = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
    return {"tempo": round(tempo, 2), "beats": [round(float(b), 3) for b in beats]}


def chord_voicing(chord: dict) -> list[int]:
    """코드 구성음을 C3~ 대역에 배치 (베이스음이 있으면 맨 아래)."""
    base = 48 + chord["root"]
    pitches = sorted(base + ((pc - chord["root"]) % 12) for pc in chord["pcs"])
    if chord.get("bass") is not None:
        pitches = [36 + chord["bass"]] + pitches
    return pitches


def write_midi(tracks: dict[str, list[dict]], path: Path, tempo: float = 120.0, chords: list[dict] | None = None) -> None:
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    for name, notes in tracks.items():
        inst = pretty_midi.Instrument(program=GM_PROGRAMS.get(name, 0), name=name)
        for n in notes:
            inst.notes.append(pretty_midi.Note(n["velocity"], n["pitch"], n["start"], n["end"]))
        pm.instruments.append(inst)
    if chords:
        inst = pretty_midi.Instrument(program=GM_PROGRAMS["chords"], name="chords")
        for c in chords:
            for p in chord_voicing(c):
                inst.notes.append(pretty_midi.Note(80, p, c["start"], c["end"]))
        pm.instruments.append(inst)
    pm.write(str(path))


def _beat_mapper(beats: list[float]):
    """초 -> 박 위치(실수). 비트 밖은 평균 간격으로 외삽."""
    b = np.asarray(beats, dtype=float)
    if len(b) < 2:
        return lambda t: t * 2.0  # 비트 없음: 120 BPM 가정
    period = float(np.median(np.diff(b)))

    def f(t: float) -> float:
        if t < b[0]:
            return (t - b[0]) / period
        if t > b[-1]:
            return len(b) - 1 + (t - b[-1]) / period
        return float(np.interp(t, b, np.arange(len(b))))

    return f


def write_musicxml(notes: list[dict], chords: list[dict], beats: list[float], tempo: float, title: str, path: Path) -> None:
    """단선율(보컬) + 코드 심볼 리드시트. 박 격자 기준 16분음표로 정량화."""
    from music21 import harmony, metadata, meter, note, stream
    from music21 import tempo as m21tempo

    to_beat = _beat_mapper(beats)
    # 첫 비트 이전(픽업)을 위해 마디 단위로 오프셋을 민다 (비트 0 = 첫 마디 첫 박 유지)
    shift = 4 * int(np.ceil(max(0.0, -to_beat(0.0)) / 4))

    def q(t: float) -> float:
        return round((to_beat(t) + shift) * 4) / 4

    part = stream.Part()
    part.append(meter.TimeSignature("4/4"))
    part.append(m21tempo.MetronomeMark(number=round(tempo)))

    # 단선율로 정리: 겹치면 앞 음을 자른다
    events: list[tuple[float, float, int]] = []
    for n in sorted(notes, key=lambda n: n["start"]):
        s, e = q(n["start"]), q(n["end"])
        e = max(e, s + 0.25)
        if events and s < events[-1][1]:
            ps, _, pp = events[-1]
            if s <= ps:
                continue
            events[-1] = (ps, s, pp)
        events.append((s, e, n["pitch"]))
    for s, e, p in events:
        nn = note.Note(p)
        nn.quarterLength = e - s
        part.insert(s, nn)

    for c in chords:
        fig = ROOT_NAMES[c["root"]] + M21_SUFFIX[c["quality"]]
        if c.get("bass") is not None:
            fig += "/" + ROOT_NAMES[c["bass"]]
        try:
            part.insert(q(c["start"]), harmony.ChordSymbol(fig))
        except Exception:
            continue

    score = stream.Score()
    score.metadata = metadata.Metadata(title=title)
    score.insert(0, part.makeNotation())
    score.write("musicxml", fp=str(path))
