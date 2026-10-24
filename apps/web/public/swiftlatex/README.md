# SwiftLaTeX WebAssembly engines (vendored)

Prebuilt `swiftlatexpdftex` and `swiftlatexxetex` (pdfTeX / XeTeX compiled to WebAssembly) from the
SwiftLaTeX project, release `v20022022`:
https://github.com/SwiftLaTeX/SwiftLaTeX/releases/tag/v20022022

License: GNU AGPL v3 (SwiftLaTeX, copyright SwiftLab). HiveTeX is AGPL-3.0-or-later, so this is compatible.

SHA-256:
019ccf66c2981cc3a371ca8983f8a0f191952e28b5df3c0b41c2e3ed80f9be65 *swiftlatexpdftex.js
154d08cbb298191cefe1bdd9e47a909d60fc7a96fce5f2319bfc6878c5b61cf1 *swiftlatexpdftex.wasm
238181805c9d8ffbb231d2ba09323145d485cf85847fc34b8c2168e7b886adb3 *swiftlatexxetex.js
dd7f4f8fe8b07b64c058683edd0298afa1998cfae461cab71bd2571e27ffb673 *swiftlatexxetex.wasm
80d0620536e0a13afaf7ddcf0ccc00c758a6735313a4e962b3a5c8779058ac40 *swiftlatexdvipdfm.js
1bf8c0d424c87c1548d9d22d29251aa3308506fa6acc29d4f08dcd77ccc1f9b1 *swiftlatexdvipdfm.wasm

XeTeX emits XDV; the matching Dvipdfmx worker converts it to PDF. All six files come from the same release archive
(`20-02-2022.zip`, SHA-256 `cf5535ffe9cdf42f7c4522e96bba4d33db10c418a7ceb24e5d80504be7de7150`).
The build creates versioned workers with the small resource lookup adapter in `scripts/tex-resource-adapter.js`;
these vendored originals remain unchanged. See `docs/compilation.md` for the pinned package distribution.
