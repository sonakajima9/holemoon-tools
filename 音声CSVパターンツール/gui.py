#!/usr/bin/env python3
"""
音声CSVパターン分析ツール — GUIフロントエンド (DearPyGui版)

依存ライブラリ:
  pip install dearpygui sounddevice soundfile numpy

起動:
  python gui.py
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import List, Optional

# ── 依存チェック ────────────────────────────────────────────────────────────

try:
    import dearpygui.dearpygui as dpg
except ImportError:
    print("エラー: pip install dearpygui", file=sys.stderr)
    sys.exit(1)

try:
    import numpy as np
    import sounddevice as sd
    import soundfile as sf
except ImportError as e:
    print(f"エラー: pip install sounddevice soundfile numpy\n{e}", file=sys.stderr)
    sys.exit(1)

# analyze.py を同ディレクトリから import
# PyInstaller の --onefile では sys._MEIPASS が展開先になる
import os as _os
_base = getattr(sys, '_MEIPASS', str(Path(__file__).parent))
sys.path.insert(0, _base)
# 開発時は __file__ の親ディレクトリも追加
if _base != str(Path(__file__).parent):
    sys.path.insert(0, str(Path(__file__).parent))
try:
    from analyze import (
        AnalysisResult,
        Segment,
        detect_speech_segments,
        export_csv,
        export_json,
        list_templates,
        parse_csv,
        read_wav_as_mono16,
        run_analysis,
        save_template,
    )
except ImportError as e:
    print(f"エラー: analyze.py が見つかりません — {e}", file=sys.stderr)
    sys.exit(1)


# ═══════════════════════════════════════════════════════════════════════════
# AudioPlayer
# ═══════════════════════════════════════════════════════════════════════════


class AudioPlayer:
    """sounddevice を使ったシーク対応オーディオプレイヤー"""

    def __init__(self) -> None:
        self._data: Optional[np.ndarray] = None   # (N, channels) float32
        self._sr: int = 44100
        self._pos: int = 0                         # 現在位置 (サンプル)
        self._stream: Optional[sd.OutputStream] = None
        self._lock = threading.Lock()
        self.is_playing: bool = False

    # ── ファイル読み込み ────────────────────────────────────────────────────

    def load(self, path: str) -> None:
        self.stop()
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        with self._lock:
            self._data = data
            self._sr = sr
            self._pos = 0

    # ── 再生制御 ────────────────────────────────────────────────────────────

    def play(self) -> None:
        if self._data is None:
            return
        self._close_stream()
        self.is_playing = True

        def _callback(
            outdata: np.ndarray, frames: int, time_info, status
        ) -> None:
            with self._lock:
                if not self.is_playing or self._data is None:
                    outdata[:] = 0
                    raise sd.CallbackStop()
                rem = len(self._data) - self._pos
                if rem <= 0:
                    outdata[:] = 0
                    self.is_playing = False
                    raise sd.CallbackStop()
                n = min(frames, rem)
                outdata[:n] = self._data[self._pos : self._pos + n]
                if n < frames:
                    outdata[n:] = 0
                self._pos += n

        self._stream = sd.OutputStream(
            samplerate=self._sr,
            channels=self._data.shape[1],
            callback=_callback,
        )
        self._stream.start()

    def pause(self) -> None:
        self.is_playing = False
        if self._stream:
            try:
                self._stream.stop()
            except Exception:
                pass

    def stop(self) -> None:
        self.is_playing = False
        self._close_stream()
        with self._lock:
            self._pos = 0

    def seek(self, time_sec: float) -> None:
        if self._data is None:
            return
        was_playing = self.is_playing
        self.pause()
        with self._lock:
            self._pos = max(0, min(int(time_sec * self._sr), len(self._data) - 1))
        if was_playing:
            self.play()

    def _close_stream(self) -> None:
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

    # ── プロパティ ──────────────────────────────────────────────────────────

    @property
    def current_time(self) -> float:
        if self._data is None or self._sr == 0:
            return 0.0
        return self._pos / self._sr

    @property
    def duration(self) -> float:
        if self._data is None or self._sr == 0:
            return 0.0
        return len(self._data) / self._sr

    @property
    def loaded(self) -> bool:
        return self._data is not None


# ═══════════════════════════════════════════════════════════════════════════
# アプリケーション状態
# ═══════════════════════════════════════════════════════════════════════════


class AppState:
    def __init__(self) -> None:
        self.wav_path: Optional[str] = None
        self.csv_path: Optional[str] = None
        self.segments: List[Segment] = []
        self.csv_rows: list = []
        self.results: List[AnalysisResult] = []
        self.wf_x: Optional[np.ndarray] = None   # 波形 X (時刻)
        self.wf_y: Optional[np.ndarray] = None   # 波形 Y (振幅)
        self.player = AudioPlayer()


state = AppState()
_seg_viz_tags: List[str] = []   # 動的に追加したセグメント描画タグ
_prev_play_state: bool = False  # 直前フレームの再生状態（ボタン更新用）


# ═══════════════════════════════════════════════════════════════════════════
# 波形ユーティリティ
# ═══════════════════════════════════════════════════════════════════════════


def extract_waveform(
    data: np.ndarray, samplerate: int, n_points: int = 2000
) -> tuple:
    """
    音声データをダウンサンプリングして波形データ (x, y) を生成。
    y は正規化済みの RMS 振幅。
    """
    mono = data[:, 0] if data.ndim > 1 else data
    total = len(mono)
    if total == 0:
        return np.array([0.0, 1.0]), np.array([0.0, 0.0])

    block = max(1, total // n_points)
    n_blocks = total // block

    xs = np.arange(n_blocks, dtype=np.float64) * block / samplerate
    ys = np.array(
        [float(np.sqrt(np.mean(mono[i * block : (i + 1) * block] ** 2)))
         for i in range(n_blocks)]
    )
    max_y = ys.max() or 1.0
    return xs, ys / max_y


# ═══════════════════════════════════════════════════════════════════════════
# UI 更新ヘルパー
# ═══════════════════════════════════════════════════════════════════════════


def set_status(msg: str) -> None:
    if dpg.does_item_exist("status_text"):
        dpg.set_value("status_text", msg)


def fmt_time(sec: float) -> str:
    m = int(sec // 60)
    s = sec % 60
    return f"{m:02d}:{s:05.2f}"


def refresh_waveform() -> None:
    """波形プロットを再描画（セグメント領域のハイライト含む）"""
    global _seg_viz_tags

    # 古いセグメント描画を削除
    for tag in _seg_viz_tags:
        if dpg.does_item_exist(tag):
            dpg.delete_item(tag)
    _seg_viz_tags = []

    if state.wf_x is None or state.wf_y is None:
        return

    # ベース波形を更新
    dpg.set_value("waveform_series", [state.wf_x.tolist(), state.wf_y.tolist()])

    # セグメント区間をシェードで表示
    for i, seg in enumerate(state.segments):
        tag = f"seg_shade_{i}"
        # shade_series: x 2点 × y1(上端) / y2(下端) で矩形塗りつぶし
        xs = [seg.start, seg.end]
        ys_top = [1.05, 1.05]
        ys_bot = [-0.05, -0.05]
        try:
            dpg.add_shade_series(
                xs, ys_top, y2=ys_bot,
                tag=tag,
                parent="wf_y_axis",
            )
            _seg_viz_tags.append(tag)
        except Exception:
            pass

    # 軸範囲を固定
    dur = state.player.duration
    dpg.set_axis_limits("wf_x_axis", 0.0, dur if dur > 0 else 1.0)
    dpg.set_axis_limits("wf_y_axis", -0.1, 1.1)


def refresh_segment_table() -> None:
    """セグメント一覧テーブルを再構築"""
    if not dpg.does_item_exist("seg_table"):
        return

    for child in dpg.get_item_children("seg_table", 1):
        dpg.delete_item(child)

    for seg in state.segments:
        res = next(
            (r for r in state.results if r.segment_index == seg.index), None
        )
        with dpg.table_row(parent="seg_table"):
            dpg.add_text(f"#{seg.index + 1}")
            # 時刻ボタン: クリックでその位置にシーク
            dpg.add_button(
                label=f"{fmt_time(seg.start)} → {fmt_time(seg.end)}",
                callback=lambda _s, _a, u: _seek_to(u),
                user_data=seg.start,
                small=True,
            )
            dpg.add_text(f"{seg.duration:.2f}s")
            dpg.add_text(res.dialogue_pattern.label if res else "—")
            dpg.add_text(res.csv_pattern.label if res else "—")


def refresh_results_panel() -> None:
    """分析サマリーパネルを更新"""
    if not dpg.does_item_exist("results_text"):
        return

    if not state.results:
        dpg.set_value("results_text", "（分析結果なし）")
        return

    csv_cnt: dict = {}
    dia_cnt: dict = {}
    total_dur = 0.0

    for r in state.results:
        csv_cnt[r.csv_pattern.label] = csv_cnt.get(r.csv_pattern.label, 0) + 1
        dia_cnt[r.dialogue_pattern.label] = dia_cnt.get(r.dialogue_pattern.label, 0) + 1
        total_dur += r.duration

    lines = [
        f"セグメント数  : {len(state.results)}",
        f"総発話時間    : {total_dur:.2f}s",
        "",
        "【発話パターン】",
        *[f"  {lb:<12} {cnt}件" for lb, cnt in sorted(dia_cnt.items())],
        "",
        "【CSVパターン】",
        *[f"  {lb:<18} {cnt}件" for lb, cnt in sorted(csv_cnt.items())],
    ]
    dpg.set_value("results_text", "\n".join(lines))


def refresh_template_list() -> None:
    names = list_templates()
    dpg.configure_item("tmpl_listbox", items=names if names else ["（なし）"])


def _seek_to(time_sec: float) -> None:
    state.player.seek(time_sec)
    dpg.set_value("seek_slider", time_sec)


# ═══════════════════════════════════════════════════════════════════════════
# コールバック
# ═══════════════════════════════════════════════════════════════════════════


def _load_wav_file(path: str) -> None:
    """音声ファイルを読み込む（ダイアログ・D&D共通処理）"""
    state.wav_path = path
    dpg.set_value("wav_label", Path(path).name)
    set_status(f"音声を読み込み中: {Path(path).name} ...")

    def _load() -> None:
        try:
            state.player.load(path)
            data, sr = sf.read(path, dtype="float32", always_2d=True)
            state.wf_x, state.wf_y = extract_waveform(data, sr)
            dur = state.player.duration

            dpg.set_value("seek_slider", 0.0)
            dpg.configure_item("seek_slider", max_value=max(dur, 0.01))
            dpg.set_value("time_text", f"00:00.00 / {fmt_time(dur)}")

            refresh_waveform()
            set_status(f"読み込み完了: {Path(path).name}  ({dur:.1f}s)")
            dpg.enable_item("btn_detect")
        except Exception as exc:
            set_status(f"読み込みエラー: {exc}")

    threading.Thread(target=_load, daemon=True).start()


def _load_csv_file(path: str) -> None:
    """CSVファイルを読み込む（ダイアログ・D&D共通処理）"""
    state.csv_path = path
    dpg.set_value("csv_label", Path(path).name)
    try:
        state.csv_rows = parse_csv(path)
        set_status(f"CSV読み込み完了: {Path(path).name}  ({len(state.csv_rows)}行)")
        if state.segments:
            dpg.enable_item("btn_analyze")
    except Exception as exc:
        set_status(f"CSVエラー: {exc}")


def on_wav_selected(_s, app_data: dict) -> None:
    selections = app_data.get("selections", {})
    if not selections:
        return
    _load_wav_file(list(selections.values())[0])


def on_csv_selected(_s, app_data: dict) -> None:
    selections = app_data.get("selections", {})
    if not selections:
        return
    _load_csv_file(list(selections.values())[0])


def on_file_drop(_s, app_data) -> None:
    """ビューポートへのファイルドロップ処理（OS からのドラッグ＆ドロップ）"""
    if not isinstance(app_data, (list, tuple)):
        return
    wav_exts = {".wav", ".mp3", ".flac", ".ogg", ".aiff", ".aif"}
    for path in app_data:
        ext = Path(path).suffix.lower()
        if ext in wav_exts:
            _load_wav_file(path)
        elif ext == ".csv":
            _load_csv_file(path)


def on_detect_clicked() -> None:
    if not state.wav_path:
        set_status("エラー: 音声ファイルを選択してください")
        return
    dpg.disable_item("btn_detect")
    set_status("発話区間を検出中...")

    def _run() -> None:
        try:
            samples, sr = read_wav_as_mono16(state.wav_path)
            agg = dpg.get_value("set_aggressiveness")
            min_sil = dpg.get_value("set_min_silence")
            min_sp = dpg.get_value("set_min_speech")

            state.segments = detect_speech_segments(
                samples, sr,
                aggressiveness=int(agg),
                min_silence_ms=int(min_sil),
                min_speech_ms=int(min_sp),
            )
            state.results = []

            refresh_waveform()
            refresh_segment_table()
            refresh_results_panel()
            set_status(f"検出完了: {len(state.segments)} セグメント")

            dpg.enable_item("btn_detect")
            if state.csv_rows:
                dpg.enable_item("btn_analyze")
        except Exception as exc:
            set_status(f"検出エラー: {exc}")
            dpg.enable_item("btn_detect")

    threading.Thread(target=_run, daemon=True).start()


def on_analyze_clicked() -> None:
    if not state.segments:
        set_status("エラー: 先に発話検出を実行してください")
        return
    if not state.csv_rows:
        set_status("エラー: CSVを読み込んでください")
        return
    state.results = run_analysis(state.segments, state.csv_rows)
    refresh_segment_table()
    refresh_results_panel()
    set_status(f"分析完了: {len(state.results)} セグメント")
    for tag in ("btn_save_tmpl", "btn_export_json", "btn_export_csv"):
        dpg.enable_item(tag)


def on_play_pause() -> None:
    if state.player.is_playing:
        state.player.pause()
        dpg.set_item_label("btn_play", "▶  再生")
    else:
        if not state.player.loaded:
            set_status("エラー: 音声ファイルを先に読み込んでください")
            return
        state.player.play()
        dpg.set_item_label("btn_play", "⏸  一時停止")


def on_stop() -> None:
    state.player.stop()
    dpg.set_item_label("btn_play", "▶  再生")
    dpg.set_value("seek_slider", 0.0)
    dpg.set_value("time_text", f"00:00.00 / {fmt_time(state.player.duration)}")


def on_seek(_s, value: float) -> None:
    state.player.seek(value)


def on_save_template() -> None:
    name = dpg.get_value("tmpl_name_input").strip()
    if not name:
        set_status("エラー: テンプレート名を入力してください")
        return
    if not state.results:
        set_status("エラー: 分析結果がありません")
        return
    try:
        path = save_template(name, state.results)
        set_status(f"テンプレート保存: {path.name}")
        refresh_template_list()
    except Exception as exc:
        set_status(f"保存エラー: {exc}")


def on_export_json() -> None:
    base = Path(state.wav_path).stem if state.wav_path else "result"
    out = Path(state.wav_path).parent / f"{base}_analysis.json" if state.wav_path else Path("result_analysis.json")
    try:
        export_json(state.results, str(out))
        set_status(f"JSON出力: {out.name}")
    except Exception as exc:
        set_status(f"出力エラー: {exc}")


def on_export_csv_result() -> None:
    base = Path(state.wav_path).stem if state.wav_path else "result"
    out = Path(state.wav_path).parent / f"{base}_analysis.csv" if state.wav_path else Path("result_analysis.csv")
    try:
        export_csv(state.results, str(out))
        set_status(f"CSV出力: {out.name}")
    except Exception as exc:
        set_status(f"出力エラー: {exc}")


# ═══════════════════════════════════════════════════════════════════════════
# GUI 構築
# ═══════════════════════════════════════════════════════════════════════════

# カラーパレット
C_RED    = (233, 69,  96)
C_RED_A  = (233, 69,  96, 80)
C_DARK   = (26,  26,  46)
C_DARK2  = (13,  13,  26)
C_PANEL  = (16,  33,  62)
C_FRAME  = (15,  52,  96)
C_TEXT   = (224, 224, 224)
C_MUTED  = (140, 140, 140)


def _setup_japanese_font() -> None:
    """日本語フォントを DearPyGui に登録してデフォルトフォントに設定する"""
    # スクリプト同階層の fonts/ フォルダを最優先で確認（PyInstaller バンドル用）
    _base = Path(getattr(sys, "_MEIPASS", str(Path(__file__).parent)))
    local_font_dir = _base / "fonts"
    local_candidates: list[Path] = []
    if local_font_dir.exists():
        local_candidates = (
            list(local_font_dir.glob("*.ttf"))
            + list(local_font_dir.glob("*.ttc"))
            + list(local_font_dir.glob("*.otf"))
        )

    # OS 別のシステムフォント候補
    if sys.platform == "win32":
        system_candidates = [
            Path("C:/Windows/Fonts/msgothic.ttc"),
            Path("C:/Windows/Fonts/YuGothM.ttc"),
            Path("C:/Windows/Fonts/meiryo.ttc"),
            Path("C:/Windows/Fonts/BIZ-UDGothicR.ttc"),
        ]
    elif sys.platform == "darwin":
        system_candidates = [
            Path("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"),
            Path("/System/Library/Fonts/AppleSDGothicNeo.ttc"),
            Path("/Library/Fonts/Arial Unicode.ttf"),
        ]
    else:  # Linux / その他
        system_candidates = [
            Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"),
            Path("/usr/share/fonts/truetype/vlgothic/VL-Gothic-Regular.ttf"),
            Path("/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf"),
            Path("/usr/share/fonts/truetype/fonts-japanese-gothic.ttf"),
        ]

    font_path: Optional[str] = None
    for p in local_candidates + system_candidates:
        if p.exists():
            font_path = str(p)
            break

    if font_path is None:
        return  # フォントが見つからない場合はデフォルトのまま続行

    try:
        with dpg.font_registry():
            with dpg.font(font_path, 16) as jfont:
                dpg.add_font_range_hint(dpg.mvFontRangeHint_Default)
                dpg.add_font_range_hint(dpg.mvFontRangeHint_Japanese)
        dpg.bind_font(jfont)
    except Exception:
        pass  # フォント読み込み失敗時はデフォルトのまま続行


def _build_theme() -> int:
    with dpg.theme() as t:
        with dpg.theme_component(dpg.mvAll):
            dpg.add_theme_color(dpg.mvThemeCol_WindowBg,         C_DARK)
            dpg.add_theme_color(dpg.mvThemeCol_ChildBg,          C_DARK2)
            dpg.add_theme_color(dpg.mvThemeCol_TitleBg,          C_FRAME)
            dpg.add_theme_color(dpg.mvThemeCol_TitleBgActive,    C_FRAME)
            dpg.add_theme_color(dpg.mvThemeCol_Button,           C_RED)
            dpg.add_theme_color(dpg.mvThemeCol_ButtonHovered,    (255, 107, 129))
            dpg.add_theme_color(dpg.mvThemeCol_ButtonActive,     (180, 40, 60))
            dpg.add_theme_color(dpg.mvThemeCol_FrameBg,          C_FRAME)
            dpg.add_theme_color(dpg.mvThemeCol_FrameBgHovered,   C_PANEL)
            dpg.add_theme_color(dpg.mvThemeCol_SliderGrab,       C_RED)
            dpg.add_theme_color(dpg.mvThemeCol_SliderGrabActive, (255, 107, 129))
            dpg.add_theme_color(dpg.mvThemeCol_Header,           C_RED_A)
            dpg.add_theme_color(dpg.mvThemeCol_HeaderHovered,    (233, 69, 96, 130))
            dpg.add_theme_color(dpg.mvThemeCol_CheckMark,        C_RED)
            dpg.add_theme_color(dpg.mvThemeCol_Text,             C_TEXT)
            dpg.add_theme_color(dpg.mvThemeCol_TableRowBg,       C_DARK2)
            dpg.add_theme_color(dpg.mvThemeCol_TableRowBgAlt,    C_PANEL)
            dpg.add_theme_color(dpg.mvThemeCol_ScrollbarBg,      C_DARK)
            dpg.add_theme_color(dpg.mvThemeCol_ScrollbarGrab,    C_RED)
            dpg.add_theme_color(dpg.mvThemeCol_PopupBg,          C_PANEL)
            dpg.add_theme_style(dpg.mvStyleVar_FrameRounding,    6)
            dpg.add_theme_style(dpg.mvStyleVar_WindowRounding,   8)
            dpg.add_theme_style(dpg.mvStyleVar_ItemSpacing,      8, 6)
            dpg.add_theme_style(dpg.mvStyleVar_FramePadding,     6, 4)
    return t


def _section_header(label: str) -> None:
    dpg.add_spacer(height=6)
    dpg.add_text(label, color=C_RED)
    dpg.add_separator()
    dpg.add_spacer(height=2)


def build_gui() -> None:
    dpg.create_context()
    _setup_japanese_font()   # 日本語フォントをコンテキスト作成直後に登録
    dpg.bind_theme(_build_theme())

    # ── ファイルダイアログ ─────────────────────────────────────────────────
    with dpg.file_dialog(
        directory_selector=False, show=False, tag="dlg_wav",
        callback=on_wav_selected, width=660, height=440,
    ):
        dpg.add_file_extension(".wav",  color=(80, 220, 80,  255), custom_text="[WAV]")
        dpg.add_file_extension(".mp3",  color=(80, 180, 255, 255), custom_text="[MP3]")
        dpg.add_file_extension(".flac", color=(180, 80, 255, 255), custom_text="[FLAC]")
        dpg.add_file_extension(".*")

    with dpg.file_dialog(
        directory_selector=False, show=False, tag="dlg_csv",
        callback=on_csv_selected, width=660, height=440,
    ):
        dpg.add_file_extension(".csv", color=(100, 180, 255, 255), custom_text="[CSV]")
        dpg.add_file_extension(".*")

    # ── メインウィンドウ ───────────────────────────────────────────────────
    with dpg.window(tag="main_window", label="音声CSVパターン分析ツール", no_close=True):

        # ステータスバー
        with dpg.group(horizontal=True):
            dpg.add_text("●", color=C_RED)
            dpg.add_text("起動完了 — ファイルをドラッグ＆ドロップするか左パネルで選択してください",
                         tag="status_text", color=C_MUTED)
        dpg.add_separator()
        dpg.add_spacer(height=4)

        # ── 2カラムレイアウト ──────────────────────────────────────────────
        with dpg.table(header_row=False, borders_innerV=True, pad_outerX=True):
            dpg.add_table_column(width_fixed=True, init_width_or_weight=265)
            dpg.add_table_column()

            with dpg.table_row():

                # ════ 左パネル ═══════════════════════════════════════════════
                with dpg.table_cell():
                    with dpg.child_window(width=255, height=-1, border=False):

                        # ── ファイル選択 ──────────────────────────────────
                        _section_header("ファイル選択 / D&D")
                        dpg.add_button(
                            label="音声ファイルを選択…",
                            width=-1,
                            callback=lambda: dpg.show_item("dlg_wav"),
                        )
                        dpg.add_text("WAV / MP3 / FLAC をドロップ可",
                                     color=C_MUTED, wrap=245)
                        dpg.add_text("（未選択）", tag="wav_label",
                                     color=C_MUTED, wrap=245)
                        dpg.add_spacer(height=4)
                        dpg.add_button(
                            label="CSV ファイルを選択…",
                            width=-1,
                            callback=lambda: dpg.show_item("dlg_csv"),
                        )
                        dpg.add_text("CSV をドロップ可",
                                     color=C_MUTED, wrap=245)
                        dpg.add_text("（未選択）", tag="csv_label",
                                     color=C_MUTED, wrap=245)

                        # ── 検出設定 ──────────────────────────────────────
                        _section_header("検出設定")
                        dpg.add_text("VAD 感度 (0〜3)", color=C_MUTED)
                        dpg.add_slider_int(
                            tag="set_aggressiveness",
                            default_value=2, min_value=0, max_value=3,
                            width=-1,
                        )
                        dpg.add_text("最小無音区間 (ms)", color=C_MUTED)
                        dpg.add_input_int(
                            tag="set_min_silence",
                            default_value=300, min_value=50, max_value=3000,
                            width=-1, step=50,
                        )
                        dpg.add_text("最小発話区間 (ms)", color=C_MUTED)
                        dpg.add_input_int(
                            tag="set_min_speech",
                            default_value=150, min_value=50, max_value=2000,
                            width=-1, step=50,
                        )

                        # ── 操作ボタン ────────────────────────────────────
                        _section_header("操作")
                        dpg.add_button(
                            label="発話区間を検出",
                            tag="btn_detect",
                            width=-1,
                            callback=on_detect_clicked,
                            enabled=False,
                        )
                        dpg.add_button(
                            label="パターン分析",
                            tag="btn_analyze",
                            width=-1,
                            callback=on_analyze_clicked,
                            enabled=False,
                        )

                        # ── テンプレート ──────────────────────────────────
                        _section_header("テンプレート")
                        dpg.add_input_text(
                            tag="tmpl_name_input",
                            hint="テンプレート名...",
                            width=-1,
                        )
                        dpg.add_button(
                            label="現在の結果を保存",
                            tag="btn_save_tmpl",
                            width=-1,
                            callback=on_save_template,
                            enabled=False,
                        )
                        dpg.add_spacer(height=2)
                        dpg.add_text("保存済みテンプレート", color=C_MUTED)
                        dpg.add_listbox(
                            tag="tmpl_listbox",
                            items=list_templates() or ["（なし）"],
                            width=-1,
                            num_items=4,
                        )

                        # ── エクスポート ──────────────────────────────────
                        _section_header("エクスポート")
                        dpg.add_button(
                            label="JSON に出力",
                            tag="btn_export_json",
                            width=-1,
                            callback=on_export_json,
                            enabled=False,
                        )
                        dpg.add_button(
                            label="CSV に出力",
                            tag="btn_export_csv",
                            width=-1,
                            callback=on_export_csv_result,
                            enabled=False,
                        )

                # ════ 右パネル ═══════════════════════════════════════════════
                with dpg.table_cell():
                    with dpg.child_window(width=-1, height=-1, border=False):

                        # ── 波形プロット ──────────────────────────────────
                        _section_header("波形")
                        with dpg.plot(
                            tag="waveform_plot",
                            height=170,
                            width=-1,
                            no_mouse_pos=True,
                            no_menus=True,
                        ):
                            dpg.add_plot_axis(
                                dpg.mvXAxis,
                                tag="wf_x_axis",
                                no_gridlines=True,
                            )
                            with dpg.plot_axis(
                                dpg.mvYAxis,
                                tag="wf_y_axis",
                                no_gridlines=True,
                                no_tick_labels=True,
                            ):
                                # ベース波形
                                dpg.add_line_series(
                                    [], [], tag="waveform_series",
                                    label="波形",
                                )
                                # プレイヘッド (x が同じ2点で垂直線)
                                dpg.add_line_series(
                                    [0.0, 0.0], [-0.1, 1.1],
                                    tag="playhead_series",
                                    label="",
                                )

                        # ── 再生コントロール ──────────────────────────────
                        dpg.add_spacer(height=4)
                        with dpg.group(horizontal=True):
                            dpg.add_button(
                                label="▶  再生",
                                tag="btn_play",
                                width=120,
                                callback=on_play_pause,
                            )
                            dpg.add_button(
                                label="■  停止",
                                width=90,
                                callback=on_stop,
                            )
                            dpg.add_spacer(width=8)
                            dpg.add_text(
                                "00:00.00 / 00:00.00",
                                tag="time_text",
                                color=C_RED,
                            )

                        dpg.add_slider_float(
                            tag="seek_slider",
                            default_value=0.0,
                            min_value=0.0,
                            max_value=1.0,
                            width=-1,
                            callback=on_seek,
                            format="",
                        )

                        # ── セグメント一覧 ────────────────────────────────
                        _section_header("セグメント一覧")
                        with dpg.table(
                            tag="seg_table",
                            header_row=True,
                            borders_outerH=True,
                            borders_innerV=True,
                            borders_innerH=True,
                            borders_outerV=True,
                            row_background=True,
                            scrollY=True,
                            height=220,
                            width=-1,
                        ):
                            dpg.add_table_column(
                                label="#", width_fixed=True, init_width_or_weight=36
                            )
                            dpg.add_table_column(label="時刻（クリックでシーク）")
                            dpg.add_table_column(
                                label="長さ", width_fixed=True, init_width_or_weight=60
                            )
                            dpg.add_table_column(
                                label="発話パターン", width_fixed=True, init_width_or_weight=110
                            )
                            dpg.add_table_column(label="CSVパターン")

                        # ── 分析サマリー ──────────────────────────────────
                        _section_header("分析サマリー")
                        dpg.add_text(
                            "（分析結果なし）",
                            tag="results_text",
                            color=C_MUTED,
                            wrap=780,
                        )

    # ── ビューポート ───────────────────────────────────────────────────────
    dpg.create_viewport(
        title="音声CSVパターン分析ツール",
        width=1120,
        height=820,
        min_width=860,
        min_height=640,
    )
    dpg.setup_dearpygui()
    dpg.set_file_drop_callback(on_file_drop)
    dpg.show_viewport()
    dpg.set_primary_window("main_window", True)


# ═══════════════════════════════════════════════════════════════════════════
# メインループ
# ═══════════════════════════════════════════════════════════════════════════


def main() -> None:
    build_gui()

    global _prev_play_state

    while dpg.is_dearpygui_running():
        # ── プレイヘッド & タイムコード更新 ─────────────────────────────
        if state.player.loaded:
            t = state.player.current_time
            dur = state.player.duration

            # 再生中のみスライダーとプレイヘッドを更新
            if state.player.is_playing:
                dpg.set_value("seek_slider", t)

            # プレイヘッド (垂直線)
            dpg.set_value("playhead_series", [[t, t], [-0.1, 1.1]])

            # タイムコード表示
            dpg.set_value("time_text", f"{fmt_time(t)} / {fmt_time(dur)}")

            # 再生が終了したらボタンラベルをリセット
            if _prev_play_state and not state.player.is_playing:
                dpg.set_item_label("btn_play", "▶  再生")

            _prev_play_state = state.player.is_playing

        dpg.render_dearpygui_frame()

    state.player.stop()
    dpg.destroy_context()


if __name__ == "__main__":
    main()
