import { Banner } from "@cloudflare/kumo";
import { EyeSlash } from "@phosphor-icons/react";

/** Customers are read through the masked view unless an administrator unmasked it (FR-022). */
const MaskedNotice = () => (
  <Banner
    icon={<EyeSlash />}
    title="Names, emails and phone numbers are hidden."
    description="An administrator can show them in Settings."
  />
);

export default MaskedNotice;
