---
name: benchling-photos
description: 'Upload photos or files into a Benchling entry with the Claude in Chrome extension, at the right line, in order and at full resolution. Use when the user asks to add photos, images or a file to a Benchling entry ("upload the photos", "add these images to the entry"), and at the photo step of a transfer from ATG ELN.'
---

# Photos and file uploads (Chrome extension only)

The Access rules are in `CLAUDE.md`, which is always loaded: among them, never open the same entry for editing in both browsers at once, and never enter credentials. Copies of transferred photos are kept as its "Scratch space" section says.

1. Copy the files into a working directory the upload tool accepts, with descriptive names: YYMMDD_[Line]_[what].jpg.
2. Open the entry in Chrome and go to NOTES. Type a placeholder line where the images belong.
3. Add a temporary <input type="file" multiple> to the page by script, find it, and upload the files to it with the extension's file-upload tool (under 10 MB per call).
4. Click the placeholder line, type one character and delete it. This sets Benchling's own cursor; a click alone does not.
5. By script, dispatch dragenter, dragover and drop on that line with the input's files, then remove the temporary input. Images are inserted at Benchling's cursor, in file order.
6. Wait about 10 s, then check the block order. If the images landed in the wrong place, press cmd+z once and repeat from step 3.
7. Replace the placeholder with a caption giving the image order. Close the Chrome tab when done.
- Keep full resolution. Never shrink images to make a transfer easier.
