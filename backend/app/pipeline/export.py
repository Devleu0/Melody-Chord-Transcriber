from pathlib import Path

import librosa
import pretty_midi

GM_PROGRAMS = {"vocals": 0, "accompaniment": 0, "other": 0, "bass": 33}


def analyze_beats(wav: Path) -> dict:
    """타임라인 격자용 템포/비트 위치."""
    y, sr = librosa.load(str(wav), sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    tempo = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
    return {"tempo": round(tempo, 2), "beats": [round(float(b), 3) for b in beats]}


def write_midi(tracks: dict[str, list[dict]], path: Path, tempo: float = 120.0) -> None:
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    for name, notes in tracks.items():
        inst = pretty_midi.Instrument(program=GM_PROGRAMS.get(name, 0), name=name)
        for n in notes:
            inst.notes.append(pretty_midi.Note(n["velocity"], n["pitch"], n["start"], n["end"]))
        pm.instruments.append(inst)
    pm.write(str(path))
