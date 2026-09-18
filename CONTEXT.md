# Ezoko Product Pipeline

Turns rows of the owner's Google Sheet, plus SKU-named photos in Google Drive,
into draft Shopify products. Built and operated without access to the
production store, by someone who isn't nearby and isn't technical — that
constraint is why the vocabulary below leans so heavily on *what a run refuses
to do* as much as what it creates.

## Language

### The pipeline

**SKU**:
The stock-keeping code that names one physical stone. It is the join key
across the sheet, the photo folder, and Shopify — normalised (uppercase,
trimmed) for matching, but shown to a human in whatever casing the owner typed.
_Avoid_: product ID, code

**Range SKU**:
A SKU that names several physical pieces on one row, e.g. `CA-738-A1-A11` for
A1 through A11. Refused outright rather than expanded: one row carries one
price and one size, and there is no honest way to split that across eleven
stones without the owner doing it.

**Row**:
One line of the sheet, exactly as the owner typed it, before any validation.
_Avoid_: record, entry

**Product type**:
The sheet's category for a row — `CARVING`, `SPHERE`, `TOWER`. It becomes the
Shopify product type and a tag, so it is what automated collections are built
from. In the title only when there is no Product name.

**Product name**:
The owner's own words for what one piece is — `DRAGON (ON STAND)`, `GHOST IN
HAT`. Optional, and feeds the title only: `{Stone} {Product name} - {size}
{weight}`, falling back to the Product type when empty. Never a tag, never
translated, never used to choose a description.
_Avoid_: product title (that is the whole title, stone and size included)

**Product Draft**:
This tool's own fully-validated, ready-to-send representation of a row — SKU,
title, price, photos, tags all resolved — before anything has been sent to
Shopify. Distinct from **Shopify draft status** below; don't say "the draft"
unless it's clear which one is meant.
_Avoid_: product (ambiguous with the eventual Shopify object)

**Shopify draft status**:
The status every product is left in after `productCreate` — nothing in this
codebase can move it to Active. A human publishes. See ADR-0001.

**Row Outcome**:
What validating one row, with its matched photos, produces before any network
call: `ready` (will be created), `skipped` (not finished yet — no price, no
stone name, no photos; normal, not a fault, roughly a third of the sheet), or
`invalid` (something a human must fix before it can proceed).

**Result Status**:
What a run reports once a `ready` row has actually been attempted against
Shopify and is about to be written back to the sheet: `created`, `partial`
(created, but not every photo attached), `exists` (already in Shopify from an
earlier run), `failed`, or `would-create` (what a preview reports in place of
`created`) — plus the row-level `invalid`/`skipped` carried through so
write-back has one status vocabulary. Don't conflate with Row Outcome: a
`ready` row can still end up `failed` if Shopify rejects it mid-run.

### Photo matching

**Matched Photo**:
A Drive file attributed to a SKU by the exact `SKU_NN.ext` naming convention —
split on the *last* underscore, so `CA-738-A1` can't steal `CA-738-A11`'s
photos.

**Rejected Photo**:
A Drive file that could not be safely attributed to a SKU — ambiguous,
malformed, or sharing a duplicate index with another file — and is refused
rather than guessed at. Only reported when its claimed SKU belongs to a row in
the sheet; the wider folder holds thousands of photos for pieces nobody asked
about this run.

**Claimed SKU**:
The SKU a filename *appears* to name, read more loosely than a Matched Photo
requires. Used only to decide whether a rejection is worth reporting — never
to actually attribute a photo.

**Photo Index**:
The result of scanning the whole photo folder once: every SKU's Matched
Photos, sorted by index, plus every Rejected Photo.

### Descriptions

**Description Catalogue**:
Every stone the shop has ever published copy for, built fresh each run by
reading the live storefront feed and grouping bodies by stone Heading. See
ADR-0004.

**Heading**:
The `<h3>` that opens a published product's body and names the stone — not the
product title, which carries per-piece noise like a size.

**Chosen Description**:
The one body picked for a stone out of everything published for it. The
most-used body wins; a tie goes to the longest, and is reported as tied so a
human knows the store disagrees with itself.

**Alias** (description alias):
A hand-written decision, in `data/description-aliases.json`, that one stone
deliberately borrows another's copy. Never inferred from a shared word — the
same reasoning that lets "Tiffany Fluorite" borrow Fluorite would just as
happily merge Azurite into Lapis Lazuli.

**Per-piece body**:
A published description that states a fact about one specific stone (a
dimension, a weight) rather than the stone in general. Excluded before voting,
so it can never be inherited onto a different, wrong piece.

### Write-back

**Owned columns**:
The four sheet columns this tool writes and nothing else ever touches:
`Shopify Status`, `Shopify Product`, `Uploaded At`, `Notes`. Appended to the
header if the sheet doesn't already have them.

**Terminal status**:
A `Shopify Status` value meaning the SKU is already in Shopify (`CREATED`,
`PARTIAL`, `EXISTS`). A Write Decision never downgrades a terminal cell to a
weaker one — the only record that a product exists must survive being
re-run.

**Write Decision**:
What write-back does with one row's owned cells, given what's already there:
`preserve` (leave a terminal cell alone), `clear` (blank a stale note from an
earlier run), `write` (record the new Result Status), or `ignore` (nothing to
say, nothing there already).

### Delivery

**current**:
The symlink pointing at whichever installed version is actually running. The
launcher repoints it on update and steps it back automatically if a freshly
installed version dies within 10 seconds of starting. See ADR-0006.

**Release**:
A version published to GitHub Releases as a checksummed tarball — compiled JS,
the web page, `data/` — that the in-app updater downloads and verifies before
installing. A prerelease or a draft release is never offered.
