import { describe, expect, it } from 'vitest'

import { cleanError, parseApprovals, Sbx, type SbxRunner } from './sbx.js'

/** What `sbx policy approval ls` printed on mikserver (sbx 0.48.0), trimmed to two rows. */
const APPROVALS = `APPROVAL                                              SANDBOX   TITLE                                    DETAIL                                                                      OPTIONS
network:-gVRIp8vYIV9Ze4Tmyj7DXDMr8JbeyEXCf6UdDuZcXY   pf-shop   trac.example.com:443                     Protocol: TCP Resource type: domain no matching allow rule (default deny)   allow (Allow), dismiss (Dismiss)
network:N11LtV0jzRFAeArXhryApV6TsFb8OEpV5_H5vAxCmhM   probe     10.6.40.112                              Protocol: TCP Resource type: cidr no matching allow rule (default deny)     allow (Allow), dismiss (Dismiss)
`

/** A runner that answers from a table of `args.join(' ')` prefixes and records every call. */
function fake(answers: Record<string, string | Error>): { runner: SbxRunner; calls: string[][] } {
    const calls: string[][] = []
    const runner: SbxRunner = (args) => {
        calls.push(args)
        const line = args.join(' ')
        const key = Object.keys(answers).find((k) => line.startsWith(k))
        const answer = key === undefined ? '' : answers[key]
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ stdout: answer, stderr: '' })
    }
    return { runner, calls }
}

describe('sbx', () => {
    it('reads the approvals table by its columns', () => {
        expect(parseApprovals(APPROVALS)).toEqual([
            {
                id: 'network:-gVRIp8vYIV9Ze4Tmyj7DXDMr8JbeyEXCf6UdDuZcXY',
                sandbox: 'pf-shop',
                resource: 'trac.example.com:443',
                detail: 'Protocol: TCP Resource type: domain no matching allow rule (default deny)',
                options: ['allow', 'dismiss']
            },
            expect.objectContaining({ sandbox: 'probe', resource: '10.6.40.112' })
        ])
        expect(parseApprovals('No pending approvals\n')).toEqual([])
    })

    it("keeps the CLI's complaint without its warnings and hints", () => {
        expect(
            cleanError('WARN: tls: cannot open the settings store\nerror: sandbox "x" not found\n  try: sbx ls\n')
        ).toBe('sandbox "x" not found')
    })

    it('builds exec with the environment by name only, never a value', () => {
        const sbx = new Sbx({ runner: fake({}).runner })
        expect(
            sbx.execArgs('pf-shop', ['claude', '-p'], {
                cwd: '/w/shop',
                env: ['GH_TOKEN', 'PF_RUN'],
                interactive: true,
                tty: true
            })
        ).toEqual(['exec', '-i', '-t', '-w', '/w/shop', '-e', 'GH_TOKEN', '-e', 'PF_RUN', 'pf-shop', 'claude', '-p'])
    })

    it('runs every command as the host user, without telemetry', () => {
        const sbx = new Sbx({ home: '/home/mik', runner: fake({}).runner })
        expect(sbx.env({ PF_RUN: 'x' })).toMatchObject({ HOME: '/home/mik', SBX_NO_TELEMETRY: '1', PF_RUN: 'x' })
    })

    it('lists sandboxes, creates one with its mounts and reads the id of a new rule', async () => {
        const { runner, calls } = fake({
            'ls --json':
                'WARN: tls: …\n[{"name":"pf-shop","status":"running","workspaces":["/w/shop"],"created_at":"2026-10-19T17:52:15Z"}]',
            'policy allow':
                'Added rule 09a69214-c238-4575-92ae-f39f0b5e8c0e to policy local (scope: sandbox:pf-shop): localhost:8081 [tcp]'
        })
        const sbx = new Sbx({ runner })
        expect(await sbx.ls()).toEqual([
            {
                name: 'pf-shop',
                status: 'running',
                workspaces: ['/w/shop'],
                ports: [],
                last_used_at: null,
                created_at: '2026-10-19T17:52:15Z'
            }
        ])
        await sbx.create('pf-shop', ['/w/shop', '/d/claude'], { memory: '8g' })
        expect(calls.at(-1)).toEqual([
            'create',
            '--name',
            'pf-shop',
            '--no-progress',
            '--memory',
            '8g',
            'claude',
            '/w/shop',
            '/d/claude'
        ])
        expect(await sbx.policyAllow('pf-shop', 'localhost:8081')).toBe('09a69214-c238-4575-92ae-f39f0b5e8c0e')
    })

    it('knows the Claude login from the secrets and the Docker one from diagnose', async () => {
        const { runner } = fake({
            'secret ls':
                '{"secrets":[{"scope":"global","type":"service","name":"anthropic","secret":"(oauth configured)"}]}',
            diagnose: '{"checks":[{"name":"Authentication","status":"pass","message":"authenticated"}]}'
        })
        const sbx = new Sbx({ runner })
        expect(await sbx.claudeLogin()).toBe(true)
        expect(await sbx.diagnose()).toEqual([{ name: 'Authentication', status: 'pass', message: 'authenticated' }])
    })
})
