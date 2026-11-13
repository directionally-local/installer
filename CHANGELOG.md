# Changelog

## [0.31.0](https://github.com/directionally-local/installer/compare/v0.30.1...v0.31.0) (2026-11-13)


### Features

* catalog entries for DeepSeek V4.1 Flash (1017) and GLM-5.3-Flash ([cdb2249](https://github.com/directionally-local/installer/commit/cdb2249ad9b17ba6a93cae02b499bd363a946d61))
* detect every GPU and its links, and pick a multi-GPU layout ([5a9bf53](https://github.com/directionally-local/installer/commit/5a9bf53565f28a91908b4b87acb7ed141ac79cd3))
* dl model up --plan prints the command and memory math, running nothing ([3a47d4f](https://github.com/directionally-local/installer/commit/3a47d4f9d93be0821c10d9910ce04e2256352db2))
* named model deployments, each pinned to its own GPUs ([2254660](https://github.com/directionally-local/installer/commit/22546608f3a49f34e27f286f1b14027e724cf2fe))
* preflight GPU memory, host RAM, disk and driver before any download ([e0bd835](https://github.com/directionally-local/installer/commit/e0bd835287f3d8c6eb8d7119c51f48524409dbfc))
* SGLang as a second engine behind the same interface as vLLM ([82eb6c4](https://github.com/directionally-local/installer/commit/82eb6c4be9d01b8859c3b7efa0e471687e1c9452))

## [0.30.1](https://github.com/directionally-local/installer/compare/v0.30.0...v0.30.1) (2026-11-13)


### Bug Fixes

* model smoke tests share one IPv4 base URL, log every request, and keep the container on failure ([#238](https://github.com/directionally-local/installer/issues/238)) ([5759b6b](https://github.com/directionally-local/installer/commit/5759b6b3981dbff92a5e25fc8c86f766ba7feac3))

## [0.30.0](https://github.com/directionally-local/installer/compare/v0.29.0...v0.30.0) (2026-11-13)


### Features

* **free:** tokens and users per upstream on the admin dashboard, with an all-time view ([#235](https://github.com/directionally-local/installer/issues/235)) ([31c6d10](https://github.com/directionally-local/installer/commit/31c6d101d66440e0117619760e3e7ecf33f67e83))
* **free:** two weekly budgets, generous DeepSeek and tighter GPT-6 ([#237](https://github.com/directionally-local/installer/issues/237)) ([b8561ed](https://github.com/directionally-local/installer/commit/b8561ed5beea878c426ce27097bb1a9ae8db498e))


### Bug Fixes

* **deps:** install Autopilot 3.22.0 ([#239](https://github.com/directionally-local/installer/issues/239)) ([ee565a6](https://github.com/directionally-local/installer/commit/ee565a6bbe3aec6a437e968f9bf6eac2c25bae9a))

## [0.29.0](https://github.com/directionally-local/installer/compare/v0.28.0...v0.29.0) (2026-11-12)


### Features

* **free:** dl Pro at $3.99/month, dollar top-ups, and a bounded admin people list ([#232](https://github.com/directionally-local/installer/issues/232)) ([dcd850c](https://github.com/directionally-local/installer/commit/dcd850cbaa9355a91d0077c9d8e6f19d36136270))


### Bug Fixes

* accept GPU detections whose tool didn't answer in the free tier's GPU counts ([#231](https://github.com/directionally-local/installer/issues/231)) ([cc04c0f](https://github.com/directionally-local/installer/commit/cc04c0f2ca54d2862fc56d0686d4cfd1c836de6c))
* **deps:** install Autopilot 3.21.0 ([#234](https://github.com/directionally-local/installer/issues/234)) ([e757ed0](https://github.com/directionally-local/installer/commit/e757ed09bdf4001e6b36fd7da3e16c7f26e94aff))
* **free:** GET /admin/people no longer starts three Durable Object calls per ([dcd850c](https://github.com/directionally-local/installer/commit/dcd850cbaa9355a91d0077c9d8e6f19d36136270))

## [0.28.0](https://github.com/directionally-local/installer/compare/v0.27.0...v0.28.0) (2026-11-12)


### Features

* **free:** a grant also sets a personal weekly dollar cap ([#227](https://github.com/directionally-local/installer/issues/227)) ([8b671af](https://github.com/directionally-local/installer/commit/8b671afa56c09d05484e824f69e0e9be1385d461))


### Bug Fixes

* **deps:** install Autopilot 3.20.1 ([#230](https://github.com/directionally-local/installer/issues/230)) ([5a1277e](https://github.com/directionally-local/installer/commit/5a1277e040e7749a2a1e046fde8b7e7d0fae9d0c))
* **model:** GPU run findings: thinking-safe smoke tests, progress, picker, short lines, failure details ([#229](https://github.com/directionally-local/installer/issues/229)) ([5a344cf](https://github.com/directionally-local/installer/commit/5a344cf8d7bde6f611d3d9a9da5a9a3bb1f6f658))

## [0.27.0](https://github.com/directionally-local/installer/compare/v0.26.0...v0.27.0) (2026-11-11)


### Features

* keep an optional email with a GPU early-access yes ([#224](https://github.com/directionally-local/installer/issues/224)) ([70940eb](https://github.com/directionally-local/installer/commit/70940eb6965bd1645c8b20ce9a98d437a51eb007))


### Bug Fixes

* **deps:** install Autopilot 3.20.0 ([#226](https://github.com/directionally-local/installer/issues/226)) ([247dfbe](https://github.com/directionally-local/installer/commit/247dfbebf51e54ea436cb97a500eb617fac95a21))

## [0.26.0](https://github.com/directionally-local/installer/compare/v0.25.0...v0.26.0) (2026-11-11)


### Features

* run dl model up from Autopilot's GPU first run, and count it ([#219](https://github.com/directionally-local/installer/issues/219)) ([0cfd965](https://github.com/directionally-local/installer/commit/0cfd9656c827d9bd041d938486e841fdaf908db1))


### Bug Fixes

* **deps:** install Autopilot 3.19.0 ([#220](https://github.com/directionally-local/installer/issues/220)) ([a154505](https://github.com/directionally-local/installer/commit/a154505b7a8d8ed70d63d6d847f20dc6a4adca99))

## [0.25.0](https://github.com/directionally-local/installer/compare/v0.24.0...v0.25.0) (2026-11-11)


### Features

* **free:** a plain-language admin home screen ([#209](https://github.com/directionally-local/installer/issues/209)) ([215161c](https://github.com/directionally-local/installer/commit/215161cd2e8b35e408e10d62fe203483dbef90dc))
* **model:** dl model bench with concurrency sweep\n\n1/8/32 concurrent streaming requests against the active model: TTFT p50/p95\nand aggregate decode tok/s per level, plus prefix cache hit rate from vLLM\nlogs.\n\nCo-authored-by: dl &lt;dl@directionallylocal.com&gt; ([5249a93](https://github.com/directionally-local/installer/commit/5249a933fedbe3df33a54df3bb501dd0db2940eb))
* **model:** per-model GPU reservation and VRAM-aware side-by-side updates ([70ad56a](https://github.com/directionally-local/installer/commit/70ad56a80a70a74008318895b93189b9002f6ada))
* **model:** per-run logs in ~/.directionallylocal/logs ([ed523fd](https://github.com/directionally-local/installer/commit/ed523fd2bb157b0d671edeb86381df63400a091e))


### Bug Fixes

* **free:** close three free tier sign-up farm holes ([#214](https://github.com/directionally-local/installer/issues/214)) ([108f11f](https://github.com/directionally-local/installer/commit/108f11f595186d3b2375e8f40f720e4c6f615f24))
* **free:** look up GitHub users with the OAuth app's credentials ([#212](https://github.com/directionally-local/installer/issues/212)) ([9b3e81e](https://github.com/directionally-local/installer/commit/9b3e81ea6517863073c1015ac27dfa14cfa687ef))
* **free:** make free tier server keys by request ([#216](https://github.com/directionally-local/installer/issues/216)) ([ea3b043](https://github.com/directionally-local/installer/commit/ea3b043d3bea04b64ec3dfb2a1c0061d3548760d))
* **free:** record OpenAI's credit in the daily per-provider spend ([#211](https://github.com/directionally-local/installer/issues/211)) ([adf0fbc](https://github.com/directionally-local/installer/commit/adf0fbc0839da32306880f69689201a00b46e62b))
* **model:** floor the decode window so short replies can't inflate tok/s ([50f1043](https://github.com/directionally-local/installer/commit/50f1043059af862156bd717e2fa8b3f27bf347f1))
* **model:** incumbent smoke re-test warns instead of aborting the switch ([6f29b3e](https://github.com/directionally-local/installer/commit/6f29b3e556e3cbe92f432736d5e66680026dc071))
* **model:** measure decode-only tok/s in the smoke test ([a1fc7cf](https://github.com/directionally-local/installer/commit/a1fc7cf01a9772852c7b6d6ef0d7df5fb42eba8e))
* **model:** probe nvidia-ctk instead of nvidia-container-cli ([1a5d7cd](https://github.com/directionally-local/installer/commit/1a5d7cd8a20e5ce783a152533e8b73ac507d3f1e))
* **model:** route dl model bench to the GPU dispatcher; fix bench output length\n\ndl model bench was swallowed by the model picker. Bench now pins output\nlength with ignore_eos so decode tok/s is measured over a fixed 512-token\nwindow.\n\nCo-authored-by: dl &lt;dl@directionallylocal.com&gt; ([ad2c037](https://github.com/directionally-local/installer/commit/ad2c037924e46b8381c95e71a67a528843451a24))
* **model:** use fixed-length bench for update comparisons ([55f3666](https://github.com/directionally-local/installer/commit/55f3666790cdfe28dee26a8533bca7dfade28467))
* **model:** use fixed-length bench for update comparisons ([ac20d3c](https://github.com/directionally-local/installer/commit/ac20d3c8f9561d48ee3c221bb9beeaa5e4f75ca2))

## [0.24.0](https://github.com/directionally-local/installer/compare/v0.23.0...v0.24.0) (2026-11-10)


### Features

* **free:** Health view on the admin dashboard ([#206](https://github.com/directionally-local/installer/issues/206)) ([8ddcdf4](https://github.com/directionally-local/installer/commit/8ddcdf4bc3a9aad4d34a0f1da424e127ae30a5e1))
* **free:** re-check admin-set Starter accounts when asked ([#200](https://github.com/directionally-local/installer/issues/200)) ([319c0cd](https://github.com/directionally-local/installer/commit/319c0cd2fc5b508ae642b849d3aff061ba527c93))


### Bug Fixes

* **free:** hold in-flight estimates against the weekly dollar cap ([#208](https://github.com/directionally-local/installer/issues/208)) ([3abed56](https://github.com/directionally-local/installer/commit/3abed5694cecfe982bc6a5e5d0d877c3a68e59e5))
* **install:** clear errors on Linux systems nodejs.org's Node can't run, with a reason in the count ([#207](https://github.com/directionally-local/installer/issues/207)) ([04f3a3b](https://github.com/directionally-local/installer/commit/04f3a3bf44c8a71e7ba9f750759758832ab6a6da))
* register vLLM's keyless route with --keyless ([#196](https://github.com/directionally-local/installer/issues/196)) ([976feb3](https://github.com/directionally-local/installer/commit/976feb37ebbfb4a2f1d878f0b5b3c1e5eb120c99))

## [0.23.0](https://github.com/directionally-local/installer/compare/v0.22.1...v0.23.0) (2026-11-10)


### Features

* **free:** basic level, access requests from dl, retention on people who could use dl ([#198](https://github.com/directionally-local/installer/issues/198)) ([84cc6b8](https://github.com/directionally-local/installer/commit/84cc6b81f0d7854ff19a08c0f604e5038168445e))
* **free:** daily cohort retention on the admin dashboard ([#188](https://github.com/directionally-local/installer/issues/188)) ([fbc0453](https://github.com/directionally-local/installer/commit/fbc045367add789217204ba6ac4ce0ee9cc94fbf))
* **free:** link the community discord in the welcome emails ([#193](https://github.com/directionally-local/installer/issues/193)) ([ce37ee5](https://github.com/directionally-local/installer/commit/ce37ee59d8634f3b34739347f78161ce2fe1c98a))
* **free:** send user emails through Cloudflare Email Service ([#190](https://github.com/directionally-local/installer/issues/190)) ([d14d046](https://github.com/directionally-local/installer/commit/d14d04602ee673c6d67a34671c507379af288095))
* **free:** Tools tab to give free tokens by GitHub username and write an email ([#192](https://github.com/directionally-local/installer/issues/192)) ([d6d381f](https://github.com/directionally-local/installer/commit/d6d381fb48c41fbf1ac3628e52c7bb88203d2294))


### Bug Fixes

* **deps:** install Autopilot 3.17.0 ([#199](https://github.com/directionally-local/installer/issues/199)) ([d9cc0e2](https://github.com/directionally-local/installer/commit/d9cc0e2f2acc9f3a5c3dca60e4a82fe407ae4d7c))
* **free:** one Spend card across providers on the admin dashboard ([#195](https://github.com/directionally-local/installer/issues/195)) ([8b331b8](https://github.com/directionally-local/installer/commit/8b331b8ffee0e5fe7c70a5295bc4928ead63af0b))

## [0.22.1](https://github.com/directionally-local/installer/compare/v0.22.0...v0.22.1) (2026-11-09)


### Bug Fixes

* **free:** send GPT-6 through OpenAI's Responses API so tools and reasoning work together ([#186](https://github.com/directionally-local/installer/issues/186)) ([2c65501](https://github.com/directionally-local/installer/commit/2c655012b605a29f34f52963dcc7dc318354fb3d))

## [0.22.0](https://github.com/directionally-local/installer/compare/v0.21.0...v0.22.0) (2026-11-09)


### Features

* add dl model up/update/rollback/status for local vLLM ([93e39cd](https://github.com/directionally-local/installer/commit/93e39cd2a60273bc783bee3fea476a5fa2a0296e))
* add dl model up/update/rollback/status for local vLLM ([8c965d1](https://github.com/directionally-local/installer/commit/8c965d1cf956423f570780e672e71e3e08c608c6))
* **free:** accounts below the bar are told who free tokens are for and how to ask for credits ([#181](https://github.com/directionally-local/installer/issues/181)) ([e16c6cb](https://github.com/directionally-local/installer/commit/e16c6cb2767c4094662c6e0814c36440cec5e314))
* **free:** additional account signals with private thresholds for Full ([#183](https://github.com/directionally-local/installer/issues/183)) ([34083dc](https://github.com/directionally-local/installer/commit/34083dc486e919137855f218fd7dd581e401a002))
* **free:** an email at each spend milestone: $50, $100, $200 and on ([#182](https://github.com/directionally-local/installer/issues/182)) ([2fc8607](https://github.com/directionally-local/installer/commit/2fc8607048365ba0d77fe73690dcda6ed08a176f))


### Bug Fixes

* **deps:** install Autopilot 3.16.0 ([#184](https://github.com/directionally-local/installer/issues/184)) ([56840b2](https://github.com/directionally-local/installer/commit/56840b281fd3413dd9a37a8dfa7375b0317eea18))
* **free:** one free account per inbox, blocked inboxes and domains, and a daily cap per email domain ([#180](https://github.com/directionally-local/installer/issues/180)) ([d3ebc96](https://github.com/directionally-local/installer/commit/d3ebc969f9643d05abd760d5659f1d28d387cd64))
* **setup:** reuse Autopilot's provider instead of asking again ([62870c8](https://github.com/directionally-local/installer/commit/62870c8d2d2183742411da76ab086a9b95468dca))
* **setup:** reuse Autopilot's provider instead of asking again ([5243507](https://github.com/directionally-local/installer/commit/5243507c20f249cf763c9ad1769179581c65767c)), closes [#103](https://github.com/directionally-local/installer/issues/103) [#111](https://github.com/directionally-local/installer/issues/111)

## [0.21.0](https://github.com/directionally-local/installer/compare/v0.20.0...v0.21.0) (2026-11-08)


### Features

* **free:** a simple admin view, readable at a glance ([74bd4fc](https://github.com/directionally-local/installer/commit/74bd4fca6c3be46c0643dc7686a4d1ee1ccdf20a))
* **free:** a simple admin view, readable at a glance ([56119f3](https://github.com/directionally-local/installer/commit/56119f38ca54d327f2fbd6f7831448a777bcb1ef))
* **free:** emails to users through Resend ([ecb6167](https://github.com/directionally-local/installer/commit/ecb616731a46ef7b248b602411ad9369b9e9214b))
* **free:** free tokens inside dl only ([62f359d](https://github.com/directionally-local/installer/commit/62f359dbb001e9a914934042c8bf6d574d355a18))
* **free:** free tokens inside dl only ([a39a72c](https://github.com/directionally-local/installer/commit/a39a72c9ba60de6392a7986d7df6664047708858))


### Bug Fixes

* **deps:** bump autopilot-ai ([#169](https://github.com/directionally-local/installer/issues/169)) ([89aeebf](https://github.com/directionally-local/installer/commit/89aeebf7d1d8bd62438ad35cc07b431cf731bb8d))
* **deps:** install Autopilot 3.15.0 ([a82f2e5](https://github.com/directionally-local/installer/commit/a82f2e55c877459837c1daf03459a93c32a54bb0))
* **free:** a request the caller hung up on is no longer OpenRouter cash or a full charge ([74fb285](https://github.com/directionally-local/installer/commit/74fb2855287024aece1de9bef328c2e6297285cc))
* **free:** a second session of the same sign-in isn't signed out when it refreshes late ([751a498](https://github.com/directionally-local/installer/commit/751a498a4f11b3e760810fe0b1e9bc5c1c77ecf6))

## [0.20.0](https://github.com/directionally-local/installer/compare/v0.19.1...v0.20.0) (2026-11-06)


### Features

* **free:** account levels make farming unprofitable without turning away developers ([0418a5b](https://github.com/directionally-local/installer/commit/0418a5ba9b4afc8d6a7c3f3c7a95b064d2bac2ee))
* **free:** OpenAI is the default provider, with DeepSeek as the fallback ([e28a6e0](https://github.com/directionally-local/installer/commit/e28a6e0c6bc96e0f991f860e447ba9c5f91682d0))
* **free:** OpenAI is the default provider, with DeepSeek as the fallback ([c4f064f](https://github.com/directionally-local/installer/commit/c4f064fc879e27849551692f11e3a8ce687eb6ae))
* **free:** sign-in asks for a contact email, and Starter can redeem an invite ([905d735](https://github.com/directionally-local/installer/commit/905d73541091c9f8e0b69f46ad3d7041bc6be9cb))
* **free:** Starter accounts are served, not refused ([5b63266](https://github.com/directionally-local/installer/commit/5b63266ed736ecbf83e16f0bf277aa8926d170f4))


### Bug Fixes

* **deps:** install Autopilot 3.14.0 ([85ce6ba](https://github.com/directionally-local/installer/commit/85ce6bae93b0adec09e4be799f6fe4eedd546ce6))
* **free:** Sol and Astra fall back to DeepSeek too, and the cap is $20 ([f9908f1](https://github.com/directionally-local/installer/commit/f9908f1668f88dfee156efb56b889f649834b181))
* **free:** the dashboard's Block and "Serve from" buttons work again ([869621c](https://github.com/directionally-local/installer/commit/869621c7d4237cf780c6071559c62a82aea88498))
* **free:** the dashboard's Block and "Serve from" buttons work again ([8739562](https://github.com/directionally-local/installer/commit/8739562e55b353a44babf05765d9ddef9542b902))
* **free:** the Luminal slow-down email needs at least 3 failures ([15afb30](https://github.com/directionally-local/installer/commit/15afb30f8a663e7e203c17a9c6f1751c74e0f42f))
* **free:** the Luminal slow-down email needs at least 3 failures ([8a2d3c4](https://github.com/directionally-local/installer/commit/8a2d3c4e37a320aca43d8b22c325a38463dc00fe))

## [0.19.1](https://github.com/directionally-local/installer/compare/v0.19.0...v0.19.1) (2026-11-06)


### Bug Fixes

* everything a user's machine fetches or runs goes through dl.new ([0bdaa3e](https://github.com/directionally-local/installer/commit/0bdaa3e8613ef6e7c2b886b7cc2e3b0ad3d738cd))

## [0.19.0](https://github.com/directionally-local/installer/compare/v0.18.1...v0.19.0) (2026-11-05)


### Features

* **free:** a public /v1/status says whether new users get free tokens, a waitlist, or a pause ([0cce1b9](https://github.com/directionally-local/installer/commit/0cce1b9ca27b5bd3dd5a6d0f9140f1570126a205))


### Bug Fixes

* **deps:** install Autopilot 3.13.0 ([e7a2648](https://github.com/directionally-local/installer/commit/e7a26480ae83db18ab0901a26495343872858820))
* **deps:** install Autopilot 3.13.0 ([74e7175](https://github.com/directionally-local/installer/commit/74e71755eb58187b68d0e9986dfa0d84a9014702))

## [0.18.1](https://github.com/directionally-local/installer/compare/v0.18.0...v0.18.1) (2026-11-05)


### Bug Fixes

* **deps:** install Autopilot 3.12.0 ([7d7c8aa](https://github.com/directionally-local/installer/commit/7d7c8aa1eb46ccbd03b7d0cc6357d6696db51a04))

## [0.18.0](https://github.com/directionally-local/installer/compare/v0.17.0...v0.18.0) (2026-11-05)


### Features

* dl uninstall works on laptops; a read-only shell rc no longer fails the install ([87fdcf2](https://github.com/directionally-local/installer/commit/87fdcf28318d8a28306e43fc925ff58991b32b0c))
* dl uninstall works on laptops; a read-only shell rc no longer fails the install ([1e1578c](https://github.com/directionally-local/installer/commit/1e1578c99658fca3b00b78ef8a875a9772f4020b))
* dl update updates dl, and every update hint says dl update ([19ba2d3](https://github.com/directionally-local/installer/commit/19ba2d3986c50532e245590d002029f09ee30f08))
* **free:** email fast when Luminal slows people down, and switch upstream from /admin ([5d8ac08](https://github.com/directionally-local/installer/commit/5d8ac081b69728a237d8efedbe55ae627dd56ed2))
* **free:** POST /v1/feedback emails the owner, with replies going to the person ([ff5433f](https://github.com/directionally-local/installer/commit/ff5433f3d30b8d9f63e9265fb6c3a5a70aa32c2f))


### Bug Fixes

* **deps:** install Autopilot 3.11.0 ([c79debf](https://github.com/directionally-local/installer/commit/c79debfbb33e35d2d4132ceda3e2cdbf2d68c054))

## [0.17.0](https://github.com/directionally-local/installer/compare/v0.16.0...v0.17.0) (2026-11-05)


### Features

* **install:** root gets the coding agent like everyone; the server setup only with DL_MODE=server ([574ed19](https://github.com/directionally-local/installer/commit/574ed1921690d5f45e8a4b3bc03f193d0b1bcf52))
* **install:** root gets the coding agent like everyone; the server setup only with DL_MODE=server ([01b91e8](https://github.com/directionally-local/installer/commit/01b91e87c8ae3bf033303badeaaf3199810159d7))

## [0.16.0](https://github.com/directionally-local/installer/compare/v0.15.0...v0.16.0) (2026-11-05)


### Features

* **free:** admin in the dl brand, credit-only budget, abuse section with block ([c6fa1f1](https://github.com/directionally-local/installer/commit/c6fa1f104255407979a46ab0085b04ebbed6ac66))
* **free:** admin in the dl brand, credit-only budget, abuse section with block ([b221151](https://github.com/directionally-local/installer/commit/b2211511eb06177e2f19675446ce9af3b732bb81))
* **free:** email the first sign-up and a daily digest ([e34326c](https://github.com/directionally-local/installer/commit/e34326c7a67a38ecff644e064fd558696e683845))
* **free:** email the first sign-up and a daily digest ([dc09b43](https://github.com/directionally-local/installer/commit/dc09b431a7924caa083eaff46f8d4ece024db59f))


### Bug Fixes

* **deps:** install Autopilot 3.10.1 ([b3dbfea](https://github.com/directionally-local/installer/commit/b3dbfeafd66b49edc2fd4b252b2f0801597e8925))
* **deps:** install Autopilot 3.10.1 ([984b2a8](https://github.com/directionally-local/installer/commit/984b2a828f49f704b8be105e436b54eff26cd9ee))
* **free:** digest money lines in Luminal credit only ([b2fba25](https://github.com/directionally-local/installer/commit/b2fba25d8d937692604de7e253f9173e1c087035))
* **free:** the free tier calls OpenRouter only if the service has an OpenRouter key ([df0d5ef](https://github.com/directionally-local/installer/commit/df0d5eff5f7ceaf30fd3296597e87b0d77e27642))
* **free:** the free tier calls OpenRouter only if the service has an OpenRouter key ([89201cf](https://github.com/directionally-local/installer/commit/89201cf6512e87b6631e877d4d55baa781baa860))

## [0.15.0](https://github.com/directionally-local/installer/compare/v0.14.0...v0.15.0) (2026-11-05)


### Features

* **free:** dl brand for the sign-in pages ([58930d9](https://github.com/directionally-local/installer/commit/58930d96aa7b5eb1d8cb18a598eb2a52184904a0))
* **free:** dl brand for the sign-in pages ([e40f065](https://github.com/directionally-local/installer/commit/e40f065d3106f78e034fc21f70c7c1350e3d1ceb))
* **free:** key per-IP limits on the IPv6 /64 and require some GitHub activity ([5a309cf](https://github.com/directionally-local/installer/commit/5a309cf68d7159f808eb88a4366b8f48ba90806d))
* **free:** the consent notice is one line with the full list a click away, and says dl ([363e037](https://github.com/directionally-local/installer/commit/363e037c47274182a624c79cc6b20ded7eca4353))


### Bug Fixes

* **deps:** install Autopilot 3.10.0, and tell it dl's version and update command ([87a1000](https://github.com/directionally-local/installer/commit/87a10008dfa647334804f664463d4178b7603090))
* **deps:** install Autopilot 3.10.0, and tell it dl's version and update command ([f6170e7](https://github.com/directionally-local/installer/commit/f6170e7b9f1069ba491fa65fed6ef4540c0d7490))
* **deps:** install Autopilot 3.9.0 ([3677e0a](https://github.com/directionally-local/installer/commit/3677e0a46da7e249f8abceeeeb897aa133f98447))
* **free:** a top-up's checkout returns to the success page with product=topup ([2de6642](https://github.com/directionally-local/installer/commit/2de66424a9d170fb0f6d3e4fd8d3c5e6264b7c44))
* **free:** a top-up's checkout returns with product=topup ([f8c01d2](https://github.com/directionally-local/installer/commit/f8c01d27badbd18dfe5a7a3e8898a19d5239f3f7))

## [0.14.0](https://github.com/directionally-local/installer/compare/v0.13.0...v0.14.0) (2026-11-04)


### Features

* count install script downloads and finished installs for the funnel ([6a2abdd](https://github.com/directionally-local/installer/commit/6a2abdd433b24e89de758e95dfbf8eb652d49b1c))
* **free:** show the invite link on the sign-in success page ([b2e8957](https://github.com/directionally-local/installer/commit/b2e89572bbba79729e0c7763e906728205410a8e))
* **free:** show the invite link on the sign-in success page ([0b530c2](https://github.com/directionally-local/installer/commit/0b530c2f7f3bd09736726c526bd342b62f1f726b))
* install funnel — count script downloads and finished installs ([bd2fcb0](https://github.com/directionally-local/installer/commit/bd2fcb0ad9eb5bfd888ce38b370b44a0ec281f56))
* **install:** install dl from one prebuilt bundle per platform ([1f9f228](https://github.com/directionally-local/installer/commit/1f9f2280fb5354375c8723d84a025df6e1a10f87))
* **install:** show what the install is doing, and download less on a laptop ([5d104d2](https://github.com/directionally-local/installer/commit/5d104d281b5ae133660c9870b784801e7d30f5c0))
* **install:** show what the install is doing, and download less on a laptop ([7519ba4](https://github.com/directionally-local/installer/commit/7519ba4bdd20c80e1aa7f0cfcaf0ae3262cfb004))


### Bug Fixes

* **deps:** install Autopilot 3.8.0 ([1eab8cd](https://github.com/directionally-local/installer/commit/1eab8cde37cb141ccbbd8a5c678f3735c11d88c0))
* install.sh's exit trap is a function, for shellcheck ([a5cc5c2](https://github.com/directionally-local/installer/commit/a5cc5c2d92088f0e90bb80021b63b82295348360))

## [0.13.0](https://github.com/directionally-local/installer/compare/v0.12.0...v0.13.0) (2026-11-04)


### Features

* **free:** land Stripe billing ([#117](https://github.com/directionally-local/installer/issues/117)) and the Luminal upstream ([#119](https://github.com/directionally-local/installer/issues/119)) on main ([52887dc](https://github.com/directionally-local/installer/commit/52887dcdd83ae2360ffe4a577379d52eb639bd8b))
* **free:** link the privacy policy and terms on the sign-in pages ([e0f93c9](https://github.com/directionally-local/installer/commit/e0f93c9d96dc06bf775728f9e14cc417df317139))
* **free:** open sign-up with a queue, referrals, spend alerts and launch dashboard ([76d26a7](https://github.com/directionally-local/installer/commit/76d26a71a5991cec1cecd0203c6909f8433bad47))
* **free:** serve the free tier from Luminal on prepaid credit ([579c869](https://github.com/directionally-local/installer/commit/579c8695df705d9f3cf36e049ed6c1ce44003a2d))
* **laptop:** pass an invite link's DL_REFERRAL through to Autopilot ([79149ef](https://github.com/directionally-local/installer/commit/79149ef56eeaef53332d8856ffab88c20cf2e1a3))


### Bug Fixes

* **deps:** install Autopilot 3.7.0 ([577a17b](https://github.com/directionally-local/installer/commit/577a17ba0fc184383ea3bb388e1d2cbfc1b38cc4))
* **deps:** install Autopilot 3.7.0 ([f3f8f2e](https://github.com/directionally-local/installer/commit/f3f8f2e1b50bee0cf58cf18e623e8930c58a7788))

## [0.12.0](https://github.com/directionally-local/installer/compare/v0.11.0...v0.12.0) (2026-11-04)


### Features

* **free:** steer around a failing OpenRouter host; sign-in codes last 15 minutes ([c58af05](https://github.com/directionally-local/installer/commit/c58af0583327e59748ae434a6b0e64b4ce7c2717))
* **free:** steer around a failing OpenRouter host; sign-in codes last 15 minutes ([f3435b5](https://github.com/directionally-local/installer/commit/f3435b58f66c739e9b80005b8a6c81c4ad70da1a))
* **laptop:** dl status shows the free tier account ([38ac660](https://github.com/directionally-local/installer/commit/38ac660a212b847958da5dfabbef8c832123929d))
* **laptop:** dl status shows the free tier account ([2b491f2](https://github.com/directionally-local/installer/commit/2b491f2dfb548673c82aeabfcad4dfae4db3de15))


### Bug Fixes

* **deps:** install Autopilot 3.6.0 ([bae53ab](https://github.com/directionally-local/installer/commit/bae53ab9ea244602fc89b0c7785d7b3e640d0040))
* **deps:** install Autopilot 3.6.0 ([bb74c31](https://github.com/directionally-local/installer/commit/bb74c31fdcdfc19e39e279284a857c8de8333489))
* **laptop:** dl status says when sign-in is unfinished; one PATH hint after install ([40c5b36](https://github.com/directionally-local/installer/commit/40c5b361fbdeccb4f9ec6a4dbfa83c878f9e323d))
* **laptop:** dl status says when sign-in is unfinished; one PATH hint after install ([6b33842](https://github.com/directionally-local/installer/commit/6b33842d82cf1f4375d1440d9b3c99dfee42baf3))

## [0.11.0](https://github.com/directionally-local/installer/compare/v0.10.1...v0.11.0) (2026-11-03)


### Features

* dl --from-claude-code and an opt-in Claude Code limit hook ([93d1af8](https://github.com/directionally-local/installer/commit/93d1af87d5813f4b2c286bec98af2ea473a6bdb1))
* **free:** admin dashboard for weekly actives, retention, cost and limits ([c5bc449](https://github.com/directionally-local/installer/commit/c5bc4496fd2bbc9d169d5f70eab88dc3158617b1))


### Bug Fixes

* **deps:** install Autopilot 3.5.0 ([104bac9](https://github.com/directionally-local/installer/commit/104bac904f6505ebd7d0effa81631d0d8be0bc5a))
* **free:** admin sign-in uses the registered OAuth callback ([7ee6bff](https://github.com/directionally-local/installer/commit/7ee6bffdebe3b25b0fd27e7e2a42bd67a11d7590))
* **laptop:** clearer dl run question, never downgrade a server, install-aware update hints ([379271f](https://github.com/directionally-local/installer/commit/379271fc85ac2d8b37463b9f4897416dabcbf440))

## [0.10.1](https://github.com/directionally-local/installer/compare/v0.10.0...v0.10.1) (2026-11-03)


### Bug Fixes

* **deps:** install Autopilot 3.3.0 ([90d648f](https://github.com/directionally-local/installer/commit/90d648ffe248cd498390f01452c81a566dec49cd))
* **install:** dl works in the same terminal, one Node copy, no leftover caches ([79428de](https://github.com/directionally-local/installer/commit/79428dec17b918163e3c406223e95be0c37355ae))
* **install:** spell out the PATH check as an if, for older shellcheck ([b24936d](https://github.com/directionally-local/installer/commit/b24936d3d76b1fd01e31577779fb42fc4d2deb22))
* **laptop:** dl status reports a laptop install; tell Autopilot dl launched it ([acb4aef](https://github.com/directionally-local/installer/commit/acb4aefbc2a25bc54d6969cba97b987d2c616def))

## [0.10.0](https://github.com/directionally-local/installer/compare/v0.9.4...v0.10.0) (2026-11-03)


### Features

* **free:** cached tokens at real cost, sign-out that revokes, server keys ([#95](https://github.com/directionally-local/installer/issues/95)) ([096dbfe](https://github.com/directionally-local/installer/commit/096dbfe859196ffca4e5aeac5bb31adc4e8a9c9c))
* **free:** free managed tier service MVP ([#84](https://github.com/directionally-local/installer/issues/84)) ([1e2f1f6](https://github.com/directionally-local/installer/commit/1e2f1f61c2a566278c49a7390e6d42a83ff414a3))
* **free:** open admission, distinct refusals, runtime limits, pause wording ([#91](https://github.com/directionally-local/installer/issues/91)) ([f944453](https://github.com/directionally-local/installer/commit/f944453a1590e0a3c78595575079e01d41e26af0))
* **free:** route to the cheapest full-precision host that doesn't collect prompts ([#96](https://github.com/directionally-local/installer/issues/96)) ([27e80cf](https://github.com/directionally-local/installer/commit/27e80cf74d17ef8b6bc26eb077eb7c3838732580))
* **install:** laptops in install.sh, and the laptop's dl version on servers ([#93](https://github.com/directionally-local/installer/issues/93)) ([a216370](https://github.com/directionally-local/installer/commit/a2163709e1c2f021c517e671b569531f3155b062))
* **laptop:** first run with nothing to set up ([#90](https://github.com/directionally-local/installer/issues/90)) ([4c0eff7](https://github.com/directionally-local/installer/commit/4c0eff7517f8f74d8763f9049ce5578e4e3d3c8d))
* on a laptop, dl runs plain Autopilot ([#83](https://github.com/directionally-local/installer/issues/83)) ([1f09cbf](https://github.com/directionally-local/installer/commit/1f09cbff0b3b16e6d078860f595dd8d50f38e1a9)), closes [#72](https://github.com/directionally-local/installer/issues/72)


### Bug Fixes

* **deps:** install Autopilot 3.2.0 ([#97](https://github.com/directionally-local/installer/issues/97)) ([9db816e](https://github.com/directionally-local/installer/commit/9db816ebc5b7c07c9c63f8f6a3271a1ed2276b8a))
* **deps:** pin Hotcell exactly, like Autopilot ([#79](https://github.com/directionally-local/installer/issues/79)) ([901bf61](https://github.com/directionally-local/installer/commit/901bf61fa57f1d062ca0311ad888b084745ec1f1))

## [0.9.4](https://github.com/directionally-local/installer/compare/v0.9.3...v0.9.4) (2026-10-30)


### Bug Fixes

* **session:** reopen a saved chat without creation flags ([#68](https://github.com/directionally-local/installer/issues/68)) ([3cc2f2f](https://github.com/directionally-local/installer/commit/3cc2f2f30d06cfab6ddd88769ce1b19e2d8badee))

## [0.9.3](https://github.com/directionally-local/installer/compare/v0.9.2...v0.9.3) (2026-10-30)


### Bug Fixes

* **deps:** ship autopilot-ai 3.1.0 so new installs use autopilot folders ([#65](https://github.com/directionally-local/installer/issues/65)) ([99a8067](https://github.com/directionally-local/installer/commit/99a8067842de6b886ce2ad55a30343110fb7ea7f))
* **deps:** ship autopilot-ai 3.1.1 ([c1abc15](https://github.com/directionally-local/installer/commit/c1abc15872abac8988b914d96266c0c27cb7b739))
* **deps:** ship autopilot-ai 3.1.1 ([c3571ee](https://github.com/directionally-local/installer/commit/c3571eebed405092d286de308c0184544e71251c))

## [0.9.2](https://github.com/directionally-local/installer/compare/v0.9.1...v0.9.2) (2026-10-30)


### Bug Fixes

* **deps:** ship autopilot-ai 3.0.4 ([#64](https://github.com/directionally-local/installer/issues/64)) ([2c939a5](https://github.com/directionally-local/installer/commit/2c939a5db6351a0863fba5a9e63ef84d208a58f3))
* read Autopilot's config from autopilot/ before the old kimiflare/ folder ([2eca447](https://github.com/directionally-local/installer/commit/2eca447418e659dd60dc16cc1e612c889de65577))
* read Hotcell's routes by name, so a configured provider is seen ([996d5c4](https://github.com/directionally-local/installer/commit/996d5c40f5d3b2110104b95090e065943fa8e8c7))
* read Hotcell's routes by name, so a configured provider is seen ([ffacae3](https://github.com/directionally-local/installer/commit/ffacae3a91ea9b8104278d4b251bffb02fea0354))

## [0.9.1](https://github.com/directionally-local/installer/compare/v0.9.0...v0.9.1) (2026-10-30)


### Bug Fixes

* **deps:** ship autopilot-ai 3.0.3 so setup opens Autopilot's provider picker ([d3d867e](https://github.com/directionally-local/installer/commit/d3d867eaff81c57279bc06dd8f9dfae20324c6db))
* **deps:** ship autopilot-ai 3.0.3 so setup opens Autopilot's provider picker ([8953f47](https://github.com/directionally-local/installer/commit/8953f47b2e9eec3a1890258f6e84b34db0c92630))

## [0.9.0](https://github.com/directionally-local/installer/compare/v0.8.2...v0.9.0) (2026-10-30)


### Features

* hand provider and model choice to Autopilot and open a session after setup ([#55](https://github.com/directionally-local/installer/issues/55)) ([65b9238](https://github.com/directionally-local/installer/commit/65b9238fb8c8dcb27e607697fa1cd748bc0cfcb9))

## [0.8.2](https://github.com/directionally-local/installer/compare/v0.8.1...v0.8.2) (2026-10-29)


### Bug Fixes

* bundle Autopilot 3 and require a patched Node ([d6f1493](https://github.com/directionally-local/installer/commit/d6f149319189b8d012017acece5a01f819a2ed19))
* bundle Autopilot 3 and require a patched Node ([bacc7be](https://github.com/directionally-local/installer/commit/bacc7be92b3556fd8573f26c951176c6bec90c58))

## [0.8.1](https://github.com/directionally-local/installer/compare/v0.8.0...v0.8.1) (2026-10-29)


### Bug Fixes

* offer this computer as the default, and don't offer it on Windows ([877d4b3](https://github.com/directionally-local/installer/commit/877d4b33085a01b9a041cc590e4771870afa78d7))
* offer this computer as the default, and don't offer it on Windows ([1809d1d](https://github.com/directionally-local/installer/commit/1809d1d931ea69e05addafe54ef559ddfaf6634d))

## [0.8.0](https://github.com/directionally-local/installer/compare/v0.7.0...v0.8.0) (2026-10-29)


### Features

* dl preview, Phase 1 of preview deploys ([14a5f21](https://github.com/directionally-local/installer/commit/14a5f21a50b4df306d86bf8a8ad4c11a431c5606))
* dl preview, Phase 1 of preview deploys ([60f150b](https://github.com/directionally-local/installer/commit/60f150b515da702b98b1a78b3fae86eacd39a1af)), closes [#28](https://github.com/directionally-local/installer/issues/28)

## [0.7.0](https://github.com/directionally-local/installer/compare/v0.6.0...v0.7.0) (2026-10-29)


### Features

* dl update, and never restart a server under a running task ([aedb26d](https://github.com/directionally-local/installer/commit/aedb26d1d3e4dc52b7a3bb204f4ea2451e57a7cb))
* dl update, and never restart a server under a running task ([4e54da6](https://github.com/directionally-local/installer/commit/4e54da6704496e8377ec4f5f15f63c791a97f08e)), closes [#34](https://github.com/directionally-local/installer/issues/34)
* **services:** add the shared library and the name service skeleton ([979d969](https://github.com/directionally-local/installer/commit/979d96904a4ee833332fb49ba80957a412c611a4)), closes [#29](https://github.com/directionally-local/installer/issues/29)
* **services:** add the shared library and the name service skeleton (Phase 1a of [#29](https://github.com/directionally-local/installer/issues/29)) ([b09a703](https://github.com/directionally-local/installer/commit/b09a7035232a202b7b5fa2c54c12b70d440c0a37))


### Bug Fixes

* show why a task failed ([edb7a52](https://github.com/directionally-local/installer/commit/edb7a524f108e443f01d6abd5fee1b774e01e78f))
* show why a task failed ([497cbc0](https://github.com/directionally-local/installer/commit/497cbc01b1800245a97a1ba9c92caf1e3d9709c8)), closes [#33](https://github.com/directionally-local/installer/issues/33)

## [0.6.0](https://github.com/directionally-local/installer/compare/v0.5.0...v0.6.0) (2026-10-29)


### Features

* choose the model in dl setup and with dl model; default to DeepSeek V4.1 Flash ([94ed5f4](https://github.com/directionally-local/installer/commit/94ed5f41430c4420f4426cd440f45a4b96598ec4))
* choose the model in dl setup and with dl model; default to DeepSeek V4.1 Flash ([ef6e8cb](https://github.com/directionally-local/installer/commit/ef6e8cb529e898b74fd320cd9514b5182defa108))

## [0.5.0](https://github.com/directionally-local/installer/compare/v0.4.1...v0.5.0) (2026-10-29)


### Features

* open an agent session when dl is typed inside a GitHub project ([d2e0820](https://github.com/directionally-local/installer/commit/d2e0820e0f34dde5119e03b7422c6b16e2659842))

## [0.4.1](https://github.com/directionally-local/installer/compare/v0.4.0...v0.4.1) (2026-10-29)


### Bug Fixes

* give Hotcell current model prices so spend-capped tasks aren't refused ([84542f2](https://github.com/directionally-local/installer/commit/84542f22e53d68eec07750c104c644bbeecc39b5))
* give Hotcell OpenRouter's model prices so spend-capped tasks can run ([256736b](https://github.com/directionally-local/installer/commit/256736b7f99ec65f367b2a387f35fb6c1ce1fb74))

## [0.4.0](https://github.com/directionally-local/installer/compare/v0.3.0...v0.4.0) (2026-10-29)


### Features

* dl keys replaces the OpenRouter key or GitHub token where agents run ([564debe](https://github.com/directionally-local/installer/commit/564debed90c6ee31d9322c0a4115e879acc5008a))


### Bug Fixes

* pick a sensible model, add dl use for a default target, and reword help ([b6d3bc0](https://github.com/directionally-local/installer/commit/b6d3bc0cd3717a1f17b0646c7770ca0b0cac593b))
* try SSH keys quietly, name servers after their hostname, clearer access step ([10403b1](https://github.com/directionally-local/installer/commit/10403b16bf4ed9f4c37725a544a07a5cd03cece3))
* v0.3.1: sensible model, quiet SSH key search, server names, dl use, dl keys ([f83330e](https://github.com/directionally-local/installer/commit/f83330e0eeb12da9810abe17ff6461e51964fad6))

## [0.3.0](https://github.com/directionally-local/installer/compare/v0.2.0...v0.3.0) (2026-10-28)


### Features

* start from the laptop: dl sets up your server over SSH, or runs agents on this computer ([e1e3411](https://github.com/directionally-local/installer/commit/e1e3411d476958f3cd95fa78a10392fd8afdafe6))


### Bug Fixes

* report a finished install.sh step under its starting label in plain output ([02e2e57](https://github.com/directionally-local/installer/commit/02e2e57c58264ed3b53cfd6561e88806c4e4545f))

## [0.2.0](https://github.com/directionally-local/installer/compare/v0.1.2...v0.2.0) (2026-10-28)


### Features

* server side of the laptop-first setup (ssh access, JSON events, needs, pair) ([b316b16](https://github.com/directionally-local/installer/commit/b316b164b822cf9162914601f8bb7d658e69b886))
* server side of the laptop-first setup (ssh access, JSON events, needs, pair) ([bdd64af](https://github.com/directionally-local/installer/commit/bdd64af5ab61d72bac74aab2f9124925b5c25b62))

## [0.1.2](https://github.com/directionally-local/installer/compare/v0.1.1...v0.1.2) (2026-10-28)


### Bug Fixes

* **package:** name the repository so npm accepts the release's provenance ([7aa1dce](https://github.com/directionally-local/installer/commit/7aa1dceae1a5c366c568f432f2064ac0992a60f6))
* **package:** name the repository so npm accepts the release's provenance ([8cab252](https://github.com/directionally-local/installer/commit/8cab2526f31c07899fb1fde646881667d36c5847))

## [0.1.1](https://github.com/directionally-local/installer/compare/v0.1.0...v0.1.1) (2026-10-28)


### Bug Fixes

* animate install.sh's bootstrap steps, and show only the failed step's output ([cf5fc13](https://github.com/directionally-local/installer/commit/cf5fc13627741ab0b823c6396f93f67025259885))
* animate install.sh's bootstrap steps, and show only the failed step's output ([5bde95e](https://github.com/directionally-local/installer/commit/5bde95e63f9f1a703dd21322b44a82b223fc8efe))
