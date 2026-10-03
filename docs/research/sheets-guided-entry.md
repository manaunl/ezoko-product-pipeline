# Sheets-native guided data entry — research (issue #21)

Research leg for the "Sheets-native" candidate in the guided-data-entry map
issue (#19). Covers dropdown/validation sync, Apps Script sidebar
feasibility and distribution, the "value not in list" escape hatch, and
known mobile/API-read limitations. Concurrency-safe writes via the Sheets
API are out of scope here — see issue #22.

## TL;DR

Sheets-native guided entry is buildable but has real edges. Data-validation
dropdowns can be pointed at a `Range` (including, by extension, a named
range), and that range's contents can be kept in sync with an external
vocabulary (e.g. this repo's `product-names`/`stone-names` lists) by having
an Apps Script **container-bound script** fetch the external source with
`UrlFetchApp` and write it into a helper range on an `onOpen` or time-driven
trigger — no separate install step for Archy, since a bound script ships
inside the spreadsheet file itself and surfaces as a custom menu item. Today,
Google's own docs describe the dropdown's "On invalid data" setting as
rejecting input by default, with an explicit opt-in ("Advanced options" →
"Show a warning") required to let an out-of-list value through — so the
"reject" behavior this tool needs is already the documented default, not
something to build. There is **no native "value not in list → add it as a
new option" UX**; that always requires a custom `onEdit` trigger or similar
script. The biggest real risks are on mobile: editor-add-on-style custom
UI (menus, sidebars, dialogs from a bound script) is documented as
**desktop-only**, so any sidebar/form built this way is invisible to Archy
if he ever edits from the Sheets phone app. Values written by a script via
`Range.setValue()`/`setValues()` read back through the Sheets API
indistinguishably from human-typed values (same `valueRenderOption`
semantics), but such script writes do **not** fire simple `onEdit`
triggers — and neither do edits made through the Sheets API itself — which
matters for any "watch for new/changed rows" automation layered on top.

---

## 1. Data-validation dropdown lists and sync

**Can the dropdown's source range be kept in sync with an external
vocabulary, instead of hand-typing a parallel list in the sheet?**

Yes, mechanically. A Sheets data-validation rule built with
`requireValueInRange(range, showDropdown)` validates against "a value in the
given range" — any `Range` object, not a static list — per the
`DataValidationBuilder` reference:
[Class DataValidationBuilder](https://developers.google.com/apps-script/reference/spreadsheet/data-validation-builder).
There's also `requireValueInList(values, ...)` for a literal array if a
range isn't wanted. The UI-level "Dropdown from a range" criterion (Data →
Data validation) is the same underlying mechanism — the support page
confirms "the changes are made in the list automatically" when the source
range's contents change: [Create an in-cell dropdown list](https://support.google.com/docs/answer/186103?hl=en).

So the pattern is: a container-bound Apps Script function calls
`UrlFetchApp.fetch(rawGithubUrl)` — documented at
[Class UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app)
(requires the `script.external_request` scope, and requests originate from
Google's own IP ranges, which matters if the source ever needs an
allowlist) — parses the fetched JSON, and writes it into a helper-sheet
range with `Range.setValues()`. The validation rule on the real column
points at that helper range (built with `requireValueInRange`, or at a
named range via `getRangeByName()` per
[Class Spreadsheet](https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet)).
Refresh is driven by either an `onOpen()` **installable** trigger (fires
whenever a user with edit rights opens the file) or a time-based trigger —
Apps Script time-driven triggers "let scripts execute at a particular time
or on a recurring interval, as frequently as every minute" — per
[Installable Triggers](https://developers.google.com/apps-script/guides/triggers/installable).
None of this is a documented, built-in Google feature for pointing a
dropdown straight at a URL; it's assembled from three separately-documented
primitives (validation-on-a-range, `UrlFetchApp`, triggers), which is worth
naming as added surface area / maintenance burden rather than a toggle.

**What happens today when a user types a value not on the dropdown list?**

Per the same support page, the current documented default is **rejection**:
entering a value that doesn't match a list item "is rejected" unless the
user opts in to the alternative. To allow non-list values, the documented
path is: open **Advanced options**, and under "If the data is invalid",
select **Show a warning** — [Create an in-cell dropdown list](https://support.google.com/docs/answer/186103?hl=en).
This is also exposed programmatically: `DataValidationBuilder.setAllowInvalid(boolean)`
— "Sets whether to show a warning when input fails data validation or
whether to reject the input entirely" (true = warn-but-allow, false =
reject) — [Class DataValidationBuilder](https://developers.google.com/apps-script/reference/spreadsheet/data-validation-builder).
Caveat: the support page's exact current UI copy for the two named radio
options ("Reject input" vs "Show a warning" as literal button labels) could
not be independently re-verified against the raw rendered page in this pass
(see Open gaps) — the *behavior* and *default* described above is sourced
directly from Google's text, but the literal button-label strings should be
confirmed against a live sheet before being referenced in code or UI copy.

---

## 2. Apps Script custom sidebar/form — feasibility and distribution

**What's buildable:** `HtmlService` lets a bound script show either a
**sidebar** (`Ui.showSidebar()`) or a **modal/modeless dialog**
(`Ui.showModalDialog()` / a non-modal custom dialog), each able to run
arbitrary HTML/CSS/JS and talk back to the server-side script
asynchronously via the `google.script` client API, without suspending the
script while open — [Dialogs and sidebars in Google Workspace documents](https://developers.google.com/apps-script/guides/dialogs).
A guided form (dropdowns backed by the same vocabulary lists, lookups,
basic validation before writing the row) is squarely within what
`HtmlService` supports; it is not bound to "the active row" automatically,
but the script can read `getActiveRange()`/`getActiveCell()` server-side
and pass that context into the sidebar.

**Distribution for a non-technical owner:** this is the strongest point in
Sheets-native's favor. A **container-bound script** is created from
*inside* the spreadsheet itself, via **Extensions → Apps Script** (or, for
Forms, **More → Script editor**) — [Container-bound Scripts](https://developers.google.com/apps-script/guides/bound).
Bound scripts "don't appear in Google Drive" and "can't be detached from
the file they are bound to" — they live and travel with the spreadsheet
file, with **no separate deployment, publishing, or install step** for the
end user. They also get privileged access the standalone kind doesn't:
`getActiveSpreadsheet()`, `getUi()`, etc., which is what lets them "add
custom menus, dialogs, and sidebars" to the file's own UI — same page. The
custom-menu entry point is the ordinary distribution mechanism: an
`onOpen()` simple trigger "runs automatically whenever you open the
document" and is the typical place to call `SpreadsheetApp.getUi().createMenu(...)`
so the sidebar/form is one click away every time Archy opens the sheet —
[Custom Menus in Google Workspace](https://developers.google.com/apps-script/guides/menus).

By contrast, a **standalone script** (created at script.google.com, not
from within a file) does appear in Drive, is not privileged to a specific
open file's UI without extra permission grants, and — if ever turned into
a published **Add-on** — requires a formal deployment/publishing/install
flow (store listing or domain install) that a bound script never needs.
For this project's single-sheet, single-non-technical-owner situation, a
bound script is the only one of the three that ships "for free" with the
spreadsheet.

---

## 3. "Value not in list → add it" escape hatch

**No native built-in exists.** Google's own dropdown documentation only
describes two first-party affordances for *changing the list itself*:
editing the data-validation rule's source range/values directly (the
"Add another item" control inside the Data Validation panel), and the 2023/24
"dropdown chip" visual refresh, which is a rendering change (colored chips,
a `Insert → Dropdown` entry point, preset chip templates for common cases
like priority/status) rather than a new in-cell "add this value to the
list" prompt — [Insert smart chips in your Google Sheets](https://support.google.com/docs/answer/12319513?hl=en),
[Google Workspace Updates: Set up dropdown chips more easily in Google Sheets](https://workspaceupdates.googleblog.com/2024/03/set-up-dropdown-chips-more-easily-google-sheets.html).
Neither mechanism offers an in-the-moment "this isn't on the list — add it?"
interaction while typing into a validated cell; both require going back into
the dropdown's own configuration UI to extend the list.

Achieving an "unknown value → prompt or auto-append" UX is therefore always
custom script territory: an installable `onEdit` trigger that reads the
edited cell, checks it against the current validation range/list, and
either appends the new value to the helper range (then possibly re-applies
`requireValueInRange`) or raises a `Ui.prompt()`/sidebar message asking the
user to confirm. There is nothing resembling this as a built-in Sheets
feature in the documentation reviewed.

---

## 4. Known limitations

**(a) Mobile.** Custom UI built by a bound script — menus, sidebars, and
dialogs — is an **Editor Add-on**-style surface, and Google's own docs are
explicit: "Editor add-ons only function in desktop clients, not Android or
iOS" — [Add-on types](https://developers.google.com/workspace/add-ons/concepts/types).
This generalizes to the plain custom-menu/sidebar mechanism this plan would
use (same underlying `Ui` service): a bound script's custom menu or
sidebar is a desktop-web-only surface. So if Archy ever opens or edits the
sheet from the Sheets Android/iOS app, any guided sidebar/form (and the menu
item that launches it) will not be there at all — he'd be back to typing
into raw cells, with only the validation dropdown itself (which does work
cross-platform, short of one caveat) as a guardrail. The dropdown caveat
documented by Google: "On mobile, you currently can't select multiple
dropdown options even when multiple selection is enabled" —
[Create an in-cell dropdown list](https://support.google.com/docs/answer/186103?hl=en)
— which doesn't affect this project's single-value dropdowns but confirms
mobile dropdown behavior isn't 1:1 with desktop either.

**(b) Script-set vs. human-typed values, as seen by the Sheets API.** No
documented distinction was found between a value placed by
`Range.setValue()/setValues()` and one typed by a human, from the
perspective of a later `spreadsheets.values.get` read — both are plain
cell values subject to the same `valueRenderOption` rules
(`FORMATTED_VALUE` default, `UNFORMATTED_VALUE`, or `FORMULA`) —
[ValueRenderOption](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueRenderOption),
[Read & write cell values](https://developers.google.com/sheets/api/guides/values).
The one real divergence is **formula cells**: a formula's computed result
(not the formula text) is what `FORMATTED_VALUE`/`UNFORMATTED_VALUE` return;
only `FORMULA` returns the literal formula string — same page. This is a
rendering-option distinction, not a script-vs-human distinction, so it
doesn't introduce a hidden gap for this tool's read path as long as the
column being read is a plain value column (which the sheet's data-entry
columns are).

The trigger-adjacent finding, relevant context for issue #22: **simple
triggers (`onEdit`, `onOpen` as bare functions) do not fire for edits made
by a script's own `Range.setValue()/setValues()` calls**, and — by the same
"script executions and API requests don't cause triggers to run" rule —
**edits made via the Sheets API also do not fire onEdit** —
[Simple Triggers](https://developers.google.com/apps-script/guides/triggers).
An *installable* `onEdit` trigger set up via the Script Editor UI/`ScriptApp`
is what's needed if "a row changed" needs to be detected reliably regardless
of whether the edit came from a human, a bound script, or the API — bare
simple triggers are not sufficient for that.

---

## Open gaps / what this doesn't resolve

- The exact, currently-rendered **button-label strings** for the two
  "On invalid data" options (commonly referred to as "Reject input" and
  "Show a warning") were not independently confirmed against a live,
  freshly-rendered Data Validation panel in this pass — only against the
  support page's prose description of the behavior and its documented
  default. Worth a 30-second check in an actual sheet before citing the
  literal labels in code/UI copy.
- Whether `requireValueInRange` / the "Dropdown from a range" UI criterion
  accepts a **named range** directly (vs. only a literal `Sheet!A1:A10`-style
  range) was not explicitly confirmed in Google's docs — the reference page
  for `DataValidationBuilder` doesn't call this out either way. `Range`
  objects obtained via `getRangeByName()` should work since they're
  ordinary `Range` instances, but this is inference from the API shape, not
  a documented statement, and is worth a direct test.
- The precise mobile-app behavior for a *plain* (non-add-on) data-validation
  dropdown beyond the one documented multi-select caveat — e.g. whether
  typing an out-of-list value on mobile triggers the same reject/warn
  behavior as desktop — isn't separately documented and would need a
  hands-on check on an Android/iOS device.
- Whether an `onOpen()`-triggered `UrlFetchApp` refresh is fast/reliable
  enough not to noticeably delay opening the sheet for Archy, and what
  happens to the dropdown/menu if the external fetch fails (stale list vs.
  broken validation) — not covered by documentation and would need a small
  prototype.
- Nothing above was tested against a live spreadsheet; all findings are
  from Google's published documentation only, per this ticket's brief.
