# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for 音声CSVパターン分析ツール
# Usage: pyinstaller build.spec

a = Analysis(
    ['gui.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'analyze',
        'dearpygui',
        'dearpygui.dearpygui',
        'sounddevice',
        'soundfile',
        'soundfile._sndfile',
        'webrtcvad',
        'numpy',
        'numpy.core._multiarray_umath',
        'cffi',
        '_cffi_backend',
    ],
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
