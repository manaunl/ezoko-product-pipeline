# Delivery is in-app updates over prebuilt releases, not a signed app or hosting

New versions must reach a non-technical, remote owner without a terminal
session and without anyone able to walk him through a failure live. Hosting it
(GitHub Pages or similar) was rejected: this is a Node server holding a live
Shopify write token and a Google refresh token, bound to `127.0.0.1` on
purpose, and Pages only serves static files. Packaging it as a signed `.app`
or Electron bundle was rejected too — signing needs an Apple Developer account
nobody on this project has, and an unsigned bundle fails as an
unreproducible *"Ezoko is damaged"* dialog.

Instead, GitHub Releases carry prebuilt tarballs (compiled JS + production
`node_modules`, no toolchain), and the running app checks, verifies the
sha256, and installs them itself behind an **Update now** button — so
updating is a file operation the app performs, never an `npm install` in a
terminal. The launcher repoints the `current` symlink and rolls back
automatically if a freshly installed version dies within 10 seconds of
starting, because the machine this runs on can never be tested directly.
