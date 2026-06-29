import { defineMiddleware } from "astro:middleware";

// Dev-only routing parity with the production nginx config (static builds have
// no runtime, so this only runs under `astro dev`):
//   /p/{id}      (one segment)  → serve the results page (island reads the id)
//   /p/{id}/{n}  (two segments) → proxied to the backend by Vite (vote)
export const onRequest = defineMiddleware((context, next) => {
  if (/^\/p\/[^/]+\/?$/.test(context.url.pathname)) {
    return context.rewrite("/results");
  }
  return next();
});
