import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
    if (params?.name) return `${key}: ${params.name}`
    return `${ns}.${key}`
  },
  useFormatter: () => ({
    number: (n: number) => String(n),
  }),
}))

// Mock useAuth
const mockCan = vi.fn()
const mockHasFeature = vi.fn()
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    profile: { full_name: 'DR. Sujal' },
    can: mockCan,
    hasFeature: mockHasFeature,
  }),
}))

// Mock format currency & duration
vi.mock('@/lib/currency', () => ({
  formatCurrency: (val: number, cur: string) => `${cur} ${val}`,
}))

import { OverviewHeader } from './overview-header'
import { KpiRow } from './kpi-row'

describe('OverviewHeader greeting and permissions', () => {
  it('renders complete full name in greeting without splitting or truncating', () => {
    mockCan.mockReturnValue(true)
    mockHasFeature.mockReturnValue(true)

    const dummyData = {
      days: 30,
      range: { start: '2026-01-01', end: '2026-01-30' },
      attention: {
        waiting: 0,
        waitingOverTarget: 0,
        oldestWaitingSince: null,
        unassigned: 0,
        windowsClosing: 0,
        failed: 0,
        failedMessages: [],
      },
      setup: {
        hasConversations: true,
        whatsappConnected: true,
        hasContacts: true,
        hasApprovedTemplate: true,
        memberCount: 2,
      },
    } as never

    const html = renderToStaticMarkup(
      React.createElement(OverviewHeader, {
        data: dummyData,
        now: new Date('2026-01-15T09:00:00Z').getTime(),
        name: 'DR. Sujal Khedekar',
        range: 30,
        onRangeChange: () => {},
      }),
    )

    // Complete name should be included in greeting, not just "DR."
    expect(html).toContain('DR. Sujal Khedekar')
    expect(html).not.toMatch(/greeting\.[a-z]+: DR\.\s*</i)
  })

  it('filters out newDeal when user lacks pipeline permission', () => {
    mockCan.mockImplementation((area: string) => area !== 'pipelines')
    mockHasFeature.mockImplementation((feature: string) => feature !== 'pipelines')

    const html = renderToStaticMarkup(
      React.createElement(OverviewHeader, {
        data: null,
        now: Date.now(),
        name: 'DR. Sujal',
        range: 30,
        onRangeChange: () => {},
      }),
    )

    expect(html).not.toContain('/pipelines')
  })
})

describe('KpiRow dealsWon visibility', () => {
  const dummyOverview = {
    days: 30,
    replyTargetMinutes: 15,
    kpis: {
      newConversations: 10,
      newConversationsPrevious: 5,
      resolved: 8,
      resolvedPrevious: 4,
      dealsWon: 3,
      dealsWonPrevious: 1,
      dealsWonValue: 15000,
      broadcastRead: 20,
      broadcastReadPrevious: 10,
      broadcastDelivered: 25,
      broadcastDeliveredPrevious: 15,
    },
    replies: {
      medianHuman: 5,
      medianHumanPrevious: 8,
      team: [],
    },
    volume: {
      series: [],
      hourly: [],
    },
  } as never

  it('renders dealsWon when showPipelines is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(KpiRow, {
        data: dummyOverview,
        currency: 'USD',
        showPipelines: true,
      }),
    )

    expect(html).toContain('dealsWon')
    expect(html).toContain('xl:grid-cols-5')
  })

  it('hides dealsWon when showPipelines is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(KpiRow, {
        data: dummyOverview,
        currency: 'USD',
        showPipelines: false,
      }),
    )

    expect(html).not.toContain('dealsWon')
    expect(html).toContain('xl:grid-cols-4')
  })
})
