# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-05

First public release.

### Added

- Select any passage of an assistant reply and attach a question to it,
  proofread-style.
- The question field opens automatically beside the selection and takes focus,
  so the flow is select → type → `Enter`.
- `Enter` saves the annotation, `Esc` discards it, and clicking anywhere outside
  the bubble discards it too.
- Annotations are mirrored into the composer automatically, so the composer's
  own `Enter`/Send action is armed without a second click.
- Every annotation is quoted into one numbered block: turn number, the original
  passage, and the question attached to it.
- Sending clears the annotations, since they have served their purpose.
- Annotated passages are highlighted in place using the CSS Custom Highlight
  API, without touching the host's DOM.
- Annotations survive transcript churn: they are stored as text-quote anchors
  (row key, character offsets, quote, surrounding context) and relocated on
  every repaint, so virtualized rows that re-render still carry their marks.
- Full English and Simplified Chinese copy.

### Known limitations

- Annotations live in the browser's localStorage per session, so they do not
  follow the reader across devices, and they never enter the session log.
- One annotation spans a single rendered row; a cross-row selection is refused
  with a notice.
- Requires the DSH Web GUI and the CSS Custom Highlight API (Chromium 105+).
