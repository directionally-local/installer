# ACP registry entry (not submitted)

`dl-autopilot/` is dl's entry for the [ACP registry](https://github.com/agentclientprotocol/registry), the list Zed (`zed: acp registry`), T3 Code ("Or choose from ACP Registry") and JetBrains IDEs install agents from. It runs `npx directionallylocal@<version> acp`, which is `dl acp`: Autopilot as an ACP agent on stdio.

To submit, once a dl release with `dl acp` is on npm (and the Autopilot it pins has `autopilot acp`):

1. Set `version` and the npx `package` to that release (`directionallylocal@X.Y.Z`; the two must match, and `@latest` is refused). After that the registry's hourly job follows new npm releases on its own.
2. Replace the placeholder `icon.svg` if there's a better mark: 16x16, one colour, `fill="currentColor"` only.
3. Fork agentclientprotocol/registry, copy `dl-autopilot/` to the repository root (the folder name must equal `id`), and check it there: `uv run --with jsonschema .github/workflows/build_registry.py` and `python3 .github/workflows/verify_agents.py --auth-check --agent dl-autopilot` (the agent must answer `initialize` with an `authMethods` entry of type `terminal` or `agent`; `dl acp` gives both).
4. Open a pull request there. CI validates the schema, the npm package, the icon and the sign-in methods; a maintainer merges.

Zed's old agent-server extensions are deprecated in favour of the registry, so no Zed extension is needed.
