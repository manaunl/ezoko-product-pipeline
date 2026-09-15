# Descriptions are inherited from the live storefront, not generated

The owner writes one description per stone and reuses it across every piece —
100 of his 103 published agates share one body. Rather than have the tool (or
an LLM) invent new copy, `describeStone` reads the public
`ezoko.shop/en/products.json` feed and copies the owner's own most-used body
for that stone verbatim, matched on the product's heading. LLM-written
descriptions were considered and rejected: they would be inventing what the
owner has already decided, and a stone he hasn't described yet correctly gets
an empty body and a warning instead of a confident guess.

The feed is read live on every run, never cached or committed, so the owner's
edits in the shop take effect on the very next run — the cost is a fixed ~11
requests and a few seconds. The Admin API was considered instead (it sees
drafts too) but rejected: it needs credentials nobody except the owner has,
so the selection rules could only ever be verified by him, not by whoever is
building this from a laptop with no store access.
