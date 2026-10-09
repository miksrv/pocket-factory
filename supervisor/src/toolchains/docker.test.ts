import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DockerSidecar } from './docker.js'

/**
 * A `docker` that answers from files: `ps` prints the lines of ps.jsonl, `stop`
 * appends its arguments to stopped.log, `version` and `system df` answer fixed text.
 */
const FAKE = `#!/bin/sh
dir=$(dirname "$0")
case "$1 $2" in
  "version --format") echo "29.9.0" ;;
  "system df") printf '%s\\n' '{"Type":"Images","TotalCount":"3","Active":"1","Size":"1.2GB","Reclaimable":"800MB (66%)"}' '{"Type":"Containers","TotalCount":"2","Active":"1","Size":"10MB","Reclaimable":"5MB (50%)"}' ;;
  "stop "*) shift; echo "$@" >> "$dir/stopped.log" ;;
  "ps -q") cut -d'"' -f4 "$dir/ps.jsonl" ;;
  "ps "*) if echo "$@" | grep -q -- ' -a'; then cat "$dir/ps.jsonl"; else grep '"State":"running"' "$dir/ps.jsonl"; fi ;;
  *) echo "fake docker: $@" >&2; exit 1 ;;
esac
`
const line = (id: string, name: string, state: string, workingDir?: string) =>
    JSON.stringify({
        ID: id,
        Names: name,
        Image: 'mysql:8',
        State: state,
        Status: state === 'running' ? 'Up 2 minutes' : 'Exited (0) 1 minute ago',
        Ports: '3306/tcp',
        CreatedAt: '2026-10-09 10:00:00 +0000 UTC',
        Labels: workingDir
            ? `com.docker.compose.project.working_dir=${workingDir},com.docker.compose.project=${path.basename(workingDir)},com.docker.compose.service=${name}`
            : ''
    })

describe('DockerSidecar', () => {
    let dir: string
    let docker: DockerSidecar
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-docker-'))
        fs.writeFileSync(path.join(dir, 'docker'), FAKE, { mode: 0o755 })
        docker = new DockerSidecar({ ...process.env, DOCKER_HOST: 'tcp://docker:2376' }, path.join(dir, 'docker'))
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    const ps = (...lines: string[]) => fs.writeFileSync(path.join(dir, 'ps.jsonl'), lines.join('\n') + '\n')
    const stopped = () =>
        fs.existsSync(path.join(dir, 'stopped.log'))
            ? fs.readFileSync(path.join(dir, 'stopped.log'), 'utf8').trim()
            : ''

    it('is off without DOCKER_HOST', async () => {
        const off = new DockerSidecar({}, path.join(dir, 'docker'))
        expect(off.enabled).toBe(false)
        expect(await off.info()).toMatchObject({ enabled: false, reachable: false, containers: [] })
        expect(await off.stopStartedSince(new Set())).toEqual([])
    })

    it('reads the daemon version, the containers with their compose labels and the disk usage', async () => {
        ps(line('aaa', 'db', 'running', '/data/workspaces/geometki'), line('bbb', 'scratch', 'exited'))
        const info = await docker.info()
        expect(info).toMatchObject({ enabled: true, reachable: true, version: '29.9.0', error: null })
        expect(info.containers).toEqual([
            expect.objectContaining({
                id: 'aaa',
                name: 'db',
                state: 'running',
                compose: { working_dir: '/data/workspaces/geometki', project: 'geometki', service: 'db' }
            }),
            expect.objectContaining({ id: 'bbb', compose: { working_dir: null, project: null, service: null } })
        ])
        expect(info.disk).toEqual([
            { type: 'Images', total: 3, active: 1, size: '1.2GB', reclaimable: '800MB (66%)' },
            { type: 'Containers', total: 2, active: 1, size: '10MB', reclaimable: '5MB (50%)' }
        ])
    })

    it('stops what appeared since the snapshot, keeps what another task claims and the ones already there', async () => {
        ps(line('old', 'mosquitto', 'running'))
        const before = await docker.snapshot()
        expect(before).toEqual(new Set(['old']))
        ps(
            line('old', 'mosquitto', 'running'),
            line('new1', 'db', 'running', '/data/workspaces/geometki'),
            line('new2', 'redis', 'running', '/data/workspaces/other'),
            line('new3', 'gone', 'exited')
        )
        const names = await docker.stopStartedSince(before, (c) => c.compose.working_dir === '/data/workspaces/other')
        expect(names).toEqual(['db'])
        expect(stopped()).toBe('new1')
    })

    it('reports an unreachable daemon instead of throwing', async () => {
        const broken = new DockerSidecar({ DOCKER_HOST: 'tcp://docker:2376' }, path.join(dir, 'missing'))
        const info = await broken.info()
        expect(info.reachable).toBe(false)
        expect(info.error).toMatch(/ENOENT|spawn/)
    })
})
