# Every product is created as a draft

Whoever builds this has no access to the production store it runs against, and
the person operating it is not technical and is not nearby, so bugs must be
caught by a human reviewing output, not by a customer. `productCreate` always
leaves the product in Shopify's `DRAFT` status; nothing in this codebase can
move it to Active. A human publishes.
