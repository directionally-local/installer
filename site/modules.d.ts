// Wrangler bundles .sh files as text (see the rules in wrangler.toml).
declare module "*.sh" {
  const text: string;
  export default text;
}
