# Every product uses the `bracelet` template

Every product is created with the theme template `bracelet`, whatever its
type. The name is misleading, but the evidence is clear: a sample of 75
published products from `ezoko.shop` found 43 on `bracelet`, 39 of them
published in 2026 and including towers, spheres and a necklace. The rest were
mostly older products on the default template, plus two books on
`for-books-no-dimension`. We rejected choosing a template per product type,
and rejected a template column in the sheet. Nothing showed that the few
carvings from 2026 still on the default template were a deliberate exception,
and a sheet column is one more thing the owner could mistype.

The value is fixed in code, not offered as a setting. It is the owner's store
convention, like the title format, and changing it takes a one-line release.
The tool does not check that the theme actually has the template. That check
would need the `read_themes` permission on his store, and if the template is
ever renamed, the product page shows it, not a failed run. Products created
before this change keep the default template, because the tool never updates
(ADR-0005).

Nothing has proven that Shopify accepts this value until the first real
`--commit --limit 1` against the owner's store. Our dev store's theme has no
`bracelet` template.
