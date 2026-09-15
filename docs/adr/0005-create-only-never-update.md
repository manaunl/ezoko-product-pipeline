# The tool only ever creates, never updates

A product already in Shopify keeps whatever title, tags, or description it
was created with — nothing here has a product-update capability, even for a
title-format change or a newly-written description. Deliberate: an update
path would need its own trust story (what happens when the sheet and Shopify
have both changed since creation?) that hasn't been earned, and the 70
products created before descriptions existed are expected to keep empty
bodies rather than be silently patched. Renaming or backfilling existing
products is out of scope until that trust story is designed on purpose.
