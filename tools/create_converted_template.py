"""Build an HWPX counterpart of the supplied binary HWP template.

The original template is HWP 5.x/OLE, which browsers cannot edit as ZIP/XML.
This one-time build script recreates its monthly-table geometry and fixed copy
as a standards-based HWPX file for the browser converter and fixture tests.
"""

from pathlib import Path

from hwpx import HwpxDocument


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "assets" / "배포용_템플릿.hwpx"


def set_run_style(paragraph, style_id: str) -> None:
    for run in paragraph.runs:
        run.element.set("charPrIDRef", str(style_id))


def set_cell_style(table, row: int, col: int, style_id: str) -> None:
    for paragraph in table.cell(row, col).paragraphs:
        set_run_style(paragraph, style_id)


def build() -> Path:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    doc = HwpxDocument.new()
    doc.set_page_setup(
        paper_size="A4",
        orientation="portrait",
        margin_left_mm=9,
        margin_right_mm=9,
        margin_top_mm=8,
        margin_bottom_mm=8,
        header_margin_mm=0,
        footer_margin_mm=0,
    )

    title_style = doc.ensure_run_style(
        font="함초롬돋움", size=16, bold=True, letter_spacing=-2
    )
    weekday_style = doc.ensure_run_style(
        font="함초롬돋움", size=9, bold=True, letter_spacing=-5
    )
    date_style = doc.ensure_run_style(
        font="함초롬돋움", size=9, letter_spacing=0
    )
    menu_style = doc.ensure_run_style(
        font="함초롬돋움", size=8, letter_spacing=-10
    )
    note_style = doc.ensure_run_style(
        font="함초롬돋움", size=7, letter_spacing=-5
    )

    title = doc.add_paragraph("구미 봉곡초 6월 식단계획")
    set_run_style(title, title_style)
    doc.set_paragraph_format(
        paragraph_index=len(doc.paragraphs) - 1,
        alignment="center",
        line_spacing_percent=140,
        spacing_after_pt=3,
    )

    table = doc.add_table(12, 5, width=54155, height=72546)
    table.set_column_widths([1, 1, 1, 1, 1])

    weekdays = ["월", "화", "수(다먹는날)", "목", "금"]
    june_weeks = [
        [1, 2, 3, 4, 5],
        [8, 9, 10, 11, 12],
        [15, 16, 17, 18, 19],
        [22, 23, 24, 25, 26],
        [29, 30, 0, 0, 0],
    ]

    for col, weekday in enumerate(weekdays):
        table.set_cell_text(0, col, weekday)
        table.cell(0, col).set_size(height=1282)
        set_cell_style(table, 0, col, weekday_style)

    for week_index, week in enumerate(june_weeks):
        date_row = 1 + week_index * 2
        menu_row = date_row + 1
        for col, day in enumerate(week):
            table.set_cell_text(date_row, col, str(day) if day else "")
            table.cell(date_row, col).set_size(height=1282)
            set_cell_style(table, date_row, col, date_style)

            table.set_cell_text(menu_row, col, "식단")
            table.cell(menu_row, col).set_size(height=11232)
            set_cell_style(table, menu_row, col, menu_style)

    table.merge_cells(11, 0, 11, 4)
    table.set_cell_text(
        11,
        0,
        "* 식단은 학사일정, 교육과정, 식품수급에 따라 변경될 수 있습니다.\n"
        "* 식단 하단 숫자는 열량(에너지)/단백질량/칼슘량/철분량입니다.\n"
        "* 알레르기 정보: ①난류 ②우유 ③메밀 ④땅콩 ⑤대두 ⑥밀 ⑦고등어 ⑧게 "
        "⑨새우 ⑩돼지고기 ⑪복숭아 ⑫토마토 ⑬아황산류 ⑭호두 ⑮닭고기 "
        "⑯쇠고기 ⑰오징어 ⑱조개류(굴, 전복, 홍합 포함) ⑲잣",
        split_paragraphs=True,
    )
    table.cell(11, 0).set_size(height=7078)
    set_cell_style(table, 11, 0, note_style)

    origin = doc.add_table(2, 10, width=54155, height=3536)
    origin.set_column_widths([0.7, 1, 1, 1, 1.1, 1.1, 1, 0.9, 1.5, 2.2])
    headers = [
        "구분", "쇠고기", "콩", "돼지고기", "닭·오리고기",
        "식육가공품", "달걀", "쌀", "김치(배추·고춧가루)", "수산물",
    ]
    values = [
        "원산지", "국내산(한우)\n2등급 이상", "국내산", "국내산\n1등급 이상",
        "국내산 1등급\n무항생제", "국내산", "국내산 1등급\n무항생제",
        "친환경(구미)", "담금/국내산\n(HACCP 인증)",
        "꽃게·오징어·낙지·고등어·삼치 국내산\n북어·동태포 러시아산",
    ]
    for col, text in enumerate(headers):
        origin.set_cell_text(0, col, text)
        set_cell_style(origin, 0, col, note_style)
    for col, text in enumerate(values):
        origin.set_cell_text(1, col, text, split_paragraphs=True)
        set_cell_style(origin, 1, col, note_style)

    doc.save_to_path(OUTPUT)
    return OUTPUT


if __name__ == "__main__":
    print(build())
