# Sheets API concurrency: can the app safely write to Archy's input columns?

**Summary: No — the Sheets API v4 has no revision/ETag precondition at any
granularity (that mechanism exists in the sibling Docs API but was dropped
from Sheets after v3), so "fresh read immediately before write" cannot detect
a collision; it is adequate for the app's own 4 owned columns, which no human
ever edits, but it is not a safe pattern to extend to Archy's free-text input
columns without an additional, app-level safeguard (e.g. narrowing the write
to empty cells only, or a human-visible diff/confirm step).**

This is research for issue #22. It does not propose a design — see the
"Conclusion for this app" section for reasoning only, flagged as such.

---

## 1. Does the Sheets API expose a revision/ETag/version signal to detect "changed since I last read it"?

**No, not at any granularity — whole-spreadsheet, per-sheet, or per-range/cell.**
This was checked directly against the field lists of the relevant resources
and methods, not inferred:

- **`Spreadsheet` resource** — the full field list returned by
  `spreadsheets.get` is: `spreadsheetId`, `properties`, `sheets`,
  `namedRanges`, `spreadsheetUrl`, `developerMetadata`, `dataSources`,
  `dataSourceSchedules`, `comments`, `commentsViewMode`. No `revisionId`,
  `version`, or `etag` field exists on it.
  Source: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets

- **`spreadsheets.values.update`** — the response is `UpdateValuesResponse`;
  the request/response reference page documents only `valueInputOption`,
  `includeValuesInResponse`, `responseValueRenderOption`, and
  `responseDateTimeRenderOption` as the relevant fields. Nothing about
  revisions, ETags, or preconditions.
  Source: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/update

- **`spreadsheets.batchUpdate`** — the full top-level request field list is
  `requests[]`, `includeSpreadsheetInResponse`, `responseRanges[]`,
  `responseIncludeGridData`, `commentsViewMode`. There is no `writeControl`,
  `precondition`, or `requiredRevisionId` field — confirmed directly against
  the field list, not inferred by absence of a mention. The only
  transaction-like guarantee stated is atomicity of the whole batch: *"A list
  of updates to apply to the spreadsheet. Requests will be applied in the
  order they are specified. If any request is not valid, no requests will be
  applied."* That protects against a partially-applied batch, not against a
  write landing on top of someone else's intervening edit.
  Source: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/batchUpdate

- **`DataFilter` / `getByDataFilter`** — exists purely to select which ranges
  of data to return (*"Specifying one or more data filters returns the
  portions of the spreadsheet that intersect ranges matched by any of the
  filters"*); it has nothing to do with versioning or concurrency.
  Source: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/getByDataFilter

- **This is a deliberate regression from Sheets API v3, not an oversight.**
  v3 (the old GData-based API, shut down August 2021) assigned each row a
  unique ID and an ETag, and supported conditional deletes via an `If-Match`
  header carrying that row's `gd:etag` value. The official migration guide
  documents the row ID (*"The v3 API also assigns an ID to rows retrieved
  using its list feed"*) and the ETag-guarded delete pattern, and v4 has no
  equivalent for either — no per-row identity and no conditional-write
  header of any kind.
  Source: https://developers.google.com/workspace/sheets/api/guides/migration

- **The guides (`concepts`, `values`, `batchupdate`) say nothing on the
  topic at all.** Each was fetched and checked specifically for
  revision/ETag/concurrency language; none contains any.
  Sources: https://developers.google.com/sheets/api/guides/concepts ,
  https://developers.google.com/sheets/api/guides/values ,
  https://developers.google.com/sheets/api/guides/batchupdate

- **Drive's separate Revisions API exists, but at whole-file granularity
  only, and is weaker for a Sheet than for a binary file.** The Drive `File`
  resource does carry a `version` field — *"Output only. A monotonically
  increasing version number for the file. This reflects every change made
  to the file on the server, even those not visible to the user"* — which is
  a coarse, whole-file staleness counter you could compare before/after. But
  the companion `headRevisionId` field is explicitly scoped away from Sheets:
  *"Output only. The ID of the file's head revision. This is currently only
  available for files with binary content in Google Drive."* A Google Sheet
  is not binary content, so `headRevisionId` does not apply to it. The
  `revisions.list`/`revisions.get` methods exist for Sheets (Docs/Sheets/
  Slides files can have published revisions), but the Revision resource's
  fields (`id`, `mimeType`, `kind`, `md5Checksum`, `modifiedTime`, `size`,
  `originalFilename`, `lastModifyingUser`, `exportLinks`, `published`,
  `keepForever`, `publishAuto`, `publishedOutsideDomain`, `publishedLink`)
  describe a revision of the *whole file*, exportable as a whole-file blob —
  there is no field or mechanism exposing which range or cell changed between
  two revisions. The guide also warns revision history can be incomplete for
  exactly this file type: *"The list of revisions returned by this method
  might be incomplete for files with a large revision history, including
  frequently edited Google Docs, Google Sheets, and Google Slides."* So even
  the coarse whole-file signal is not guaranteed complete for an actively
  edited sheet.
  Sources: https://developers.google.com/drive/api/reference/rest/v3/files ,
  https://developers.google.com/drive/api/reference/rest/v3/revisions ,
  https://developers.google.com/drive/api/guides/manage-revisions

**Bottom line for Q1:** nothing in the Sheets API v4 surface — not
`spreadsheets.get`, not `values.get`/`values.update`/`values.batchUpdate`,
not `spreadsheets.batchUpdate`, not `DataFilter` — returns or accepts a
revision/ETag/version token at spreadsheet, sheet, range, or cell
granularity. The only thing resembling a version counter anywhere in the
Google stack for this file is Drive's whole-file `version` number, which is
informational only (nothing enforces it) and explicitly not paired with the
finer `headRevisionId` for non-binary files like Sheets.

---

## 2. What does Google itself recommend for concurrency-safe / collaborative writes?

**There is no Sheets-API-level recommendation at all** — none of the guide
pages fetched for this research (`concepts`, `values`, `batchupdate`, the
troubleshooting page) mentions conflict detection, collaborative-write
guidance, or a precondition mechanism for Sheets.

- `troubleshoot-api-errors` addresses *rate*, not *correctness*: its only
  concurrency-adjacent guidance is quota-shaped — *"Limit the number of
  concurrent requests to the API per spreadsheet to 1 request per second"* —
  which is about avoiding 503s, not about avoiding clobbering another
  writer's change.
  Source: https://developers.google.com/workspace/sheets/api/troubleshoot-api-errors

- **The sibling Google Docs API has exactly the precondition mechanism Q1
  was looking for — and Sheets conspicuously does not.** Docs API v1's
  `documents.batchUpdate` accepts an optional `WriteControl` object,
  described as *"Provides control over how write requests are executed,"*
  with two fields:
  - `requiredRevisionId` — *"The optional revision ID of the document the
    write request is applied to. If this is not the latest revision of the
    document, the request is not processed and returns a 400 bad request
    error."* This is a true optimistic-concurrency precondition: read the
    document, capture its `revisionId`, write only if nothing has changed
    since.
  - `targetRevisionId` — a looser variant that applies the write against the
    revision as of read time and attempts to merge forward, failing only if
    the target revision is too far behind.

  The recommended pattern per Google's own docs is explicit: *"Get the
  document using the `documents.get` method and save the `revisionId` from
  the returned documents resource, then include an optional `WriteControl`
  object with the `requiredRevisionId` field set to the revisionId of the
  document the write request is applied to. If the document was modified
  since the API read request, the write request isn't processed and it
  returns an error."*
  Source: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate

  This directly answers Q2's question of "is there anything resembling an
  optimistic-concurrency precondition" — **yes, for Docs. No, for Sheets.**
  `spreadsheets.batchUpdate`'s field list (verified under Q1) has no
  `writeControl` or equivalent. Google built this exact feature for a
  sibling API in the same product family and did not carry it over to
  Sheets.

- **Google's own guidance for Sheets-backed apps states last-write-wins
  explicitly, with no conflict detection.** AppSheet (a Google product built
  on Sheets as a data backend) documents its own concurrency behavior in
  terms that are about as close as Google gets to addressing this scenario:
  *"The simple rule is that the last writer wins."* and *"If two clients
  happen to change the same row at nearly the same time, the last client's
  change is what persists."* The page describes audit-trail logging of what
  happened after the fact, but — as fetched and checked directly — **no
  mechanism to detect the conflict beforehand, block it, merge it, or
  surface it to either writer.** It is after-the-fact visibility, not
  prevention.
  Source: https://support.google.com/appsheet/answer/10104702?hl=en

**Bottom line for Q2:** the implicit guidance for Sheets is last-write-wins,
full stop. Nothing resembling an `If-Match`/ETag header or a `WriteControl`
precondition exists for `spreadsheets.values.update` or
`spreadsheets.batchUpdate`. That this precondition mechanism demonstrably
exists one API over (Docs) rules out "nobody has thought about this
problem" as an explanation — it is a capability Sheets v4 specifically does
not have.

---

## 3. Is "fresh read immediately before write" adequate for the input-column use case too?

The two questions above establish the hard constraint this reasoning has to
work inside: whatever pattern the app uses, there is no API-level signal
available afterward to prove a collision did or didn't happen. "Fresh read
immediately before write" is therefore not a defense against collisions in
either case — it is a window-narrowing tactic. The question is how large,
and how costly, the remaining window is in each case.

### Conclusion for this app — original reasoning, not sourced from Google's docs

*Everything below is this research's own analysis of the app's specific
situation. Google's documentation does not address this app or this
scenario; nothing in this section should be read as a claim about what
Google recommends.*

**For the 4 owned columns, the pattern is adequate, for a structural reason
specific to those columns: the only other writer is the app itself.**
`Shopify Status`, `Shopify Product`, `Uploaded At`, and `Notes` are never
typed into by Archy — ADR-0003 and the write-back design treat them as the
tool's own ledger. The race the "fresh read right before write" pattern has
to survive is therefore only "another run of this same tool, started close
enough in time to this one." That race has three properties that make it
tolerable:

1. It is bounded and rare — the app runs on demand, not continuously, so
   two overlapping runs racing on the *same SKU's owned cells* is already an
   edge case, and the existing "concurrent-run refusal" (noted in the
   project status) narrows it further.
2. The worst case is self-correcting in kind — a stale `Shopify Status`
   briefly overwritten by a fresher one is a status *about the same
   underlying fact* (what's in Shopify), and `decideWrite`'s `preserve` rule
   (never downgrade a terminal status) already bounds the damage: the only
   thing that can be lost is a `clear`-type blank-the-stale-note write, not a
   human's authored content.
3. There is no human input in flight to lose. A lost or overwritten race on
   these columns costs a few seconds of staleness in a convenience column,
   explicitly documented as "a convenience for the human, never a ledger the
   tool relies on."

**For Archy's free-text input columns, the same pattern carries a
materially different risk, for two reasons that are specific to how Sheets'
own web client behaves, not to anything the Sheets API documents:**

1. **There is no API-visible "save" boundary to read before.** Sheets
   autosaves per cell on blur/edit-commit from the browser's perspective,
   but the API has no concept of "a cell mid-edit" — a `values.get` either
   sees the last committed value or it doesn't; there's no signal
   distinguishing "Archy is three keystrokes into typing in this cell right
   now" from "this cell is settled." A `values.update` landing in that
   window overwrites whatever Archy types next with the server's own
   subsequent autosave, or vice versa — and, as established in Q1 and Q2,
   nothing in the API would tell either side it happened. The "fresh read
   immediately before write" pattern narrows the window to roughly the
   round-trip time of one API call, but it does not close it, and — unlike
   the owned-columns case — the thing that can be lost in that window is
   content a human typed and cannot be reconstructed from Shopify or
   anywhere else the app can re-derive it from.
2. **The failure is not symmetric with the owned-columns case.** Losing a
   stale `Shopify Status` costs nothing because Shopify is still the source
   of truth and the next run re-derives it (ADR-0003's entire point). Losing
   three characters of a stone name Archy was mid-typing has no equivalent
   recovery: there is no second source for "what Archy meant to type," and
   the sheet's edit history (standard Sheets revision history, not an API
   the app can query granularly per Q1) is the only place that content
   might survive, if at all, and is not something the app's write path can
   check before acting.
3. **The inverse ordering is just as real.** If the app writes first and
   Archy's browser — still showing the pre-write value, because nothing
   pushed a refresh to his open tab — commits an edit a moment later, Sheets'
   client applies that edit as a plain last-write-wins cell update with no
   merge and no diff against what's now actually on the server. The app's
   write is silently gone, and neither Archy nor the app has any way to
   notice: the app assumes its write succeeded (it did, as an API call), and
   Archy has no reason to suspect his own save clobbered something, since
   his sheet UI never told him the cell had changed under him.

**Conclusion:** "fresh read immediately before write" is a reasonable match
for a column no human edits, where it narrows a race against the app's own
other runs. It is not, by itself, an adequate safeguard for writing into a
column Archy edits by hand, because (a) the API gives no way to detect a
collision after the read, before, or after the write — confirmed, not
assumed, by Q1 and Q2 — and (b) unlike the owned-columns case, a collision
here can destroy human-authored content with no fallback source of truth to
recover it from. Any design that writes into Archy's input columns would
need a safeguard the API itself does not provide — e.g., restricting writes
to cells confirmed empty at both the pre-write read and a post-write
verification read, surfacing a visible conflict back to a human instead of
silently overwriting, or some other app-level compensating control — rather
than relying on the read-then-write timing alone. Designing that safeguard
is outside the scope of this research ticket.

---

## Sources

Fetched and read directly for this research:

- https://developers.google.com/sheets/api/reference/rest — top-level REST reference structure
- https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets — `Spreadsheet` resource field list
- https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/update — `values.update` request/response fields
- https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/batchUpdate — `BatchUpdateSpreadsheetRequest` field list
- https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/getByDataFilter — `DataFilter` purpose
- https://developers.google.com/sheets/api/guides/concepts — checked for revision/concurrency language (none found)
- https://developers.google.com/sheets/api/guides/values — checked for revision/concurrency language (none found)
- https://developers.google.com/sheets/api/guides/batchupdate — checked for revision/concurrency language (only atomicity-of-the-batch found)
- https://developers.google.com/workspace/sheets/api/troubleshoot-api-errors — rate-limit guidance only
- https://developers.google.com/workspace/sheets/api/guides/migration — v3→v4 removal of row IDs and ETags
- https://developers.google.com/drive/api/guides/manage-revisions — Drive Revisions guide, whole-file granularity
- https://developers.google.com/drive/api/reference/rest/v3/files — `version` and `headRevisionId` field definitions
- https://developers.google.com/drive/api/reference/rest/v3/revisions — `Revision` resource field list
- https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate — Docs API `WriteControl`/`requiredRevisionId`/`targetRevisionId`
- https://support.google.com/appsheet/answer/10104702?hl=en — Google's own "last writer wins" statement for a Sheets-backed app

No fetch was blocked or returned an error for this research; all URLs above
returned usable content on first attempt. Two general WebSearch queries were
also run (for "Sheets API concurrent edits best practices" and for "Docs API
WriteControl") to locate the Docs API comparison and the AppSheet page; the
documentation pages they surfaced are the ones listed above and are what is
cited, not the search snippets themselves.
