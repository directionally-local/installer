import type { EngineId, ModelRecipe } from "./model-catalog.js";

/**
 * `--image`: run a catalog entry in another container image (a release candidate, a nightly, a
 * mirror) with the entry's flags unchanged. The catalog's pinned image stays the default.
 */

/** Each engine's official image repository on Docker Hub. */
export const OFFICIAL_REPOSITORY: Readonly<Record<EngineId, string>> = { vllm: "vllm/vllm-openai", sglang: "lmsysorg/sglang" };

export interface ImageRef {
  /** Everything before the tag and digest: [registry/]path. */
  repository: string;
  tag?: string;
  digest?: string;
}

// Docker's reference grammar (distribution/reference): lowercase path components joined by
// ".", "_", "__" or dashes; an optional registry host (with a dot or port, or "localhost");
// tags of up to 128 word characters, dots and dashes; sha256 digests of 64 hex digits.
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const REGISTRY = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::\d+)?$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** A container image reference, name[:tag][@sha256:…]; throws a clear message for anything else. */
export function parseImageRef(text: string): ImageRef {
  const bad = (why: string) => new Error(`--image takes a container image like vllm/vllm-openai:v0.34.0rc2 (name[:tag][@sha256:…]); "${text}" ${why}.`);
  if (!text.trim()) throw new Error("--image needs a container image, like vllm/vllm-openai:v0.34.0rc2.");
  if (/\s/.test(text)) throw bad("has spaces");
  if (text.startsWith("-")) throw bad("starts with a dash");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw bad("is a URL; leave out the scheme");
  if (text.length > 255 + 1 + 128 + 1 + 71) throw bad("is too long");
  let rest = text;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) throw bad("has a digest that isn't sha256: and 64 lowercase hex digits");
  }
  let tag: string | undefined;
  const slash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) throw bad("has an invalid tag (letters, digits, _ . -, at most 128, not starting with . or -)");
  }
  const parts = rest.split("/");
  const registry = parts.length > 1 && (/[.:]/.test(parts[0]!) || parts[0] === "localhost") ? parts.shift()! : undefined;
  if (registry !== undefined && !REGISTRY.test(registry)) throw bad(`has an invalid registry "${registry}"`);
  if (parts.length === 0 || parts.some((part) => !COMPONENT.test(part))) {
    throw bad(/[A-Z]/.test(parts.join("/")) ? "has capital letters in its name (image names are lowercase)" : "isn't a valid image name");
  }
  if (rest.length > 255) throw bad("has a name longer than 255 characters");
  return { repository: rest, ...(tag !== undefined ? { tag } : {}), ...(digest !== undefined ? { digest } : {}) };
}

/** "docker.io/vllm/vllm-openai" and "index.docker.io/…" are "vllm/vllm-openai". */
function canonicalRepository(repository: string): string {
  return repository.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "").replace(/^library\//, "");
}

/** Whether an image comes from the engine's official repository. */
export function isOfficial(engine: EngineId, image: string): boolean {
  return canonicalRepository(parseImageRef(image).repository) === OFFICIAL_REPOSITORY[engine];
}

/** One line when an image isn't from the engine's official repository (allowed, but said). */
export function unofficialWarning(engine: EngineId, label: string, image: string): string | undefined {
  if (isOfficial(engine, image)) return undefined;
  return `${parseImageRef(image).repository} isn't ${label}'s official image (${OFFICIAL_REPOSITORY[engine]}); using it as given.`;
}

/**
 * The image a deployment runs: the catalog's, or `override` when given and different from it.
 * `catalogImage` is set only for an override, so state, status and the plan can say so.
 */
export interface ImageChoice { image: string; catalogImage?: string }

export function chooseImage(model: Pick<ModelRecipe, "image">, override: string | undefined): ImageChoice {
  if (override === undefined || override === model.image) return { image: model.image };
  parseImageRef(override);
  return { image: override, catalogImage: model.image };
}

/**
 * The entry run in another image. The catalog's CUDA requirement is the pinned image's, so it's
 * dropped: the override's requirement is unknown (and --plan doesn't pull or inspect it).
 */
export function withImage(model: ModelRecipe, choice: ImageChoice): ModelRecipe {
  if (choice.catalogImage === undefined) return model;
  const { minCuda: _unknown, ...rest } = model;
  return { ...rest, image: choice.image };
}

/** "v0.33.0" when the catalog image shares the override's repository, else the whole reference. */
export function catalogDefaultText(image: string, catalogImage: string): string {
  const ours = parseImageRef(image);
  const theirs = parseImageRef(catalogImage);
  return canonicalRepository(ours.repository) === canonicalRepository(theirs.repository) && theirs.tag && !theirs.digest ? theirs.tag : catalogImage;
}

/** Whether `image` is one a caveat names as containing the fix (same repository and tag). */
export function namedByCaveat(image: string, fixedIn: readonly string[] | undefined): boolean {
  if (!fixedIn?.length) return false;
  const ours = parseImageRef(image);
  return fixedIn.some((named) => {
    const theirs = parseImageRef(named);
    return canonicalRepository(ours.repository) === canonicalRepository(theirs.repository) && ours.tag !== undefined && ours.tag === theirs.tag;
  });
}
