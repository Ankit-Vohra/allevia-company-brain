// fontkit ships no types; type.ts narrows what it uses to its own small interfaces.
declare module "fontkit" {
  export function create(bytes: Buffer, postscriptName?: string): unknown;
}
