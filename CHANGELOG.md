# Changelog

## [0.54.0](https://github.com/directionally-local/installer/compare/v0.53.1...v0.54.0) (2026-11-28)


### Features

* **free:** give one person a complimentary plan without Stripe (ENG-26) ([#507](https://github.com/directionally-local/installer/issues/507)) ([d3eec0b](https://github.com/directionally-local/installer/commit/d3eec0be1497e53d376fc1ee212b5bccd813a798))

## [0.53.1](https://github.com/directionally-local/installer/compare/v0.53.0...v0.53.1) (2026-11-28)


### Bug Fixes

* **versions:** pin Autopilot 3.37.0 ([#505](https://github.com/directionally-local/installer/issues/505)) ([362f9d3](https://github.com/directionally-local/installer/commit/362f9d3a1b58b3edda4b1f0c8d610a9f2ffee2e3))

## [0.53.0](https://github.com/directionally-local/installer/compare/v0.52.1...v0.53.0) (2026-11-28)


### Features

* **free:** offer live subscription plans on paywalls ([#504](https://github.com/directionally-local/installer/issues/504)) ([9eb23d8](https://github.com/directionally-local/installer/commit/9eb23d86b16590e3fffc7dee4a081c36ec303b94))


### Bug Fixes

* **deps:** install Autopilot 3.36.3 ([#503](https://github.com/directionally-local/installer/issues/503)) ([92c79c6](https://github.com/directionally-local/installer/commit/92c79c6a5136ef9f7288d93fa038a288511deb2f))
* **free:** a zero weekly budget means off, not spent (ENG-43) ([#494](https://github.com/directionally-local/installer/issues/494)) ([8589acd](https://github.com/directionally-local/installer/commit/8589acd3427da80214063abb40501c391a0a9dec))
* **free:** plan-neutral upstream error messages ([#493](https://github.com/directionally-local/installer/issues/493)) ([ad92264](https://github.com/directionally-local/installer/commit/ad92264d3d35999162e47d14cc430cd8b0eab205))

## [0.52.1](https://github.com/directionally-local/installer/compare/v0.52.0...v0.52.1) (2026-11-27)


### Bug Fixes

* **free:** normalize invite codes that start with DL ([#491](https://github.com/directionally-local/installer/issues/491)) ([8f30f07](https://github.com/directionally-local/installer/commit/8f30f077cff3bf73db79f19dcce6a25bc991cc02))

## [0.52.0](https://github.com/directionally-local/installer/compare/v0.51.0...v0.52.0) (2026-11-27)


### Features

* **free:** post new feedback to Slack ([#486](https://github.com/directionally-local/installer/issues/486)) ([83f87df](https://github.com/directionally-local/installer/commit/83f87df6bf679ea0e6900dfecaf1f02ebf8ffc43))
* **laptop:** name dl's provider for the plan in every agent ([#487](https://github.com/directionally-local/installer/issues/487)) ([59230eb](https://github.com/directionally-local/installer/commit/59230eb7683d95fe3102b5bace9fc7c2a4cef63c))


### Bug Fixes

* **deps:** install Autopilot 3.36.1 ([#489](https://github.com/directionally-local/installer/issues/489)) ([03268eb](https://github.com/directionally-local/installer/commit/03268eb8ec440646977b850b0b114633176ef1cf))
* **free:** retry short rate limits and stop refusals looking like logins ([#488](https://github.com/directionally-local/installer/issues/488)) ([b94cf79](https://github.com/directionally-local/installer/commit/b94cf79d65978027bf44835804aff44645ef4dd3))
* **free:** show our message in Claude Code for plan, dl-only, bar and blocked refusals ([#490](https://github.com/directionally-local/installer/issues/490)) ([75e65c5](https://github.com/directionally-local/installer/commit/75e65c508722bda09854c53decd60cd283b300a5))
* **test:** read npm pack --json from npm 12 as well ([#483](https://github.com/directionally-local/installer/issues/483)) ([66dbd17](https://github.com/directionally-local/installer/commit/66dbd17f6bd7668a6438723a1151949f4c0a50b5))

## [0.51.0](https://github.com/directionally-local/installer/compare/v0.50.0...v0.51.0) (2026-11-27)


### Features

* dl codex and POST /v1/responses, so Codex CLI runs on dl ([#476](https://github.com/directionally-local/installer/issues/476)) ([3569319](https://github.com/directionally-local/installer/commit/3569319622782955e03228df7546250c083a0145))
* **free:** admin credit-tokens route to give back tokens an upstream fault charged ([#474](https://github.com/directionally-local/installer/issues/474)) ([b3299d6](https://github.com/directionally-local/installer/commit/b3299d60c9c85b79ffbe7cb3376b3ab74593b81c))
* **free:** Autopilot-only keys from the dl key, so the GPT-6 launch bonus works in Autopilot launched by dl ([#477](https://github.com/directionally-local/installer/issues/477)) ([b42e850](https://github.com/directionally-local/installer/commit/b42e850803b79718f8b003a2f240e4b41f2bcbaf))
* router tracking: which coding agent people pick, and whether they stay and pay ([#478](https://github.com/directionally-local/installer/issues/478)) ([75bf8e2](https://github.com/directionally-local/installer/commit/75bf8e2356e80a828aff3630f6e1ae0a143e2b30))


### Bug Fixes

* **deps:** pin autopilot-ai 3.35.0 ([#481](https://github.com/directionally-local/installer/issues/481)) ([0391589](https://github.com/directionally-local/installer/commit/03915894bfc94b05575739c8582fb3dd4b6be04b))
* **free:** chat replies keep only OpenAI's top-level fields ([#480](https://github.com/directionally-local/installer/issues/480)) ([bd853e1](https://github.com/directionally-local/installer/commit/bd853e152fa5a1d73c524857e696fb67973e7ea8))
* **free:** keep upstream costs out of client replies ([#475](https://github.com/directionally-local/installer/issues/475)) ([6cb9e07](https://github.com/directionally-local/installer/commit/6cb9e07459b998824f4558afe199027c0b38640f))
* **free:** shape requests to Open Relay's rules and skip it while it asks for a wait ([#471](https://github.com/directionally-local/installer/issues/471)) ([f055785](https://github.com/directionally-local/installer/commit/f0557857aae333f3415f43749e44d35fa1127f7d))
* **install:** install Node, Docker and Tailscale from signed apt repositories ([#473](https://github.com/directionally-local/installer/issues/473)) ([25dd078](https://github.com/directionally-local/installer/commit/25dd078eef6e212e186516dcb4a1878173e53548))
* **laptop:** name dl's models in every agent's picker; Autopilot on any saved dl key ([#482](https://github.com/directionally-local/installer/issues/482)) ([4275a34](https://github.com/directionally-local/installer/commit/4275a345cf7258107dec77b7479775197b8135e3))
* publish npm-shrinkwrap.json so installs pin transitive dependencies ([#472](https://github.com/directionally-local/installer/issues/472)) ([b0159de](https://github.com/directionally-local/installer/commit/b0159de6bb0f93f1e82f997f7967c1cad523bc66))

## [0.50.0](https://github.com/directionally-local/installer/compare/v0.49.1...v0.50.0) (2026-11-27)


### Features

* **laptop:** Autopilot first in the picker; plan models in each agent ([#469](https://github.com/directionally-local/installer/issues/469)) ([940ee02](https://github.com/directionally-local/installer/commit/940ee02976a75b6c5a790e150b1553af2e592528))


### Bug Fixes

* **deps:** pin autopilot-ai 3.34.1 ([#467](https://github.com/directionally-local/installer/issues/467)) ([d93e1af](https://github.com/directionally-local/installer/commit/d93e1aff1b1b5208dbc10be58a095e4eb4a56702))
* **free:** drop degenerate upstream streams and retry on the next upstream ([#470](https://github.com/directionally-local/installer/issues/470)) ([0d94511](https://github.com/directionally-local/installer/commit/0d9451156028a56344a1881142a08212620311ba))
* **free:** never advise discarding the conversation on an unknown refusal ([#465](https://github.com/directionally-local/installer/issues/465)) ([0648cac](https://github.com/directionally-local/installer/commit/0648cac2b97cfae70c1540c5d0dce46ab41c52e6))
* **free:** repair broken tool histories and retry Open Relay's opaque 400 ([#463](https://github.com/directionally-local/installer/issues/463)) ([80680b3](https://github.com/directionally-local/installer/commit/80680b301c8e8bf34269ef273a9605ba86945980))
* **install:** require https for the advertised install command ([#468](https://github.com/directionally-local/installer/issues/468)) ([4ee36bd](https://github.com/directionally-local/installer/commit/4ee36bd003e67b7707078dcb16f764c0289d5977))

## [0.49.1](https://github.com/directionally-local/installer/compare/v0.49.0...v0.49.1) (2026-11-26)


### Bug Fixes

* **deps:** pin autopilot-ai 3.34.0 ([#460](https://github.com/directionally-local/installer/issues/460)) ([775e926](https://github.com/directionally-local/installer/commit/775e926f42a6a752329b31d1b1eac5e8aae6e45b))

## [0.49.0](https://github.com/directionally-local/installer/compare/v0.48.0...v0.49.0) (2026-11-26)


### Features

* **laptop:** small touches on dl's first run, and honest sign-in wording on a headless box ([#458](https://github.com/directionally-local/installer/issues/458)) ([a3fa73d](https://github.com/directionally-local/installer/commit/a3fa73dd1992165d5fe31aeebe1d4176f113a66a))


### Bug Fixes

* **autopilot:** run dl's own Autopilot at the pin, and install 3.33.0 ([#457](https://github.com/directionally-local/installer/issues/457)) ([b80110e](https://github.com/directionally-local/installer/commit/b80110eb1b99934be7be5655240ca6fd06fed344))
* **free:** treat every coding agent the same on the free tier ([#449](https://github.com/directionally-local/installer/issues/449)) ([484d762](https://github.com/directionally-local/installer/commit/484d76272debb362a38d3f1133c70b63f43ae1f4))

## [0.48.0](https://github.com/directionally-local/installer/compare/v0.47.0...v0.48.0) (2026-11-26)


### Features

* **free:** POST /v1/agent-request for coding agents dl doesn't support yet ([#450](https://github.com/directionally-local/installer/issues/450)) ([10b474f](https://github.com/directionally-local/installer/commit/10b474fd705774b0541f4e5393428a44cab9ce7b))
* **laptop:** dl routes your own coding agent; Autopilot becomes optional ([#452](https://github.com/directionally-local/installer/issues/452)) ([b1b3571](https://github.com/directionally-local/installer/commit/b1b35717546f8f475ee1c40a2900ddc1f5ed365e))

## [0.47.0](https://github.com/directionally-local/installer/compare/v0.46.0...v0.47.0) (2026-11-26)


### Features

* dl zed and dl acp, dl's Autopilot in Zed, T3 Code and other ACP editors ([#359](https://github.com/directionally-local/installer/issues/359)) ([b1ac232](https://github.com/directionally-local/installer/commit/b1ac2322604b56aa17a681b853a14ad5d58526c8))
* **free:** /v1/me token limits in real tokens; limit refusals name the limit ([#375](https://github.com/directionally-local/installer/issues/375)) ([9245801](https://github.com/directionally-local/installer/commit/9245801dd7155c830eb6212505b39ed94c8f6cf4))
* **free:** 24-hour refund window, no refund once a weekly limit is reached, terms consent at Checkout ([#362](https://github.com/directionally-local/installer/issues/362)) ([a27b7bd](https://github.com/directionally-local/installer/commit/a27b7bd00381f670956de2d1f0301d3b8fbbfff9))
* **free:** API keys from api.dl.new (/web/keys), lastTool, and the API at api.dl.new ([#355](https://github.com/directionally-local/installer/issues/355)) ([3b94363](https://github.com/directionally-local/installer/commit/3b94363eebf5434951db621b9667f39b011ad36b))
* **free:** dl.new free trials: a card trial on every plan and a no-card trial after GitHub ([#365](https://github.com/directionally-local/installer/issues/365)) ([0aafa10](https://github.com/directionally-local/installer/commit/0aafa10eafd28625d54ff7d742d4c7118d431a95))
* **free:** dl.new launch offer (50% off the first month, 27-30 Nov), freeForever, no public refund promise ([#364](https://github.com/directionally-local/installer/issues/364)) ([d34da3d](https://github.com/directionally-local/installer/commit/d34da3dec01bba83bd50e277e6672a5f0f2e2539))
* **free:** dl.new paid plans: accounts without GitHub, checkout first, dl_sk_ keys, cli-login ([#358](https://github.com/directionally-local/installer/issues/358)) ([fbeee3d](https://github.com/directionally-local/installer/commit/fbeee3d0c9fa934680450fd2532605781b710f40))
* **free:** email the owner on every plan trial, payment, plan change and cancellation ([#373](https://github.com/directionally-local/installer/issues/373)) ([5a36718](https://github.com/directionally-local/installer/commit/5a367182c24ef53291b5753c01d5be6d36c00b11))
* **free:** Free plan behind one switch (freePlan, default off) ([#377](https://github.com/directionally-local/installer/issues/377)) ([23f473c](https://github.com/directionally-local/installer/commit/23f473c0522259ffd14b756576b6d7df0fb79580))
* **free:** hold a verified sign-in with no account until Checkout ([#370](https://github.com/directionally-local/installer/issues/370)) ([c5aa629](https://github.com/directionally-local/installer/commit/c5aa62985ecd80f0214b3ee5a447eef0dff9bd46))
* **free:** old free-tier accounts become Free plan accounts at freeEndsAt ([#423](https://github.com/directionally-local/installer/issues/423)) ([9aa2604](https://github.com/directionally-local/installer/commit/9aa26044cd4570a50df84dbe9157ab3c50704013))
* **free:** paid plans with per-model weekly limits, fallback, 80% warnings, free-tier end and GPT-6 launch bonus ([#357](https://github.com/directionally-local/installer/issues/357)) ([901868b](https://github.com/directionally-local/installer/commit/901868b4368d45f73525360f8d11e87a7b82f3ef))
* **free:** provider inquiry endpoint for dl.new/providers ([#369](https://github.com/directionally-local/installer/issues/369)) ([cbdfe89](https://github.com/directionally-local/installer/commit/cbdfe894e8d28ec19423e2bf0768e41ecb3c3400))
* **free:** send bulk email through Resend, keep codes on the binding ([#371](https://github.com/directionally-local/installer/issues/371)) ([4a3527f](https://github.com/directionally-local/installer/commit/4a3527f31c0bd0c685ecf63c9cd769e4175e8e26))
* **free:** wire dl.new's paid accounts to the plan limits, welcome and Monday emails, email budget ([#361](https://github.com/directionally-local/installer/issues/361)) ([39c43d5](https://github.com/directionally-local/installer/commit/39c43d5f3e839517dbd19c361e6fde27a2927390))


### Bug Fixes

* **cli:** confirm a new server's SSH host key before sending it secrets ([#428](https://github.com/directionally-local/installer/issues/428)) ([17c4a20](https://github.com/directionally-local/installer/commit/17c4a207406401352436a3b091c5911829a4c8f2))
* **cli:** dl -- ARGS without a terminal, T3 Code's OpenCode, dl claude's stdout, api-key URLs ([#368](https://github.com/directionally-local/installer/issues/368)) ([1e19c2b](https://github.com/directionally-local/installer/commit/1e19c2bc95f46d85c38c7cfb39674bccc901418a))
* **cli:** dl t3 asks before turning on OpenCode in T3 Code's settings ([#424](https://github.com/directionally-local/installer/issues/424)) ([44584c6](https://github.com/directionally-local/installer/commit/44584c6815be9a0653d0919678f4ea4df867b6d3))
* **cli:** honour DL_NO_TELEMETRY, DO_NOT_TRACK and CI for session events ([#419](https://github.com/directionally-local/installer/issues/419)) ([db02d03](https://github.com/directionally-local/installer/commit/db02d0378b5e77d99643a6116f5ba3dacd9adf97)), closes [#394](https://github.com/directionally-local/installer/issues/394)
* **cli:** open only http(s) URLs, and never through cmd.exe ([#414](https://github.com/directionally-local/installer/issues/414)) ([403565d](https://github.com/directionally-local/installer/commit/403565db6d4ffcab93090c44eb5588df39b8d9db))
* **cli:** refuse to start Claude Code when its settings hold an Anthropic key ([#433](https://github.com/directionally-local/installer/issues/433)) ([1f023e3](https://github.com/directionally-local/installer/commit/1f023e3f07440c90e106b972c18b67bf4d054a50)), closes [#395](https://github.com/directionally-local/installer/issues/395)
* **cli:** strip control characters from remote strings before printing ([#418](https://github.com/directionally-local/installer/issues/418)) ([2a40b28](https://github.com/directionally-local/installer/commit/2a40b2812c2eb58da36d84dfb5d90c8bc29b03e8))
* **deps:** bump autopilot-ai ([#446](https://github.com/directionally-local/installer/issues/446)) ([bd0af7b](https://github.com/directionally-local/installer/commit/bd0af7b3974622d017ba143d29ba8d508fde64ec))
* **free:** cancel plan subscriptions nobody can use ([#429](https://github.com/directionally-local/installer/issues/429)) ([a1b8a5d](https://github.com/directionally-local/installer/commit/a1b8a5d6d891d5df5d38eef7e369daa6801f159f))
* **free:** cap rawLogKeepDays so it can never mean "keep forever" ([#430](https://github.com/directionally-local/installer/issues/430)) ([ef9baf2](https://github.com/directionally-local/installer/commit/ef9baf25ec016f21c413bcd55dd0bb91c2c083d2))
* **free:** derive per-purpose subkeys of TOKEN_SIGNING_KEY with HKDF ([#442](https://github.com/directionally-local/installer/issues/442)) ([42b1c78](https://github.com/directionally-local/installer/commit/42b1c783a3096e69c713261332fc63e3263436fc))
* **free:** don't promise a card trial to an account that already had one ([#431](https://github.com/directionally-local/installer/issues/431)) ([245b17d](https://github.com/directionally-local/installer/commit/245b17dd55c771f7a80012d9b78189ac6945b680)), closes [#379](https://github.com/directionally-local/installer/issues/379)
* **free:** estimate a cut-off request at the plan mix's cached share until a person's own is known ([#435](https://github.com/directionally-local/installer/issues/435)) ([fc96020](https://github.com/directionally-local/installer/commit/fc96020e9ab8170f4f96ccb8ce8293d9b6e01aaa)), closes [#381](https://github.com/directionally-local/installer/issues/381)
* **free:** hash the network in rate-limit keys and prune refilled buckets ([#422](https://github.com/directionally-local/installer/issues/422)) ([1e42233](https://github.com/directionally-local/installer/commit/1e42233e0850345c6189ed810a9db0791a06d309))
* **free:** honour the 14-day withdrawal right when Checkout had no waiver ([#426](https://github.com/directionally-local/installer/issues/426)) ([e804ec8](https://github.com/directionally-local/installer/commit/e804ec8c1b21971022087643e795ea839490fff6)), closes [#382](https://github.com/directionally-local/installer/issues/382)
* **free:** keep cancel_at_period_end when an event doesn't carry it ([#415](https://github.com/directionally-local/installer/issues/415)) ([9dde8a2](https://github.com/directionally-local/installer/commit/9dde8a21ba91932a32557fe55f89ffea2362ab27)), closes [#383](https://github.com/directionally-local/installer/issues/383)
* **free:** keep quoted prompt text out of stored use descriptions ([#427](https://github.com/directionally-local/installer/issues/427)) ([d187e88](https://github.com/directionally-local/installer/commit/d187e88913be80bacdd7bfeaeb0518f0a94d1dc5))
* **free:** leave card-trial tokens out of the refund's weekly-limit check ([#416](https://github.com/directionally-local/installer/issues/416)) ([e20db63](https://github.com/directionally-local/installer/commit/e20db63ff90d32787de66e06e7cc2c8cb0050259)), closes [#384](https://github.com/directionally-local/installer/issues/384)
* **free:** never echo a provider's refusal message to clients ([#440](https://github.com/directionally-local/installer/issues/440)) ([e8f5d7b](https://github.com/directionally-local/installer/commit/e8f5d7b001517245410c76ab13156f54234555f8)), closes [#389](https://github.com/directionally-local/installer/issues/389)
* **free:** plan-aware wording for provider blocks, plan_limit on a retry's or fallback's reservation ([#439](https://github.com/directionally-local/installer/issues/439)) ([9092e95](https://github.com/directionally-local/installer/commit/9092e959232c416c17c3c9a584fe4657fb9b500f)), closes [#388](https://github.com/directionally-local/installer/issues/388)
* **free:** put the launch coupon on card-trial Checkouts ([#372](https://github.com/directionally-local/installer/issues/372)) ([ed4bfab](https://github.com/directionally-local/installer/commit/ed4bfabdcbcac13f431a784b99ce3034b0a185cf))
* **free:** read x-forwarded-for only behind TRUST_X_FORWARDED_FOR ([#434](https://github.com/directionally-local/installer/issues/434)) ([4dbc377](https://github.com/directionally-local/installer/commit/4dbc37731e1b1cd088aa8f141137dd06a7d36d2c))
* **free:** report the served model on /anthropic, not the claude-* name asked for ([#437](https://github.com/directionally-local/installer/issues/437)) ([9e249d6](https://github.com/directionally-local/installer/commit/9e249d6391fbc0d030cd2a4517749106bf2568e4)), closes [#386](https://github.com/directionally-local/installer/issues/386)
* **free:** set x-dl-fallback when a plan, trial or the Free plan moves a request to DeepSeek ([#436](https://github.com/directionally-local/installer/issues/436)) ([614f784](https://github.com/directionally-local/installer/commit/614f784a2e69c24b1c07da4bd7ebceabee43847f)), closes [#385](https://github.com/directionally-local/installer/issues/385)
* **free:** take an invoice's plan from its charged lines, not a proration credit ([#417](https://github.com/directionally-local/installer/issues/417)) ([5124c7d](https://github.com/directionally-local/installer/commit/5124c7d32573bbe215f0d5edea686ee0d19e1b6a)), closes [#380](https://github.com/directionally-local/installer/issues/380)
* **free:** throttle the device-code browser steps and same-origin /device/deny ([#432](https://github.com/directionally-local/installer/issues/432)) ([165c90c](https://github.com/directionally-local/installer/commit/165c90c2d639d9fd428c2047d1c737293e7a2b22))
* **install:** keep server secrets from vendor installers; npm fallback without dependency scripts; warn on sudo without DL_MODE ([#441](https://github.com/directionally-local/installer/issues/441)) ([11d20f6](https://github.com/directionally-local/installer/commit/11d20f654cb53d4e80f672c726eee58ab99a5769))
* **name:** validate dnsTarget, hide it from public reads, add admin revoke ([#420](https://github.com/directionally-local/installer/issues/420)) ([f77ee06](https://github.com/directionally-local/installer/commit/f77ee062e0907f87d4e0b1581c91db333e04a7ea)), closes [#399](https://github.com/directionally-local/installer/issues/399) [#397](https://github.com/directionally-local/installer/issues/397)
* **remote-install:** bootstrap from a private mktemp -d directory, removed after it runs ([#443](https://github.com/directionally-local/installer/issues/443)) ([77e24ee](https://github.com/directionally-local/installer/commit/77e24ee82235a548be0e99771633b5215507315e))
* **self-update:** run the install script shipped in dl's package, not one fetched at update time ([#445](https://github.com/directionally-local/installer/issues/445)) ([dabea5d](https://github.com/directionally-local/installer/commit/dabea5dd64096eb303daa37a26ea4e8f4e03b39f))
* **site:** show browsers install.sh as plain text at /install.sh ([#444](https://github.com/directionally-local/installer/issues/444)) ([2487024](https://github.com/directionally-local/installer/commit/248702409bff3100fe2629e3903984d3d2bcf0e8))

## [0.46.0](https://github.com/directionally-local/installer/compare/v0.45.1...v0.46.0) (2026-11-24)


### Features

* **free:** API keys for any tool (dl api-key) ([#352](https://github.com/directionally-local/installer/issues/352)) ([a128f13](https://github.com/directionally-local/installer/commit/a128f137888481d62751d61d638b7e209b618c1e))
* **free:** country rules for GPT-6 and embargoed countries ([#345](https://github.com/directionally-local/installer/issues/345)) ([23aabb9](https://github.com/directionally-local/installer/commit/23aabb921f7c6ee543f1901184dcb4ecc1e37ef7))
* **free:** GLM 5.3 Flash on Liquid Inference first, Open Relay as backup ([#347](https://github.com/directionally-local/installer/issues/347)) ([bca46df](https://github.com/directionally-local/installer/commit/bca46df15463d1228dca650920f7c6b8d6e954db))
* **free:** global caps count every provider, runway alerts, access-request email cap ([#349](https://github.com/directionally-local/installer/issues/349)) ([22a503f](https://github.com/directionally-local/installer/commit/22a503f86abe87a98b4b531e0ea6983acbd17d42))
* **free:** Monday "tokens reset" email (weekly_reset) ([#354](https://github.com/directionally-local/installer/issues/354)) ([6c50192](https://github.com/directionally-local/installer/commit/6c50192e5fc5d17c6726e7a97199a71f3f5d020f))
* **free:** Open Relay as a registry provider, GLM 5.3 Flash free for everyone ([#346](https://github.com/directionally-local/installer/issues/346)) ([66baeed](https://github.com/directionally-local/installer/commit/66baeedf6eedc6ec77aa15edb6956c05f16ced64))
* **free:** remove country rules ([#348](https://github.com/directionally-local/installer/issues/348)) ([48fc43a](https://github.com/directionally-local/installer/commit/48fc43a2d161e5cf4c8a8480b2341914f1ee055b))
* **free:** serve GPT-6 in Autopilot only; other agents get DeepSeek ([#342](https://github.com/directionally-local/installer/issues/342)) ([e3bb947](https://github.com/directionally-local/installer/commit/e3bb947c363518ff62ba5181400debee7a386d10))
* **free:** sign-up rules that scale with a busy launch, plus event codes ([#350](https://github.com/directionally-local/installer/issues/350)) ([373e2b0](https://github.com/directionally-local/installer/commit/373e2b08297dbbd8d9e9c36311a7e3f6e233eec6))
* **free:** storage size in metrics, rollups and raw log retention ([#351](https://github.com/directionally-local/installer/issues/351)) ([fd6107d](https://github.com/directionally-local/installer/commit/fd6107d03b3df156f987ba4b251cfc5add00b496))


### Bug Fixes

* **free:** charge failed and cut-off requests a realistic estimate, not the reservation ([#353](https://github.com/directionally-local/installer/issues/353)) ([5e2e224](https://github.com/directionally-local/installer/commit/5e2e2240659f53cf5f450f18fba21a7765aeaef6))

## [0.45.1](https://github.com/directionally-local/installer/compare/v0.45.0...v0.45.1) (2026-11-23)


### Bug Fixes

* **deps:** install Autopilot 3.30.0 ([#340](https://github.com/directionally-local/installer/issues/340)) ([00fed7e](https://github.com/directionally-local/installer/commit/00fed7e0ebe1012c2f807aee2789cc798deee69d))

## [0.45.0](https://github.com/directionally-local/installer/compare/v0.44.0...v0.45.0) (2026-11-23)


### Features

* dl proxy and dl conductor, desktop apps on dl's free tier ([#334](https://github.com/directionally-local/installer/issues/334)) ([073810c](https://github.com/directionally-local/installer/commit/073810c6d58b96b72429be37275bfb8cf2493737))
* **free:** count dl.new link campaigns per day (visits, clicks, sign-ups) ([#337](https://github.com/directionally-local/installer/issues/337)) ([28a2262](https://github.com/directionally-local/installer/commit/28a22629713a3eec300fae909bfc31796f532712))
* **free:** Kimi K3.1 Pro is a dl Pro perk, with a weekly ration stated upfront ([#338](https://github.com/directionally-local/installer/issues/338)) ([46962c9](https://github.com/directionally-local/installer/commit/46962c9d125fdb7134521802d4a547d1d477e926))
* **laptop:** dl t3 runs T3 Code's server with Claude Code and OpenCode on free tokens ([#336](https://github.com/directionally-local/installer/issues/336)) ([9cda9be](https://github.com/directionally-local/installer/commit/9cda9be9f9e5de9d2b234a3191149bfee18fbcc0))


### Bug Fixes

* **deps:** install Autopilot 3.29.0 ([#339](https://github.com/directionally-local/installer/issues/339)) ([deb813a](https://github.com/directionally-local/installer/commit/deb813a8dd1f796da17912ef670a1aad5f4c80e0))

## [0.44.0](https://github.com/directionally-local/installer/compare/v0.43.0...v0.44.0) (2026-11-23)


### Features

* **free:** dl claude / dl opencode say Autopilot gets 2x the free allowance ([#328](https://github.com/directionally-local/installer/issues/328)) ([5496424](https://github.com/directionally-local/installer/commit/54964242925deb021f6bb9eb514d03ada692b744))
* **model:** default to vLLM; hide the experimental engine option for now ([#319](https://github.com/directionally-local/installer/issues/319)) ([316e227](https://github.com/directionally-local/installer/commit/316e2274b4f2a40e913a8bbfe7496c0fdfa2f737))


### Bug Fixes

* **deps:** install Autopilot 3.28.2 ([#329](https://github.com/directionally-local/installer/issues/329)) ([1bf8e05](https://github.com/directionally-local/installer/commit/1bf8e05c9980c6a7af550664e0ea6edd9f2dd180))
* **free:** dl status shows DeepSeek's allowance; precise model and GPT-6 refusals; Claude Code session ids ([#327](https://github.com/directionally-local/installer/issues/327)) ([68ffe4f](https://github.com/directionally-local/installer/commit/68ffe4f83d9cf90751c55026f6873abfc7d52271))

## [0.43.0](https://github.com/directionally-local/installer/compare/v0.42.0...v0.43.0) (2026-11-20)


### Features

* **free:** broadcasts can skip people who got an earlier broadcast (skipIfSent) ([#295](https://github.com/directionally-local/installer/issues/295)) ([044468d](https://github.com/directionally-local/installer/commit/044468db6f03bf6d64ed60c7cf3ef51f2b123a32))
* **free:** keep security work off GPT-6, serve it with DeepSeek only ([#300](https://github.com/directionally-local/installer/issues/300)) ([b616b73](https://github.com/directionally-local/installer/commit/b616b7313740f5a8180872c55ce01bb7a7a38c27))
* **free:** short automated description and safety label per session ([#299](https://github.com/directionally-local/installer/issues/299)) ([8c618ae](https://github.com/directionally-local/installer/commit/8c618ae0144e5a183eef4d054eed0d3397b5f8ab))


### Bug Fixes

* **deps:** install Autopilot 3.28.1 ([#302](https://github.com/directionally-local/installer/issues/302)) ([5ae1d4e](https://github.com/directionally-local/installer/commit/5ae1d4ecc1d08a9e52a6a602b6873bcba5d116f2))
* **free:** default dl opencode to DeepSeek V4.1 Flash ([#301](https://github.com/directionally-local/installer/issues/301)) ([46a8e7b](https://github.com/directionally-local/installer/commit/46a8e7b8977ede3cb7009103678c8c5dec3fabb1))
* **free:** read whole requests for abuse, not just the first 4 KB ([#303](https://github.com/directionally-local/installer/issues/303)) ([661b748](https://github.com/directionally-local/installer/commit/661b74861f3bdcb536e12357db9073d96f724754))
* **free:** start a checkout without a customer saved from an old Stripe account ([#293](https://github.com/directionally-local/installer/issues/293)) ([cbdda3a](https://github.com/directionally-local/installer/commit/cbdda3ae5aab752e7e8f220f75396ddb6e97fce9))

## [0.42.0](https://github.com/directionally-local/installer/compare/v0.41.0...v0.42.0) (2026-11-20)


### Features

* **agent:** pick the coding agent for the GPU box's own model ([#289](https://github.com/directionally-local/installer/issues/289)) ([46ab55a](https://github.com/directionally-local/installer/commit/46ab55ad927866c478905d1e6d3fa19804d34bd7))
* **ui:** team chat from the GPU first run, HTTPS only, admin in the browser, 2FA on ([#278](https://github.com/directionally-local/installer/issues/278)) ([0efd182](https://github.com/directionally-local/installer/commit/0efd1824a358cdf6e766688087ca5430847bbc54))


### Bug Fixes

* **deps:** install Autopilot 3.28.0 ([#292](https://github.com/directionally-local/installer/issues/292)) ([57fa89f](https://github.com/directionally-local/installer/commit/57fa89f68101b21a8479ed4a61d67f0be3422b2f))

## [0.41.0](https://github.com/directionally-local/installer/compare/v0.40.0...v0.41.0) (2026-11-19)


### Features

* dl opencode runs OpenCode on the free tier (every model) ([#288](https://github.com/directionally-local/installer/issues/288)) ([f4bb45e](https://github.com/directionally-local/installer/commit/f4bb45edb13ae28ba5914faad1f66628dd6533a3))


### Bug Fixes

* **free:** accept system-role messages on the Anthropic endpoint ([#285](https://github.com/directionally-local/installer/issues/285)) ([ebb600b](https://github.com/directionally-local/installer/commit/ebb600b31651c6def354c1aea3c4f7e5c5253e0c))
* **free:** DeepSeek requests may ask for up to 65,536 output tokens ([#283](https://github.com/directionally-local/installer/issues/283)) ([ba626a1](https://github.com/directionally-local/installer/commit/ba626a1ad573854cc98cb66d334d7ca5975d8d32))

## [0.40.0](https://github.com/directionally-local/installer/compare/v0.39.0...v0.40.0) (2026-11-19)


### Features

* dl claude runs Claude Code on the free tier (DeepSeek) ([#281](https://github.com/directionally-local/installer/issues/281)) ([ac9d257](https://github.com/directionally-local/installer/commit/ac9d2576dc38927df59262805cffca1c1a3b9e42))
* **model:** engine choice step for models the optimized engine serves ([#279](https://github.com/directionally-local/installer/issues/279)) ([4f43d24](https://github.com/directionally-local/installer/commit/4f43d249f63b0f02d8d2f70b3bbae16405432361))


### Bug Fixes

* **free:** exempt Pro from otherHarnessShare ([#282](https://github.com/directionally-local/installer/issues/282)) ([8c9b621](https://github.com/directionally-local/installer/commit/8c9b621d5f1bac1d99bde8599c93485aec7819ff))

## [0.39.0](https://github.com/directionally-local/installer/compare/v0.38.0...v0.39.0) (2026-11-18)


### Features

* **evals:** bring your data runs on promptfoo ([#276](https://github.com/directionally-local/installer/issues/276)) ([e3a7896](https://github.com/directionally-local/installer/commit/e3a78961290ecc798739973061eda2a8297efe5d))
* **model:** dl evals, bring your data ([#273](https://github.com/directionally-local/installer/issues/273)) ([a0a816e](https://github.com/directionally-local/installer/commit/a0a816e696585e6e78b2cecd821f201076bb9864))
* **ui:** dl ui runs Open WebUI as team chat next to the model ([#275](https://github.com/directionally-local/installer/issues/275)) ([ce63ed5](https://github.com/directionally-local/installer/commit/ce63ed5b7fde314169e3958c32d51f0750b03c8b))


### Bug Fixes

* **deps:** install Autopilot 3.27.0 ([#277](https://github.com/directionally-local/installer/issues/277)) ([450ebbc](https://github.com/directionally-local/installer/commit/450ebbc499e30595ff1b9ee715e72cf2709427fb))

## [0.38.0](https://github.com/directionally-local/installer/compare/v0.37.0...v0.38.0) (2026-11-18)


### Features

* **free:** referral bonus adds to the one-time trial ([#269](https://github.com/directionally-local/installer/issues/269)) ([25f1429](https://github.com/directionally-local/installer/commit/25f14295f049948e7fdb67cf856665274ac6043e))
* **model:** dl evals, bring your command, and the update gate ([#272](https://github.com/directionally-local/installer/issues/272)) ([5dd6bca](https://github.com/directionally-local/installer/commit/5dd6bcafcb0e404bfcb56bc81fedd792d23d3639))

## [0.37.0](https://github.com/directionally-local/installer/compare/v0.36.0...v0.37.0) (2026-11-18)


### Features

* **free:** web sign-up from dl.new with a one-time install command ([#264](https://github.com/directionally-local/installer/issues/264)) ([9a9f555](https://github.com/directionally-local/installer/commit/9a9f5556ca402139142ff8c43a9dfb9b41149461))


### Bug Fixes

* **deps:** install Autopilot 3.26.0 ([#266](https://github.com/directionally-local/installer/issues/266)) ([7068a6b](https://github.com/directionally-local/installer/commit/7068a6ba32ef2e3c37559ff1c442e2c0038498a4))

## [0.36.0](https://github.com/directionally-local/installer/compare/v0.35.1...v0.36.0) (2026-11-17)


### Features

* **free:** one-time trial for new accounts, with a paywall when it runs out ([6baab58](https://github.com/directionally-local/installer/commit/6baab5804902e1aecb779265593895c495bb18ab))
* **free:** one-time trial for new accounts, with a paywall when it runs out ([f165e3b](https://github.com/directionally-local/installer/commit/f165e3b957c5101673ab50efc65b68db42631133))


### Bug Fixes

* **deps:** install Autopilot 3.25.0 ([0c7f452](https://github.com/directionally-local/installer/commit/0c7f452cf88db4656a691dae78456ca40590529a))
* **deps:** install Autopilot 3.25.0 ([8c5c4c4](https://github.com/directionally-local/installer/commit/8c5c4c45b4180f963410638b09a64af4660e5323))

## [0.35.1](https://github.com/directionally-local/installer/compare/v0.35.0...v0.35.1) (2026-11-16)


### Bug Fixes

* **deps:** install Autopilot 3.23.0 ([#257](https://github.com/directionally-local/installer/issues/257)) ([3dcdef4](https://github.com/directionally-local/installer/commit/3dcdef4bfcd9150ae86ae8b4e6e35b6b743e34cc))
* **deps:** install Autopilot 3.24.0 ([566a243](https://github.com/directionally-local/installer/commit/566a243ec097f62bfb85d80013519d5e1e02d444))
* **deps:** install Autopilot 3.24.0 ([6643d92](https://github.com/directionally-local/installer/commit/6643d92e8ce75aa3fb9530d330212ab50512caff))
* **free:** Checkout asks only for the address it needs ([#258](https://github.com/directionally-local/installer/issues/258)) ([3d92df6](https://github.com/directionally-local/installer/commit/3d92df61911d4769f0ae33ec3ace28ee07bc6efc))

## [0.35.0](https://github.com/directionally-local/installer/compare/v0.34.0...v0.35.0) (2026-11-16)


### Features

* **free:** admin home shows the old Kimiflare admin dashboard's data ([#254](https://github.com/directionally-local/installer/issues/254)) ([9646491](https://github.com/directionally-local/installer/commit/9646491e931b31b0a713b79f79c39629b4bf85a1))
* **free:** email the owner when someone pays ([#253](https://github.com/directionally-local/installer/issues/253)) ([903c2bc](https://github.com/directionally-local/installer/commit/903c2bc102bf3c9cc7e33d0ee75a5a75e87578f6))


### Bug Fixes

* **free:** always send our own safety_identifier to OpenAI ([#256](https://github.com/directionally-local/installer/issues/256)) ([100f330](https://github.com/directionally-local/installer/commit/100f330d61f652714375f6e2ca02cf7f7338ded7))
* **free:** home "Who's using it?" uses live budget counters, skips blocked accounts ([#251](https://github.com/directionally-local/installer/issues/251)) ([c8af739](https://github.com/directionally-local/installer/commit/c8af739101912c184a413bbf8219f6d1416ee5dd))

## [0.34.0](https://github.com/directionally-local/installer/compare/v0.33.0...v0.34.0) (2026-11-13)


### Features

* run the --workspace agent as the folder's owner, with its home outside the workspace ([#249](https://github.com/directionally-local/installer/issues/249)) ([fa1a1b6](https://github.com/directionally-local/installer/commit/fa1a1b6793de070965970c65c91d5fc95776eaca))

## [0.33.0](https://github.com/directionally-local/installer/compare/v0.32.0...v0.33.0) (2026-11-13)


### Features

* dl model up --workspace runs Autopilot in a Hotcell sandbox beside the model ([#245](https://github.com/directionally-local/installer/issues/245)) ([92c0e2f](https://github.com/directionally-local/installer/commit/92c0e2f985bb2cffc2de3060fb92e0094cc7317c))

## [0.32.0](https://github.com/directionally-local/installer/compare/v0.31.0...v0.32.0) (2026-11-13)


### Features

* dl model up/update --image runs a catalog entry in another container image ([#243](https://github.com/directionally-local/installer/issues/243)) ([124b53c](https://github.com/directionally-local/installer/commit/124b53c351c130528740a7652fa554a6133c629c))

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
