import { describe, expect, it } from 'vitest'
import type { BlueprintBinding } from '@gadgets/workshop-shared/api'
import { uniqueBindingBadges } from './BlueprintCard'

const RETAIL_DATA: BlueprintBinding = {
  type: 'ambient', title: 'Retail data', description: '', vendorId: 'retail',
}

describe('uniqueBindingBadges', () => {
  it('gives no badge to a connection that is made automatically', () => {
    expect(uniqueBindingBadges({ RETAIL_DATA })).toEqual([])
    expect(uniqueBindingBadges({
      RETAIL_DATA,
      AI: { type: 'aiModel', title: 'Model', description: '' },
    })).toEqual([{ type: 'aiModel', label: 'AI Model', vendorKey: undefined }])
  })
})
