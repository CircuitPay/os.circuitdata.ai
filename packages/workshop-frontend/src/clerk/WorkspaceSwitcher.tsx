import { OrganizationSwitcher } from '@clerk/react'
import { useServerConfig } from '../ServerConfigContext'
import { useClerkBridge } from './clerkBridge'

// OrganizationSwitcher has no prop for this: whether it offers creation is a Clerk instance setting,
// which a Clerk instance shared with pooled deployments cannot turn off for one deployment.
const HIDE_CREATE_ORGANIZATION = {
  elements: { organizationSwitcherPopoverActionButton__createOrganization: { display: 'none' } },
}

/**
 * Shows the active workspace and lets the user switch between their personal workspace and
 * organizations, create one, invite members and manage them. Clerk supplies all of that; the
 * Workshop reconnects into the new tenant when the active organization changes. A deployment
 * dedicated to one organization admits nothing else, so it offers neither the personal workspace
 * nor creating organizations. Renders nothing on deployments that don't use Clerk.
 */
const WorkspaceSwitcher = () => {
  const singleOrganization = useServerConfig()?.clerk?.singleOrganization === true
  if (!useClerkBridge()) return null
  return (
    <OrganizationSwitcher
      hidePersonal={singleOrganization}
      appearance={singleOrganization ? HIDE_CREATE_ORGANIZATION : undefined}
      afterSelectOrganizationUrl="/"
      afterSelectPersonalUrl="/"
      afterCreateOrganizationUrl="/"
      afterLeaveOrganizationUrl="/"
    />
  )
}

export default WorkspaceSwitcher
