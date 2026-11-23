// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /** Raw records (original CSV files, provider pages), keyed `ds/<datasetId>/...`. */
    RETAIL_RAW: R2Bucket;
    /** Raw-storage quota per dataset in bytes, set by the operator. Default 20 GiB. */
    RETAIL_RAW_QUOTA_BYTES?: string;
    /** Above this many rows, guarded SQL refuses a full scan of a fact table. */
    RETAIL_SCAN_ROW_LIMIT?: string;
    /** `$PUBLIC_BASE_URL/gatekeeper/retail`: OAuth redirect and webhook URLs are built from it. */
    BASE_URL?: string;
    /** The Square application (deploy inputs). A `sandbox-` client id talks to Square's sandbox. */
    SQUARE_CLIENT_ID?: string;
    SQUARE_CLIENT_SECRET?: string;
    SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
    /** The Stripe App (deploy inputs). */
    STRIPE_CLIENT_ID?: string;
    STRIPE_APP_SECRET?: string;
    STRIPE_WEBHOOK_SECRET?: string;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./index.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces: "RetailDataset" | "RetailGatekeeper" | "RetailConnection" | "RetailWebhookRoute";
  }
}
