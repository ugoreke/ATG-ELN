---
name: eln-sync-protocols
description: 'Save the protocols from the Docs tab of ATG ELN to data/protocols/ in this folder, as a local copy. Use when the user says "sync my protocols", or asks to save, back up or refresh the local copy of their protocols.'
---

# Saving protocols to data/protocols ("sync my protocols")

Protocols added in the app's Docs tab live in the app's database (collection `protocols`), not on disk. `data/protocols/` in this folder is a local copy, never committed.
- Read the whole `protocols` collection of the user's ATG ELN artifact and write each document to `data/protocols/<id>.json` with the fields as stored. For a protocol with an `assetId`, also fetch that asset and save it beside the JSON under its `fileName`.
- Add and update only. If a file in `data/protocols/` has no document any more, list it in the report and leave it; removing it needs the user's permission.
- Never write to the `protocols` collection during this step.
