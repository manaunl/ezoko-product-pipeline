# Shopify, not the sheet, is the source of truth

A run both creates products and writes results back to the sheet, and those
two are not one transaction — the process can be interrupted between them, or
re-run days later after the owner has edited the sheet by hand. So before
creating anything, the tool looks the SKU up directly against Shopify
(`productVariants` by SKU) rather than trusting the sheet's own status
columns. That makes a run idempotent no matter how many times it is
interrupted or repeated: the sheet's `Shopify Status` column is a convenience
for the human, never a ledger the tool relies on.
