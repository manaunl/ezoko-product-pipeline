# Delivering new versions

How a change you make on your laptop reaches the Mac you have never touched.

The reasoning behind each choice is in `CLAUDE.md` under *Delivering new
versions*. This file is the order of work.

---

## The problem today

The owner downloads a ZIP from GitHub. `.gitignore` excludes `.env`,
`.google-token.json` and `runs/`, so the archive arrives with no state in it.
Per update he must:

1. Download, unzip, right-click → **Open** past Gatekeeper
2. Open a terminal and `npm install` — `start.command` only runs `npm start`,
   which is `tsx src/server/main.ts`, and with no `node_modules` that dies
   before printing anything a person could act on. It also pulled 182MB, of
   which 114MB was Google APIs the tool never calls
3. Re-enter every credential on the setup page
4. Re-sign into Google

Steps 2–4 are why versions don't get shipped. The cost of delivery is what
decides how often you fix things.

---

## The shape

```
~/Ezoko/                          ← unzipped once, ever
  start.command                   ← the launcher. Deliberately dumb, rarely changes
  versions/
    1.0.0/                        ← compiled JS + pruned node_modules
    1.1.0/
  current → versions/1.1.0        ← symlink; swapping it is one atomic rename

~/Library/Application Support/Ezoko/
  .env
  google-token.json
  runs/
  stone-names.local.json          ← his overrides, merged over the shipped file
  description-aliases.local.json
```

**The launcher** resolves `current`, runs it, and relaunches on a specific exit
code (75). That is the whole restart mechanism: the update handler downloads,
unpacks, repoints the symlink and exits 75; the launcher starts the new code;
the open browser tab polls until the server answers and reloads itself.

**Rollback** is in the launcher too. It records the version it is about to try;
if that process exits non-zero within ~10s of a fresh swap, it repoints
`current` back, relaunches the previous version, and leaves a marker the page
turns into *"update to 1.4.0 failed — running 1.3.0"*.

The last three versions stay on disk. Nothing is ever deleted — same rule as
the rest of the codebase.

---

## Order of work

### v1.0 — plumbing only, hand-delivered once

Behaviourally identical to what he runs today: same two buttons, same
behaviour. If the cutover goes wrong, the diagnosis is small. If it goes right,
he notices nothing except that it opened.

1. ~~**State relocation.**~~ **Done.** `src/paths.ts` answers "where does state
   live" and nothing else builds a persistent path; `src/bootstrap.ts` is what
   every entry point imports first, in place of `dotenv/config` — which resolved
   `.env` against the working directory, the one thing a Finder-launched app
   cannot be trusted about. Default `~/Library/Application Support/Ezoko/`,
   `EZOKO_STATE_DIR` overrides. Old state beside the code is copied forward
   once, never moved and never overwriting. 12 tests; verified end to end on the
   real sheet, the 13,049-file Drive folder and the dev store, through both the
   CLI and the web page.
2. ~~**Narrow the Google dependency.**~~ **Done.** `googleapis` →
   `@googleapis/sheets` + `@googleapis/drive` + `google-auth-library`.
   `node_modules` 182M → 83M, the Google surface 114M → 5.4M, production
   dependencies 23M, and the gzipped tarball of them **4.5M**. One
   `google-auth-library` on disk, no duplicate copies.

   Verified live rather than by typecheck, because these are network clients:
   OAuth, 144 sheet rows, the 13,049-file Drive walk in 8.3s (no regression on
   the 8.7s figure), a photo downloaded and checked for a real image header, a
   preview byte-identical to the one before the swap, a sheet write-back of 14
   rows, and one product created end to end on the dev store — Drive download →
   staged upload → `productCreate` → image processing.

   `src/scripts/check-google.ts` came out of this: a preview never downloads a
   photo, so the download path could have broken silently and only surfaced
   with a commit run half finished.
3. ~~**Build step.**~~ **Done.** `npm run build` → `build/ezoko-<version>.tgz`
   plus a `.sha256`. **4.0M packed, 19.3M unpacked.** `tsc` emits to a staging
   directory; the web page and `data/` are copied in (tsc carries neither); a
   trimmed `package.json` with production dependencies only and
   `start: node dist/server/main.js`; then `npm ci --omit=dev --ignore-scripts`.
   `tsx`, `typescript` and `vitest` are gone from the shipped tree, so the
   devDependency-in-the-run-path problem is gone with them.

   `npm run smoke` unpacks the tarball somewhere clean, points it at an empty
   state directory and starts it the way the owner's Mac will — plain `node`, no
   repository around it. 14 checks, all of them things a compiler cannot see:
   no toolchain shipped, the web page copied, the data tables still reachable at
   their relative path, an install with no credentials starting rather than
   crashing, the state directory honoured, and nothing written into the app
   folder. It exits non-zero, so a release can be gated on it.

   `--ignore-scripts` is deliberate — no dependency here needs a postinstall,
   and the smoke test is what proves that rather than assuming it.

   Verified beyond booting: the compiled artifact ran `check-google.js` against
   live Google and a full preview against the real sheet, Drive folder,
   storefront and dev store in 30.7s, with the same results as the source tree.

   `src/version.ts` came out of this — read from the `package.json` one
   directory up, which is true in a checkout and in a release alike, so nothing
   has to stamp a version anywhere. It is recorded in every run report, which is
   what makes *"send me the newest file in the runs folder"* answer "which
   version are you on" without asking him.
4. ~~**Launcher + rollback**~~ **Done.** `start.command` plus the `versions/` +
   `current` layout, and `npm run build` now also produces
   `build/Ezoko-<version>.zip` — the launcher and one version, in the layout the
   launcher expects. No `current` symlink in the zip: archives carry those
   unreliably, and the launcher creates one anyway by picking the newest version
   folder, which also self-heals a deleted link.

   Beyond the plan above it handles two things real use will hit: **Node missing
   from a Finder-launched PATH** (it looks in the Homebrew and `/usr/local`
   locations before giving up, and the message says to install Node from
   nodejs.org rather than naming a variable), and **the app double-clicked
   twice** — the server now answers `EADDRINUSE` with "already running" and exit
   code 3, and the launcher opens the browser and stops quietly instead of
   reporting a crash.

   `npm run test:launcher` runs 16 checks against a real fake installation:
   self-heal, newest-version selection, a deliberately broken release rolling
   back, the marker cleared, the note written, the broken version kept on disk,
   exit 75 restarting exactly once, the double-click case, and nothing written
   into the app folder.

   **A third bug, found by the person using it rather than by a test:** making
   the launcher understand the installed layout quietly made it *stop*
   understanding a source checkout — no `versions` folder, so it refused with
   "this folder looks incomplete". That broke the only delivery route that
   existed at the time, and the suite did not notice because every scenario in
   it built an installed layout first. It now runs the real checkout too.

   **Two bugs the suite did catch, both silent:**

   - `mv -f new current`, where `current` is a symlink to a directory, makes
     `mv` **follow the link** and move the new link *inside* the version folder.
     The link never changed, so rollback printed "going back to 1.2.0" and then
     started the broken version again. `mv -fh` is the fix, and the whole
     mechanism was worthless without it.
   - The first version of the test killed the launcher with `SIGTERM`, which
     kills bash and orphans the `node` it started. The orphan kept the port, so
     later scenarios "passed" against a server from an earlier one. Each run now
     gets its own process group, and the test refuses to start if anything is
     already listening.
5. ~~**Update check and button.**~~ **Done.** The rules are pure and tested in
   `src/domain/updates.ts` (27 tests): version comparison that is numeric rather
   than alphabetic, prereleases and drafts never offered, a release missing its
   tarball or its checksum reported out loud rather than swallowed, and the
   checksum file refused unless it really is a hash.

   `src/update/install.ts` does the rest: download, verify sha256, unpack to a
   temporary folder, rename into `versions/<v>`, write the pending marker, move
   `current`, exit 75. Nothing is swapped until the unpack has finished, so a
   download that dies halfway leaves the installation untouched.

   The check runs in the background after the server is listening and **never
   throws** — no wifi, GitHub down, rate limited, all come back as a note beside
   an otherwise complete answer. Updating refuses while a run's heartbeat is
   live. Re-checks every six hours.

   An update takes minutes and ends by killing the process, so it cannot be one
   request: the page starts it and polls `GET /api/update`, which reports
   progress. A failure after the response has gone out is reported there rather
   than thrown into a request nobody is listening to.

6. ~~**Previous-version button.**~~ **Done.** Same restart path, no pending
   marker — stepping back deliberately should not put the launcher on probation.

   `npm run test:update` — 21 checks against a real installation, a real
   launcher and a real tarball, with **a fake GitHub served from localhost**, so
   it needs no network and no published release. It covers a corrupt download
   being refused with nothing unpacked, a good release installing and restarting
   into itself, a release that installs but will not start being undone by the
   launcher, and a deliberate step back.

   **What the test got wrong twice, which is worth remembering:** a restart
   takes well under a second, so "is something answering?" almost always catches
   the *old* server and passes against the version being replaced. And a rolled
   back update ends on the version it started from, so "the version changed" can
   never detect it — the rollback note is the only evidence.
7. ~~**Release pipeline.**~~ **Done.** `.github/workflows/release.yml` on a
   `v*` tag; `check.yml` on every push and pull request. Both on macOS runners,
   because the launcher uses `mv -fh` and `open` — BSD behaviour — and macOS is
   the only platform this runs on.

   The release job **refuses if the tag does not match `package.json`**: the
   updater names its download from the version, so the two have to agree or the
   release is unusable. It then runs typecheck, unit tests, build, smoke,
   launcher and update suites, and publishes only if every one passes. Nothing
   is built by hand, so there is nothing to forget.
8. ~~**Repo made public.**~~ **Done**, with the history squashed to a single
   commit first — the trim only covered the current file, and the old commits
   still carried it.

### Verified against the real thing

`v1.0.0` is published: tarball, checksum and installer zip. Downloaded from the
release, the published checksum matches the published tarball; the zip preserves
the executable bit on `start.command`; the launcher creates the `current` symlink
the zip deliberately omits; and `/api/update` reaches the real GitHub, finds
v1.0.0 and correctly reports being up to date with no error.

**What is still unproven:** pressing **Update now** against a real release. The
fake-GitHub suite covers the mechanism end to end, but the real API has only
been exercised for the *check*, not the install. Cutting a `v1.0.1` and pressing
the button is the last dry run before any of this reaches the operator's Mac.

### Verify before he sees any of it

All of this is testable on your own Mac:

- install v1.0 from the ZIP as if you were him
- cut v1.1, press the button, confirm it restarts into the new version
- ship a v1.2 that throws on boot, confirm the rollback fires and the page says so
- pull the network mid-download, confirm `current` never moves

### The cutover

Send one ZIP. He unzips it **beside** the old folder, opens setup, fills it in,
presses **Test the connection**, and deletes nothing. The old install is the
rollback — if anything is wrong he double-clicks the old `start.command` and is
exactly where he started.

Nothing he re-enters is unrecoverable: Shopify client ID and secret from
dev.shopify.com, Google client ID and secret from console.cloud.google.com,
sheet and folder ids out of browser URLs, and the Google sign-in is the button
he already presses every 7 days.

**Pre-flight:** have him confirm he can still see the Shopify client secret in
the dev dashboard *before* the cutover. If Shopify has stopped showing it he
needs to rotate it, and you want to know that while he still has a working
install.

### v1.1 — stone-name editor, delivered through the button

The first real thing the channel carries. Small enough that if the update
mechanism is broken, what he is missing is a convenience rather than his tool.

Shipped `data/stone-names.json` stays code-owned. `stone-names.local.json` in
the state folder holds only his additions and changes and wins on conflict, so
every base improvement still reaches him.

The page is **driven by the last run**, not a JSON editor: *"3 stones in your
sheet have no English name"*, each with a field prefilled with what the sheet
actually said. Every row is labelled *built-in* or *yours*, and a *yours* row
has **Reset to built-in** — otherwise a typo outlives the fix that corrected it,
with nothing on screen explaining why.

### v1.2 — alias editor

Same merge model. Two constraints that make a bad alias hard to express:

- **The target is a dropdown**, populated from the live `ezoko.shop/en`
  headings. Matching is exact, so a typed target that doesn't exist fails
  *silently* — empty body, one warning, a product that looks fine.
- **Show him the body.** Choosing `Tiffany Fluorite → Fluorite` renders the
  actual paragraph the product would inherit. That is the judgement `CLAUDE.md`
  says needs a human, and he is better at it than we are.

Preview already makes this safe to experiment with: set an alias, press
**Preview**, see what would happen, write nothing.

---

## What this does not solve

He can ignore the banner indefinitely. The pinned Shopify API version in
`src/shopify/client.ts` (`2026-07`) still retires on Shopify's schedule, about a
year out — this makes the fix *deliverable*, not automatic. The banner should
eventually escalate for that case (*"this version stops working in 3 weeks"*)
rather than nagging identically forever.

## Support

Every `runs/*.json` records the app version, so *"send me the newest file in the
runs folder"* also answers "which version are you on" — the first question of
every support conversation. `npx tsx src/scripts/where.ts` (or
`node dist/scripts/where.js` in a release) prints the version and every path it
is using, present or missing.
