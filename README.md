# Ezoko Product Pipeline

Creates draft Shopify products from a Google Sheet and photos in Google Drive.

One spreadsheet row plus its SKU-named photos becomes one draft product — title,
description, price, weight, inventory, tags and images — which a human then
reviews and publishes in the Shopify admin.

Built for a dealer in individual mineral and crystal pieces. Every SKU is a
unique physical stone, so every product has exactly one variant.

---

## Setup

```bash
npm install
npm start          # then open http://127.0.0.1:4517/setup.html
```

**The setup page is the easy path** — it carries the instructions below, has
fields for every credential, a **Sign in with Google** button, and a **Test the
connection** button that tells you which of Shopify, the spreadsheet, the photo
folder and the shop's own descriptions are actually reachable. It writes `.env`
for you, with `600` permissions, and never displays a saved secret back to the
screen.

Paste the spreadsheet and folder **web addresses** straight from the browser;
the page extracts the ids.

The rest of this section is the same information, for setting it up by hand.

### 1. Install by hand

```bash
npm install
mkdir -p ~/Library/Application\ Support/Ezoko
cp .env.example ~/Library/Application\ Support/Ezoko/.env
chmod 600 ~/Library/Application\ Support/Ezoko/.env
```

**Settings do not live in this folder.** See *Where things are stored* below —
and `npx tsx src/scripts/where.ts` prints the paths on any machine.

### 2. Google

You need a Google Cloud project with an OAuth client. It should belong to
**whoever owns the spreadsheet**, so the credentials outlive whoever built this.

1. [console.cloud.google.com](https://console.cloud.google.com) → **New Project**
2. *APIs & Services → Library* → enable **Google Sheets API** and **Google Drive API**
3. *OAuth consent screen* (newer consoles: **Google Auth Platform → Branding**) →
   **External** → fill in the app name and contact email
4. *Audience → Test users* → add the Google account that owns the sheet
5. *Credentials → Create credentials → OAuth client ID → **Desktop app***
6. Put the client ID and secret in `.env`

Then sign in:

```bash
npm run login
```

> **The sign-in expires every 7 days.** Drive and Sheets are restricted scopes,
> so an unverified app's refresh tokens are short-lived. When it expires, run
> `npm run login` again. This was a deliberate trade-off — the alternative was a
> service account, which we chose against.

### 3. Shopify

Since January 2026 Shopify no longer issues permanent `shpat_` tokens for new
apps. Apps are created in the **Dev Dashboard** and exchange a client ID and
secret for a 24-hour token, which this tool refreshes automatically.

1. [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard) → create an app
2. Configure access scopes on the app version and **release** it:
   `read_products`, `write_products`, `read_inventory`, `write_inventory`,
   `read_locations`
3. App → **Home** → **Install app** → choose the store
4. Copy the **Client ID** and **Client secret** into `.env`

> **The app and the store must be in the same Shopify organization.** The client
> credentials grant does not work across organizations. If the store isn't listed
> under *Dev stores* in the dashboard, it's in a different org.

Stores with an app created *before* January 2026 still have a permanent token.
Set `SHOPIFY_ACCESS_TOKEN=shpat_...` and it will be used instead.

### 4. Point it at the data

In `.env`:

- `GOOGLE_SHEET_ID` — from the sheet URL, `/spreadsheets/d/THIS_PART/edit`
- `GOOGLE_SHEET_TAB` — the tab name inside the file
- `GOOGLE_DRIVE_FOLDER_ID` — from the folder URL, `/folders/THIS_PART`
- `EZOKO_STOREFRONT_URL` — the shop, **in English**: `https://ezoko.shop/en`

> **The `/en` is load-bearing.** Descriptions are copied from the products
> already published for that stone, read from the shop's public
> `/products.json`. Without the language prefix that feed serves the Hungarian
> pages, whose headings say `Szerpentin` rather than `Serpentine`, so every
> lookup misses. The tool detects this and refuses to run rather than creating
> products with empty descriptions.

### 5. Check it works

```bash
npx tsx src/scripts/check-shopify.ts
npx tsx src/scripts/read-sheet.ts
npx tsx src/scripts/read-drive.ts
```

---

## Running it — the web page

```bash
npm start        # then open http://127.0.0.1:4517
```

Or double-click **`start.command`**, which starts the server and opens the
browser. Nobody needs to see a terminal.

It works in either layout: a source checkout like this one (after `npm install`,
which it will tell you to run if you haven't), or an installed copy unpacked
from the release zip, which has a `versions/` folder and updates itself.

The page has two buttons. **Preview** shows what would happen and writes nothing
anywhere. **Upload to Shopify** creates the products, after a confirmation, and
the **Limit** box caps how many — that's the control for a cautious first run.

The run happens in the background and its progress is written to
`current.json` in the state directory's `runs/` folder, which the page polls. **Closing the tab does not stop the
run**, and reopening the page picks it back up. A second run cannot start while
one is going: the obvious way to double-create is somebody hitting refresh on a
page that looks stuck. If the process dies mid-run, its heartbeat goes stale and
the page says so instead of showing a progress bar forever.

The server binds to `127.0.0.1` only, never `0.0.0.0` — it holds a live Shopify
write token and has no business being reachable from the network.

## Running it — the command line

```bash
npx tsx src/scripts/run.ts                    # preview — writes nothing
npx tsx src/scripts/run.ts --commit           # create everything that is ready
npx tsx src/scripts/run.ts --commit --limit 3 # create at most 3
```

**Preview is the default.** `--commit` is required to write anything, because
the dangerous action should be the one you have to ask for.

### What gets written back to the sheet

A **commit** run adds four columns (creating them if they don't exist) and fills
them in. A **preview** writes nothing.

Each product's row is written **as soon as that product is created**, not at the
end of the run, so a process that dies halfway still leaves the sheet saying
what it did.

| Column | Contents |
|---|---|
| `Shopify Status` | `CREATED` · `PARTIAL` · `EXISTS` · `FAILED` · `NEEDS FIXING` · `NOT READY` |
| `Shopify Product` | Link straight to the product in the Shopify admin |
| `Uploaded At` | Timestamp, only for rows this tool actually created |
| `Notes` | What needs fixing, photo counts, warnings |

**Rows that are simply unfinished are left blank.** Only rows that are in
Shopify or that need a person get a status — on the real sheet that's 16 rows
out of 144, rather than 128 rows all saying "NOT READY". A column that says
something on every row says nothing, and teaches people to skip past it. A row
that still carries a note from an earlier run is cleared once the problem is
gone, so nothing stale lingers.

The tool writes **only** to those four columns. `PHOTO Status` belongs to the
photographer and `Update in Shopify Archy` to the owner; neither is ever touched.

Rows are matched by SKU in a **fresh read taken at write time**, never by a row
number remembered from the start of the run — a run takes minutes, and sorting
or inserting rows midway would otherwise put one stone's result on another
stone's row.

A row already recording a product in Shopify is **never downgraded**. If a
product was created last week and its photos have since been moved out of the
Drive folder, the next run leaves the row alone instead of relabelling it
"not ready" and destroying the only record that the product exists.

Every run writes a timestamped report to the `runs/` folder **inside the state
directory**, updated after each product. If something goes wrong on someone
else's machine, that file is the whole support story — and
`npx tsx src/scripts/where.ts` tells them where it is.

### Where things are stored

Settings, the Google sign-in and the run reports live **outside this folder**:

```
~/Library/Application Support/Ezoko/
  .env                 credentials and settings, 600, written by the setup page
  google-token.json    the cached Google refresh token
  runs/                one JSON report per run, plus current.json
```

They are separate from the code because an update replaces the code, and
replacing the code must not take the credentials with it. Everything here
survives an update, a reinstall, and deleting the app folder entirely.

`EZOKO_STATE_DIR` overrides the location — how a second checkout, or a test,
stays out of the way of a real installation. It has to be a real environment
variable, not a line in `.env`, since `.env` lives inside the directory it would
be choosing.

The first run after upgrading from the old layout **copies** an `.env` and
`.google-token.json` found beside the code into the new directory and says so.
It copies rather than moves, and never overwrites: the old folder stays a
working installation, which is what makes it the fallback.

### First run on a real store

1. `run.ts` with no flags — read every line of the output
2. `run.ts --commit --limit 3` — check those three by hand in the Shopify admin
3. `run.ts --commit` for the rest

### Other tools

```bash
npx tsx src/scripts/preview.ts --all        # validate every row, ignoring photos
npx tsx src/scripts/inspect.ts stoneName    # distinct values in a column
npx tsx src/scripts/create-one.ts SP-190-B  # one product, verbose, step by step
npx tsx src/scripts/list-products.ts        # what is actually in the store
npx tsx src/scripts/introspect.ts <Type>    # ask the store's own GraphQL schema
npx tsx src/scripts/where.ts                # which files is it actually using?
npx tsx src/scripts/check-google.ts         # sheet, Drive and a real photo download
npm run build                               # the release tarball and installer zip
npm run smoke                               # unpack it and start it, as the owner's Mac will
npm run test:launcher                       # start.command, including a bad update
npm run test:update                         # updating, against a fake GitHub on localhost
npm test                                    # 171 tests, no credentials needed
```

---

## How it works

```
Google Sheet ──┐
Drive photos ──┼─→ match by SKU ─→ validate ─→ create in Shopify ─→ report
ezoko.shop/en ─┘
```

1. **Read** the sheet. Columns are found by header name, never by position.
2. **Read** the Drive folder, recursively — photos live in subfolders by type.
3. **Read** the shop's published descriptions, so each product can inherit the
   copy the owner already wrote for that stone.
4. **Match** photos to rows. `SP-190-B_01.jpg` splits on the *last* underscore:
   SKU `SP-190-B`, position `1`. Splitting on the delimiter gives an exact match,
   which is what stops `CA-738-A1` from stealing `CA-738-A11`'s photos.
5. **Validate.** Every row becomes one of three outcomes:
   - **ready** — will be created
   - **skipped** — not finished yet (no photos, no price, `?` in a cell). Normal.
   - **invalid** — something a human must fix. Reported, never guessed at.
6. **Create**, for each ready row: check the SKU doesn't already exist → upload
   photos → `productCreate` as **draft** → set SKU/price/weight on the default
   variant → set inventory to 1 → wait for image processing to finish.

### Descriptions

The body of every product is the owner's own published copy for that stone,
inherited verbatim. He writes one description per stone and reuses it — 100 of
his 103 published agates carry the same text — so the description for a new
piece already exists and does not need writing.

| | |
|---|---|
| Where from | `ezoko.shop/en/products.json`, the shop's public feed. No credentials, so it works from any laptop and is unaffected by which store `.env` points at |
| Keyed on | the `<h3>` heading at the top of each body, not the product title — titles carry per-piece noise like `- 45cm/13mm` |
| Matching | **exact**, after folding case and accents and dropping a trailing parenthetical, so `Bowenite (New Jade)` matches `Bowenite` |
| Choosing | the body used on the most products wins. A tie goes to the longest, and the report says that it did |
| Excluded | bodies carrying another piece's data — one Rose Quartz body opens `Dimension: 49cm` |
| Cleaned | reduced to `p/strong/em/br/ul/ol/li` and the like, every attribute stripped, leading heading removed |
| Language | **English**, which is the side the owner writes. Hungarian is Translate & Adapt output; he presses the translate button after these are created |

**Read on every run, never cached.** If any page of the feed fails the run
aborts before creating anything: a half-read catalogue would drop stones
silently, and their products would get an empty body that looks exactly like a
stone he simply hasn't written about yet.

**A stone with no published copy is still created** — full photos, price,
title, weight, and an empty description plus a warning naming the stone. Every
run reports how many of the stones in the sheet have copy, so you can see the
gap closing as the owner writes more; there is no list to maintain here.

Nothing is ever guessed from a shared word. The shop has `Azurite Malachite` and
`Blue Aragonite`, which are different minerals from Azurite and Aragonite, so a
prefix or substring rule would confidently attach the wrong mineral's chemistry.
A stone matches its own name or it matches nothing.

`data/description-aliases.json` lets a stone borrow another's copy on purpose —
`Tiffany Fluorite` → `Fluorite`. It is separate from `data/stone-names.json`
because that file feeds the **title**, and aliasing there would rename the
product to "Fluorite Sphere".

**A description is inherited once, at creation, and never revisited.** Editing
the copy on ezoko.shop changes what future products inherit; it does not rewrite
products this tool has already created. There is no update path, deliberately.

Only **published** products are visible in the feed, so copy written on a draft
is not inherited until that product goes live.

### Two rules the design rests on

**Shopify is the source of truth, not the sheet.** Before creating anything we
ask Shopify whether a variant with that SKU exists. Creating a product and
updating the sheet are not one transaction — a crash between them would leave
the row saying "not uploaded", and a sheet-driven tool would then cheerfully
create a duplicate. Because of this, **any run can be repeated safely**.

**Nothing is ever deleted.** There is no delete mutation anywhere in this
codebase. Combined with everything being created as a draft, the worst case is a
half-built product that nobody can see — never a lost one. That guarantee is
what makes it safe to point at a live store.

### Layout

| Path | What lives there |
|---|---|
| `tools/` | Building and smoke-testing the release tarball. Not shipped. |
| `src/paths.ts` | Where state lives. Every persistent path is resolved here and nowhere else. |
| `src/version.ts` | Which version is running, from `package.json`. In every run report. |
| `src/bootstrap.ts` | What each entry point imports first: brings forward old state, loads `.env`. |
| `src/domain/` | Pure logic — no network, no clock. Parsing, titles, validation, description selection. All the tests point here. |
| `src/google/` | Sheets, Drive, OAuth |
| `src/storefront/` | Reading the shop's public product feed |
| `src/shopify/` | Admin GraphQL client, products, media |
| `src/run/` | The runner and the report data structure |
| `src/scripts/` | Command-line entry points |
| `data/stone-names.json` | Hungarian → English stone names, used for titles and tags |
| `data/description-aliases.json` | Stones that deliberately borrow another stone's description |

The **report is a data structure**, not print statements. The console renders it
today; the planned local web page will render the same objects.

---

## Things that will bite you

**The API version is pinned** in `src/shopify/client.ts` (`2026-07`). Shopify
ships a new version quarterly and retires each after about a year. Unattended,
this tool works perfectly for a year and then breaks on an ordinary Tuesday.

**Image attachment is asynchronous.** The mutation returns success and Shopify
can still fail to process the image afterwards. `waitForMedia` polls until each
one is genuinely READY or FAILED — without it, products report "created fine"
and show no pictures.

**Inventory mutations need an idempotency key** (`@idempotent`) since API
`2026-04`, and `changeFromQuantity` must match the actual current quantity. We
read the quantity first and no-op when it already matches.

**Units come from the cell, not the header.** The `WIDTH` header implies cm but
the data is `"37 mm"`. Trusting the header would publish a 37 mm sphere as a
37 cm one.

**When the schema surprises you, introspect rather than read the docs.** The
docs are incomplete for input objects; `src/scripts/introspect.ts` asks the store
directly and has been right every time the docs weren't.

**The storefront feed is a locale, not a shop.** `ezoko.shop/products.json`
returns Hungarian and looks entirely healthy doing it — 276 stones, no errors.
It is the wrong 276. `EZOKO_STOREFRONT_URL` must carry `/en`, and the tool
counts how many stone names it recognises to be sure (47 of 54 in English, 3 in
Hungarian) rather than trusting the URL.

**Drive is slow because of round trips, not size.** Listing 13,049 files one
folder at a time took 267 requests and 104 seconds, which got blamed on a slow
laptop — but the whole run uses about three seconds of CPU. Naming 25 parents
per query and fetching levels concurrently does the same work in 37 requests and
8.7 seconds. If this ever feels slow again, count the requests before suspecting
the machine.
