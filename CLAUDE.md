# Project brief

Read this first, then `README.md` for setup and commands.

**What this is:** a tool that turns rows of a Google Sheet plus SKU-named photos
in Google Drive into draft Shopify products.

**The constraint that shapes everything:** whoever builds this has no access to
the production store it will eventually run against, and the person who operates
it is not technical and is not nearby. Every safeguard below exists because of
that — draft-only creation, no delete anywhere, preview as the default, Shopify
rather than the sheet as the source of truth, and a launcher that undoes a bad
update by itself.

> This repository is public. Notes that name people, describe the commercial
> arrangement, or record open questions about a real shop's data live in
> `NOTES.local.md`, which is deliberately not committed.

---

## Status

### Working and verified against real data

- Google OAuth sign-in (desktop flow, 7-day expiry accepted)
- Reading the sheet — 144 real rows, columns matched by header name
- Reading Drive recursively — photos live in subfolders by product type
- Photo→SKU matching, ordering, and rejection of ambiguous filenames
- Validation: units, ranges, prices, placeholders, duplicate and range SKUs
- Hungarian→English stone-name translation
- Shopify connection via client credentials grant, token auto-refresh
- **Full create path**: staged upload → `productCreate` (draft) → variant
  (SKU/price/weight) → inventory 1 → wait for image processing
- Batch runner with preview/commit, `--limit`, repeatable `--sku`, and JSON run
  artifacts
- **Local web page** (`npm start`, or double-click `start.command`) — a Preview
  button, then a checkbox on every row it would create (nothing ticked),
  **Select all** and **Create selected (N)**. After a commit the list is still
  the last preview, with everything created since laid over it (assembled from
  the run reports), so unticked rows keep what the preview said and can be
  ticked next. Ticking is allowed
  for four hours after the last finished preview (read from the run reports, so
  a reload or restart keeps it, a commit doesn't extend it; page-only, not the
  CLI). The server refuses a commit with no SKUs. Background runs with file-based
  progress polling,
  concurrent-run refusal, stale-run detection, bound to `127.0.0.1` only
- **Write-back to the sheet** — four tool-owned columns, appended if absent;
  rows located by SKU in a fresh read at write time; written per product as it
  is created, not at the end; unfinished rows left blank and stale notes
  cleared; a row already recording a product in Shopify is never downgraded.
  The decision is one tested function, `decideWrite`
- **Setup page** (`/setup.html`) — instructions, credential fields, browser
  Google sign-in via `/auth/google`, and a connection test for Shopify, the
  sheet and the photo folder. Writes `.env` in place (keeps comments and unknown
  keys, `600` perms, blank secret means "keep the stored one") and updates
  `process.env` so saving takes effect without a restart. Secrets are never sent
  to the browser — only whether each one is set
- **Descriptions inherited from the live storefront** — every product's body is
  the owner's own published copy for that stone, read from the public
  `ezoko.shop/en/products.json`, keyed on the `<h3>` heading, exact match only,
  most-used body wins. A stone the shop has never described gets an empty body
  and a warning naming it; every run reports its own coverage, so that number
  moves as the owner writes copy and adds rows. `data/description-aliases.json`
  allows a deliberate borrow. Verified against all 2,550 published products
- **State lives outside the app folder** — `~/Library/Application Support/Ezoko/`
  holds `.env`, `google-token.json` and `runs/`, resolved through `src/paths.ts`
  and nowhere else, so replacing the code cannot take the credentials with it.
  `EZOKO_STATE_DIR` overrides it. An `.env` left beside the code from the old
  layout is copied forward on first run — copied, never moved, never
  overwriting, so the old folder stays a working fallback
- **Google client libraries narrowed** to `@googleapis/sheets`,
  `@googleapis/drive` and `google-auth-library`. Every path re-verified against
  live data after the swap, including a created product — a preview never
  downloads a photo, so `src/scripts/check-google.ts` exists to exercise that
  path without writing anything
- **Release build** — `npm run build` produces a 4.0M gzipped tarball plus a
  checksum: compiled JS, the web page, `data/`, and production `node_modules`,
  with no toolchain in it. `npm run smoke` unpacks it somewhere clean and starts
  it on plain `node` with an empty state directory, checking the 14 things a
  compiler cannot see. The compiled artifact has run a full preview against real
  data. Every run report records the version that produced it
- **Launcher with automatic rollback** — `start.command` runs whatever `current`
  points at, restarts on exit 75 (how an update applies itself), and puts the
  previous version back if a freshly installed one dies within 10 seconds. Finds
  Node when Finder's PATH doesn't have it; treats a second double-click as
  "already open" rather than a crash. `npm run test:launcher` — 16 checks
  against a real installation with a deliberately broken release in it
- **In-app updates** — a banner on the page, an **Update now** button, and a
  step-back button for versions already on disk. Reads GitHub's latest release,
  verifies the sha256 before unpacking, and never offers a prerelease, a draft,
  or a release missing its files. The check cannot break the app: no wifi or a
  GitHub outage is a note, not a failure. Refuses while a run is live.
  `npm run test:update` — 21 checks driven through a fake GitHub on localhost,
  so it needs neither network nor a published release
- 206 unit tests, no credentials required

**The tool only ever creates, never updates.** A product already in Shopify
keeps whatever title it was created with — changing the title format does not
rename existing products. Renaming would need a product-update capability that
deliberately does not exist.

**Verified end to end on the dev store:** preview wrote nothing; `--commit`
created 3 products with 3/3 images each, correct titles, prices, weights, tags,
type and inventory; a second `--commit` created nothing (all `EXISTS`).

**Descriptions — verified up to, but not including, the write.** The selection
rules are covered by 47 tests against a fixture of the owner's real HTML. A preview
against the sample sheet, the real 13,049-file folder and all 2,550 published
products resolved 25 of the 28 stones it contained, with both aliases firing and
Moonstone correctly flagged as tied. The chosen HTML was inspected by hand and is
correct — Malachite comes through byte-for-byte as the owner wrote it. What has
**not** been done is a `--commit` with a description attached, so `productCreate`
accepting this HTML is still unproven. First real run should be
`--commit --limit 1` followed by a look at the product in the admin.

**Product template — not verified at all.** Every product is created with the
theme template `bracelet` (ADR-0008). The dev store's theme has no such
template, so only the owner's store can show whether Shopify accepts it and the
page renders. The same first `--commit --limit 1` should check the product's
template in the admin as well as its description.

Note the 70 products already on the test store were created before this existed
and have empty bodies. They will stay that way: the tool never updates.

**Sales-channel availability — confirmed on a real (non-dev) store.** A run
refuses to start, in both preview and commit, without the `read_publications`
and `write_publications` scopes — confirmed both ways: refuses with them
absent, proceeds and correctly discovers the store's channels with them
present. A created product becomes genuinely available to its channels on a
real store. That's the important correction: the dev store showed
`publishablePublish` returning success while silently leaving the product
available to zero channels, which looked like a design flaw in ADR-0009
rather than what it turned out to be — a dev-store limitation. See ADR-0009's
resolution note.

### Not built yet

1. **Packaging and delivery** to the owner's Mac. He currently downloads a ZIP from
   GitHub, which means every update costs him an `npm install` in a terminal and
   a full re-entry of his credentials — `.env` and `.google-token.json` are
   gitignored, so a fresh ZIP arrives with neither. Designed and agreed, not yet
   built: see **`docs/delivery-plan.md`**.

### Deliberately out of scope for v1

Hosted deployment · repairing missing photos on a re-run (partials are
*reported*, not repaired) · cost-based rate-limit throttling · choosing which
channels get which product, or removing a product from one, or scheduled
publishing (every product goes to every channel that exists, ADR-0009) ·
barcode, SEO, compare-at price, cost · theme work to display metafields ·
dimension metafields · Hungarian storefront (the owner presses the Translate &
Adapt button himself) · multiple variants or locations · LLM-written
descriptions (they are *inherited* from the shop instead) · backfilling
descriptions or channel availability onto products already created (there is
no update path)

---

## Decisions that are settled

Don't relitigate these without asking; each was argued through.

| Decision | Why |
|---|---|
| One row = one product = one variant | Every stone is a unique physical piece |
| Everything is created as **DRAFT** | A human publishes. Bugs are found by us, not customers |
| **No delete anywhere in the codebase** | Cannot destroy a catalogue we cannot test against |
| Preview is the default; `--commit` required | The dangerous action is the one you ask for |
| **Shopify is the source of truth, not the sheet** | Create + sheet-update aren't one transaction. Makes every run repeatable |
| Photos: split filename on the **last** underscore | Exact SKU match, so `CA-738-A1` can't steal `CA-738-A11`'s photos |
| Normalise the unambiguous, refuse the ambiguous | A best-effort guess puts the wrong photo on the wrong stone |
| Title = `{Stone} {Product name or Type} - {size} {weight}` | the owner's format. The optional `PRODUCT name` column says what a carving actually is; empty falls back to the type, and tags stay on the type. Its small words stay lower case and its brackets are kept: `Dragonfly (on Stand)`. Size = first of height→width→depth in the cell's own unit; weight written as `gr`. Either part is dropped when missing |
| Units read from the **cell**, not the header | The WIDTH header says nothing; the data says `"37 mm"` |
| Prices are whole forints | HUF; every separator is a thousands separator |
| Tags = lowercase stone + type | Shopify automated collections then build themselves |
| Every product uses the **`bracelet`** template | Despite the name, it is what his recent towers, spheres and necklaces use. Fixed in code, not per type, not a sheet column, not checked against the theme. ADR-0008 |
| Description = the shop's own published copy for that stone | It already exists — 100 of 103 agates share one body. Writing new copy would be inventing what the owner has already decided |
| Descriptions read from the **public storefront feed**, not the Admin API | No credentials, so it is testable from any laptop and identical on the dev store. The Admin API sees drafts but could only ever be verified by the owner |
| Read **live** every run, never cached or committed | the owner's edits take effect on the next run. Costs ~11 requests and a few seconds |
| Description match is **exact**; aliases are hand-written | The store has `Azurite Malachite` and `Blue Aragonite` but no plain Azurite or Aragonite. Any looser rule confidently attaches the wrong mineral's chemistry |
| Aliases live apart from `stone-names.json` | That file feeds the title. Aliasing there would rename "Tiffany Fluorite Sphere" to "Fluorite Sphere" |
| Most-used body wins; a tie goes to the longest, and is reported | Frequency is evidence of what the owner settled on. Anything cleverer is us overruling him |
| No spec line in the description | None of his 2,550 products has one, and the title already carries a size. The trade: width and depth now appear nowhere for a carving |
| Report is a **data structure** | Console renders it now, the web page later |
| Every created product is made available to **all** of the store's sales channels, discovered fresh each run | Backfilling six ticks per product by hand is the largest manual step left. Channels are never listed in code so a new one needs no release. A run refuses outright if the two scopes are missing, in both preview and commit — the alternative is drafts nobody can reach and a run that claims success. ADR-0009 |
| Rejected photos reported only for SKUs **in the sheet** | The folder holds photos for 4,449 SKUs against a 144-row sheet; reporting all of them meant 1,020 red lines about pieces nobody asked about, which made a healthy run look broken |
| Node + TypeScript | Compile-time safety matters more than usual when you can't test against prod |

### Delivering new versions

Argued through separately; the implementation order is in `docs/delivery-plan.md`.

| Decision | Why |
|---|---|
| **Not a hosted web app, and not GitHub Pages** | Pages serves static files. This is a Node server holding a live Shopify write token and a Google refresh token, bound to `127.0.0.1` on purpose. GitHub is the *distribution channel*, not the host |
| **Not a `.app` bundle, not Electron** | Signing needs an Apple Developer account nobody has, and an unsigned bundle fails on his Mac as *"Ezoko is damaged"* — a dialog you cannot reproduce or talk him through. `start.command` fails gently and already works |
| **The repo goes public** | Every credential is entered at runtime and gitignored, so there is no secret to protect. Private would mean shipping a PAT to a laptop we don't control, which expires silently and leaks the code anyway |
| **Updates happen inside the running app** | A button, not a download. Nothing arrives via Finder, so Gatekeeper never appears after the first install |
| **Releases are prebuilt** — compiled JS plus `node_modules` | Updating becomes a file operation, not an installation. No npm, no registry, no `PATH` under a Finder-launched shell, no half-finished install. The only failure left is "the download didn't finish", which is detectable and recoverable |
| **State lives outside the app folder** | `~/Library/Application Support/Ezoko/`. Replacing code must not destroy credentials. It also makes "delete it and unzip again" a safe instruction |
| **Automatic rollback on a failed boot** | We cannot test the machine that matters, so assume the untested thing is eventually wrong. 15 lines of bash against a day where his only tool won't open |
| **Updates are always manual** | Same rule as `--commit`: the dangerous action is the one you ask for. Him pressing the button is what makes *"it broke after I updated"* a sentence he can say |
| **One last manual cutover, beside the old install** | The old folder stays as the rollback. No import feature — `.env` is a dotfile Finder hides, and an importer is untestable code that runs exactly once on a machine we can't see |
| **User-editable data merges over shipped data** | Shipped base plus a `*.local.json` override in the state folder. Copying the file to his folder would freeze it at install time and silently stop every future fix from reaching him |
| **`googleapis` → `@googleapis/sheets` + `@googleapis/drive`** | 114MB of the 182MB tree was Google APIs the tool never calls. Done: 83MB installed, 23MB of production dependencies, a 4.5MB gzipped tarball |

### Reversed by real data

Decisions made from reasoning and disproved by looking. Each correction is
load-bearing:

- *"Always use HEIGHT in the title"* → spheres record only a width, in mm, and
  would have had no size at all. Now falls back height → width → depth.
- *"WIDTH is in cm"* → it is millimetres. Assuming cm would publish a 37 mm
  sphere as 37 cm.
- *"The shop's primary locale is Hungarian, so we must write Hungarian"* →
  backwards. English is what the owner authors; Hungarian is Translate & Adapt
  output, and it proves it by leaving "Copper carbonate hydroxide" and
  "Democratic Republic of the Congo" in English mid-Hungarian-sentence while
  translating Namibia and Australia. The handles are English too. The unprefixed
  URL is just the Hungarian default market.
- *"Prefer the description template the owner showed us"* → for Agate that would
  discard the body used on 100 of 103 products in favour of one used on 1.
  Frequency beats a single example.
- *"It's slow because the owner's laptop is weak"* → the whole run spends 3.4
  seconds on CPU. It was 267 sequential Drive requests.

The lesson generalises: **look at the data before writing rules about it.**

---

## What the sheet actually contains

**The sheet we developed against is a sample — `[TEST] Névtelen táblázat`, 144
rows — and it will grow.** So the counts below are a snapshot and are not worth
keeping current; the *shapes* are the point, because each one is a rule in the
code that has to keep working as rows are added. Treat a number here as "this
happens" rather than "this happens N times".

Headers are bilingual and untidy (trailing spaces, `LENGHT` misspelled), so
match on a trimmed lowercase prefix — never by position.

| Shape in the data | Handling |
|---|---|
| `"?"` in `PRICE`, `STONE Name` or `PRODUCT name` | Placeholder for "not decided". Row is **skipped**, not failed |
| `"?"` beside other text: `"BRONZE ?"`, in `STONE Name` or `PRODUCT name` | A half-made decision, not a placeholder. **Invalid** (`NEEDS FIXING` in the sheet) — flagged even before the price is set, never created |
| Dimensions as ranges: `"5-6 cm"`, `"2,5-3,5 cm"` | Both ends kept; title uses the upper bound |
| `"17 cm (box)"` | Note stripped for parsing, kept for display |
| Range SKUs: `CA-738-A1-A11` | **Refused** — one row covering 11 pieces with one price. The owner must split them |
| The same SKU on two rows | Both refused — creating either is a coin flip |
| Weight missing | Warning only, still created — but the title then has no weight, so the title is inconsistent with the owner's requested format until he fills it in |
| Stone names mixed HU/EN, mixed case | `data/stone-names.json`; unknowns pass through and warn |
| A stone the shop has never described | Created with an empty body and a warning |

Product types seen so far: `CARVING`, `SPHERE`, `CRYSTAL`, `TUMBLE STONE`,
`SMALL FIGURES`, `TOWER`, `HEART`, `PENDANT`. New ones need no code change.

Photo filenames are clean and consistent where they matter: `SP-190-B_01.jpg`.
The wider folder is not — bare trailing underscores, missing `_NN`, videos, and
the same filename in several folders all appear, which is why rejections are
reported only for SKUs the sheet actually asks about.

---

## Open questions

Questions the tool cannot answer for itself — about the operator's data,
workflow and intentions — live in `NOTES.local.md`, which is not committed.

What does *not* belong there, or here: which stones lack copy, which have
competing descriptions, which photo files are badly named. All of that is in the
run report, per run, and always current. Writing today's answers into a document
just creates something to go stale.

---

## Working agreements

- **Don't write code ahead of the evidence.** Read the real data first. Every
  bug so far came from assuming a shape instead of looking at one.
- **Small verified steps.** Build one piece, run it, look at the output, then
  continue. Don't stack unverified layers.
- **Introspect, don't guess.** `src/scripts/introspect.ts` beats the Shopify
  docs for input objects; the docs were incomplete or wrong three times.
- **Errors name the fix**, not just the failure — the eventual reader is
  non-technical and remote. Compare: *"SHOPIFY_ACCESS_TOKEN holds the API secret
  key (shpss_), not the access token (shpat_)"*.
- Keep `src/domain/` pure. It's the part testable without credentials, and it's
  where the expensive mistakes live.

---

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `manaunl/ezoko-product-pipeline`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
