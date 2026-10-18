import { describe, expect, it } from 'vitest'

import { stepsOf } from './Routines'

describe('stepsOf', () => {
    it('reads a 1.5.0 poll prefilter as the server does: the name on the step, not in its options', () => {
        expect(
            stepsOf({
                triggers: [
                    {
                        poll: '*/10 * * * *',
                        prefilter: { kind: 'trac', name: 'New tickets', url: 'https://t/query?a=1' }
                    }
                ],
                agent: 'triager'
            })
        ).toEqual([
            { name: 'New tickets', trac: { url: 'https://t/query?a=1' } },
            { agent: 'triager', skill: undefined }
        ])
    })

    it('ignores a prefilter under schedule: and a top-level one next to triggers:', () => {
        expect(
            stepsOf({
                prefilter: { kind: 'command', run: 'echo top' },
                triggers: [{ schedule: '0 8 * * *', prefilter: { kind: 'command', run: 'echo nested' } }],
                steps: [{ run: 'echo 1' }]
            })
        ).toEqual([{ run: 'echo 1' }])
        expect(stepsOf({ cron: '0 8 * * *', prefilter: { kind: 'command', run: 'ls' }, steps: [] })).toEqual([
            { run: 'ls', items: true }
        ])
    })
})
