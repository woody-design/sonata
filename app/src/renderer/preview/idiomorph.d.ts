// idiomorph ships no type declarations. This is a pure-ambient module
// declaration (no top-level import/export → script context, so it is a genuine
// ambient declaration, not a module augmentation). The Preview reader is the
// only importer — the import-fence scopes the `idiomorph` package to
// `renderer/preview/`. We declare only the `morph` surface we use: childrenOnly
// morphing via `morphStyle: "innerHTML"`.
declare module "idiomorph" {
  interface IdiomorphConfig {
    morphStyle?: "outerHTML" | "innerHTML";
    ignoreActive?: boolean;
    ignoreActiveValue?: boolean;
    head?: { style?: "merge" | "append" | "morph" | "none" };
  }
  export const Idiomorph: {
    morph(oldNode: Node, newContent: Node | string, config?: IdiomorphConfig): void;
  };
}
