# Changelog

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
