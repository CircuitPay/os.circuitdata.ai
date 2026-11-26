import { Checkbox } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { GatekeeperIcon } from './GatekeeperIcon'
import { WorkshopInput, WorkshopInputArea } from './WorkshopControls'
import type { BlueprintBindingAnnotation, GadgetClient, GatekeeperCreationSpec } from '@gadgets/workshop-shared/api'

export type BindingCardData = {
  bindingName: string
  resourceTitle: string
  vendorId?: string
  creationSpec: GatekeeperCreationSpec
  annotation: BlueprintBindingAnnotation
}

export function suggestValueLabel(spec: GatekeeperCreationSpec, title?: string): string {
  const displayTitle = title?.trim()
  switch (spec.type) {
    case 'gatekeeper':
      return displayTitle ? `Suggest "${displayTitle}" by default` : 'Suggest this resource by default'
    case 'aiModel':
      return displayTitle ? `Suggest "${displayTitle}" by default` : 'Suggest this model by default'
    case 'agentSpawner':
      return displayTitle ? `Suggest "${displayTitle}" by default` : 'Suggest this agent setup by default'
    case 'ambient':
    case 'tenantAmbient':
      // The card offers no suggestion for a connection the Workshop makes itself, so this never renders.
      return 'Suggest this by default'
  }
}

export function BlueprintBindingCard({
  data,
  onChange,
  autoFocusDescription,
  flat = false,
}: {
  data: BindingCardData
  onChange: (annotation: BlueprintBindingAnnotation) => void
  autoFocusDescription?: boolean
  /** When true, render without the outer card chrome (border, background, divider). */
  flat?: boolean
}) {
  const { bindingName, resourceTitle, vendorId, creationSpec, annotation } = data
  const titleId = `blueprint-binding-title-${bindingName}`
  const descriptionId = `blueprint-binding-desc-${bindingName}`
  // A blueprint publishes an ambient connection under its resource's own title, with only the
  // help text taken from here, and nobody installing it picks a value to suggest.
  const automatic = creationSpec.type === 'ambient' || creationSpec.type === 'tenantAmbient'
  const displayTitle = automatic
    ? resourceTitle || bindingName
    : annotation.title || resourceTitle || bindingName

  const containerClass = flat
    ? 'space-y-3'
    : 'rounded-xl border border-kumo-line bg-kumo-base'
  const headerClass = flat
    ? 'flex items-start gap-3'
    : 'flex items-start gap-3 px-3 pt-3'
  // The footer closes the card's bottom edge; without one the help text pads it.
  const descriptionWrapperClass = flat ? '' : automatic ? 'px-3 pt-2 pb-3' : 'px-3 pt-2'
  const footerClass = flat
    ? 'flex items-center [&_label]:!text-[12px] [&_label]:!leading-4 [&_label]:!tracking-[-0.2px] [&_label]:!font-normal [&_label]:!text-kumo-subtle'
    : 'mt-2 flex items-center border-t border-kumo-line/70 px-3 py-2 [&_label]:!text-[12px] [&_label]:!leading-4 [&_label]:!tracking-[-0.2px] [&_label]:!font-normal [&_label]:!text-kumo-subtle'

  return (
    <div className={containerClass}>
      <div className={headerClass}>
        <GatekeeperIcon
          // The binding list names a vendor only for a connected account's resource.
          vendorId={creationSpec.type === 'ambient' || creationSpec.type === 'tenantAmbient' ? creationSpec.vendorId : vendorId}
          fallbackText={resourceTitle || bindingName}
        />
        <div className="min-w-0 flex-1">
          {automatic ? (
            <p className="m-0 flex min-h-8 flex-wrap items-center gap-x-2 text-[13px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
              {displayTitle}
              <span className="text-[11px] leading-4 font-normal tracking-[-0.1px] text-kumo-subtle">
                Connected automatically
              </span>
            </p>
          ) : (
            <>
              <label htmlFor={titleId} className="sr-only">Connection name</label>
              <WorkshopInput
                id={titleId}
                aria-label={`Name for ${bindingName}`}
                value={annotation.title}
                onChange={(e) => onChange({ ...annotation, title: e.target.value })}
                placeholder="Connection name"
                className="!h-8 w-full bg-kumo-base text-[13px] leading-5 font-medium tracking-[-0.25px]"
              />
            </>
          )}
          <p className="mt-1 text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
            Referenced in code as: <span className="font-mono text-kumo-subtle">{bindingName}</span>
          </p>
        </div>
      </div>

      <div className={descriptionWrapperClass}>
        <WorkshopInputArea
          id={descriptionId}
          aria-label={`Help text for ${displayTitle}`}
          value={annotation.description}
          onChange={(e) => onChange({ ...annotation, description: e.target.value })}
          placeholder={automatic ? 'What does this gadget use it for?' : 'What should people connect here?'}
          rows={2}
          autoFocus={autoFocusDescription}
          className="w-full resize-none"
        />
      </div>

      {!automatic && (
        <div className={footerClass}>
          <Checkbox
            label={suggestValueLabel(creationSpec, resourceTitle)}
            checked={annotation.suggestValue ?? false}
            onCheckedChange={(checked) =>
              onChange({ ...annotation, suggestValue: checked === true })
            }
          />
        </div>
      )}
    </div>
  )
}

export function defaultAnnotation(): BlueprintBindingAnnotation {
  return { title: '', description: '', suggestValue: false }
}

export async function loadBindingCardData(
  gadget: RpcStub<GadgetClient>,
  meta: { name: string; resourceTitle: string; vendorId?: string },
): Promise<BindingCardData | null> {
  const gk = await gadget.getBinding(meta.name)
  try {
    if (!gk) return null
    const creationSpecP = gk.getCreationSpec()
    const annotationP = gadget.getBlueprintAnnotation(meta.name)
    const [creationSpec, existing] = await Promise.all([creationSpecP, annotationP])
    return {
      bindingName: meta.name,
      resourceTitle: meta.resourceTitle,
      vendorId: meta.vendorId,
      creationSpec,
      annotation: existing ?? { ...defaultAnnotation(), title: meta.resourceTitle || meta.name },
    }
  } finally {
    gk?.[Symbol.dispose]()
  }
}
