# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for 音声CSVパターン分析ツール
# Usage: pyinstaller build.spec

from PyInstaller.utils.hooks import collect_all

# cffi ベース・ネイティブ拡張のバイナリ/データ/隠しインポートを確実に収集
# (PyInstaller 6.x でのDLL収集挙動変更に対応)
_webrtcvad = collect_all('webrtcvad')
_sounddevice = collect_all('sounddevice')
# sounddevice の PortAudio DLL は _sounddevice_data という別パッケージに格納されているため
# collect_all('sounddevice') だけでは portaudio64bit.dll が拾われない場合がある
_sounddevice_data = collect_all('_sounddevice_data')
_dearpygui = collect_all('dearpygui')

a = Analysis(
    ['gui.py'],
    pathex=['.'],
    binaries=_webrtcvad[1] + _sounddevice[1] + _sounddevice_data[1] + _dearpygui[1],
    datas=_webrtcvad[0] + _sounddevice[0] + _sounddevice_data[0] + _dearpygui[0],
    hiddenimports=[
        'analyze',
        'soundfile',
        'soundfile._sndfile',
        'numpy',
        'numpy.core._multiarray_umath',
        'cffi',
        '_cffi_backend',
    ] + _webrtcvad[2] + _sounddevice[2] + _sounddevice_data[2] + _dearpygui[2],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 未使用のGUIフレームワークを除外してサイズを削減
    excludes=['tkinter', 'PyQt5', 'PyQt6', 'wx', 'PySide6', 'matplotlib'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='AudioCSVPatternTool',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX なしでも動作するように
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,      # コンソールウィンドウを非表示（GUIアプリ）
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
