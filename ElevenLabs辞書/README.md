# ElevenLabs 発音辞書

## 概要

ElevenLabsで作成したヤンデレ系日本語ボイス用の発音辞書（PLS形式）です。
日本語台本をより自然に読み上げるための発音ルールを定義しています。

## ファイル

| ファイル | 説明 |
|---------|------|
| `elevenlabs_pronunciation_dictionary.pls` | PLS形式の発音辞書（ElevenLabsにアップロード） |

## 辞書の内容（5カテゴリ）

### 1. 漢字の読み間違い防止 — 62語
台本で頻出する漢字のうち、TTSが誤読しやすいものの読みを固定。5サブカテゴリに分類。

| サブカテゴリ | 件数 | 例 |
|-------------|------|-----|
| 1-A. 身体・感覚 | 15語 | `疼く`→`うずく`、`項`→`うなじ` |
| 1-B. 動作・行為 | 21語 | `弄る`→`いじる`、`蕩ける`→`とろける` |
| 1-C. 感情・心理 | 12語 | `恍惚`→`こうこつ`、`蠱惑`→`こわく` |
| 1-D. 時間・場面 | 6語 | `今日`→`きょう`、`何処`→`どこ` |
| 1-E. 台本演出・指示 | 8語 | `紅潮`→`こうちょう`、`膨張`→`ぼうちょう` |

### 2. ヤンデレ口調の頻出表現 — 10語
ボイスのキャラクター性に関連する感情表現の正しい読み。

例: `狂おしい` → `くるおしい`、`執着` → `しゅうちゃく`

### 3. 演出記号の処理 — 5語
音声作品特有の記号（♡、♪、$など）を無音化。波線（～）を長音符（ー）に正規化。

### 4. オノマトペ — 8語
台本で使われる擬音語・擬態語の読みを保証。

### 5. 笑い声・息遣い — 6語
ヤンデレキャラ特有の笑い方（あはっ、えへへ、ふふ……）の読みを定義。

## ElevenLabsへの登録方法

### UIから登録する場合
1. [ElevenLabs](https://elevenlabs.io) にログイン
2. **Speech** → **Pronunciation Dictionaries** を開く
3. **Add** → **Upload PLS file** を選択
4. `elevenlabs_pronunciation_dictionary.pls` をアップロード
5. 対象のボイスまたはプロジェクトに辞書を紐付け

### APIから登録する場合
```bash
curl -X POST "https://api.elevenlabs.io/v1/pronunciation-dictionaries/add-from-file" \
  -H "xi-api-key: YOUR_API_KEY" \
  -F "name=yandere-voice-dict" \
  -F "file=@elevenlabs_pronunciation_dictionary.pls"
```

---

## ボイス2: 癒し系・囁くように甘く穏やかな若い女性

### 概要
柔らかく愛情深い、落ち着いた囁き声の若い女性ボイス。ゆっくりとした自然なペースで、リスナーのそばにいるような親密さと温もりを感じさせる。

### プロンプト
```
A young Japanese woman speaking in a soft, affectionate, and soothing manner.
Her voice is calm, warm, and slightly breathy, with a gentle and intimate feeling.
She speaks slowly with natural pauses, as if she is very close to the listener.
Her tone expresses kindness, sweetness, and emotional warmth, like she is comforting and caring for someone she loves.
The delivery should feel natural and relaxed, not overly dramatic or exaggerated.
Focus on a tender, whisper-like quality with subtle emotional expression.
```

### ファイル

| ファイル | 説明 |
|---------|------|
| `iyashi_soft_female_dictionary.pls` | 癒し系ボイス用PLS発音辞書 |

### 辞書の内容

| カテゴリ | 件数 | 内容 |
|---------|------|------|
| A. 漢字の読み間違い防止 | 62語 | 身体・感覚(15), 動作・行為(21), 感情・心理(12), 時間・場面(6), 台本演出(8) |
| B. 演出記号の処理 | 6語 | ～→ー正規化、♡♪☆★$の無音化 |
| C. オノマトペ | 10語 | 共通セット＋癒し系追加（ほわぁっと、ふわぁっと） |
| D. 癒し系キャラ特化表現 | 23語 | 安らぐ、穏やか、寄り添う、微睡む、温もり、癒す 等 |
| E. 笑い声・息遣い | 8語 | えへへ、ふふっ、んー……、うふふ 等 |
| **合計** | **109語** | |

### ElevenLabsへの登録方法

#### UIから登録する場合
1. [ElevenLabs](https://elevenlabs.io) にログイン
2. **Speech** → **Pronunciation Dictionaries** を開く
3. **Add** → **Upload PLS file** を選択
4. `iyashi_soft_female_dictionary.pls` をアップロード
5. 対象のボイスまたはプロジェクトに辞書を紐付け

#### APIから登録する場合
```bash
curl -X POST "https://api.elevenlabs.io/v1/pronunciation-dictionaries/add-from-file" \
  -H "xi-api-key: YOUR_API_KEY" \
  -F "name=iyashi-soft-female-dict" \
  -F "file=@iyashi_soft_female_dictionary.pls"
```

---

## 運用メモ

- ElevenLabsの辞書はプロジェクト単位で適用されるため、ボイスごとの使い分けが可能
- カタカナ造語・果物置換語はElevenLabsが正しく読めるため辞書登録不要
