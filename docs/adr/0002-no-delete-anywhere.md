# No delete anywhere in the codebase

There is no delete mutation against Shopify, the sheet, or Drive anywhere in
this codebase — not behind a flag, not as an admin escape hatch. The tool was
built and tested without access to the catalogue it eventually runs against,
so a delete bug could never be caught before it destroyed real data; making it
structurally impossible is safer than trusting careful use. The worst case of
any bug here is a draft product that needs tidying, never a lost one.
