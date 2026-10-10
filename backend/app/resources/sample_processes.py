"""同梱の業務マスターに付けるサンプルのAs-Is。

アプリ状態をまだ保存していないテナントへ、業務マスターと一緒に返す。
開始と終了だけのフローでは画面の機能（情報の流れ、転記の指摘、滞留の把握）を
試せないため、分岐・差し戻し・複数の担当・紙やExcelを含む実務に近い形で持つ。

書き方:
- STEPS は (id, 種類, 名前, レーン, 使うシステム, 所要時間, リスク, 要確認, 説明)。
- FLOWS は (接続元, 接続先, ラベル)。
- INFORMATION は (タスクid, 入力, 出力)。「情報名@アセット名」で、入力なら取得元、
  出力なら格納先・送付先を表す。アセットを付けない情報は、頭の中や口頭のやり取り。
- ITEMS は情報に含まれる項目。項目が重なる情報をアセット間で移していると転記の候補になる。
"""

from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
from typing import Any

Step = tuple[str, str, str, str, str | None, str | None, str | None, bool, str]

SAMPLE_PROCESSES: list[dict[str, Any]] = [
    {
        "business_id": "ap-invoice",
        "title": "請求書処理 As-Is",
        "summary": "請求書の受領から照合・承認・支払・保管までを5つの担当にまたがって行う。差異確認と承認待ちで滞留しやすい。",
        "lanes": ["買掛金担当", "購買担当", "部門長", "経理マネージャー", "財務担当"],
        "assets": [
            ("SAP", "業務システム"),
            ("メール", "メール"),
            ("ワークフロー", "業務システム"),
            ("Excel", "Excel・台帳"),
            ("紙", "紙帳票"),
            ("インターネットバンキング", "業務システム"),
            ("共有フォルダ", "共有フォルダ"),
        ],
        "steps": [
            ("start", "start", "取引先から請求書を受領", "買掛金担当", None, None, None, False, ""),
            ("register", "task", "請求書を登録", "買掛金担当", "SAP", "10分", None, False, "メール・紙で届いた請求書を取引先・金額・支払期日ごとに登録する。"),
            ("match", "task", "発注・検収データと照合", "買掛金担当", "SAP", "15分", "medium", False, "発注書と検収実績を突き合わせ、金額と数量の差異を確認する。"),
            ("g-match", "gateway", "照合差異あり？", "買掛金担当", None, None, None, False, ""),
            ("confirm-diff", "task", "差異の内容を購買へ確認", "購買担当", "メール", "1〜2日", "high", True, "検収漏れ・単価違いなど、差異の原因を購買担当へメールで確認する。回答待ちで滞留しやすい。"),
            ("request-fix", "task", "訂正請求書を取引先へ依頼", "買掛金担当", "メール", "30分", None, False, ""),
            ("check-account", "task", "勘定科目・税区分を確認", "買掛金担当", "SAP", "10分", None, False, ""),
            ("make-approval", "task", "承認依頼を作成", "買掛金担当", "ワークフロー", "5分", None, False, "請求書の画像と照合結果を添付して承認依頼を起票する。"),
            ("dept-approve", "task", "請求内容を承認", "部門長", "ワークフロー", "1日", "high", True, "月末は承認依頼が集中し、承認待ちが数日に及ぶことがある。"),
            ("g-approve", "gateway", "承認されたか？", "部門長", None, None, None, False, ""),
            ("fix-reject", "task", "差し戻し内容を修正", "買掛金担当", "SAP", "20分", "medium", False, ""),
            ("book", "task", "支払予定を確定しSAPへ計上", "買掛金担当", "SAP", "15分", None, False, ""),
            ("make-payment", "task", "支払データを作成", "買掛金担当", "Excel", "10分", "medium", True, "SAPから出力した支払予定をExcelで整形している。手作業での転記ミスが懸念される。"),
            ("review-payment", "task", "支払内容をレビュー", "経理マネージャー", "Excel", "30分", None, False, ""),
            ("g-amount", "gateway", "1,000万円以上？", "経理マネージャー", None, None, None, False, ""),
            ("exec-approve", "task", "役員承認を取得", "経理マネージャー", "紙", "2日", "high", True, "紙の稟議書を持ち回って押印をもらう。役員の不在時は承認が止まる。"),
            ("send-bank", "task", "総合振込データを銀行へ送信", "財務担当", "インターネットバンキング", "10分", "medium", False, ""),
            ("clear", "task", "仕訳計上・消込", "買掛金担当", "SAP", "20分", None, False, ""),
            ("archive", "task", "証憑を共有フォルダへ保管", "買掛金担当", "共有フォルダ", "5分", "low", False, ""),
            ("end", "end", "支払完了", "財務担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "register", ""),
            ("register", "match", ""),
            ("match", "g-match", ""),
            ("g-match", "confirm-diff", "あり"),
            ("g-match", "check-account", "なし"),
            ("confirm-diff", "request-fix", ""),
            ("request-fix", "match", "再照合"),
            ("check-account", "make-approval", ""),
            ("make-approval", "dept-approve", ""),
            ("dept-approve", "g-approve", ""),
            ("g-approve", "fix-reject", "差し戻し"),
            ("fix-reject", "make-approval", "再申請"),
            ("g-approve", "book", "承認"),
            ("book", "make-payment", ""),
            ("make-payment", "review-payment", ""),
            ("review-payment", "g-amount", ""),
            ("g-amount", "exec-approve", "はい"),
            ("g-amount", "send-bank", "いいえ"),
            ("exec-approve", "send-bank", ""),
            ("send-bank", "clear", ""),
            ("clear", "archive", ""),
            ("archive", "end", ""),
        ],
        # 請求書と発注・検収データは社外・他業務から届くので、どのタスクも出力しない。
        "information": [
            ("register", ["請求書@メール"], ["請求書データ@SAP"]),
            ("match", ["請求書データ@SAP", "発注・検収データ@SAP"], ["照合結果"]),
            ("confirm-diff", ["照合結果"], ["差異の回答@メール"]),
            ("request-fix", ["差異の回答@メール"], ["訂正依頼@メール"]),
            ("check-account", ["請求書データ@SAP"], ["勘定科目・税区分@SAP"]),
            ("make-approval", ["請求書データ@SAP", "照合結果"], ["承認依頼@ワークフロー"]),
            ("dept-approve", ["承認依頼@ワークフロー"], ["承認結果@ワークフロー"]),
            ("fix-reject", ["承認結果@ワークフロー"], ["承認依頼@ワークフロー"]),
            ("book", ["承認結果@ワークフロー", "勘定科目・税区分@SAP"], ["支払予定@SAP"]),
            ("make-payment", ["支払予定@SAP"], ["支払予定表@Excel"]),
            ("review-payment", ["支払予定表@Excel"], ["レビュー結果"]),
            ("exec-approve", ["支払予定表@Excel"], ["役員承認@紙"]),
            ("send-bank", ["支払予定表@Excel"], ["総合振込データ@インターネットバンキング"]),
            ("clear", ["支払予定@SAP"], ["仕訳@SAP"]),
            ("archive", ["請求書@メール"], ["証憑ファイル@共有フォルダ"]),
        ],
        "items": {
            "請求書": ["請求番号", "取引先", "金額", "支払期日"],
            "支払予定": ["支払先", "金額", "支払期日"],
            "支払予定表": ["支払先", "金額", "支払期日", "振込口座"],
            "総合振込データ": ["支払先", "振込口座", "金額"],
        },
    },
    {
        "business_id": "expense",
        "title": "経費精算 As-Is",
        "summary": "従業員の申請から上長承認、経理の審査、仕訳連携、振込までを行う。不備の問い合わせと紙の原本回収に手間がかかる。",
        "lanes": ["申請者", "上長", "経費管理担当", "経理マネージャー", "財務担当"],
        "assets": [
            ("スマートフォン", "その他"),
            ("Concur", "SaaS"),
            ("Excel", "Excel・台帳"),
            ("メール", "メール"),
            ("紙", "紙帳票"),
            ("書庫", "紙帳票"),
            ("SAP", "業務システム"),
            ("インターネットバンキング", "業務システム"),
        ],
        "steps": [
            ("start", "start", "経費が発生", "申請者", None, None, None, False, ""),
            ("photo", "task", "領収書を撮影", "申請者", "スマートフォン", "5分", None, False, "Concurのアプリで領収書を撮影する。紙の領収書は申請後も手元に保管する。"),
            ("apply", "task", "経費を申請", "申請者", "Concur", "15分", "low", False, "交通費は乗換案内で調べた経路を手入力する。月末にまとめて申請する人が多い。"),
            ("mgr-approve", "task", "申請内容を承認", "上長", "Concur", "2日", "high", True, "出張中は承認が滞る。件数が多い上長は内容を見ずに承認していることがある。"),
            ("g-mgr", "gateway", "承認されたか？", "上長", None, None, None, False, ""),
            ("fix-apply", "task", "申請を修正して再申請", "申請者", "Concur", "20分", None, False, ""),
            ("check-receipt", "task", "領収書と申請内容を突合", "経費管理担当", "Concur", "10分", "medium", False, "金額・日付・宛名・インボイス登録番号を画像で目視確認する。"),
            ("check-policy", "task", "規程・勘定科目を確認", "経費管理担当", "Excel", "5分", "medium", True, "交際費の1人あたり単価や出張日当の上限を、規程をまとめたExcelで都度確認している。"),
            ("g-policy", "gateway", "不備・規程違反あり？", "経費管理担当", None, None, None, False, ""),
            ("inquire", "task", "申請者へ不備を問い合わせ", "経費管理担当", "メール", "1〜3日", "high", True, "回答待ちのまま締め日を過ぎ、翌月の精算に回ることがある。"),
            ("collect-paper", "task", "紙の原本を回収・保管", "経費管理担当", "書庫", "10分", "low", True, "電子保存の要件を満たさない領収書は、原本を社内便で回収して書庫へ綴じている。"),
            ("g-amount", "gateway", "10万円以上？", "経費管理担当", None, None, None, False, ""),
            ("fin-approve", "task", "高額経費を承認", "経理マネージャー", "Concur", "1日", None, False, ""),
            ("post", "task", "仕訳を連携・計上", "経費管理担当", "SAP", "10分", "medium", False, "ConcurからSAPへ連携する。連携エラーになった分はSAPへ手入力する。"),
            ("pay-data", "task", "精算金の振込データを作成", "財務担当", "インターネットバンキング", "15分", None, False, ""),
            ("pay", "task", "振込を実行", "財務担当", "インターネットバンキング", "10分", None, False, ""),
            ("end", "end", "精算金の支払完了", "財務担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "photo", ""),
            ("photo", "apply", ""),
            ("apply", "mgr-approve", ""),
            ("mgr-approve", "g-mgr", ""),
            ("g-mgr", "fix-apply", "差し戻し"),
            ("fix-apply", "mgr-approve", "再申請"),
            ("g-mgr", "check-receipt", "承認"),
            ("check-receipt", "check-policy", ""),
            ("check-policy", "g-policy", ""),
            ("g-policy", "inquire", "あり"),
            ("inquire", "fix-apply", "修正依頼"),
            ("g-policy", "collect-paper", "なし"),
            ("collect-paper", "g-amount", ""),
            ("g-amount", "fin-approve", "はい"),
            ("g-amount", "post", "いいえ"),
            ("fin-approve", "post", ""),
            ("post", "pay-data", ""),
            ("pay-data", "pay", ""),
            ("pay", "end", ""),
        ],
        "information": [
            ("photo", ["領収書@紙"], ["領収書画像@スマートフォン"]),
            ("apply", ["領収書画像@スマートフォン"], ["経費申請@Concur"]),
            ("mgr-approve", ["経費申請@Concur"], ["承認結果@Concur"]),
            ("fix-apply", ["承認結果@Concur", "不備の問い合わせ@メール"], ["経費申請@Concur"]),
            ("check-receipt", ["経費申請@Concur", "領収書画像@Concur"], ["突合結果"]),
            ("check-policy", ["経費申請@Concur", "経費規程@Excel"], ["審査結果"]),
            ("inquire", ["審査結果"], ["不備の問い合わせ@メール"]),
            ("collect-paper", ["領収書@紙"], ["領収書@書庫"]),
            ("fin-approve", ["経費申請@Concur"], ["承認結果@Concur"]),
            ("post", ["経費申請@Concur"], ["仕訳@SAP"]),
            ("pay-data", ["仕訳@SAP"], ["振込データ@インターネットバンキング"]),
            ("pay", ["振込データ@インターネットバンキング"], ["振込結果@インターネットバンキング"]),
        ],
        "items": {
            "領収書": ["日付", "金額", "宛名", "登録番号"],
            "経費申請": ["申請者", "日付", "金額", "勘定科目", "用途"],
            "仕訳": ["申請者", "金額", "勘定科目"],
            "振込データ": ["振込先", "振込口座", "金額"],
        },
    },
    {
        "business_id": "purchase-order",
        "title": "購買申請・発注 As-Is",
        "summary": "購買依頼の起票から仕様確認、相見積、稟議、発注、納期回答の記録までを行う。仕様の確認待ちと見積の転記が負担になっている。",
        "lanes": ["依頼部門", "依頼部門長", "購買担当", "購買課長", "取引先"],
        "assets": [
            ("ワークフロー", "業務システム"),
            ("メール", "メール"),
            ("Excel", "Excel・台帳"),
            ("SAP", "業務システム"),
        ],
        "steps": [
            ("start", "start", "購買の必要が発生", "依頼部門", None, None, None, False, ""),
            ("make-request", "task", "購買依頼を起票", "依頼部門", "ワークフロー", "20分", "medium", False, "品名・数量・希望納期・予算科目を入力する。仕様が曖昧なまま起票されることが多い。"),
            ("dept-approve", "task", "購買依頼を承認", "依頼部門長", "ワークフロー", "1日", None, False, ""),
            ("check-request", "task", "依頼内容・仕様を確認", "購買担当", "ワークフロー", "15分", None, False, ""),
            ("g-spec", "gateway", "仕様は確定している？", "購買担当", None, None, None, False, ""),
            ("clarify", "task", "仕様を依頼部門へ確認", "購買担当", "メール", "2〜3日", "high", True, "依頼部門の回答待ちで止まる。電話で聞いた内容は記録に残らない。"),
            ("g-contract", "gateway", "単価契約がある？", "購買担当", None, None, None, False, ""),
            ("rfq", "task", "3社へ見積を依頼", "購買担当", "メール", "30分", "medium", False, "見積依頼書をWordで作り、取引先ごとにメールで送る。"),
            ("quote", "task", "見積書を提出", "取引先", "メール", "3〜5日", None, False, ""),
            ("compare", "task", "見積を比較し発注先を選定", "購買担当", "Excel", "1時間", "medium", True, "比較表を毎回Excelで作る。選定理由の書き方が担当者によって違う。"),
            ("g-amount", "gateway", "100万円以上？", "購買担当", None, None, None, False, ""),
            ("mgr-approve", "task", "発注稟議を承認", "購買課長", "ワークフロー", "2日", "high", True, "期末は稟議が集中し、承認まで1週間かかることがある。"),
            ("create-po", "task", "SAPに発注を登録", "購買担当", "SAP", "15分", "medium", True, "見積書の明細をSAPへ手で転記して発注伝票を作る。単価の入力誤りが時々起きる。"),
            ("send-po", "task", "発注書を送付", "購買担当", "メール", "10分", None, False, "SAPから出力したPDFをメールで送る。"),
            ("confirm", "task", "注文請書を返送", "取引先", "メール", "2日", None, False, ""),
            ("record-confirm", "task", "納期回答を記録", "購買担当", "Excel", "10分", "low", True, "回答された納期をExcelの発注管理表に記録し、納品の追いかけに使う。"),
            ("end", "end", "発注完了", "購買担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "make-request", ""),
            ("make-request", "dept-approve", ""),
            ("dept-approve", "check-request", ""),
            ("check-request", "g-spec", ""),
            ("g-spec", "clarify", "いいえ"),
            ("clarify", "check-request", "再確認"),
            ("g-spec", "g-contract", "はい"),
            ("g-contract", "create-po", "あり"),
            ("g-contract", "rfq", "なし"),
            ("rfq", "quote", ""),
            ("quote", "compare", ""),
            ("compare", "g-amount", ""),
            ("g-amount", "mgr-approve", "はい"),
            ("g-amount", "create-po", "いいえ"),
            ("mgr-approve", "create-po", ""),
            ("create-po", "send-po", ""),
            ("send-po", "confirm", ""),
            ("confirm", "record-confirm", ""),
            ("record-confirm", "end", ""),
        ],
        "information": [
            ("make-request", [], ["購買依頼@ワークフロー"]),
            ("dept-approve", ["購買依頼@ワークフロー"], ["承認済み購買依頼@ワークフロー"]),
            ("check-request", ["承認済み購買依頼@ワークフロー"], ["確認結果"]),
            ("clarify", ["確認結果"], ["仕様の回答@メール"]),
            ("rfq", ["承認済み購買依頼@ワークフロー"], ["見積依頼書@メール"]),
            ("quote", ["見積依頼書@メール"], ["見積書@メール"]),
            ("compare", ["見積書@メール"], ["見積比較表@Excel"]),
            ("mgr-approve", ["見積比較表@Excel"], ["発注稟議@ワークフロー"]),
            ("create-po", ["見積書@メール", "承認済み購買依頼@ワークフロー"], ["発注データ@SAP"]),
            ("send-po", ["発注データ@SAP"], ["発注書@メール"]),
            ("confirm", ["発注書@メール"], ["注文請書@メール"]),
            ("record-confirm", ["注文請書@メール"], ["発注管理表@Excel"]),
        ],
        "items": {
            "購買依頼": ["品名", "数量", "希望納期", "予算科目"],
            "見積書": ["品名", "数量", "単価", "納期"],
            "見積比較表": ["取引先", "品名", "単価", "納期"],
            "発注データ": ["取引先", "品名", "数量", "単価", "納期"],
            "発注管理表": ["発注番号", "取引先", "納期"],
        },
    },
    {
        "business_id": "receiving-inspection",
        "title": "納品・検収管理 As-Is",
        "summary": "納品予定の確認から受領、品質検査、入庫・検収登録、経理への回付までを行う。差異の電話連絡と紙の納品書の回付で情報が途切れやすい。",
        "lanes": ["取引先", "倉庫・受入担当", "依頼部門", "購買担当", "買掛金担当"],
        "assets": [
            ("Excel", "Excel・台帳"),
            ("紙", "紙帳票"),
            ("電話", "その他"),
            ("メール", "メール"),
            ("SAP", "業務システム"),
            ("共有フォルダ", "共有フォルダ"),
        ],
        "steps": [
            ("start", "start", "発注済み案件の納品予定日が到来", "倉庫・受入担当", None, None, None, False, ""),
            ("check-schedule", "task", "当日の納品予定を確認", "倉庫・受入担当", "Excel", "15分", None, False, "購買担当が共有する発注管理表から当日分を抜き出して印刷する。"),
            ("deliver", "task", "納品書とともに納品", "取引先", "紙", None, None, False, ""),
            ("receive", "task", "現品と納品書を照合", "倉庫・受入担当", "紙", "20分", "medium", False, "品名と数量を目視で数え、納品書に手書きでチェックを付けて受領印を押す。"),
            ("g-qty", "gateway", "数量・品目は一致？", "倉庫・受入担当", None, None, None, False, ""),
            ("report-diff", "task", "差異を購買へ連絡", "倉庫・受入担当", "電話", "15分", "high", True, "電話で伝えるため記録が残らず、購買側で対応漏れが起きることがある。"),
            ("arrange", "task", "過不足・再納品を取引先と調整", "購買担当", "メール", "2〜5日", "high", False, ""),
            ("g-inspect", "gateway", "品質検査が必要？", "倉庫・受入担当", None, None, None, False, ""),
            ("inspect", "task", "品質・仕様を検査", "依頼部門", "紙", "1〜3日", "medium", True, "検査する人が決まっておらず、通常業務の合間に行うため検収が後回しになる。"),
            ("g-pass", "gateway", "合格？", "依頼部門", None, None, None, False, ""),
            ("return", "task", "不良品の返品を手配", "購買担当", "メール", "1日", None, False, ""),
            ("gr-entry", "task", "SAPに入庫・検収を登録", "倉庫・受入担当", "SAP", "10分", "medium", True, "受領印を押した納品書を見ながらSAPへ手入力する。入力が翌日以降にずれることがある。"),
            ("send-slip", "task", "納品書を経理へ回付", "倉庫・受入担当", "紙", "1〜2日", "medium", False, "社内便で買掛金担当へ送る。請求書との照合に使われる。"),
            ("file", "task", "検収記録を保管", "買掛金担当", "共有フォルダ", "5分", "low", False, "納品書をスキャンして共有フォルダへ保存する。"),
            ("end", "end", "検収完了", "買掛金担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "check-schedule", ""),
            ("check-schedule", "deliver", ""),
            ("deliver", "receive", ""),
            ("receive", "g-qty", ""),
            ("g-qty", "report-diff", "不一致"),
            ("report-diff", "arrange", ""),
            ("arrange", "deliver", "再納品"),
            ("g-qty", "g-inspect", "一致"),
            ("g-inspect", "inspect", "はい"),
            ("g-inspect", "gr-entry", "いいえ"),
            ("inspect", "g-pass", ""),
            ("g-pass", "return", "不合格"),
            ("return", "deliver", "再納品"),
            ("g-pass", "gr-entry", "合格"),
            ("gr-entry", "send-slip", ""),
            ("send-slip", "file", ""),
            ("file", "end", ""),
        ],
        "information": [
            ("check-schedule", ["発注管理表@Excel"], ["当日の納品予定@紙"]),
            ("deliver", [], ["納品書@紙"]),
            ("receive", ["納品書@紙", "当日の納品予定@紙"], ["受領済み納品書@紙"]),
            ("report-diff", ["受領済み納品書@紙"], ["差異連絡@電話"]),
            ("arrange", ["差異連絡@電話"], ["再納品依頼@メール"]),
            ("inspect", ["受領済み納品書@紙"], ["検査結果@紙"]),
            ("return", ["検査結果@紙"], ["再納品依頼@メール"]),
            ("gr-entry", ["受領済み納品書@紙"], ["入庫・検収データ@SAP"]),
            ("send-slip", ["受領済み納品書@紙"], []),
            ("file", ["受領済み納品書@紙"], ["検収記録@共有フォルダ"]),
        ],
        "items": {
            "発注管理表": ["発注番号", "取引先", "納期"],
            "納品書": ["発注番号", "品名", "数量"],
            "受領済み納品書": ["発注番号", "品名", "数量", "受領日"],
            "入庫・検収データ": ["発注番号", "品名", "数量", "検収日"],
        },
    },
    {
        "business_id": "onboarding",
        "title": "入社手続き As-Is",
        "summary": "入社書類の回収から従業員情報の登録、各部門への連絡、アカウント・備品・社会保険の準備、初日のオリエンテーションまでを行う。紙の書類からの二重入力と、部門間の連絡の遅れが課題。",
        "lanes": ["人事オペレーション担当", "入社予定者", "配属部門", "情報システム", "総務"],
        "assets": [
            ("メール", "メール"),
            ("紙", "紙帳票"),
            ("SuccessFactors", "SaaS"),
            ("給与システム", "業務システム"),
            ("Excel", "Excel・台帳"),
            ("ワークフロー", "業務システム"),
            ("Active Directory", "業務システム"),
            ("e-Gov", "その他"),
        ],
        "steps": [
            ("start", "start", "入社予定者が確定", "人事オペレーション担当", None, None, None, False, ""),
            ("send-docs", "task", "入社書類一式を送付", "人事オペレーション担当", "メール", "30分", None, False, "雇用契約書・誓約書・身上書などをメールで送り、記入後に郵送で返送してもらう。"),
            ("submit", "task", "書類を記入して返送", "入社予定者", "紙", "3〜7日", "medium", False, ""),
            ("check-docs", "task", "提出書類の不備を確認", "人事オペレーション担当", "紙", "20分", "medium", False, ""),
            ("g-docs", "gateway", "不備あり？", "人事オペレーション担当", None, None, None, False, ""),
            ("request-resubmit", "task", "再提出を依頼", "人事オペレーション担当", "メール", "2〜3日", "high", True, "マイナンバーや扶養家族の記入不備が多く、入社日の直前までやり取りが続く。"),
            ("register", "task", "従業員情報を登録", "人事オペレーション担当", "SuccessFactors", "30分", "medium", True, "紙の身上書を見ながら手入力する。"),
            ("payroll-register", "task", "給与システムへ登録", "人事オペレーション担当", "給与システム", "20分", "medium", True, "SuccessFactorsに入れた内容と同じものを給与システムへもう一度入力している。"),
            ("notify", "task", "入社連絡票を各部門へ送付", "人事オペレーション担当", "メール", "15分", None, False, "Excelの入社連絡票を情報システム・総務・配属部門へメールで送る。"),
            ("request-account", "task", "アカウント発行を申請", "配属部門", "ワークフロー", "15分", None, False, ""),
            ("create-account", "task", "アカウントとPCを準備", "情報システム", "Active Directory", "1〜2日", "medium", True, "入社連絡が遅れるとPCのキッティングが入社日に間に合わない。"),
            ("prepare-items", "task", "入館証・備品を手配", "総務", "Excel", "1日", None, False, ""),
            ("g-insurance", "gateway", "社会保険の加入対象？", "人事オペレーション担当", None, None, None, False, ""),
            ("insurance", "task", "社会保険の資格取得届を提出", "人事オペレーション担当", "e-Gov", "30分", "medium", True, "入社日から5日以内の届出が必要。短時間勤務の人は加入要件を勤務時間から都度判断している。"),
            ("orientation", "task", "入社初日のオリエンテーション", "人事オペレーション担当", None, "3時間", None, False, ""),
            ("end", "end", "入社初日の手続き完了", "人事オペレーション担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "send-docs", ""),
            ("send-docs", "submit", ""),
            ("submit", "check-docs", ""),
            ("check-docs", "g-docs", ""),
            ("g-docs", "request-resubmit", "あり"),
            ("request-resubmit", "submit", "再提出"),
            ("g-docs", "register", "なし"),
            ("register", "payroll-register", ""),
            ("payroll-register", "notify", ""),
            ("notify", "request-account", ""),
            ("request-account", "create-account", ""),
            ("notify", "prepare-items", ""),
            ("notify", "g-insurance", ""),
            ("g-insurance", "insurance", "対象"),
            ("g-insurance", "orientation", "対象外"),
            ("create-account", "orientation", ""),
            ("prepare-items", "orientation", ""),
            ("insurance", "orientation", ""),
            ("orientation", "end", ""),
        ],
        "information": [
            ("send-docs", [], ["入社書類一式@メール"]),
            ("submit", ["入社書類一式@メール"], ["記入済み入社書類@紙"]),
            ("check-docs", ["記入済み入社書類@紙"], ["不備チェック結果"]),
            ("request-resubmit", ["不備チェック結果"], ["再提出依頼@メール"]),
            ("register", ["記入済み入社書類@紙"], ["従業員情報@SuccessFactors"]),
            ("payroll-register", ["記入済み入社書類@紙"], ["給与基本情報@給与システム"]),
            ("notify", ["従業員情報@SuccessFactors"], ["入社連絡票@メール"]),
            ("request-account", ["入社連絡票@メール"], ["アカウント申請@ワークフロー"]),
            ("create-account", ["アカウント申請@ワークフロー"], ["アカウント情報@Active Directory"]),
            ("prepare-items", ["入社連絡票@メール"], ["備品管理台帳@Excel"]),
            ("insurance", ["従業員情報@SuccessFactors"], ["資格取得届@e-Gov"]),
            ("orientation", ["アカウント情報@Active Directory"], []),
        ],
        "items": {
            "記入済み入社書類": ["氏名", "住所", "生年月日", "マイナンバー", "振込口座", "扶養家族"],
            "従業員情報": ["氏名", "住所", "生年月日", "所属", "入社日"],
            "給与基本情報": ["氏名", "住所", "振込口座", "扶養家族"],
            "入社連絡票": ["氏名", "所属", "入社日"],
        },
    },
    {
        "business_id": "hr-offboarding",
        "title": "退社手続き As-Is",
        "summary": "退職の申し出から各部門への連絡、貸与物の回収、アカウント停止、最終給与と社会保険の手続き、証明書の発行までを行う。連絡漏れによるアカウントの残存と貸与物の未回収が起きやすい。",
        "lanes": ["退職者", "所属部門長", "人事オペレーション担当", "情報システム", "総務"],
        "assets": [
            ("紙", "紙帳票"),
            ("メール", "メール"),
            ("SuccessFactors", "SaaS"),
            ("Excel", "Excel・台帳"),
            ("Active Directory", "業務システム"),
            ("各SaaS管理画面", "SaaS"),
            ("給与システム", "業務システム"),
            ("e-Gov", "その他"),
        ],
        "steps": [
            ("start", "start", "退職の申し出", "退職者", None, None, None, False, ""),
            ("submit", "task", "退職届を提出", "退職者", "紙", "1日", None, False, ""),
            ("mgr-receive", "task", "退職届を受理し人事へ連絡", "所属部門長", "メール", "1〜3日", "medium", True, "部門長の手元で止まり、人事への連絡が退職日の直前になることがある。"),
            ("register", "task", "退職日・最終出社日を登録", "人事オペレーション担当", "SuccessFactors", "15分", None, False, ""),
            ("notify", "task", "退職連絡を各部門へ送付", "人事オペレーション担当", "メール", "15分", None, False, "Excelの退職連絡票を情報システム・総務へメールで送る。"),
            ("list-items", "task", "貸与物の一覧を確認", "総務", "Excel", "20分", "medium", True, "貸与物台帳が最新ではなく、何を貸しているか分からない人がいる。"),
            ("collect", "task", "貸与物を回収", "総務", "Excel", "30分", None, False, "最終出社日にPC・入館証・社用携帯を回収し、台帳に返却日を記入する。"),
            ("g-collect", "gateway", "すべて回収できた？", "総務", None, None, None, False, ""),
            ("chase", "task", "未返却品を督促", "総務", "メール", "1〜2週間", "high", False, ""),
            ("stop-account", "task", "アカウントを停止", "情報システム", "Active Directory", "30分", "high", True, "最終出社日の夕方に手作業で停止する。連絡漏れがあるとアカウントが残る。"),
            ("g-saas", "gateway", "個別SaaSの利用あり？", "情報システム", None, None, None, False, ""),
            ("stop-saas", "task", "個別SaaSのアカウントを削除", "情報システム", "各SaaS管理画面", "1時間", "high", True, "部門で契約したSaaSは情報システムが把握しておらず、削除漏れの原因になっている。"),
            ("settle", "task", "最終給与・精算額を確定", "人事オペレーション担当", "給与システム", "30分", "medium", False, ""),
            ("insurance", "task", "社会保険の資格喪失届を提出", "人事オペレーション担当", "e-Gov", "30分", None, False, ""),
            ("certificate", "task", "離職票・源泉徴収票を発行", "人事オペレーション担当", "紙", "1〜2週間", "medium", False, ""),
            ("end", "end", "返却・精算・証明書発行の完了", "人事オペレーション担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "submit", ""),
            ("submit", "mgr-receive", ""),
            ("mgr-receive", "register", ""),
            ("register", "notify", ""),
            ("notify", "list-items", ""),
            ("list-items", "collect", ""),
            ("collect", "g-collect", ""),
            ("g-collect", "chase", "いいえ"),
            ("chase", "collect", "再回収"),
            ("g-collect", "end", "はい"),
            ("notify", "stop-account", ""),
            ("stop-account", "g-saas", ""),
            ("g-saas", "stop-saas", "あり"),
            ("g-saas", "end", "なし"),
            ("stop-saas", "end", ""),
            ("notify", "settle", ""),
            ("settle", "insurance", ""),
            ("insurance", "certificate", ""),
            ("certificate", "end", ""),
        ],
        "information": [
            ("submit", [], ["退職届@紙"]),
            ("mgr-receive", ["退職届@紙"], ["退職連絡@メール"]),
            ("register", ["退職連絡@メール"], ["退職情報@SuccessFactors"]),
            ("notify", ["退職情報@SuccessFactors"], ["退職連絡票@メール"]),
            ("list-items", ["退職連絡票@メール", "貸与物台帳@Excel"], ["回収対象一覧"]),
            ("collect", ["回収対象一覧"], ["貸与物台帳@Excel"]),
            ("chase", ["貸与物台帳@Excel"], ["返却督促@メール"]),
            ("stop-account", ["退職連絡票@メール"], ["アカウント情報@Active Directory"]),
            ("stop-saas", ["退職連絡票@メール"], ["SaaSアカウント@各SaaS管理画面"]),
            ("settle", ["退職情報@SuccessFactors", "勤怠実績@給与システム"], ["最終給与@給与システム"]),
            ("insurance", ["退職情報@SuccessFactors"], ["資格喪失届@e-Gov"]),
            ("certificate", ["最終給与@給与システム"], ["離職票・源泉徴収票@紙"]),
        ],
        "items": {
            "退職情報": ["氏名", "退職日", "最終出社日", "退職理由"],
            "退職連絡票": ["氏名", "所属", "退職日", "最終出社日"],
            "貸与物台帳": ["氏名", "品目", "管理番号", "返却日"],
        },
    },
    {
        "business_id": "account-request",
        "title": "アカウント申請 As-Is",
        "summary": "利用申請の起票から承認、権限の特定、特権の審査、アカウント作成と各システムの権限設定、台帳への記録、払い出しの通知までを行う。必要な権限が特定できない申請と、システムごとの依頼回しで時間がかかる。",
        "lanes": ["申請者", "申請者の上長", "ID管理担当", "システム管理者", "情報セキュリティ担当"],
        "assets": [
            ("ワークフロー", "業務システム"),
            ("メール", "メール"),
            ("Excel", "Excel・台帳"),
            ("Active Directory", "業務システム"),
            ("各システム管理画面", "業務システム"),
        ],
        "steps": [
            ("start", "start", "アカウント・権限が必要になる", "申請者", None, None, None, False, ""),
            ("apply", "task", "利用申請を起票", "申請者", "ワークフロー", "15分", "medium", True, "対象システムと権限を選ぶが、どの権限が要るか分からず「前任者と同じ」と書かれることが多い。"),
            ("mgr-approve", "task", "申請を承認", "申請者の上長", "ワークフロー", "1日", None, False, ""),
            ("check", "task", "申請内容・権限を確認", "ID管理担当", "ワークフロー", "15分", "medium", False, ""),
            ("g-clear", "gateway", "権限が特定できる？", "ID管理担当", None, None, None, False, ""),
            ("clarify", "task", "必要な権限を申請者へ確認", "ID管理担当", "メール", "1〜3日", "high", True, "前任者の権限を調べるため、各システムの画面を見て回っている。"),
            ("g-priv", "gateway", "特権・機密データの権限？", "ID管理担当", None, None, None, False, ""),
            ("sec-approve", "task", "特権付与を審査", "情報セキュリティ担当", "ワークフロー", "2日", "high", False, ""),
            ("g-sec", "gateway", "承認されたか？", "情報セキュリティ担当", None, None, None, False, ""),
            ("reject-notify", "task", "却下を申請者へ連絡", "ID管理担当", "メール", "10分", None, False, ""),
            ("create-ad", "task", "ADアカウントを作成", "ID管理担当", "Active Directory", "10分", None, False, ""),
            ("g-system", "gateway", "業務システムの権限が必要？", "ID管理担当", None, None, None, False, ""),
            ("grant", "task", "業務システムの権限を設定", "システム管理者", "各システム管理画面", "1〜2日", "medium", True, "システムごとに管理者が違い、依頼をメールで回すため進み具合が見えない。"),
            ("record", "task", "権限管理台帳へ記録", "ID管理担当", "Excel", "10分", "medium", True, "台帳と実際の権限がずれていて、棚卸のたびに突き合わせが発生する。"),
            ("notify", "task", "払い出しを申請者へ通知", "ID管理担当", "メール", "10分", None, False, "初期パスワードは別のメールで送っている。"),
            ("end", "end", "利用者への払い出し通知", "ID管理担当", None, None, None, False, ""),
            ("end-reject", "end", "申請却下", "ID管理担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "apply", ""),
            ("apply", "mgr-approve", ""),
            ("mgr-approve", "check", ""),
            ("check", "g-clear", ""),
            ("g-clear", "clarify", "いいえ"),
            ("clarify", "check", "再確認"),
            ("g-clear", "g-priv", "はい"),
            ("g-priv", "sec-approve", "はい"),
            ("g-priv", "create-ad", "いいえ"),
            ("sec-approve", "g-sec", ""),
            ("g-sec", "reject-notify", "却下"),
            ("reject-notify", "end-reject", ""),
            ("g-sec", "create-ad", "承認"),
            ("create-ad", "g-system", ""),
            ("g-system", "grant", "はい"),
            ("g-system", "record", "いいえ"),
            ("grant", "record", ""),
            ("record", "notify", ""),
            ("notify", "end", ""),
        ],
        "information": [
            ("apply", [], ["利用申請@ワークフロー"]),
            ("mgr-approve", ["利用申請@ワークフロー"], ["承認済み申請@ワークフロー"]),
            ("check", ["承認済み申請@ワークフロー", "権限管理台帳@Excel"], ["確認結果"]),
            ("clarify", ["確認結果"], ["権限の回答@メール"]),
            ("sec-approve", ["承認済み申請@ワークフロー"], ["特権審査結果@ワークフロー"]),
            ("reject-notify", ["特権審査結果@ワークフロー"], ["却下連絡@メール"]),
            ("create-ad", ["承認済み申請@ワークフロー"], ["アカウント情報@Active Directory"]),
            ("grant", ["承認済み申請@ワークフロー"], ["システム権限@各システム管理画面"]),
            ("record", ["アカウント情報@Active Directory", "システム権限@各システム管理画面"], ["権限管理台帳@Excel"]),
            ("notify", ["アカウント情報@Active Directory"], ["払い出し通知@メール"]),
        ],
        "items": {
            "利用申請": ["申請者", "対象システム", "権限", "利用開始日"],
            "システム権限": ["利用者", "対象システム", "権限"],
            "権限管理台帳": ["利用者", "対象システム", "権限", "付与日"],
            "アカウント情報": ["利用者", "アカウントID", "所属"],
        },
    },
    {
        "business_id": "helpdesk-management",
        "title": "問い合わせ・ヘルプデスク対応 As-Is",
        "summary": "問い合わせの受付から既知の問題の案内、二次対応での調査、ベンダーへのエスカレーション、クローズとFAQへの登録までを行う。電話受付の記録漏れとベンダーの回答待ちの追跡が課題。",
        "lanes": ["利用者", "サービスデスク担当", "二次対応担当", "外部ベンダー"],
        "assets": [
            ("電話", "その他"),
            ("Excel", "Excel・台帳"),
            ("共有フォルダ", "共有フォルダ"),
            ("チャット", "チャット"),
            ("各システム", "業務システム"),
            ("メール", "メール"),
        ],
        "steps": [
            ("start", "start", "困りごとが発生", "利用者", None, None, None, False, ""),
            ("contact", "task", "電話・メール・チャットで問い合わせ", "利用者", "電話", None, None, False, ""),
            ("log", "task", "問い合わせを受付・記録", "サービスデスク担当", "Excel", "10分", "medium", True, "電話の問い合わせは記録されないことがあり、件数が実態より少なく見えている。"),
            ("search", "task", "FAQ・過去の対応を検索", "サービスデスク担当", "共有フォルダ", "15分", "medium", True, "過去の対応が担当者個人のメールに埋もれていて探せない。"),
            ("g-known", "gateway", "既知の問題？", "サービスデスク担当", None, None, None, False, ""),
            ("answer", "task", "解決方法を案内", "サービスデスク担当", "チャット", "20分", None, False, ""),
            ("g-solved", "gateway", "解決した？", "サービスデスク担当", None, None, None, False, ""),
            ("investigate", "task", "原因を調査", "二次対応担当", "各システム", "1〜3日", "high", False, ""),
            ("g-vendor", "gateway", "ベンダー対応が必要？", "二次対応担当", None, None, None, False, ""),
            ("vendor-ticket", "task", "ベンダーへ問い合わせ", "二次対応担当", "メール", "30分", None, False, ""),
            ("vendor-answer", "task", "調査結果を回答", "外部ベンダー", "メール", "3〜10日", "high", True, "回答待ちの案件を一覧で追えず、利用者からの催促で気付くことが多い。"),
            ("fix", "task", "対処を実施", "二次対応担当", "各システム", "2時間", "medium", False, ""),
            ("close", "task", "解決を連絡しクローズ", "サービスデスク担当", "メール", "10分", None, False, ""),
            ("g-knowledge", "gateway", "同様の問い合わせが多い？", "サービスデスク担当", None, None, None, False, ""),
            ("knowledge", "task", "FAQに登録", "サービスデスク担当", "共有フォルダ", "30分", "low", True, "登録は担当者の善意に頼っており、ほとんど更新されていない。"),
            ("end", "end", "解決連絡とナレッジ登録の完了", "サービスデスク担当", None, None, None, False, ""),
        ],
        "flows": [
            ("start", "contact", ""),
            ("contact", "log", ""),
            ("log", "search", ""),
            ("search", "g-known", ""),
            ("g-known", "answer", "はい"),
            ("g-known", "investigate", "いいえ"),
            ("answer", "g-solved", ""),
            ("g-solved", "close", "解決"),
            ("g-solved", "investigate", "未解決"),
            ("investigate", "g-vendor", ""),
            ("g-vendor", "vendor-ticket", "はい"),
            ("g-vendor", "fix", "いいえ"),
            ("vendor-ticket", "vendor-answer", ""),
            ("vendor-answer", "fix", ""),
            ("fix", "close", ""),
            ("close", "g-knowledge", ""),
            ("g-knowledge", "knowledge", "はい"),
            ("g-knowledge", "end", "いいえ"),
            ("knowledge", "end", ""),
        ],
        "information": [
            ("contact", [], ["問い合わせ@電話"]),
            ("log", ["問い合わせ@電話"], ["受付記録@Excel"]),
            ("search", ["受付記録@Excel", "FAQ@共有フォルダ"], ["検索結果"]),
            ("answer", ["検索結果"], ["回答@チャット"]),
            ("investigate", ["受付記録@Excel"], ["調査メモ"]),
            ("vendor-ticket", ["調査メモ"], ["ベンダー問い合わせ@メール"]),
            ("vendor-answer", ["ベンダー問い合わせ@メール"], ["ベンダー回答@メール"]),
            ("fix", ["調査メモ", "ベンダー回答@メール"], ["対応結果"]),
            ("close", ["対応結果"], ["受付記録@Excel", "解決連絡@メール"]),
            ("knowledge", ["受付記録@Excel"], ["FAQ@共有フォルダ"]),
        ],
        "items": {
            "受付記録": ["受付日時", "問い合わせ者", "内容", "対応状況", "担当者"],
            "ベンダー問い合わせ": ["内容", "対象システム", "発生日時"],
            "FAQ": ["質問", "回答", "対象システム"],
        },
    },
]


def _asset_id(business_id: str, index: int) -> str:
    return f"asset-{business_id}-{index + 1}"


def build_process_model(sample: dict[str, Any], department_id: str) -> dict[str, Any]:
    """作りやすい形のサンプルを、画面が扱うAs-Isの形へ広げる。

    座標は持たない。画面が読み込んだときに自動で整列する。
    """
    business_id = sample["business_id"]
    lanes: list[str] = sample["lanes"]
    assets = [
        {
            "id": _asset_id(business_id, index),
            "name": name,
            "type": kind,
            "purpose": "",
            "owner": "未確認",
            "location": "未確認",
            "dataDescription": "",
            "status": "未確認",
            "confidence": 80,
            "sourceFragmentIds": [],
        }
        for index, (name, kind) in enumerate(sample["assets"])
    ]
    asset_ids = {asset["name"]: asset["id"] for asset in assets}

    steps: list[dict[str, Any]] = []
    for sid, kind, label, lane, system, duration, risk, review, description in sample["steps"]:
        if lane not in lanes:
            raise ValueError(f"{business_id}: {sid} のレーン「{lane}」がlanesにありません。")
        step: dict[str, Any] = {
            "id": f"{business_id}-{sid}",
            "label": label,
            "actor": lane,
            "lane": lane,
            "type": kind,
            "x": 0,
            "y": 0,
        }
        if kind == "task":
            step["width"] = 150
            step["confidence"] = 55 if review else 90
            if system:
                if system not in asset_ids:
                    raise ValueError(f"{business_id}: {sid} のシステム「{system}」がassetsにありません。")
                step["system"] = system
            if duration:
                step["duration"] = duration
            if risk:
                step["risk"] = risk
            if review:
                step["needsReview"] = True
            if description:
                step["description"] = description
        steps.append(step)
    step_by_id = {step["id"]: step for step in steps}

    entries = [entry for _, inputs, outputs in sample["information"] for entry in [*inputs, *outputs]]
    names = list(dict.fromkeys(entry.split("@")[0] for entry in entries))
    items: dict[str, list[str]] = sample.get("items", {})
    unknown_items = set(items) - set(names)
    if unknown_items:
        raise ValueError(f"{business_id}: どのタスクも使わない情報に項目があります: {sorted(unknown_items)}")
    information = [
        {"id": f"info-{business_id}-{index + 1}", "name": name, **({"items": list(items[name])} if name in items else {})}
        for index, name in enumerate(names)
    ]
    information_ids = {item["name"]: item["id"] for item in information}

    def reference(entry: str) -> dict[str, Any]:
        name, _, asset_name = entry.partition("@")
        if asset_name and asset_name not in asset_ids:
            raise ValueError(f"{business_id}: 情報「{entry}」のアセットがassetsにありません。")
        return {"informationId": information_ids[name], **({"assetIds": [asset_ids[asset_name]]} if asset_name else {})}

    for sid, inputs, outputs in sample["information"]:
        step = step_by_id.get(f"{business_id}-{sid}")
        if step is None or step["type"] != "task":
            raise ValueError(f"{business_id}: 情報を持つ {sid} はタスクではありません。")
        step["inputs"] = [reference(entry) for entry in inputs]
        step["outputs"] = [reference(entry) for entry in outputs]

    connections = []
    for index, (source, target, label) in enumerate(sample["flows"]):
        source_id, target_id = f"{business_id}-{source}", f"{business_id}-{target}"
        if source_id not in step_by_id or target_id not in step_by_id:
            raise ValueError(f"{business_id}: 接続 {source} → {target} の工程がありません。")
        connections.append({
            "id": f"flow-{business_id}-{index + 1}",
            "from": source_id,
            "to": target_id,
            **({"label": label} if label else {}),
        })

    return {
        "businessId": business_id,
        "departmentId": department_id,
        "title": sample["title"],
        "layoutDirection": "vertical",
        "lanes": list(lanes),
        "steps": steps,
        "connections": connections,
        "information": information,
        "assets": assets,
        "assetLinks": [],
        "updatedAt": "サンプル",
        "reviewStatus": "編集中",
        "sourceType": "master",
        "summary": sample["summary"],
    }


@lru_cache(maxsize=1)
def _cached_samples() -> dict[str, dict[str, Any]]:
    return {sample["business_id"]: sample for sample in SAMPLE_PROCESSES}


def sample_process_models(business_masters: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """テナントの業務マスターのうち、サンプルがあるものだけのAs-Isを返す。

    業務領域はテナント側の業務マスターに合わせる。利用者が付け替えていても食い違わない。
    """
    samples = _cached_samples()
    models: dict[str, dict[str, Any]] = {}
    for business in business_masters:
        business_id = str(business.get("id") or "")
        if business_id in samples:
            models[business_id] = build_process_model(
                deepcopy(samples[business_id]),
                str(business.get("departmentId") or ""),
            )
    return models
