#!/usr/bin/env python3
"""
音声CSVパターン分析ツール (webrtcvad版)
=============================================
WAV音声からwebrtcvadで発話区間を検出し、
UFOTWフォーマットCSVのパターンと照合・分類するCLIツール。

必要ライブラリ:
  pip install webrtcvad

使い方:
  # 音声のみ解析（発話区間を検出）
  python analyze.py audio.wav

  # 音声 + CSV でパターン分析
  python analyze.py audio.wav --csv pattern.csv

  # 分析結果をテンプレートとして保存
  python analyze.py audio.wav --csv pattern.csv --save-template my_template

  # 保存済みテンプレートを読み込んで比較
  python analyze.py audio.wav --csv pattern.csv --load-template my_template

  # JSON出力
  python analyze.py audio.wav --csv pattern.csv --output result.json

  # テンプレート一覧
  python analyze.py --list-templates
"""

from __future__ import annotations

import argparse
import array
import csv
import json
import math
import os
import struct
import sys
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional

# ---------------------------------------------------------------------------
# 依存チェック
# ---------------------------------------------------------------------------

try:
    import webrtcvad  # type: ignore
except ImportError:
    print(
        "エラー: webrtcvad が見つかりません。\n"
        "  pip install webrtcvad\n"
        "でインストールしてください。",
        file=sys.stderr,
    )
    sys.exit(1)

# テンプレート保存ディレクトリ（スクリプトと同階層）
TEMPLATE_DIR = Path(__file__).parent / "templates"

# ---------------------------------------------------------------------------
# データクラス
# ---------------------------------------------------------------------------


@dataclass
class Segment:
    """検出された発話区間"""
    index: int
    start: float        # 開始時刻 (秒)
    end: float          # 終了時刻 (秒)
    duration: float     # 長さ (秒)
    avg_rms: float = 0.0
    normalized_rms: float = 0.0
    text: str = ""


@dataclass
class CsvRow:
    """CSVの1行"""
    time: int           # デシ秒 (raw値)
    time_sec: float     # 秒換算
    left_dir: float
    left_speed: float
    right_dir: float
    right_speed: float


@dataclass
class DialoguePattern:
    """発話パターン分類（時間長 × 音量）"""
    duration_type: str   # 極短 / 短 / 中 / 長 / 超長
    intensity_type: str  # 弱 / 中 / 強 / 最強
    label: str
    duration: float
    rms: float


@dataclass
class CsvPattern:
    """CSVパターン分類（速度・方向の変化）"""
    type: str            # constant / accel / decel / wave / pulse / alternate / climax / custom / silent
    label: str
    avg_speed: float = 0.0
    min_speed: float = 0.0
    max_speed: float = 0.0
    direction_pattern: str = ""
    row_count: int = 0


@dataclass
class AnalysisResult:
    """1セグメントの分析結果"""
    segment_index: int
    start: float
    end: float
    duration: float
    text: str
    dialogue_pattern: DialoguePattern
    csv_pattern: CsvPattern
    gap_csv_pattern: CsvPattern
    overlapping_csv_row_count: int
    gap_csv_row_count: int


# ---------------------------------------------------------------------------
# 音声読み込み・前処理
# ---------------------------------------------------------------------------


def read_wav_as_mono16(path: str) -> tuple[array.array, int]:
    """
    WAVファイルを読み込み、モノラル16bit PCMとサンプルレートを返す。
    マルチチャンネル・8/24/32bit にも対応。
    """
    with wave.open(path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())

    # サンプルを16bit整数へ変換
    if sampwidth == 1:
        # 8bit unsigned → 16bit signed
        samples: array.array = array.array(
            "h", [((b - 128) << 8) for b in raw]
        )
    elif sampwidth == 2:
        samples = array.array("h")
        samples.frombytes(raw)
    elif sampwidth == 3:
        # 24bit → 16bit (上位16bitを使用)
        vals = []
        for i in range(0, len(raw) - 2, 3):
            v = raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            vals.append(v >> 8)
        samples = array.array("h", vals)
    elif sampwidth == 4:
        src = array.array("i")
        src.frombytes(raw)
        samples = array.array("h", [s >> 16 for s in src])
    else:
        raise ValueError(f"非対応のサンプル幅: {sampwidth} bytes")

    # マルチチャンネル → モノラル
    if n_channels > 1:
        mono_vals = []
        for i in range(0, len(samples), n_channels):
            block = samples[i : i + n_channels]
            mono_vals.append(sum(block) // len(block))
        samples = array.array("h", mono_vals)

    return samples, framerate


def resample_linear(
    samples: array.array, src_rate: int, dst_rate: int
) -> array.array:
    """
    線形補間によるリサンプリング。
    webrtcvad は 8000/16000/32000/48000 Hz のみ対応するため使用。
    """
    if src_rate == dst_rate:
        return samples

    src_len = len(samples)
    dst_len = int(src_len * dst_rate / src_rate)
    result = array.array("h", [0] * dst_len)

    for i in range(dst_len):
        pos = i * src_rate / dst_rate
        idx = int(pos)
        frac = pos - idx
        a = samples[idx] if idx < src_len else 0
        b = samples[idx + 1] if idx + 1 < src_len else a
        result[i] = max(-32768, min(32767, int(a + frac * (b - a))))

    return result


def compute_rms(samples: array.array) -> float:
    """配列のRMS（二乗平均平方根）を計算"""
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


# ---------------------------------------------------------------------------
# webrtcvad による発話区間検出
# ---------------------------------------------------------------------------


def detect_speech_segments(
    samples: array.array,
    sample_rate: int,
    aggressiveness: int = 2,
    frame_ms: int = 20,
    min_silence_ms: int = 300,
    min_speech_ms: int = 150,
) -> List[Segment]:
    """
    webrtcvad を使って発話区間を検出する。

    Args:
        samples:        モノラル16bit PCMサンプル列
        sample_rate:    サンプルレート (Hz)
        aggressiveness: VAD感度 0〜3 (値が大きいほどノイズを無音と判定しやすい)
        frame_ms:       フレーム長 (ms) — 10 / 20 / 30 のみ有効
        min_silence_ms: この長さ以上の無音でセグメントを分割 (ms)
        min_speech_ms:  この長さ未満のセグメントは破棄 (ms)

    Returns:
        検出された発話区間のリスト
    """
    # webrtcvad が対応するサンプルレートへリサンプリング
    supported = [8000, 16000, 32000, 48000]
    if sample_rate not in supported:
        target = 16000
        _log(f"  リサンプリング: {sample_rate} Hz → {target} Hz")
        samples = resample_linear(samples, sample_rate, target)
        sample_rate = target

    vad = webrtcvad.Vad(aggressiveness)

    frame_size = int(sample_rate * frame_ms / 1000)  # サンプル数/フレーム
    frame_bytes = frame_size * 2                      # バイト数/フレーム

    raw = samples.tobytes()
    n_frames = len(raw) // frame_bytes

    # フレームごとの発話ラベルを取得
    speech_flags: list[bool] = []
    for i in range(n_frames):
        offset = i * frame_bytes
        frame = raw[offset : offset + frame_bytes]
        try:
            speech_flags.append(vad.is_speech(frame, sample_rate))
        except Exception:
            speech_flags.append(False)

    frame_sec = frame_ms / 1000.0
    min_sil_frames = max(1, int(min_silence_ms / frame_ms))
    min_sp_frames = max(1, int(min_speech_ms / frame_ms))

    # ─── パス1: 短い無音を埋めてセグメントを結合 ─────────────────────────
    merged = list(speech_flags)
    i = 0
    while i < len(merged):
        if not merged[i]:
            j = i
            while j < len(merged) and not merged[j]:
                j += 1
            sil_len = j - i
            if sil_len < min_sil_frames:
                has_pre = any(merged[max(0, i - min_sp_frames) : i])
                has_post = any(merged[j : min(len(merged), j + min_sp_frames)])
                if has_pre and has_post:
                    for k in range(i, j):
                        merged[k] = True
            i = j
        else:
            i += 1

    # ─── パス2: ラベル列 → 区間リスト ──────────────────────────────────
    segments: List[Segment] = []
    in_speech = False
    seg_start = 0

    def _push_segment(start_f: int, end_f: int) -> None:
        if end_f - start_f < min_sp_frames:
            return
        t0 = round(start_f * frame_sec, 3)
        t1 = round(end_f * frame_sec, 3)
        s0 = start_f * frame_size
        s1 = min(end_f * frame_size, len(samples))
        rms = compute_rms(samples[s0:s1])
        segments.append(
            Segment(
                index=len(segments),
                start=t0,
                end=t1,
                duration=round(t1 - t0, 3),
                avg_rms=rms,
            )
        )

    for fi, sp in enumerate(merged):
        if sp and not in_speech:
            seg_start = fi
            in_speech = True
        elif not sp and in_speech:
            _push_segment(seg_start, fi)
            in_speech = False

    if in_speech:
        _push_segment(seg_start, len(merged))

    # ─── RMS 正規化 ─────────────────────────────────────────────────────
    if segments:
        max_rms = max(s.avg_rms for s in segments) or 1.0
        for s in segments:
            s.normalized_rms = round(s.avg_rms / max_rms, 4)

    return segments


# ---------------------------------------------------------------------------
# CSV 読み込み・パース
# ---------------------------------------------------------------------------


def parse_csv(path: str) -> List[CsvRow]:
    """
    UFOTWフォーマットCSVを読み込む。
    3列形式: time(ds), direction, speed
    5列形式: time(ds), leftDir, leftSpeed, rightDir, rightSpeed
    先頭行がヘッダの場合はスキップ。
    """
    rows: List[CsvRow] = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for lineno, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            cols = [c.strip() for c in line.split(",")]
            # ヘッダ行スキップ
            if lineno == 0 and not _is_float(cols[0]):
                continue
            if not _is_float(cols[0]):
                continue

            t = int(float(cols[0]))
            t_sec = t / 10.0

            if len(cols) >= 5:
                rows.append(
                    CsvRow(
                        time=t,
                        time_sec=t_sec,
                        left_dir=float(cols[1]),
                        left_speed=float(cols[2]),
                        right_dir=float(cols[3]),
                        right_speed=float(cols[4]),
                    )
                )
            elif len(cols) >= 3:
                d = float(cols[1])
                sp = float(cols[2])
                rows.append(
                    CsvRow(
                        time=t,
                        time_sec=t_sec,
                        left_dir=d,
                        left_speed=sp,
                        right_dir=d,
                        right_speed=sp,
                    )
                )
    return rows


def _is_float(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# パターン分類
# ---------------------------------------------------------------------------


def classify_dialogue_pattern(seg: Segment) -> DialoguePattern:
    """発話区間を時間長・音量で分類する"""
    d = seg.duration
    if d < 0.5:
        dur_type = "極短"
    elif d < 1.5:
        dur_type = "短"
    elif d < 3.0:
        dur_type = "中"
    elif d < 6.0:
        dur_type = "長"
    else:
        dur_type = "超長"

    rms = seg.normalized_rms
    if rms < 0.3:
        int_type = "弱"
    elif rms < 0.6:
        int_type = "中"
    elif rms < 0.85:
        int_type = "強"
    else:
        int_type = "最強"

    return DialoguePattern(
        duration_type=dur_type,
        intensity_type=int_type,
        label=f"{dur_type}・{int_type}",
        duration=d,
        rms=rms,
    )


def _calculate_correlation(values: list[float]) -> float:
    """
    インデックス列と値列のピアソン相関係数を計算する。
    戻り値: -1.0〜1.0
    """
    n = len(values)
    if n < 2:
        return 0.0
    sum_x = sum_y = sum_xy = sum_x2 = sum_y2 = 0.0
    for i, y in enumerate(values):
        sum_x += i
        sum_y += y
        sum_xy += i * y
        sum_x2 += i * i
        sum_y2 += y * y
    num = n * sum_xy - sum_x * sum_y
    den = math.sqrt(
        max(0.0, (n * sum_x2 - sum_x**2) * (n * sum_y2 - sum_y**2))
    )
    return 0.0 if den == 0.0 else num / den


def classify_csv_pattern(csv_rows: List[CsvRow]) -> CsvPattern:
    """
    CSV行列をパターンに分類する。
    パターン種別:
      silent   … 全速度0（または行なし）
      alternate… 方向が頻繁に切り替わる（正逆交互）
      constant … 速度がほぼ一定
      accel    … 加速傾向
      decel    … 減速傾向
      climax   … 増加後に急落
      pulse    … 大きな速度変動を繰り返す
      wave     … 速度が波状に変化
      custom   … 上記いずれにも該当しない
    """
    if not csv_rows:
        return CsvPattern(type="silent", label="無音")

    speeds = [r.left_speed for r in csv_rows]
    directions = [r.left_dir for r in csv_rows]

    if all(s == 0 for s in speeds):
        return CsvPattern(type="silent", label="無音")

    avg_sp = sum(speeds) / len(speeds)
    min_sp = min(speeds)
    max_sp = max(speeds)
    n = len(speeds)

    base = dict(
        avg_speed=round(avg_sp, 1),
        min_speed=min_sp,
        max_speed=max_sp,
        row_count=n,
    )

    # 方向パターン判定
    if all(d == 0 for d in directions):
        dir_pat = "all_0"
    elif all(d == 1 for d in directions):
        dir_pat = "all_1"
    else:
        alt = all(directions[i] != directions[i - 1] for i in range(1, n))
        dir_pat = "alternating" if (alt and n > 1) else "mixed"
    base["direction_pattern"] = dir_pat

    # 正逆交互 (方向転換が1/3以上)
    dir_changes = sum(1 for i in range(1, n) if directions[i] != directions[i - 1])
    if dir_changes > n / 3 and n > 2:
        return CsvPattern(type="alternate", label="正逆交互", **base)

    # 一定 (±5以内)
    if all(abs(s - avg_sp) <= 5 for s in speeds):
        return CsvPattern(type="constant", label=f"一定(速度{round(avg_sp)})", **base)

    # 相関係数ベース
    corr = _calculate_correlation(speeds)

    if corr > 0.7:
        # クライマックス: ピーク後に急落
        peak_i = speeds.index(max_sp)
        if (
            0 < peak_i < n - 1
            and speeds[-1] < max_sp * 0.5
        ):
            return CsvPattern(
                type="climax",
                label=f"クライマックス({round(max_sp)})",
                **base,
            )
        return CsvPattern(
            type="accel",
            label=f"加速({round(speeds[0])}→{round(speeds[-1])})",
            **base,
        )

    if corr < -0.7:
        return CsvPattern(
            type="decel",
            label=f"減速({round(speeds[0])}→{round(speeds[-1])})",
            **base,
        )

    # クライマックス（相関弱でもピーク後急落）
    if n >= 3:
        peak_i = speeds.index(max_sp)
        if (
            peak_i > n * 0.3
            and peak_i < n - 1
            and speeds[-1] < max_sp * 0.4
        ):
            return CsvPattern(
                type="climax",
                label=f"クライマックス({round(max_sp)})",
                **base,
            )

    # パルス（連続する大きな速度差）
    if avg_sp > 0:
        pulse_count = sum(
            1
            for i in range(1, n)
            if abs(speeds[i] - speeds[i - 1]) > avg_sp * 0.5
        )
        if pulse_count > n * 0.6 and n > 2:
            return CsvPattern(
                type="pulse",
                label=f"パルス(平均{round(avg_sp)})",
                **base,
            )

    # 波状（速度変化方向が頻繁に反転）
    sp_dir_changes = sum(
        1
        for i in range(2, n)
        if (speeds[i - 1] - speeds[i - 2]) * (speeds[i] - speeds[i - 1]) < 0
    )
    if sp_dir_changes > n / 3 and n > 3:
        return CsvPattern(
            type="wave",
            label=f"波状(平均{round(avg_sp)})",
            **base,
        )

    return CsvPattern(type="custom", label="カスタム", **base)


# ---------------------------------------------------------------------------
# メイン分析
# ---------------------------------------------------------------------------


def run_analysis(
    segments: List[Segment],
    csv_rows: List[CsvRow],
) -> List[AnalysisResult]:
    """
    発話区間とCSVデータを照合してパターン分析を行う。

    - overlapping: セグメント区間と重なるCSV行
    - gap:         直前セグメント終了〜現セグメント開始の無音区間のCSV行
    """
    results: List[AnalysisResult] = []

    for i, seg in enumerate(segments):
        prev_end = segments[i - 1].end if i > 0 else 0.0

        overlap_rows = [r for r in csv_rows if seg.start <= r.time_sec <= seg.end]
        gap_rows = [r for r in csv_rows if prev_end <= r.time_sec < seg.start]

        dialogue_pat = classify_dialogue_pattern(seg)
        csv_pat = classify_csv_pattern(overlap_rows)
        gap_csv_pat = classify_csv_pattern(gap_rows)

        results.append(
            AnalysisResult(
                segment_index=i,
                start=seg.start,
                end=seg.end,
                duration=seg.duration,
                text=seg.text,
                dialogue_pattern=dialogue_pat,
                csv_pattern=csv_pat,
                gap_csv_pattern=gap_csv_pat,
                overlapping_csv_row_count=len(overlap_rows),
                gap_csv_row_count=len(gap_rows),
            )
        )

    return results


# ---------------------------------------------------------------------------
# テンプレート管理
# ---------------------------------------------------------------------------


def _ensure_template_dir() -> None:
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)


def save_template(name: str, results: List[AnalysisResult]) -> Path:
    """分析結果をテンプレートJSONとして保存する"""
    _ensure_template_dir()
    data = {
        "name": name,
        "segments": [asdict(r) for r in results],
    }
    path = TEMPLATE_DIR / f"{name}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def load_template(name: str) -> dict:
    """テンプレートJSONを読み込む"""
    path = TEMPLATE_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(f"テンプレートが見つかりません: {name}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def list_templates() -> List[str]:
    """保存済みテンプレート名の一覧を返す"""
    if not TEMPLATE_DIR.exists():
        return []
    return [p.stem for p in sorted(TEMPLATE_DIR.glob("*.json"))]


# ---------------------------------------------------------------------------
# 出力
# ---------------------------------------------------------------------------


def export_json(results: List[AnalysisResult], path: str) -> None:
    """分析結果をJSONファイルへ書き出す"""
    data = [asdict(r) for r in results]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def export_csv(results: List[AnalysisResult], path: str) -> None:
    """分析結果をCSVファイルへ書き出す"""
    headers = [
        "セグメント番号",
        "開始(s)",
        "終了(s)",
        "長さ(s)",
        "発話パターン",
        "CSVパターン(重複)",
        "CSVパターン(無音区間)",
        "CSV行数(重複)",
        "CSV行数(無音区間)",
        "テキスト",
    ]
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        for r in results:
            writer.writerow([
                r.segment_index + 1,
                r.start,
                r.end,
                r.duration,
                r.dialogue_pattern.label,
                r.csv_pattern.label,
                r.gap_csv_pattern.label,
                r.overlapping_csv_row_count,
                r.gap_csv_row_count,
                r.text,
            ])


def print_summary(
    segments: List[Segment],
    results: Optional[List[AnalysisResult]],
    csv_rows: Optional[List[CsvRow]],
) -> None:
    """分析結果をコンソールへ出力する"""
    SEP = "─" * 60

    print(f"\n{SEP}")
    print(f"  発話区間検出結果  ({len(segments)} セグメント)")
    print(SEP)

    if not results:
        # CSVなし：発話区間のみ表示
        for s in segments:
            bar = "█" * int(s.normalized_rms * 20)
            print(
                f"  #{s.index + 1:>3}  "
                f"{_fmt_time(s.start)} → {_fmt_time(s.end)}  "
                f"({s.duration:.2f}s)  "
                f"RMS:{s.normalized_rms:.2f} {bar}"
            )
        return

    print(f"  ※ CSV: {len(csv_rows)} 行\n")

    # パターン集計
    csv_pattern_counts: dict[str, int] = {}
    dia_pattern_counts: dict[str, int] = {}

    for r in results:
        csv_pattern_counts[r.csv_pattern.type] = (
            csv_pattern_counts.get(r.csv_pattern.type, 0) + 1
        )
        dia_pattern_counts[r.dialogue_pattern.label] = (
            dia_pattern_counts.get(r.dialogue_pattern.label, 0) + 1
        )

    for r in results:
        print(
            f"  #{r.segment_index + 1:>3}  "
            f"{_fmt_time(r.start)} → {_fmt_time(r.end)}  "
            f"({r.duration:.2f}s)  "
            f"[{r.dialogue_pattern.label}]  "
            f"CSV: {r.csv_pattern.label}"
            + (f"  gap:{r.gap_csv_pattern.label}" if r.gap_csv_row_count > 0 else "")
        )

    total_speech = sum(r.duration for r in results)
    print(f"\n{SEP}")
    print(f"  サマリー")
    print(SEP)
    print(f"  総セグメント数  : {len(results)}")
    print(f"  総発話時間      : {total_speech:.2f}s")
    print(f"  発話パターン内訳:")
    for label, count in sorted(dia_pattern_counts.items()):
        print(f"    {label:<12} {count:>3} 件")
    print(f"  CSVパターン内訳:")
    for pat, count in sorted(csv_pattern_counts.items()):
        print(f"    {pat:<12} {count:>3} 件")
    print(SEP)


def _fmt_time(seconds: float) -> str:
    m = int(seconds // 60)
    s = seconds % 60
    return f"{m:02d}:{s:05.2f}"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="音声CSVパターン分析ツール (webrtcvad版)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("audio", nargs="?", help="入力WAVファイル")
    p.add_argument("--csv", metavar="FILE", help="UFOTWフォーマットCSVファイル")
    p.add_argument(
        "--aggressiveness",
        type=int,
        default=2,
        choices=[0, 1, 2, 3],
        help="VAD感度 (0=最低, 3=最高) [デフォルト: 2]",
    )
    p.add_argument(
        "--frame-ms",
        type=int,
        default=20,
        choices=[10, 20, 30],
        help="フレーム長(ms) [デフォルト: 20]",
    )
    p.add_argument(
        "--min-silence",
        type=int,
        default=300,
        metavar="MS",
        help="最小無音区間(ms) [デフォルト: 300]",
    )
    p.add_argument(
        "--min-speech",
        type=int,
        default=150,
        metavar="MS",
        help="最小発話区間(ms) [デフォルト: 150]",
    )
    p.add_argument("--output", metavar="FILE", help="結果をJSONへ出力")
    p.add_argument("--output-csv", metavar="FILE", help="結果をCSVへ出力")
    p.add_argument(
        "--save-template",
        metavar="NAME",
        help="分析結果をテンプレートとして保存",
    )
    p.add_argument(
        "--load-template",
        metavar="NAME",
        help="テンプレートを読み込んで比較表示",
    )
    p.add_argument(
        "--list-templates",
        action="store_true",
        help="保存済みテンプレート一覧を表示",
    )
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # ── テンプレート一覧 ──────────────────────────────────────────────────
    if args.list_templates:
        names = list_templates()
        if names:
            print("保存済みテンプレート:")
            for n in names:
                print(f"  {n}")
        else:
            print("テンプレートがありません。")
        return

    if not args.audio:
        parser.print_help()
        return

    # ── 音声読み込み ──────────────────────────────────────────────────────
    _log(f"[1/3] 音声を読み込み中: {args.audio}")
    try:
        samples, sample_rate = read_wav_as_mono16(args.audio)
    except Exception as e:
        print(f"エラー: 音声ファイルを読み込めませんでした — {e}", file=sys.stderr)
        sys.exit(1)

    duration_sec = len(samples) / sample_rate
    _log(
        f"  {sample_rate} Hz, {duration_sec:.2f}s, "
        f"{len(samples)} サンプル"
    )

    # ── 発話区間検出 ─────────────────────────────────────────────────────
    _log(
        f"[2/3] 発話区間を検出中 "
        f"(aggressiveness={args.aggressiveness}, "
        f"frame={args.frame_ms}ms, "
        f"min_silence={args.min_silence}ms, "
        f"min_speech={args.min_speech}ms) ..."
    )
    segments = detect_speech_segments(
        samples,
        sample_rate,
        aggressiveness=args.aggressiveness,
        frame_ms=args.frame_ms,
        min_silence_ms=args.min_silence,
        min_speech_ms=args.min_speech,
    )
    _log(f"  → {len(segments)} セグメント検出")

    # ── CSV読み込み & パターン分析 ────────────────────────────────────────
    csv_rows: Optional[List[CsvRow]] = None
    results: Optional[List[AnalysisResult]] = None

    if args.csv:
        _log(f"[3/3] CSVを読み込み・分析中: {args.csv}")
        try:
            csv_rows = parse_csv(args.csv)
        except Exception as e:
            print(f"エラー: CSVを読み込めませんでした — {e}", file=sys.stderr)
            sys.exit(1)
        _log(f"  CSV: {len(csv_rows)} 行")
        results = run_analysis(segments, csv_rows)
        _log("  → 分析完了")
    else:
        _log("[3/3] CSVなし — 発話区間のみ検出します")

    # ── 結果表示 ─────────────────────────────────────────────────────────
    print_summary(segments, results, csv_rows)

    # ── テンプレート読み込み比較 ──────────────────────────────────────────
    if args.load_template:
        try:
            tmpl = load_template(args.load_template)
            print(f"\nテンプレート「{tmpl['name']}」と比較:")
            tmpl_pats = [seg["csv_pattern"]["type"] for seg in tmpl["segments"]]
            cur_pats = [r.csv_pattern.type for r in results] if results else []
            match = sum(a == b for a, b in zip(tmpl_pats, cur_pats))
            total = max(len(tmpl_pats), len(cur_pats), 1)
            print(f"  パターン一致率: {match}/{total} ({match/total*100:.1f}%)")
        except FileNotFoundError as e:
            print(f"警告: {e}", file=sys.stderr)

    # ── テンプレート保存 ──────────────────────────────────────────────────
    if args.save_template:
        if not results:
            print("警告: CSV未指定のためテンプレートを保存できません。", file=sys.stderr)
        else:
            path = save_template(args.save_template, results)
            print(f"\nテンプレートを保存しました: {path}")

    # ── JSON / CSV 出力 ──────────────────────────────────────────────────
    if args.output:
        if not results:
            print("警告: CSV未指定のためJSON出力できません。", file=sys.stderr)
        else:
            export_json(results, args.output)
            print(f"JSON出力: {args.output}")

    if args.output_csv:
        if not results:
            print("警告: CSV未指定のためCSV出力できません。", file=sys.stderr)
        else:
            export_csv(results, args.output_csv)
            print(f"CSV出力: {args.output_csv}")


if __name__ == "__main__":
    main()
