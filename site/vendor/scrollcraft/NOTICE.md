# scrollcraft engine (vendored)

`scrollcraft.js` and `scrollcraft.css` are the scroll engine from the **scroll-craft** agent skill by Nate Herk,
copied unchanged. MIT licence, see `LICENSE` in this folder.

- Source: https://github.com/nateherkai/scroll-craft
- Path in that repository: `plugins/nateherk-design/skills/scroll-craft/engine/`
- Pinned commit: `75d81f74e83692add18cd7a8a8e078b8a887a579` (release 0.3.1, 2026-09-30)
- SHA-256 at copy time (the test compares the first 16 digits):
  - `scrollcraft.js`  `4a419b3ede51f647 (first 16 hex digits)`
  - `scrollcraft.css` `e19eb3aa73b09446 (first 16 hex digits)`

**Do not edit these two files.** The skill's rule is that the engine is the mechanism and is never changed per project.
Allevia's look comes from the theme tokens and our own markup in `site/src/styles/story.css`; Allevia's own scroll
behaviour (the courier route, the goal bars) lives in `site/src/story.ts`. `tests/site/story.test.ts` checks the hashes
above, so an accidental edit fails the suite. To update, copy both files from a newer commit and change this note and
the hashes together.

`scrollcraft.d.ts` (ours, not part of the upstream engine) only tells TypeScript the shape of `window.ScrollCraft`.
