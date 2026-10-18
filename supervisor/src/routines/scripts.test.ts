import { describe, expect, it } from 'vitest'

import { describeScript, scriptOf } from './scripts.js'

describe('scriptOf', () => {
    const dirs = { routine: '/r/geo', skill: '/s/geo-skill' }

    it('finds the file a command starts in the routine folder or the skill', () => {
        expect(scriptOf('"${ROUTINE_DIR}/scripts/gsc.sh" --days 7', dirs)).toEqual({
            scope: 'routine',
            path: 'scripts/gsc.sh',
            full: '/r/geo/scripts/gsc.sh'
        })
        expect(scriptOf('$SKILL_DIR/scripts/x.sh', dirs)).toMatchObject({
            scope: 'skill',
            full: '/s/geo-skill/scripts/x.sh'
        })
    })

    it('knows nothing of other commands, a missing skill or a path that climbs out', () => {
        expect(scriptOf('gh pr list --json number', dirs)).toBeNull()
        expect(scriptOf('${SKILL_DIR}/x.sh', { routine: '/r', skill: null })).toBeNull()
        expect(scriptOf('${ROUTINE_DIR}/../other/x.sh', dirs)).toBeNull()
    })
})

describe('describeScript', () => {
    it('reads the header comment and the declared names, and every $NAME used', () => {
        const info = describeScript(
            [
                '#!/usr/bin/env bash',
                '# Google Search Console, 28 days for the page:',
                '# queries, clicks, position.',
                '# secrets: GSC_REFRESH_TOKEN, GOOGLE_CLIENT_ID',
                'set -euo pipefail',
                'curl -H "Authorization: Bearer $TOKEN" "$API/x"'
            ].join('\n')
        )
        expect(info.description).toBe('Google Search Console, 28 days for the page: queries, clicks, position.')
        expect(info.declared).toEqual(['GSC_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID'])
        expect(info.variables).toEqual([])
        expect(describeScript('#!/bin/sh\n# vars: TRAC_URL\n# secrets: TOKEN\n').variables).toEqual(['TRAC_URL'])
        expect(info.referenced.sort()).toEqual(['API', 'TOKEN'])
    })

    it('has no description for a script without a header', () => {
        expect(describeScript('echo hi').description).toBe('')
        expect(describeScript('').declared).toEqual([])
    })
})
