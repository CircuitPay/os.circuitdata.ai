import { describe, expect, it } from 'vitest'
import type { MessageFormatRef } from '@gadgets/workshop-shared/api'
import { locateMessageFormatRefs } from '../messageFormatRefs'

function format(noun: string): Pick<MessageFormatRef, 'noun' | 'icon'> {
  return { noun, icon: 'fileText' }
}

const report = format('Report')
const dashboard = format('Dashboard')

describe('locateMessageFormatRefs', () => {
  it('finds each noun where it ended up in the sent text', () => {
    const text = 'create a Report for the board and a Dashboard for the team'
    const refs = locateMessageFormatRefs(text, [report, dashboard])
    expect(refs).toHaveLength(2)
    expect(text.slice(refs![0].position, refs![0].position + refs![0].length)).toBe('Report')
    expect(text.slice(refs![1].position, refs![1].position + refs![1].length)).toBe('Dashboard')
  })

  it('gives each of two identical formats its own occurrence', () => {
    // Searching from the previous match is what keeps the second ref off the first "Report".
    const text = 'a Report for the board and a Report for the team'
    const refs = locateMessageFormatRefs(text, [report, report])
    expect(refs).toHaveLength(2)
    expect(refs![0].position).toBe(text.indexOf('Report'))
    expect(refs![1].position).toBe(text.lastIndexOf('Report'))
  })

  it('carries the noun and icon through for rendering', () => {
    const refs = locateMessageFormatRefs('make a Dashboard', [dashboard])
    expect(refs![0]).toMatchObject({ noun: 'Dashboard', icon: 'fileText' })
  })

  it('drops a format whose noun did not survive into the sent text', () => {
    // A slash command's arguments may not include the part of the line the format was in.
    expect(locateMessageFormatRefs('nothing here', [report])).toBeUndefined()
  })

  it('keeps the formats it can find when another is missing', () => {
    const refs = locateMessageFormatRefs('only the Dashboard made it', [report, dashboard])
    expect(refs).toHaveLength(1)
    expect(refs![0].noun).toBe('Dashboard')
  })

  it('returns undefined when no formats were named', () => {
    expect(locateMessageFormatRefs('plain message', [])).toBeUndefined()
  })
})
