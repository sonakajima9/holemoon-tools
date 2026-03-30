#!/usr/bin/env python3
"""
音声CSVパターン分析ツール - Streamlit版
========================================
WAV音声の発話区間検出 × UFOTWフォーマットCSVのパターン照合・テンプレート管理。

起動方法:
  streamlit run streamlit_app.py
"""

from __future__ import annotations

import array
import io
import json
import os
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import List, Optional

import pandas as pd
import streamlit as st

# analyze.py をインポート (同階層)
_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))

from analyze import (
    CsvPattern,
    CsvRow,
    DialoguePattern,
    Segment,
    classify_csv_pattern,
    classify_dialogue_pattern,
    detect_speech_segments,
    list_templates,
    load_template,
    parse_csv,
    read_wav_as_mono16,
    run_analysis,
    save_template,
)

# ---------------------------------------------------------------------------
# ページ設定
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="音声CSVパターン分析ツール",
    page_icon="🎵",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ---------------------------------------------------------------------------
# カスタム CSS (ブラウザ版に近いダーク配色)
# ---------------------------------------------------------------------------

st.markdown(
    """
<style>
/* ── 全体背景 ── */
.stApp { background-color: #1a1a2e; color: #e0e0e0; }
section[data-testid="stSidebar"] { background-color: #16213e; }

/* ── タイトル ── */
h1 { color: #e94560 !important; text-align: center; }
h2 { color: #e94560 !important; }
h3 { color: #ccc !important; }

/* ── メトリクスカード ── */
div[data-testid="metric-container"] {
  background: #0d0d1a;
  border: 1px solid #0f3460;
  border-radius: 8px;
  padding: 12px;
}
div[data-testid="metric-container"] label { color: #888 !important; }
div[data-testid="metric-container"] div[data-testid="stMetricValue"] {
  color: #e94560 !important;
}

/* ── テーブル ── */
thead tr th { background-color: #16213e !important; color: #e94560 !important; }

/* ── ダウンロードボタン ── */
.stDownloadButton button {
  border: 2px solid #27ae60 !important;
  color: #27ae60 !important;
  background: transparent !important;
}
.stDownloadButton button:hover {
  background: #27ae60 !important;
  color: #fff !important;
}

/* ── エキスパンダー ── */
details summary { color: #e94560 !important; }

/* ── セクション区切り ── */
hr { border-color: #0f3460 !important; }
</style>
""",
    unsafe_allow_html=True,
)

# ---------------------------------------------------------------------------
# セッション状態初期化
# ---------------------------------------------------------------------------

def _init_session() -> None:
    defaults = {
        "segments": [],
        "csv_rows": [],
        "analysis_results": None,
        "audio_file_name": "",
        "csv_file_name": "",
        "audio_duration": 0.0,
        "templates": [],          # [{name, date, data}]
        "audio_bytes": None,
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


_init_session()

# ---------------------------------------------------------------------------
# ユーティリティ
# ---------------------------------------------------------------------------

def _fmt_time(seconds: float) -> str:
    m = int(seconds // 60)
    s = seconds % 60
    return f"{m:02d}:{s:05.2f}"


def _pattern_color(pat_type: str) -> str:
    colors = {
        "constant": "#3498db",
        "accel": "#27ae60",
        "decel": "#e67e22",
        "wave": "#9b59b6",
        "pulse": "#f39c12",
        "alternate": "#1abc9c",
        "climax": "#e94560",
        "silent": "#666",
        "custom": "#95a5a6",
    }
    return colors.get(pat_type, "#888")


def _intensity_color(intensity: str) -> str:
    colors = {"弱": "#3498db", "中": "#27ae60", "強": "#f39c12", "最強": "#e94560"}
    return colors.get(intensity, "#888")


def _load_templates_from_disk() -> List[dict]:
    """templates/ フォルダからテンプレートを読み込む"""
    tpl_dir = _HERE / "templates"
    if not tpl_dir.exists():
        return []
    templates = []
    for p in sorted(tpl_dir.glob("*.json")):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            templates.append({
                "name": p.stem,
                "data": data,
            })
        except Exception:
            pass
    return templates


# ---------------------------------------------------------------------------
# サイドバー：発話検出設定
# ---------------------------------------------------------------------------

with st.sidebar:
    st.title("⚙️ 設定")
    st.markdown("---")
    st.subheader("発話検出パラメータ")

    aggressiveness = st.select_slider(
        "VAD感度",
        options=[0, 1, 2, 3],
        value=2,
        help="値が大きいほどノイズを無音と判定しやすい (0=最低, 3=最高)",
    )
    frame_ms = st.select_slider(
        "フレーム長 (ms)",
        options=[10, 20, 30],
        value=20,
        help="音声フレームの長さ",
    )
    min_silence_ms = st.slider(
        "最小無音区間 (ms)",
        min_value=100,
        max_value=2000,
        value=300,
        step=50,
        help="この長さ以上の無音でセグメントを分割",
    )
    min_speech_ms = st.slider(
        "最小発話区間 (ms)",
        min_value=50,
        max_value=500,
        value=150,
        step=25,
        help="この長さ未満のセグメントは破棄",
    )

    st.markdown("---")
    st.subheader("ツール情報")
    st.caption("音声CSVパターン分析ツール v2.0 (Streamlit版)")
    st.caption("ブラウザ版も同フォルダの index.html で利用可能")

# ---------------------------------------------------------------------------
# タイトル
# ---------------------------------------------------------------------------

st.title("🎵 音声CSVパターン分析ツール")
st.caption("音声ファイルの発話区間を検出し、UFOTWフォーマットCSVパターンとの照合・テンプレート管理を行います")

# ---------------------------------------------------------------------------
# Step 1: 音声ファイル読み込み
# ---------------------------------------------------------------------------

st.markdown("---")
st.header("Step 1 — 音声ファイル読み込み")

col_audio_upload, col_audio_info = st.columns([2, 1])

with col_audio_upload:
    audio_file = st.file_uploader(
        "音声ファイルを選択",
        type=["wav", "mp3", "ogg", "m4a", "flac"],
        key="audio_uploader",
        help="WAV / MP3 / OGG / M4A / FLAC に対応",
    )

with col_audio_info:
    if st.session_state.audio_file_name:
        st.success(f"読み込み済み: {st.session_state.audio_file_name}")
        st.metric("検出セグメント数", len(st.session_state.segments))
        if st.session_state.audio_duration > 0:
            st.metric("音声長", f"{st.session_state.audio_duration:.1f}s")

if audio_file is not None:
    # 新しいファイルが選択された場合のみ処理
    if audio_file.name != st.session_state.audio_file_name:
        st.session_state.audio_bytes = audio_file.read()
        st.session_state.audio_file_name = audio_file.name
        st.session_state.segments = []
        st.session_state.analysis_results = None

    # 音声プレイヤー表示
    st.audio(st.session_state.audio_bytes, format=f"audio/{audio_file.name.split('.')[-1].lower()}")

    # 発話検出ボタン
    if st.button("🔍 発話区間を検出", type="primary", key="detect_btn"):
        with st.spinner("発話区間を検出しています..."):
            try:
                # 一時ファイルに保存して処理
                suffix = Path(audio_file.name).suffix
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                    tmp.write(st.session_state.audio_bytes)
                    tmp_path = tmp.name

                try:
                    samples, sample_rate = read_wav_as_mono16(tmp_path)
                    total_samples = len(samples)
                    st.session_state.audio_duration = total_samples / sample_rate

                    segs = detect_speech_segments(
                        samples,
                        sample_rate,
                        aggressiveness=aggressiveness,
                        frame_ms=frame_ms,
                        min_silence_ms=min_silence_ms,
                        min_speech_ms=min_speech_ms,
                    )
                    st.session_state.segments = segs
                    st.session_state.analysis_results = None
                    st.success(f"✅ {len(segs)} 個のセグメントを検出しました")
                finally:
                    os.unlink(tmp_path)

            except Exception as e:
                st.error(f"エラー: {e}")

# セグメント一覧表示
if st.session_state.segments:
    segs = st.session_state.segments
    with st.expander(f"検出セグメント一覧 ({len(segs)} 件)", expanded=True):
        rows = []
        for s in segs:
            rows.append({
                "#": s.index + 1,
                "開始": _fmt_time(s.start),
                "終了": _fmt_time(s.end),
                "長さ (s)": f"{s.duration:.3f}",
                "RMS (正規化)": f"{s.normalized_rms:.3f}",
                "テキスト": s.text,
            })
        df_segs = pd.DataFrame(rows)
        st.dataframe(df_segs, use_container_width=True, hide_index=True)

        # テキスト入力（編集）
        st.subheader("セグメントテキストを編集")
        segs_editable = segs.copy()
        for i, seg in enumerate(segs_editable):
            text_val = st.text_input(
                f"セグメント #{i+1} ({_fmt_time(seg.start)} → {_fmt_time(seg.end)})",
                value=seg.text,
                key=f"seg_text_{i}",
                label_visibility="visible",
            )
            st.session_state.segments[i].text = text_val

# ---------------------------------------------------------------------------
# Step 2: CSVファイル読み込み
# ---------------------------------------------------------------------------

st.markdown("---")
st.header("Step 2 — CSVファイル読み込み (UFOTWフォーマット)")

col_csv_upload, col_csv_info = st.columns([2, 1])

with col_csv_upload:
    csv_file = st.file_uploader(
        "CSVファイルを選択",
        type=["csv", "tsv"],
        key="csv_uploader",
        help="UFOTWフォーマット: 3列(time, dir, speed) または 5列(time, leftDir, leftSpeed, rightDir, rightSpeed)",
    )

with col_csv_info:
    if st.session_state.csv_file_name:
        st.success(f"読み込み済み: {st.session_state.csv_file_name}")
        st.metric("CSV行数", len(st.session_state.csv_rows))

if csv_file is not None:
    if csv_file.name != st.session_state.csv_file_name:
        try:
            csv_bytes = csv_file.read()
            with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="wb") as tmp:
                tmp.write(csv_bytes)
                tmp_path = tmp.name
            try:
                rows = parse_csv(tmp_path)
                st.session_state.csv_rows = rows
                st.session_state.csv_file_name = csv_file.name
                st.session_state.analysis_results = None
                st.success(f"✅ {len(rows)} 行を読み込みました")
            finally:
                os.unlink(tmp_path)
        except Exception as e:
            st.error(f"CSVパースエラー: {e}")

# CSV プレビュー
if st.session_state.csv_rows:
    with st.expander(f"CSV プレビュー (先頭50行 / 全{len(st.session_state.csv_rows)}行)"):
        preview_rows = st.session_state.csv_rows[:50]
        df_csv = pd.DataFrame([{
            "time (ds)": r.time,
            "time (s)": f"{r.time_sec:.1f}",
            "左方向": r.left_dir,
            "左速度": r.left_speed,
            "右方向": r.right_dir,
            "右速度": r.right_speed,
        } for r in preview_rows])
        st.dataframe(df_csv, use_container_width=True, hide_index=True)

# ---------------------------------------------------------------------------
# Step 3: パターン分析
# ---------------------------------------------------------------------------

st.markdown("---")
st.header("Step 3 — パターン分析")

can_analyze = len(st.session_state.segments) > 0

if not can_analyze:
    st.info("Step 1 で音声ファイルを読み込み、発話区間を検出してください。")
else:
    if not st.session_state.csv_rows:
        st.warning("CSVファイルが未読み込みです。音声のみのパターン分析を実行します。")

    if st.button("▶ 分析開始", type="primary", key="analyze_btn"):
        with st.spinner("パターン分析中..."):
            try:
                results = run_analysis(
                    st.session_state.segments,
                    st.session_state.csv_rows,
                )
                st.session_state.analysis_results = results
                st.success(f"✅ {len(results)} セグメントの分析が完了しました")
            except Exception as e:
                st.error(f"分析エラー: {e}")

if st.session_state.analysis_results:
    results = st.session_state.analysis_results

    # ── サマリー統計 ──────────────────────────────────────────────────────
    st.subheader("サマリー統計")
    total_dur = sum(r.duration for r in results)
    csv_pattern_counts: dict[str, int] = {}
    dia_pattern_counts: dict[str, int] = {}
    for r in results:
        csv_pattern_counts[r.csv_pattern.type] = csv_pattern_counts.get(r.csv_pattern.type, 0) + 1
        dia_pattern_counts[r.dialogue_pattern.label] = dia_pattern_counts.get(r.dialogue_pattern.label, 0) + 1

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("検出セグメント数", len(results))
    col2.metric("総発話時間", f"{total_dur:.1f}s")
    col3.metric("CSV行数", len(st.session_state.csv_rows))
    col4.metric("CSV対応セグメント",
                sum(1 for r in results if r.overlapping_csv_row_count > 0))

    # ── パターン内訳 ──────────────────────────────────────────────────────
    col_dia, col_csv_pat = st.columns(2)
    with col_dia:
        st.subheader("発話パターン内訳")
        df_dia = pd.DataFrame(
            [{"パターン": k, "件数": v} for k, v in sorted(dia_pattern_counts.items())]
        )
        st.dataframe(df_dia, use_container_width=True, hide_index=True)

    with col_csv_pat:
        st.subheader("CSVパターン内訳")
        df_csv_pat = pd.DataFrame(
            [{"パターン": k, "件数": v} for k, v in sorted(csv_pattern_counts.items())]
        )
        st.dataframe(df_csv_pat, use_container_width=True, hide_index=True)

    # ── 分析結果詳細 ──────────────────────────────────────────────────────
    st.subheader("分析結果詳細")

    # テーブル形式
    detail_rows = []
    for r in results:
        detail_rows.append({
            "#": r.segment_index + 1,
            "開始": _fmt_time(r.start),
            "終了": _fmt_time(r.end),
            "長さ (s)": f"{r.duration:.3f}",
            "発話パターン": r.dialogue_pattern.label,
            "CSVパターン (発話中)": r.csv_pattern.label,
            "CSVパターン (無音中)": r.gap_csv_pattern.label,
            "CSV行数 (発話中)": r.overlapping_csv_row_count,
            "CSV行数 (無音中)": r.gap_csv_row_count,
            "テキスト": r.text,
        })
    df_detail = pd.DataFrame(detail_rows)
    st.dataframe(df_detail, use_container_width=True, hide_index=True)

    # カード形式（詳細展開）
    with st.expander("セグメント別カード表示"):
        for r in results:
            dia_col = _intensity_color(r.dialogue_pattern.intensity_type)
            csv_col = _pattern_color(r.csv_pattern.type)
            gap_col = _pattern_color(r.gap_csv_pattern.type)

            st.markdown(
                f"""
<div style="background:#0d0d1a;border:1px solid #0f3460;border-radius:8px;
            padding:12px;margin-bottom:8px;">
  <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
    <span style="color:#e94560;font-weight:600;">
      セグメント #{r.segment_index + 1}
    </span>
    <span style="color:#888;font-size:0.85em;">
      {_fmt_time(r.start)} → {_fmt_time(r.end)} ({r.duration:.2f}s)
    </span>
  </div>
  <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:0.87em;">
    <div>
      <div style="color:#666;font-size:0.78em;">発話パターン</div>
      <span style="color:{dia_col};font-family:monospace;">{r.dialogue_pattern.label}</span>
    </div>
    <div>
      <div style="color:#666;font-size:0.78em;">CSVパターン (発話中)</div>
      <span style="color:{csv_col};font-family:monospace;">{r.csv_pattern.label}</span>
      <span style="color:#555;font-size:0.8em;"> ({r.overlapping_csv_row_count}行)</span>
    </div>
    <div>
      <div style="color:#666;font-size:0.78em;">CSVパターン (無音中)</div>
      <span style="color:{gap_col};font-family:monospace;">{r.gap_csv_pattern.label}</span>
      <span style="color:#555;font-size:0.8em;"> ({r.gap_csv_row_count}行)</span>
    </div>
    {"<div><div style='color:#666;font-size:0.78em;'>テキスト</div><span style='color:#b0c4de;font-style:italic;'>" + r.text + "</span></div>" if r.text else ""}
  </div>
</div>
""",
                unsafe_allow_html=True,
            )

# ---------------------------------------------------------------------------
# Step 4: テンプレートライブラリ
# ---------------------------------------------------------------------------

st.markdown("---")
st.header("Step 4 — テンプレートライブラリ")

col_tpl_left, col_tpl_right = st.columns([1, 1])

with col_tpl_left:
    st.subheader("テンプレートを保存")

    if st.session_state.analysis_results:
        tpl_name_input = st.text_input(
            "テンプレート名",
            placeholder="例: 作品名_キャラ名",
            key="tpl_name_input",
        )
        if st.button("💾 テンプレートとして保存", key="save_tpl_btn"):
            name = tpl_name_input.strip()
            if not name:
                st.warning("テンプレート名を入力してください")
            else:
                try:
                    path = save_template(name, st.session_state.analysis_results)
                    st.success(f"✅ '{name}' を保存しました ({path})")
                except Exception as e:
                    st.error(f"保存エラー: {e}")
    else:
        st.info("Step 3 でパターン分析を実行してからテンプレートを保存できます。")

with col_tpl_right:
    st.subheader("保存済みテンプレート")

    tpl_names = list_templates()
    if tpl_names:
        selected_tpl = st.selectbox(
            "テンプレートを選択",
            options=tpl_names,
            key="tpl_select",
        )
        if selected_tpl:
            tpl_data = load_template(selected_tpl)
            segs_data = tpl_data.get("segments", [])

            col_a, col_b = st.columns(2)
            col_a.metric("セグメント数", len(segs_data))

            if st.button("📋 テンプレート詳細を表示", key="show_tpl_btn"):
                rows = []
                for s in segs_data:
                    dp = s.get("dialogue_pattern", {})
                    cp = s.get("csv_pattern", {})
                    rows.append({
                        "#": s.get("segment_index", 0) + 1,
                        "長さ (s)": f"{s.get('duration', 0):.3f}",
                        "発話パターン": dp.get("label", ""),
                        "CSVパターン": cp.get("label", ""),
                        "テキスト": s.get("text", ""),
                    })
                st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

            # JSON としてダウンロード
            tpl_json = json.dumps(tpl_data, ensure_ascii=False, indent=2)
            st.download_button(
                label="⬇ テンプレートをダウンロード",
                data=tpl_json.encode("utf-8"),
                file_name=f"{selected_tpl}.json",
                mime="application/json",
                key="dl_tpl_btn",
            )
    else:
        st.info("テンプレートがありません。Step 3 で分析後に保存してください。")

# テンプレートインポート
st.subheader("テンプレートをインポート")
imported_tpl_file = st.file_uploader(
    "テンプレートJSONをアップロード",
    type=["json"],
    key="import_tpl",
    help="以前エクスポートしたテンプレートJSONを読み込みます",
)
if imported_tpl_file is not None:
    try:
        tpl_import_data = json.loads(imported_tpl_file.read().decode("utf-8"))
        tpl_import_name = Path(imported_tpl_file.name).stem
        tpl_dir = _HERE / "templates"
        tpl_dir.mkdir(exist_ok=True)
        with open(tpl_dir / f"{tpl_import_name}.json", "w", encoding="utf-8") as f:
            json.dump(tpl_import_data, f, ensure_ascii=False, indent=2)
        st.success(f"✅ テンプレート '{tpl_import_name}' をインポートしました")
    except Exception as e:
        st.error(f"インポートエラー: {e}")

# ---------------------------------------------------------------------------
# Step 5: エクスポート
# ---------------------------------------------------------------------------

st.markdown("---")
st.header("Step 5 — 分析結果エクスポート")

if st.session_state.analysis_results:
    results = st.session_state.analysis_results

    col_exp1, col_exp2 = st.columns(2)

    with col_exp1:
        st.subheader("JSON形式")
        json_data = json.dumps(
            [asdict(r) for r in results],
            ensure_ascii=False,
            indent=2,
        )
        st.download_button(
            label="⬇ 分析結果をJSON形式でダウンロード",
            data=json_data.encode("utf-8"),
            file_name="analysis_result.json",
            mime="application/json",
            key="dl_json_btn",
        )

    with col_exp2:
        st.subheader("CSV形式")
        csv_export_rows = []
        for r in results:
            csv_export_rows.append({
                "セグメント番号": r.segment_index + 1,
                "開始(s)": r.start,
                "終了(s)": r.end,
                "長さ(s)": r.duration,
                "発話パターン": r.dialogue_pattern.label,
                "CSVパターン(重複)": r.csv_pattern.label,
                "CSVパターン(無音区間)": r.gap_csv_pattern.label,
                "CSV行数(重複)": r.overlapping_csv_row_count,
                "CSV行数(無音区間)": r.gap_csv_row_count,
                "テキスト": r.text,
            })
        df_export = pd.DataFrame(csv_export_rows)
        csv_buf = io.StringIO()
        df_export.to_csv(csv_buf, index=False, encoding="utf-8-sig")
        st.download_button(
            label="⬇ 分析結果をCSV形式でダウンロード",
            data=csv_buf.getvalue().encode("utf-8-sig"),
            file_name="analysis_result.csv",
            mime="text/csv",
            key="dl_csv_btn",
        )
else:
    st.info("Step 3 でパターン分析を実行するとエクスポートが可能になります。")

# ---------------------------------------------------------------------------
# フッター
# ---------------------------------------------------------------------------

st.markdown("---")
st.caption(
    "音声CSVパターン分析ツール Streamlit版  |  "
    "同フォルダの `index.html` でブラウザ版も利用できます  |  "
    "コアロジック: analyze.py"
)
