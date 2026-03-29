# webrtcvad-wheels でインストールした場合のカスタムフック
#
# pyinstaller-hooks-contrib の標準 hook-webrtcvad.py は
#   datas = copy_metadata('webrtcvad')
# を呼ぶが、webrtcvad-wheels は pip メタデータを 'webrtcvad-wheels' として
# 登録しているため PackageNotFoundError が発生してビルドが失敗する。
# このファイルを hookspath に置くことで標準フックを上書きして問題を回避する。

hiddenimports = []
datas = []
binaries = []
