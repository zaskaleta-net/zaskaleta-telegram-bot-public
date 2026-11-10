# Schleswig-Holstein Jobcenter/KdU registry status

Verified on: 2026-09-10

The housing search is statewide and remains independent of this table. This registry controls only the automatic Jobcenter/KdU assessment. A territory without current, source-grounded rules must not return an automatic green result.

| Territory | Status | Effective from | Automatic assessment |
|---|---|---:|---|
| Kreis Stormarn | verified | 2025-01-01 | yes, full municipality routing |
| Flensburg | verified | 2025-07-01 | yes, full city |
| Kiel | verified | 2025-01-01 | yes, full city |
| Lübeck | verified | 2026-05-01 | yes, full city; published table through 6 persons |
| Kreis Herzogtum Lauenburg | verified values / partial routing | 2025-03-01 | yes only for explicitly mapped official subareas; otherwise warning |
| Kreis Nordfriesland | verified values / partial routing | 2026-01-01 | yes only for explicitly mapped official subareas; otherwise warning |
| Kreis Plön | verified values / partial routing | 2026-01-01 | yes only for explicitly mapped official subareas; otherwise warning |
| Kreis Steinburg | verified values / partial routing | 2025-07-01 | yes only for explicitly mapped official subareas; otherwise warning |
| Kreis Rendsburg-Eckernförde | source found | pending validity confirmation | no |
| Kreis Ostholstein | current source found | 2026-07-01 | no until current table is imported and tested |
| Kreis Segeberg | official calculator found | pending static rule extraction | no |
| Kreis Schleswig-Flensburg | current official KdU documents found | pending table import | no |
| Kreis Dithmarschen | authority/source found | pending current values | no |
| Kreis Pinneberg | authority verified | pending current official rules | no |
| Neumünster | authority verified | pending current official rules | no |

## Safety invariant

`Kaltmiete`, `Betriebskosten/Nebenkosten` and `Heizkosten` must all be separately available before the bot may produce an automatic assessment. The comparison amount is the locally defined gross-cold measure; heating remains a separate adequacy review. An automatic result is never a `Zusicherung` and never replaces the responsible Jobcenter's decision.
