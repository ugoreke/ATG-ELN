# Project instructions: ATG ELN and Benchling

These load automatically in a Claude Code session opened in this folder (through `CLAUDE.md`). In a Claude chat project, paste them into the project's custom instructions instead. "Your settings" means the values in `CLAUDE.local.md`.

## Purpose
Help the user keep their Benchling ELN complete, consistent and fast to write: new entries from templates or one-off, edits to existing entries, new templates, plasmid/registry records, daily transfers from ATG ELN, and questions answered from their notes.

## Access
- Benchling address: from your settings. Never use a Benchling connector or API.
- Default browser: the built-in browser, for all reading, typing and editing.
- Fallback: the Claude in Chrome extension. Use it (a) for any file or photo upload the built-in browser cannot do, and (b) when the built-in browser is unreachable. It only connects while Chrome is running on the user's computer; if no browser is listed, ask the user to open Chrome, nothing else.
- Never open the same entry for editing in both browsers at once (Benchling locks editing). Finish the text in the built-in browser and navigate that tab away from the entry before opening it in Chrome.
- If Benchling asks to sign in, stop and ask the user to sign in in that browser; never enter credentials.
- Do not use: the "Control Chrome" connector (Chrome blocks its scripts), computer use on the Claude app, pop-ups, or a local file server. All were tried and fail.
- Benchling AI (inside Benchling) is the source for how-to questions about Benchling itself. Ask the user to query it rather than guessing at the UI.

## Daily transfer from ATG ELN ("transfer today's notes")
1. Source: the user's ATG ELN artifact (find it in the artifact list). Read the "entries" collection from its database; today's entries are those created today in the user's time zone. Photo and sketch blocks carry an assetId; fetch each asset by that id, one per call.
2. Look at every photo before writing about it.
3. Search the user's email (the account in your settings) before writing, even when nothing seems missing:
   - Every cell line, clone, plasmid, sgRNA or sample name in the notes, especially dictated ones that look garbled. Use the spelling from the emails in the entry.
   - Every person named in the notes, for what they handed over, its passage, and any protocol or plan they sent.
   - Orders, tracking and shipments for anything received or sent that day.
   Limit to the last 60 days unless the notes point further back. Use what the emails say to fix names and fill fields; do not copy email text into the entry beyond the fact and its date. In the report, list each thing taken from email with the sender and date, so the user can check it.
4. Do not ask before writing. Build the entries with your best reading of the notes, then report assumptions afterwards in one short list. Leave template fields blank when the notes don't cover them; never ask the user to fill them. Write "not recorded" only for things that matter for reproducing the work. Ask first only if two notes contradict each other on a number, date or sample identity, or if something would be sent to an outside party. Split a mixed day by experiment: add to the existing entry when one exists, create a new one-off entry otherwise, and log every frozen vial where your settings say frozen vials are recorded.
5. Build the entry (see Creating an entry), then upload photos (see Photos).
6. Reload, scroll through, and re-read the full text; confirm every photo loaded. Report anything missing.
7. Mark the ATG ELN entry transferred: update its document with lastTransfer = {at: <now, ISO>, benchlingUrl: <entry URL>}.
8. If the notes conflict with something sent to an outside party, draft the correction as a reply in the existing email thread. Do not send it.

## Creating an entry
- Go to Benchling, open the Projects sidebar and click the project named in your settings. Click + > Entry > Blank entry, or Entry from template.
- A new entry opens on the ADD PROTOCOL tab. Click NOTES before doing anything else.
- Title: triple-click the title, type, Return.
- Headings: type the text, press ctrl+` (cycles heading levels), then End and Return for the next line.
- After the first click-and-type in the body, confirm by screenshot or page text that the text landed once and in the right place before batching the rest.
- Tables: Insert > Table; add rows in bulk with the "add rows" count field. Fill cell by cell (click, type, Tab across, Return down) and confirm the selected cell by screenshot first.
- @-links: press @ to open the mention picker. If no matching record exists, use plain text and say so in the report; do not keep searching.

## Templates and one-off entries
- Templates: the ones listed in your settings. Pick by what was done, not by what the user calls it.
- If none fits (shipment, differentiation, lentivirus, PCR, cloning, imaging...), create a one-off blank entry without asking. Use the sections that apply, in this order: Goal, Order or Plan, Samples or Materials, Procedure or Shipment, Calculations, Images, Run notes. Say it was a one-off and suggest a template only if the same type has come up before.
- To make a new template: duplicate from the source template's version history (clock icon > three dots on the latest version > Duplicate from Version), rename, then edit. Archive empties.

## Photos and file uploads (Chrome extension only)
1. Copy the files into a working directory the upload tool accepts, with descriptive names: YYMMDD_[Line]_[what].jpg.
2. Open the entry in Chrome and go to NOTES. Type a placeholder line where the images belong.
3. Add a temporary <input type="file" multiple> to the page by script, find it, and upload the files to it with the extension's file-upload tool (under 10 MB per call).
4. Click the placeholder line, type one character and delete it. This sets Benchling's own cursor; a click alone does not.
5. By script, dispatch dragenter, dragover and drop on that line with the input's files, then remove the temporary input. Images are inserted at Benchling's cursor, in file order.
6. Wait about 10 s, then check the block order. If the images landed in the wrong place, press cmd+z once and repeat from step 3.
7. Replace the placeholder with a caption giving the image order. Close the Chrome tab when done.
- Keep full resolution. Never shrink images to make a transfer easier.

## Scratch space
- `scratch/` in this folder is scratch and archive space: save copies of transferred photos there in a dated subfolder (YYMMDD_photos), and use it for any temporary or kept file. Its contents are never committed. Do not leave helper files in it. Deleting there needs the user's permission; otherwise move leftovers to `scratch/_to_delete/`.

## Before writing anything
- Open the template or entry and read it in full (page text; tables load lazily, so scroll the whole page first and re-read). Don't ask for information the template has no slot for.
- Do every calculation the user delegates (dilutions, master mixes, cells per well, n+1 volumes) and show the numbers before entering them.
- Check the notes for internal conflicts (dates, volumes, counts, passage numbers that don't match earlier records) and raise them in the consolidated list.

## Conventions
- Entry title: YYMMDD_[Project or Gene]_[Line]_[Type], e.g. 261102_ProjectX_LineA_Nucleofection. Day 0 is the day the procedure was done, not the day the entry is written.
- Record plasmids, cell lines, sgRNAs and prior entries as @-links where records exist.
- Deviations table holds protocol changes only. Media, coating, line-specific culture conditions and lot differences are not deviations.
- Distinguish nominal from actual values when they differ and log the gap as a deviation with its impact on the comparison.
- Side treatments stay in the entry; anything bigger gets its own linked entry.
- Materials table: working amount, lot/catalogue number, physical location (freezer, floor, box).
- Observations and "Next" go in run notes; "Next" must agree with every dated plan elsewhere in the entry.

## Plasmid and registry work
Open the plasmid folder; read the record before editing. For new plasmids, use the existing naming pattern in the folder and fill the fields the schema already has. Link the plasmid from any entry that uses it.

## Answering questions from the notes
Open the relevant entry (search Benchling by title or keyword), read it, and answer from what's written. Quote dates and values exactly. If the notes don't say, say so; don't infer. Also search past chats when the user refers to earlier work.

## Style
Short, specific, numbers first. Flag conflicts and gaps plainly. Don't narrate the browser steps unless something fails.
