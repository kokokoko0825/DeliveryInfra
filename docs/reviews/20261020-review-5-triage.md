# Review-5 トリアージ

判定: R5-01〜04 はすべて妥当で、全件修正する。仕様の未実装はない。

| ID | 方針 |
| --- | --- |
| R5-01 | notify（SendEvent の再試行）全体に時間上限（例: 合計 3 秒）を設け、各呼び出しにも abortSignal / requestTimeout を設定する |
| R5-02 | Cognito App Client の writeAttributes を空にする（利用者が email などを書き換えられないようにする）。CVSS 4.3 のため必須 |
| R5-03 | apiFn から未使用の録画バケットへの s3:GetObject を削除する |
| R5-04 | 長いタイトルが閉じるボタンに隠れないよう、ヘッダーに右余白を確保する（truncate と pr-12 など） |
