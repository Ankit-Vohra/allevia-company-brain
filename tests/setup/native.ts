// libvips (sharp) runs its own thread pool and caches decoded images. Under four forked workers that has crashed a
// worker with SIGSEGV (tests/brand/upload.test.ts, once per several full runs). One libvips thread and no cache per
// worker keeps the native side small and predictable; no test depends on either. A file that never loads sharp pays nothing.
import { createRequire } from "node:module";

try {
  const sharp = createRequire(import.meta.url)("sharp") as { concurrency: (n: number) => number; cache: (o: boolean) => unknown };
  sharp.concurrency(1);
  sharp.cache(false);
} catch {
  // sharp is not installed or not loadable here: the files that need it fail on their own
}
