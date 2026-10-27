# pi-handoff

`/handoff` for [Pi](https://github.com/badlogic/pi-mono). It writes a structured handoff and commits that document as an **in-place compaction** of the current session. Persisted history stays in the session file. The same session continues, with the handoff as the compaction summary and Pi's normal retention boundary left intact.

This is not a new-session handoff. Pi's built-in example creates another session; this extension does not.

Tested against Pi `1.3.0` (`@earendil-works/pi-coding-agent`).

## Install

From git:

```bash
pi install git:github.com/scaryPonens/pi-handoff
```

Or load the directory Pi already watches:

```bash
ln -s /path/to/pi-handoff/extensions/handoff ~/.pi/agent/extensions/handoff
```

Then start Pi, or run `/reload` in an open session. `/reload` replaces the extension runtime; run it again after pulling changes.

One-shot load, without installing:

```bash
pi --extension /path/to/pi-handoff/extensions/handoff/index.ts
```

## Use

```text
/handoff
/handoff Focus on solver tests
```

The optional text is a priority hint. The summary should still keep every other fact needed to continue.

The document has these sections:

- Goal
- Constraints & Preferences
- Progress (Done / In Progress / Pending)
- Key Decisions
- Critical Context
- Next Steps

`/compact` is unchanged. The custom summary runs only for a `/handoff` that this extension just started.

## In place vs a new session

| | `/handoff` | Pi's example new-session handoff |
|---|---|---|
| Session file | Same file. Older entries remain on disk. | New file. |
| What the model sees next | The handoff summary, plus whatever Pi's compaction cut kept. | Whatever you paste into the new session. |
| `/compact` | Still Pi's normal summary. | Unaffected. |

Cancel with Escape while the summary is generating. A failed or cancelled handoff does not replace context.

## Limitations

- Pi prepares compaction before `session_before_compact`. If the branch is below the recent-token window (20,000 tokens by default) or is already compacted with nothing after it, Pi never fires that hook. `/handoff` then refuses and does not write a summary. That is the same gate as `/compact`. Lower `compaction.keepRecentTokens` only if you want a smaller retention window; this extension does not change that setting.
- A cancelled or failed handoff returns `cancel` from the hook so Pi does not fall back to a normal summary. Pi still prints `Compaction cancelled` for that path. The notification from this extension has the specific reason.
- No `--new`, no saved Markdown file, and no custom template.
- Generation uses the current session model, up to 8,192 output tokens. A length stop is rejected rather than committed.
