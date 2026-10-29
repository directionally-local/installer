// Regenerates site/install-script.ts from install.sh.
//
// The Worker used to import install.sh through a Wrangler `rules` entry. celld
// supports `rules`, but `sobjects build` bundles with esbuild without applying
// them, so the portability gate failed on the .sh import. A generated module
// keeps the module graph plain TypeScript and works on every target.
import { readFile, writeFile } from "node:fs/promises";

const site = new URL("./", import.meta.url);
const script = await readFile(new URL("../install.sh", import.meta.url), "utf8");

const output = `// Generated from install.sh by \`npm run sync:site-script\`. Do not edit.
// The script is a module rather than a Wrangler Text import so the same Worker
// bundles under Wrangler, celld and the Serverless Objects native engine.
export const INSTALL_SCRIPT = ${JSON.stringify(script)};
`;

await writeFile(new URL("install-script.ts", site), output);
