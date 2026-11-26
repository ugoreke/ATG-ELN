# The run folder and its manifest

Reference for the `eln-transfer` skill ([SKILL.md](SKILL.md)). Every transfer has one folder in `scratch/` that holds everything it read and everything it decided. It is there for two reasons: a transfer that stopped half-way can be picked up from it, and the `transfer-verifier` agent, which checks the entries before any line is moved, reads nothing else.

The folder holds the user's notes. It stays in `scratch/` and is never committed. A made-up example is in `tests/fixtures/transfer-run/`.

## Layout

`scratch/<YYMMDD>_transfer/` (add `-2`, `-3`… if it exists), with:

| Path | Written at | What it is |
|---|---|---|
| `manifest.json` | started at step 3, updated after every step | what went where and why (shape below) |
| `read-1/logs/daily.json`, `read-1/entries/<id>.json` | steps 1 and 3 | the first read, saved by the data tool's `out_dir`; never changed (see "Files" in [moving-lines.md](moving-lines.md)) |
| `audit/` | before step 1 | the check of the last transfer ([moving-lines.md](moving-lines.md)) |
| `photos/<line id>.<ext>` | step 1 | each photo and handwriting file as fetched, full size, named by its line id |
| `photo-facts.md` | step 4 | the `photo-reader` agent's report, as returned |
| `email-facts.md` | step 5 | the `email-scout` agent's report, as returned |
| `benchling/<entry key>.before.txt` | step 7, before typing | the entry's page text before this transfer wrote anything (an existing entry, or one just made from a template); left out for an entry that starts blank |
| `benchling/<entry key>.txt` | step 8 | the entry's page text as re-read after writing; saved again after every fix |
| `verdict-<n>.md` | before step 9 | the `transfer-verifier` agent's report of round n, as returned |
| `plan-<k>/`, `after-<k>/`, `check-<k>/` | step 9 | the move and its check ([moving-lines.md](moving-lines.md)) |

The files in `photos/` are working copies for the reader and the verifier. The copies with descriptive names for the upload and the dated archive are still made as the `benchling-photos` skill and "Scratch space" in `CLAUDE.md` say.

Page text is saved exactly as the page gives it after a reload and a scroll through the whole entry (tables load lazily). Never type or tidy a page-text file by hand, and never change one so that a check passes: it is the record of what Benchling shows.

## `manifest.json`

Written by the main session only. Paths are relative to the run folder; times are ISO; days are `YYYY-MM-DD`.

```json
{
  "run": "<YYMMDD>_transfer",
  "startedAt": "<ISO time>",
  "timeZone": "<IANA zone of the bench, for example Europe/London>",
  "stepDone": 8,
  "source": {
    "daily": { "file": "read-1/logs/daily.json", "version": 7 },
    "notebooks": [{ "id": "<notebook id>", "file": "read-1/entries/<notebook id>.json", "version": 3 }]
  },
  "entries": [{
    "key": "entry-1",
    "title": "<the Benchling entry's name>",
    "url": "<the entry's URL>",
    "origin": "new one-off | new from template: <template name> | existing",
    "day0": "<YYYY-MM-DD, the day the work was done>",
    "pageTextBefore": "benchling/entry-1.before.txt",
    "pageText": "benchling/entry-1.txt",
    "readAt": "<ISO time of the re-read>",
    "images": {
      "before": 0,
      "found": [{ "position": 1, "lineId": "<line id>", "caption": "<the caption beside it, as on the page>" }]
    },
    "notebookId": "<the app notebook with this name, or null until it is created>"
  }],
  "lines": [{
    "id": "<line id>",
    "type": "text | photo | ink | audio",
    "status": "written | stays",
    "entries": ["entry-1"],
    "reason": "<for a line that stays: why>",
    "file": "photos/<line id>.jpg"
  }],
  "assumptions": [{ "entry": "entry-1", "lineIds": ["<line id>"], "text": "<what was assumed>" }],
  "emailFacts": [{ "entry": "entry-1", "lineIds": ["<line id>"], "fact": "<the fact, with any corrected spelling as: dictated -> written>", "sender": "<who>", "date": "<YYYY-MM-DD>", "subject": "<thread subject>" }],
  "photoFacts": [{ "lineId": "<line id>", "fact": "<the number, name or label taken from the photo>", "openedByMainSession": true }],
  "checks": [{ "round": 1, "at": "<ISO time>", "report": "verdict-1.md", "overall": "PASS | FAIL | CANNOT TELL" }],
  "moves": [{ "notebookId": "<notebook id>", "plan": "plan-1", "check": "check-1", "lineIds": ["<line id>"] }]
}
```

- `lines` lists **every** line of Daily's first read (and every line of an older notebook that this transfer writes to Benchling), each exactly once: `written` (it is in Benchling and is to be moved) or `stays` (it stays in Daily, with the reason). A line that went into two entries (a frozen vial that is also logged where your settings say) names both in `entries`; it is moved to the notebook of the first.
- `images.found` is what the re-read page shows, in page order: one element per image, with the line id it belongs to. `before` is the number of images the entry had before this transfer.
- `photoFacts` lists every number, name or label an entry takes from a photo. `openedByMainSession` is true only when you opened that photo yourself (step 4).
- `emailFacts` lists every fact an entry takes from email, and every spelling corrected from email. It is the list the report gives the user, and the only reason the verifier accepts a name that differs from the note.
- `assumptions` is the list the report gives the user. A name you corrected without an email goes here, and so does anything in a title or a field that no note states (the project name in a title, for example): the verifier fails a statement it cannot trace to a note, a photo fact, an email fact or an assumption.
- `stepDone` is the last step of [SKILL.md](SKILL.md) that is complete. `checks` and `moves` grow as the gate and step 9 run.

## Picking up a stopped transfer

If a run folder for these notes exists and its manifest does not show every line moved or staying, continue it; do not start a second one.

1. Read `manifest.json`. Never trust it for what is stored: read `logs/daily` and the notebooks again, into a new folder (`read-2/`…), and run the `audit` command of [moving-lines.md](moving-lines.md).
2. If Daily's version changed since the first read, the notes may have been edited: use the wording that is there now, in Benchling as well ("Edits during a transfer" in [moving-lines.md](moving-lines.md)).
3. Open each entry in `entries` and re-read it: what the manifest says was written is checked against the page, not assumed. Save the page text again.
4. Go on from the step after `stepDone`. A move that was planned but whose check is missing is checked first (`verify`), never planned again blind.
5. Run the `transfer-verifier` again before moving anything, even if an earlier round passed: the entries or the notes may have changed since.
