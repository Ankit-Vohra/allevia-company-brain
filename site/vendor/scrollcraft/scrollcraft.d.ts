// Types for the vendored scrollcraft engine (scrollcraft.js assigns window.ScrollCraft). Ours, not upstream.
export {};

declare global {
  interface ScrollCraftApi {
    layout(): void;
    read(): void;
    destroy(): void;
  }
  interface Window {
    ScrollCraft?: {
      mount(root: Element): ScrollCraftApi;
      reduce: boolean;
      instances: ScrollCraftApi[];
    };
  }
}
