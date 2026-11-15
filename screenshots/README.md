# screenshots/

The three required screenshots are NOT in this folder yet — this machine
has no browser installed (no Chrome / Chromium / Firefox was found), and
this agent cannot operate a live browser, so they cannot be taken here.
`main.ts` refuses to write `dossier.json` without them (the kit's
`buildDossier` refuses an empty `screenshots/`), so the entry is not
gradeable until they exist. Do NOT generate fake / placeholder screenshots
— the bounty requires real screenshots of the dashboard you submit.

## How to take them (2 minutes, on any machine with a browser)

1. Run the build first: `npm run build` (or `node main.ts --out ./out`).
   (It will fail at the dossier step until the screenshots exist — that is
   expected. The board, data.js and dashboard are written before it.)
2. Open `out/dashboard/index.html` in Chrome / Firefox (it renders with no
   network; `out/data.js` sits beside `out/dashboard/`).
3. Take these three screenshots and save them here as PNGs:
   - `1-board.png` — the full board (top of the page, ranked table visible).
     This is the cover: the first screenshot by name shows on the Feed.
   - `2-detail.png` — a protocol's detail view: click any row (e.g. #1) and
     screenshot the detail panel below the table.
   - `3-filtered.png` — a filtered view: type e.g. `lending` in the search
     box, or pick a category from the Category filter, and screenshot the
     filtered table.
4. Size rules (the sealed gate): each PNG at most 512 KiB, long side at
   most 1440 px, short side at least 800 px. Aim for 1440×800 and
   300–350 KiB each — three at the 512 KiB cap exceed the 1.5 MiB dossier.
5. Verify each PNG actually shows the dashboard (not a blank page), then
   re-run `npm run build` and commit them with the entry.
