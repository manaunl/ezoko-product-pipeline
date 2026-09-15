# State lives outside the app folder

`.env`, `google-token.json`, and `runs/` used to sit next to `src/`, which
broke the moment an update needed to replace the code: replacing the code
would take the credentials with it. All of it now resolves through
`src/paths.ts` to `~/Library/Application Support/Ezoko/`, a directory an
update never touches, overridable only via `EZOKO_STATE_DIR`. This is also
what makes "delete the app folder and unzip again" a safe instruction to give
a remote, non-technical operator — the one thing that must survive that is
never in the folder being deleted.
