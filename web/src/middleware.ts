import { defineMiddleware } from "astro:middleware";

// Dev-only routing parity with production (static builds have no runtime, so
// this only runs under `astro dev`): /p/{id} and /p/{id}/{n} both serve the
// results page, which reads the id (and vote intent) from the URL and POSTs the
// vote to the backend.
export const onRequest = defineMiddleware((context, next) => {
  if (/^\/p\/[^/]+(\/\d+)?\/?$/.test(context.url.pathname)) {
    return context.rewrite("/results");
  }
  return next();
});
