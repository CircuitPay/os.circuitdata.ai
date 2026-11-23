import type { ImportTarget } from "../src/app-api-types";

/**
 * What the Workshop host offers the Data app besides its `ui` capability (mirrors the host's
 * `GatekeeperAppHostImpl`, contracts/data-area-api.md "Host bridge additions").
 */
export interface DataAppHost {
  /** Opens a new chat with the prompt. */
  openPrompt(prompt: string): Promise<void>;
  /**
   * Lets the member pick (or upload) Files; the host hands them to `receiveTenantFiles(target, …)`
   * and returns its result, or null when the member cancels.
   */
  pickTenantFiles(request: {
    accept: string[];
    multiple: boolean;
    target: ImportTarget;
  }): Promise<{ importId: number } | null>;
  /** Opens a provider's consent page in a popup that completes through the connect handoff. */
  openConnectPopup(flow: { url: string; nonce: string }): Promise<void>;
}
