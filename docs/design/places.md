# 場所(places)— 登録して、時系列で変化させる

作成日時: 2026-07-27 01:03
更新日時: 2026-07-27 01:40

キャラクターと同じように**場所を登録制の第一級エンティティにする**設計メモ。
2026-07-27 のユーザー発案。未完了タスクの「[location の引き継ぎ](../plan/progress.md)」を含む。

## 1. 動機と決定事項

**動機は「現在のロケーションが曖昧」**。いま場所の情報は 3 系統に散っていて、どれが正なのか決まっていない。

| いまの持ち方 | 問題 |
|---|---|
| `nodes.location`(自由テキスト) | 表記ゆれを防げない(「港」「港町」「港の桟橋」)。空欄だと清書が「場所: 不明」になる |
| `chars[id].facts["location"]`(fact_set scope=char) | EVENT_RULES が例示しているので LLM がよく出す。ノードの location と食い違う |
| `world.facts[key]`(フラット辞書) | 場所ごとの状態を持てない。`港_天気` のようなキー命名規約でしか表現できない |

決定事項(ユーザー判断):

- **場所は必ず登録する。** ノードは登録済みの場所から **1 つだけ** 選ぶ(cast と同じ選び方、ただし単一選択)
- **場所は記憶を持たない。関係も持たない。** 記憶は視点を持つ主体のもの
- **状態(facts)だけが、たまに変化する。** 変化の頻度はキャラより大幅に低い

## 2. データモデル

### places テーブル(新規)

```sql
CREATE TABLE IF NOT EXISTS places(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,     -- 固定設定(地形・規模・成り立ち)。清書に毎回渡す
  atmosphere TEXT,      -- 雰囲気・空気感。清書の描写トーン用
  color TEXT,           -- UI 表示色(characters.color と同じ役割)
  image_path TEXT,      -- 参考画像(装飾専用。LLM には渡さない)
  created_at TEXT
);
```

`characters` と同型にする。`profile` / `appearance` に対応するのが `description` / `atmosphere`。

### nodes.location

**列名はそのまま、中身を place の ID にする。** 型は TEXT のままなので ALTER は不要。

- 空文字 / NULL = 「親から引き継ぐ」の意味になる(§4)
- 既存の自由テキストは移行で places に登録する(§8)

### state に places を足す

```
state = {
  world:  { time, facts },
  chars:  { id: { status, retire_reason, facts, relationships, memories } },
  places: { id: { facts } },          ← 追加
}
```

`places[id]` は `facts` のみ。status も memories も持たない。

### イベント

**新しいイベント型は作らない。** `fact_set` に scope の 3 つめを足すだけ。

```json
{ "type": "fact_set", "payload": { "scope": "place", "place": "port", "key": "橋", "value": "落ちている" } }
```

`fact_set` は scope ごとにスキーマ変種を分けてある(条件付き required を llama.cpp の
グラマー変換が扱えないため)。ここに 3 つめの変種が増える形になる。

## 3. fold の変更([backend/fold.py](../../backend/fold.py))

```python
def empty_state():
    return {"world": {...}, "chars": {}, "places": {}}   # places を追加

def _ensure_place(state, place_id):
    if place_id not in state["places"]:
        state["places"][place_id] = {"facts": {}}
    return state["places"][place_id]

# apply_event の fact_set 分岐
if payload["scope"] == "world":   ...
elif payload["scope"] == "place":
    place = _ensure_place(state, payload["place"])   # place 欠落は ValueError
    place["facts"][payload["key"]] = payload["value"]
else:                              # scope == "char"
    ...
```

**場所の「登場」は location からの導出**(cast からの登場導出と同じ理屈)。

```python
def fold(parent_state, events, cast=None, location=None):
    state = deepcopy(parent_state)
    for char_id in cast or []:
        _ensure_char(state, char_id)
    if location:
        _ensure_place(state, location)     # 初めて使われた場所を state に作る
    for event in events:
        apply_event(state, event)
    return state
```

**`input_hash` に location を含める**(重要)。いまは `parent_state_hash + events_hash + cast` で、
ここに location を足さないと、location を変えても state_cache が再計算されない。

```python
def input_hash(parent_state_hash, node_events_hash, cast=None, location=None):
```

**キャラの現在地は state に置かない。** キャラがどこにいるかは「そのキャラを cast に含む
直近ノードの実効ロケーション」で決まる。`fact_set(scope="char", key="location")` は
機能としては残す(別行動中のキャラの居場所を明示したいときに使える)が、
**EVENT_RULES の例示からは外す** — LLM がノードの location と食い違う値を出す原因になっているため。

## 4. 実効ロケーション(引き継ぎ)

`nodes.location` が空なら、**親を遡って直近の非空の場所を使う**。
「場所が変わらない限り書かない」という自然な書き方を許すため。

```python
# backend/store.py
def effective_location(self, node_id) -> tuple[str | None, bool]:
    """(place_id, 継承かどうか)。自ノードに値があれば (それ, False)。
    なければ親を遡り、最初に見つかった値を (それ, True) で返す。"""
```

- 遡るのは **親チェーン**(正史パスではない)。分岐上でも自分の祖先から取れる
- 島の根まで遡って見つからなければ `None`(表示は「不明」)
- 参照先が 4 箇所ある(§6)。**すべてこの 1 関数を通す**

ID 参照になったことで、遡って得た値が確実に同じ場所を指す(自由テキスト時代は
「港」と「港町」が別物になっていた)。

## 5. 場所 facts の変化を誰が発行するか

**第 1 段階は手動のみ。** LLM の抽出スキーマには入れない。

理由は 2 つ。

1. 2026-07-26 に「LLM が出すイベントは 3 種のみ」と絞ったばかり([node-inheritance.md](node-inheritance.md))。
   scope が 3 択になると 12B の判断負荷が上がり、char に入れるべき事実を place に入れる誤りが増える
2. 場所の変化(橋が落ちた、店が畳まれた)は**作者が意図して決めたい**種類の情報で、
   キャラの内面と違って自動抽出の必要性が低い。変化の頻度自体も低い

効果を見て「毎回手で書くのが面倒」と感じたら、抽出スキーマに開放する(§8 Step 2)。

## 6. プロンプトへの注入(4 箇所)

いずれも「固定設定(places 行)+ その時点の facts(state)」の 2 層で出す。

| 箇所 | 変更 |
|---|---|
| 清書 [rendering.py](../../backend/rendering.py) | `## このシーンのビート` の `場所: {location or '不明'}` を実効ロケーションの**名前**に。さらに `## 場所` ブロックを新設し、description / atmosphere / その時点の facts を出す。**POV でフィルタしない**(その場にいる以上、場所の状態は見えている) |
| 生成コンテキスト [generation.py](../../backend/generation.py) | `_format_state` に「場所: {name} — {facts}」を **1 つだけ**(直近ノードの実効ロケーション)追加。`_format_recent_beats` の `@{location}` を名前表示に |
| 相談チャット [chat_agent.py](../../backend/chat_agent.py) | `get_beats` の返す `location` を名前に。`get_state` に場所ブロックを追加 |
| ノードカード [StructureMode.tsx](../../src/renderer/src/modes/StructureMode.tsx) | `@{location}` を名前表示に。**継承分は淡い色**で出して、自ノードで指定した場所と区別する |

**全キャラ・全状態を入れている現状の肥大化問題**(progress の未完了)に対して、場所は
「そのシーンの 1 つだけ」なので追加コストは小さい。

### 生成スキーマの location

`beat_schema` の `location` を **登録済み place ID の enum** にする(cast が char_ids の enum に
なっているのと同じ)。これで生成経路の表記ゆれが構造的に消える。

新しい場所が必要な展開を LLM が書きたい場合は、enum に縛られて書けない。第 1 段階では
**作者が先に場所を登録する**運用にする(場所は数が少なく、登録は軽い)。窮屈さを感じたら、
`location_new`(任意テキスト)を別プロパティで許して、確定時に places へ登録する案を検討する。

## 7. UI

- **場所庫**: [CharactersMode.tsx](../../src/renderer/src/modes/CharactersMode.tsx) を「エンティティ庫」に拡張し、
  **キャラクター / 場所 / 勢力** の 3 タブにする。`factions` は API だけあって UI が未実装なので、
  この拡張 1 回で 2 つ片付く。CRUD の形はキャラクターとほぼ同じ
- **ノードのインスペクタ**: location をテキスト入力 → **セレクト(単一選択)**。
  未選択のときは「(継承: 港)」を淡色で表示し、選ぶと上書きになることが分かるようにする
- **インスペクタの「場所」タブ**: そのシーン時点の場所 facts と、変化の履歴。
  [FactTimeline.tsx](../../src/renderer/src/FactTimeline.tsx) の帯を場所に流用できる
- **[EventsEditor.tsx](../../src/renderer/src/EventsEditor.tsx)**: `fact_set` の scope プルダウンに「場所」を追加し、
  scope=place のとき place セレクトを出す
- **場所マップ**(progress の未完了「場所マップ」): 場所ごとにキャラをまとめて表示する。
  実効ロケーションがあれば「各キャラの直近ノードの場所」で機械的に出せる

## 8. 段階

### Step 0 — 登録と参照(LLM を触らない)✅ 2026-07-27 実装済み

places テーブル + CRUD API + 場所庫 UI、`nodes.location` の ID 化と移行、実効ロケーション、
清書への `## 場所` 注入(固定設定のみ)。

**移行**: 既存の `nodes.location` の非空文字列を一意化して places に自動登録し、
ノードの値をその ID に置き換える。`db.init_schema` の `user_version` 分岐に一回限りの変換として登録する。

この段階だけで「背景が毎回 LLM の想像になる」問題はかなり軽くなる。時系列変化はまだない。

実装で決めた細部(設計時に書いていなかった点):

- **場所庫は「資料庫」モードの中のタブ**にした(上部モードの `キャラクター` → `資料庫`)。
  勢力タブは今回入れていない(API はあるので後から足せる)
- **実効ロケーションはフロントでも解決する**。構造モードは全ノード + 全エッジを持っているので、
  ノードカードの表示のためにバックエンドへ問い合わせない(`effectiveLocations` の memo)。
  規則はバックエンドの `Store.effective_location` と同じ
- **場所が 1 つも登録されていないとき、生成スキーマから `location` を外す**。
  自由テキストを許すと ID 参照との混在データが生まれるため
- **相談チャットの `propose_beats` からは `location` を削除**した。LLM に場所 ID の一覧を
  渡していないので文字列を作らせないほうが安全で、空欄で挿入すればアンカーから引き継がれる
- **場所の削除**は、参照していたシーンを「引き継ぐ」(空欄)に戻して renders を stale にする

### Step 1 — 時系列変化(手動のみ)

state に `places` を追加、`fact_set(scope="place")` の fold 実装、`input_hash` への location 追加、
EventsEditor の対応、インスペクタの場所タブ、清書と生成コンテキストへの facts 注入。

**state のスキーマが変わるが、state は導出物なので既存 DB は再 fold すれば済む**(設計原則 2)。
`state_cache` を全削除して dirty にすれば移行完了。

### Step 2 — LLM 抽出への開放(効果を見てから)

抽出スキーマに scope="place" の変種を追加、EVENT_RULES に 1〜2 行。
同時に EVENT_RULES から `scope="char"` の location 例示を外す。

## 9. 波及箇所

| ファイル | 変更 | Step |
|---|---|---|
| [backend/db.py](../../backend/db.py) | places テーブル、location の一回限り移行 | 0 |
| [backend/store.py](../../backend/store.py) | places CRUD、`effective_location`、fold 呼び出しに location | 0/1 |
| [backend/app.py](../../backend/app.py) | `/places` エンドポイント群 | 0 |
| [backend/fold.py](../../backend/fold.py) | `empty_state` / `_ensure_place` / fact_set 分岐 / `fold` 引数 / `input_hash` | 1 |
| [backend/validation.py](../../backend/validation.py) | 未登録 place の参照を警告。将来は隣接情報で瞬間移動チェック(現状 TODO) | 1 |
| [backend/rendering.py](../../backend/rendering.py) | `## 場所` ブロック、場所名の解決 | 0/1 |
| [backend/generation.py](../../backend/generation.py) | location の enum 化、`_format_state` / `_format_recent_beats`、EVENT_RULES | 0/2 |
| [backend/chat_agent.py](../../backend/chat_agent.py) | `get_beats` / `get_state` の場所表示 | 0/1 |
| [types.ts](../../src/renderer/src/types.ts) / [api.ts](../../src/renderer/src/api.ts) | Place 型、places API | 0 |
| [CharactersMode.tsx](../../src/renderer/src/modes/CharactersMode.tsx) | 3 タブ化(キャラ / 場所 / 勢力) | 0 |
| [StructureMode.tsx](../../src/renderer/src/modes/StructureMode.tsx) | location セレクト、継承表示、場所タブ | 0/1 |
| [EventsEditor.tsx](../../src/renderer/src/EventsEditor.tsx) | scope=place | 1 |

テストは `backend/tests/` の `fact_set(scope="char", key="location")` を使っている箇所が複数あるが、
**この機能は残すのでテストはそのまま通る**。places 用のテストを追加する。

## 10. 決めていないこと

- **場所の階層**(桟橋 ⊂ 港町 ⊂ 王国)。持てば「町の状態」を桟橋のシーンから参照できるが、
  fold と UI が一段複雑になる。第 1 段階では**持たない**(フラットな一覧)
- **場所間の隣接情報**。[validation.py](../../backend/validation.py) の冒頭に「location の瞬間移動チェックは
  場所の隣接情報が未定義のため未実装(TODO)」とある。places が入れば隣接テーブルを足して解ける。
  ただし作者が隣接を全部書く手間に見合うかは不明なので保留
- **場所に対するキャラの関係**(思い入れ、所属)。relationships の `target_type` は既に
  char / faction を持つので place を足せるが、必要性が見えるまで作らない
- **時間帯・天気を場所 facts に入れるか、world に残すか**。天気は場所ごとに違いうるが、
  当面は world.facts のままにして、必要になったら場所 facts に移す
