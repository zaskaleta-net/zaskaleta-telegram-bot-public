#!/usr/bin/env python3
"""Generate the Schleswig-Holstein municipality registry from Statistik Nord.

Source of truth: Bevölkerung der Gemeinden in Schleswig-Holstein, 1. Quartal 2026
(Statistikamt Nord, published 2026-07-15). The publication contains the official
AGS for every politically independent municipality in Schleswig-Holstein.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

from openpyxl import load_workbook
from pypdf import PdfReader

XLSX_URLS = [
    "https://www.statistik-nord.de/fileadmin/Dokumente/A_I_2_vj_26-1_Zensus22_SH.xlsx",
    "https://www.statistik-nord.de/fileadmin/Dokumente/Statistische_Berichte/bevoelkerung/A_I_2_S/A_I_2_vj_26-1_Zensus22_SH.xlsx",
]
PDF_URL = "https://www.statistik-nord.de/fileadmin/Dokumente/A_I_2_vj_26-1_Zensus22_SH.pdf"
SOURCE_PAGE = "https://www.statistik-nord.de/zahlen-fakten/bevoelkerung/bevoelkerungsstand-und-entwicklung"
SOURCE_DATE = "2026-07-15"
DATA_DATE = "2026-03-31"
EXPECTED_COUNT = 1104

KREIS_BY_CODE = {
    "01": "Flensburg",
    "02": "Kiel",
    "03": "Lübeck",
    "04": "Neumünster",
    "51": "Dithmarschen",
    "53": "Herzogtum Lauenburg",
    "54": "Nordfriesland",
    "55": "Ostholstein",
    "56": "Pinneberg",
    "57": "Plön",
    "58": "Rendsburg-Eckernförde",
    "59": "Schleswig-Flensburg",
    "60": "Segeberg",
    "61": "Steinburg",
    "62": "Stormarn",
}


def ags(value) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        s = str(value)
    elif isinstance(value, float) and value.is_integer():
        s = str(int(value))
    else:
        s = re.sub(r"\s+", "", str(value).strip())
        if s.endswith(".0") and s[:-2].isdigit():
            s = s[:-2]
    if not s.isdigit() or len(s) not in (7, 8):
        return None
    s = s.zfill(8)
    if not s.startswith("010") or s[3:5] not in KREIS_BY_CODE:
        return None
    return s


def clean_name(value) -> str | None:
    if not isinstance(value, str):
        return None
    name = re.sub(r"\s+", " ", value).strip()
    if not name or len(name) > 120:
        return None
    if re.search(r"(?:AGS|Gemeinde|Kreis|Geschlecht|insgesamt|männlich|weiblich)$", name, re.I):
        return None
    name = re.sub(r",\s*(?:Stadt|Landeshauptstadt|Hansestadt)\s*$", "", name, flags=re.I).strip()
    if any(ch.isalpha() for ch in name) and name == name.upper():
        name = name.title()
    return name or None


def download_url(url: str, suffix: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "zaskaleta-info-bot-registry/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = response.read()
    if len(data) < 50_000:
        raise RuntimeError(f"download too small: {len(data)} bytes from {url}")
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    Path(path).write_bytes(data)
    return path


def row(code: str, name: str) -> dict[str, str]:
    return {"ags": code, "canonical": name, "jurisdiction": KREIS_BY_CODE[code[3:5]]}


def extract_xlsx(path: str) -> list[dict[str, str]]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    found: dict[str, dict[str, str]] = {}
    for sheet in workbook.worksheets:
        for values in sheet.iter_rows(values_only=True):
            for i, value in enumerate(values[:6]):
                code = ags(value)
                if not code:
                    continue
                name = None
                for candidate in values[i + 1 : i + 6]:
                    name = clean_name(candidate)
                    if name:
                        break
                if name:
                    found[code] = row(code, name)
                break
    return [found[key] for key in sorted(found)]


def extract_pdf(path: str) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    reader = PdfReader(path)
    for page in reader.pages:
        text = page.extract_text() or ""
        for raw in text.splitlines():
            line = re.sub(r"\s+", " ", raw).strip()
            match = re.match(r"^(010\d{5})\s+(.+)$", line)
            if not match:
                continue
            code = ags(match.group(1))
            if not code:
                continue
            parts = match.group(2).split()
            first_number = next((i for i, token in enumerate(parts) if re.fullmatch(r"\d+(?:[.,]\d+)?", token)), None)
            if first_number is None or first_number == 0:
                continue
            name = clean_name(" ".join(parts[:first_number]))
            if name:
                found[code] = row(code, name)
    return [found[key] for key in sorted(found)]


def validate(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    if len(rows) != EXPECTED_COUNT:
        raise RuntimeError(f"unexpected municipality count {len(rows)}; expected exactly {EXPECTED_COUNT}; sample={rows[:5]}")
    husum = [item for item in rows if item["canonical"].casefold() == "husum"]
    if len(husum) != 1 or husum[0]["jurisdiction"] != "Nordfriesland":
        raise RuntimeError(f"Husum missing or misrouted: {husum}")
    if {item["jurisdiction"] for item in rows} != set(KREIS_BY_CODE.values()):
        raise RuntimeError("generated registry does not cover all 15 Schleswig-Holstein territories")
    if len({item["ags"] for item in rows}) != len(rows):
        raise RuntimeError("duplicate AGS in generated municipality registry")
    return rows


def acquire() -> tuple[list[dict[str, str]], str]:
    override = os.environ.get("SH_MUNICIPALITY_SOURCE_URL", "").strip()
    candidates = [(override, ".xlsx")] if override else [(url, ".xlsx") for url in XLSX_URLS] + [(PDF_URL, ".pdf")]
    errors: list[str] = []
    for url, suffix in candidates:
        path = None
        try:
            path = download_url(url, suffix)
            rows = extract_pdf(path) if suffix == ".pdf" else extract_xlsx(path)
            return validate(rows), url
        except Exception as exc:
            errors.append(f"{url}: {exc}")
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
    raise RuntimeError("all official Statistik Nord sources failed: " + " | ".join(errors))


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render(rows: list[dict[str, str]], source_url: str) -> str:
    lines = [
        "// AUTO-GENERATED. Do not edit by hand.",
        "// Official source: Statistikamt Nord, Bevölkerung der Gemeinden in Schleswig-Holstein, 1. Quartal 2026.",
        f"export const SH_MUNICIPALITY_SOURCE = Object.freeze({{ url:{js_string(source_url)}, page:{js_string(SOURCE_PAGE)}, published:{js_string(SOURCE_DATE)}, dataDate:{js_string(DATA_DATE)} }});",
        "export const SH_OFFICIAL_MUNICIPALITIES = Object.freeze([",
    ]
    for item in rows:
        lines.append(
            "  Object.freeze({ ags:%s, canonical:%s, jurisdiction:%s }),"
            % (js_string(item["ags"]), js_string(item["canonical"]), js_string(item["jurisdiction"]))
        )
    lines += [
        "]);",
        "export const SH_OFFICIAL_MUNICIPALITY_COUNT = SH_OFFICIAL_MUNICIPALITIES.length;",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    target = Path(__file__).resolve().parents[1] / "src" / "sh-municipalities-generated.mjs"
    rows, source_url = acquire()
    target.write_text(render(rows, source_url), encoding="utf-8")
    print(f"generated {len(rows)} Schleswig-Holstein municipalities from {source_url} -> {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
