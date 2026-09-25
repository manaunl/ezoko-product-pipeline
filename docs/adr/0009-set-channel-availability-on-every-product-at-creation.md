# Every created product is made available to all of the store's sales channels

Every product this tool creates in Shopify is made available to every sales
channel the store has, discovered fresh from the store each run rather than
listed anywhere in code or `.env`. This reverses a line `CLAUDE.md` used to
carry under *Deliberately out of scope for v1* ("sales-channel publication").
The reversal is narrow: that line existed for scope control while v1 shipped
the create path, not because the idea was wrong, and nothing else in the
safety story moves. Products are still created as **DRAFT** (ADR-0001), and a
draft is invisible on every channel regardless of its channel availability —
this changes what happens the moment a human later flips one to Active, not
what a customer can see today.

Verified against the live schema: `ProductCreateInput` has no publications
field (`descriptionHtml, handle, seo, productType, tags, templateSuffix,
giftCardTemplateSuffix, title, vendor, category, giftCard, collectionsToJoin,
combinedListingRole, metafields, productOptions, status, requiresSellingPlan,
claimOwnership` is the complete list), so this is necessarily a second
mutation, `publishablePublish(id, input: [PublicationInput!]!)`, called after
`productCreate` — and set **last**, after the photos have finished processing,
the variant carries its SKU/price/weight, and stock is set, so a channel is
never offered a half-built product.

Two new access scopes are needed, `read_publications` and
`write_publications`, that the app did not previously request. Verified live:
querying `publications` without the first returns *"Access denied for
publications field. Required access: `read_publications` access scope"* —
exactly what the run's preflight check recognises to tell a missing scope from
any other failure.

## The gate

A run asks for the store's publications before creating anything, alongside
the existing sheet/Drive/storefront preconditions. If the scope is missing, the
**whole run refuses**, in preview and commit alike, naming both scopes and the
release step. The alternative — creating products and warning afterwards —
was rejected: a hundred products that reach nobody, in a run that reports
"created" for every one of them, is exactly the silent failure this tool
exists to avoid. A run that never asked would be worse still, since nobody
would learn the scope was missing until they went looking for why nothing
ever showed up.

A channel that fails for one product, after the gate has already passed, is a
different situation: the product **exists**. It is reported `created` (or
`partial`, unchanged by the photo logic that already owns that distinction),
with a warning naming exactly the channels it missed. No new `ResultStatus`
value exists for this — `decideWrite` and the sheet write-back are untouched,
and the sheet keeps recording the product exactly as it records any other.

## Alternatives considered and rejected

**Shopify Flow**, a no-code automation Shopify offers for exactly this kind of
"do X whenever a product is created" rule. Rejected because it would move a
safety-relevant behaviour outside this codebase, into a workflow nobody
building this tool can see, test, or version alongside the code it depends
on — the same reason theme work and dimension metafields stay out of scope.

**Backfilling channel availability onto products already created.** Rejected
for the identical reason ADR-0005 gives for never updating a description: this
tool creates, never updates, with no exceptions. The seventy products already
on the test store, and every product created before this ships, stay without
channels permanently — exactly as they stay without a description if none
existed when they were made.

**Warning instead of refusing when the scope is missing.** Considered because
it is less disruptive to an existing install, but rejected: it produces the
exact silent-failure shape this decision exists to prevent, at the scale of a
whole run rather than one channel on one product. A missing scope is something
the owner can fix in five minutes in a dashboard; the run should say so and
stop, not create a hundred stranded drafts and mention it in passing.

## Consequence accepted deliberately

The first run after upgrading to a version carrying this feature refuses to
work until the two scopes are added and released, for every existing
install, exactly once. The alternative was a version that silently creates
products nobody can reach. The owner is told out of band, before the release
reaches him, rather than discovering it from the app refusing to run on a day
he planned to create products.

## Resolution: verified, with a dev-store scare in between

First pass on the dev store, with the scopes granted and released, looked like
a design failure: the run correctly discovered the store's 3 channels and
reported every created product as reaching all of them, but querying that same
product straight after — `resourcePublications`, `availablePublicationsCount`,
`unpublishedPublications` — showed it available to **zero**. Calling
`publishablePublish` again directly, per channel and combined, returned no
`userErrors` every time and changed nothing. Not a propagation delay — waited
and re-checked.

Confirmed against a real (non-dev) store: the same code makes a created
product genuinely available to its channels. The dev store's behaviour was a
platform limitation of dev stores specifically, not a flaw in setting channel
availability on a draft product. Recorded here rather than only in a commit
message, because the failure mode — a mutation that reports success while
silently doing nothing — is exactly the kind of thing a future reader debugging
"channels aren't showing up" on a dev store needs to find fast, and exactly the
kind of thing `CLAUDE.md`'s working agreement ("look at the data before writing
rules about it") is built to catch.

`CLAUDE.md` now carries this under *Working and verified against real data*.
