# Excel real Desktop UAT

Same real CI ARM app source `1c8e280d`, cloud conversation `conv_19f391161d9447dda2c9486cad4f4394`, run `run_cda2dd9ec5a34b6187aa2bb671f0cc18`.

Hatch loaded spreadsheets skill and used its bundled openpyxl/LibreOffice/Poppler toolchain, without installing dependencies. Created `output/spreadsheets/hatch-uat-0131-c.xlsx`, modified B3 from 3 to 4 and saved separate `hatch-uat-0131-c-v2.xlsx`. Both retain `=SUM(B2:B3)` in sheet 验收 B4.

Read-only verification with the bundled Python confirmed recalculated files `tmp/hatch-uat-0131-c-recalc.xlsx` and `tmp/hatch-uat-0131-c-v2-recalc.xlsx` retain the formula with cached values 5 and 6 respectively. Original output files have no cached value; do not describe them as the recalculated artifacts.

Actual render `tmp/xlsx-render-0131-c-v2/sheet-page-1.png` inspected: Chinese table labels and values 2/4/6 visible without clipping. This proves scoped create/edit/recalculate/render capability, not Excel application compatibility or complete release UAT. Final deliverable placement and attachment/reload remain to verify.
