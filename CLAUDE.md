# ATG ELN

This folder is two things: the ATG ELN bench notebook app (`src/index.html`, a private Claude artifact) and the place to run sessions that move its notes into Benchling.

@project-instructions.md

## Your settings

The instructions above refer to "your settings": the user's name, Benchling address, Benchling project, the email account to search, and their templates. They are kept in `CLAUDE.local.md`, which is private to each person and never committed.

If `CLAUDE.local.md` does not exist or lacks a "My settings" section, ask the user for those values once, in one message, and create it. Don't ask again in later sessions.

## Working on the app

- The whole app is `src/index.html`. Run `npm test` after every change, and add a test for every bug fixed.
- Keep the test stand-in (`tests/mock-claude.mjs`) realistic: data from the store is deep-frozen, and snapshots replace the page's copies.
- The app is for iPad and iPhone. The tests can't cover camera, microphone, Apple Pencil or real Claude answers; say plainly what was and wasn't tested.
- Never commit notebook entries, protocols or anything from `CLAUDE.local.md`. Keep `src/index.html` free of any person's name or notebook content, since everyone runs the same file.
- The notebook database holds real lab records. Don't write test data to it.
