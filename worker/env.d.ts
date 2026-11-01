// Test-only typings for the default export as seen through `cloudflare:workers`.
declare namespace Cloudflare {
  interface Exports {
    default: Fetcher;
  }
}
