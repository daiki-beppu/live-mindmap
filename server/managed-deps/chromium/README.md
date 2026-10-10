# Managed Chromium

Generate the bundled lock with npm 11.19.1:

```sh
test "$(npm --version)" = 11.19.1 && npm install --prefix server/managed-deps/chromium --package-lock-only --ignore-scripts
```

This package is deliberately outside the pnpm workspace. Runtime installation uses the discovered npm with the bundled lock.

Generation verified on 2026-10-10 with Node v26.9.0 and npm 11.19.1.
The generated package-lock.json SHA-256 is
`8980c46ec840d6b5e05388d4840ebbdad19c91025cc8c2afc306a23e6bc201d9`.
