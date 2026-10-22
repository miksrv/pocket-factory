import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp, type TestApp } from '../test/app.js'

/**
 * Before 1.8.0 a Trac step never read the change time of a Trac that heads its CSV with labels
 * (Modified), so its seen keys are bare ids; now they are `id@time`. The first run after the
 * upgrade must not hand every seen ticket over again as "changed since".
 */
describe('Trac keys across the upgrade', () => {
    let t: TestApp
    let server: http.Server
    beforeEach(async () => {
        server = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/csv' })
            res.end(
                'id,Summary,Status,Modified\r\n' +
                    '101,Old one,new,"Jul 2, 2026, 6:00:08 PM"\r\n' +
                    '102,New one,new,"Jul 3, 2026, 9:00:00 AM"\r\n'
            )
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        t = createTestApp()
        t.ctx.catalog.save('routines', 'bugs', {
            frontmatter: {
                enabled: true,
                triggers: [],
                steps: [
                    { trac: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/query?status=new` } },
                    { agent: 'orchestrator' }
                ]
            },
            body: 'Look and report.'
        })
    })
    afterEach(async () => {
        server.close()
        await t.cleanup()
    })

    it('takes a ticket seen under its bare id as seen, and hands over only the new one', async () => {
        t.ctx.store.markSeen('bugs', [{ key: '101', title: '#101 Old one' }], null)
        const run = await t.ctx.routines.fire('bugs', 'manual')
        expect(run).toMatchObject({ status: 'queued', items: 1 })
        const prompt = t.ctx.store.getTask(run.task_id!)!.prompt
        const fresh = prompt.slice(prompt.indexOf('## New since the last run'), prompt.indexOf('## Everything'))
        expect(fresh).toContain('## New since the last run (1)')
        expect(fresh).toContain('#102 New one')
        expect(fresh).not.toContain('#101')
        expect(t.ctx.store.seenKeys('bugs', ['101@Jul 2, 2026, 6:00:08 PM']).size).toBe(1)
    })
})
