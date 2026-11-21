# Base and Arbitrum deployment fingerprints

These values were captured by GitHub Actions using public chain RPC endpoints at the pinned block numbers shown below. They identify the deployed proxies and bytecode observed at those blocks. They do **not** prove that the implementation bytecode matches a particular verified source commit.

## Aave V3

| Field | Base | Arbitrum |
|---|---|---|
| Chain ID | 8453 | 42161 |
| Fingerprint block | 60,154,300 | 526,087,130 |
| Addresses Provider | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` |
| Pool proxy | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Pool implementation | `0xf248Dd0AdB01e78043e8a423b8504c8129F11918` | `0xa6E7d235A5B2fc7811d10669bbe20fA14B658A1e` |
| Proxy runtime code hash | `0xffcb26fbebbe09d9b0d8baef76a1fa218989be6c279b7acf9865d8fb6e0718ce` | `0xf168c2e9e4d04292c7d5d526a9a917175a44369ab63a2f9997537acf0ffaaf2e` |
| Implementation runtime code hash | `0xa4d2855cd851dc69a5bef2dfc99504ab6b101f29c5353a4b043eece444780771` | `0x1f369913d01c3141dff9de25fe35d096c468b1d43d7996b3a1ba7fa0d759a0ec` |
| Pool revision getter | `12` | `12` |
| eMode profile | Aave Origin collateral bitmap | Aave Origin collateral bitmap |
| Flash-loan premium | 5 bps | 5 bps |
| Threshold getters | Not exposed on Pool proxy | Not exposed on Pool proxy |

The Pool proxy addresses resolve from the configured official Aave Addresses Providers. The implementation slot is the EIP-1967 implementation slot. The live eMode probe confirms that the separate `getEModeCategoryCollateralBitmap` getter is available even though `getEModeCategoryData` retains its legacy-compatible return tuple. The calculator therefore uses the category's collateral bitmap for eMode liquidation bonus selection and normal reserve oracle prices for pair sizing.

The close-factor and dust constants are internal to Aave's linked LiquidationLogic library and are not exposed by the Pool proxy. For the USD base-currency profile (zero base-currency address, 1e8 base unit), the adapter uses the source-defined values: `MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 2000e8` and `MIN_LEFTOVER_BASE = 1000e8`. Non-USD base-currency profiles fail closed.

## Morpho Blue

| Field | Base | Arbitrum |
|---|---|---|
| Chain ID | 8453 | 42161 |
| Fingerprint block | 60,154,300 | 526,087,130 |
| Singleton | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | `0x6c247b1F6182318877311737BaC0844bAa518F5e` |
| Runtime code hash | `0xaa76348c0b91e5dfcece228ef6847b0c5081656d2def05c5617bcab659f0b819` | `0xd2bb64e51bc71ff5ce00ae89eab643e65fda6fc59f4ab8c367241c4bedf8acf5` |

## What this establishes — and what it does not

Established:
- the configured Aave providers resolve to the expected Pool proxies;
- both Pool proxies have non-empty EIP-1967 implementation addresses and runtime code;
- both Aave Pool revisions returned `12` at the fingerprint blocks;
- both Aave deployments expose the Origin collateral-bitmap eMode getter and report a 5 bps flash-loan premium;
- both Morpho Blue singleton addresses have runtime code.

Not established:
- source verification or bytecode equivalence to the current Aave Origin / Morpho source repositories;
- that every reserve's configuration and every eMode category is handled correctly;
- exact reserve-index rounding, scaled-token consumption and actual liquidation return amounts on a real borrower;
- complete transaction gas, Base L1 data fees, MEV/inclusion costs or atomic callback success.

These fingerprints must be refreshed after any Pool upgrade. Use `npm run verify:protocol-deployments` to refresh them.
