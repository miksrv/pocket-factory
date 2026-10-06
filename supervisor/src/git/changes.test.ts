import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { changesLine, filePatch, isGenerated, listFiles, measure, snapshot, snapshotSync } from './changes.js'

describe('isGenerated', () => {
    it.each([
        'yarn.lock',
        'web/package-lock.json',
        'go.sum',
        'Cargo.lock',
        'dist/index.js',
        'web/build/app.css',
        'node_modules/x/index.js',
        'src/__generated__/schema.ts',
        'public/app.min.js',
        'public/app.min.css',
        'app.js.map',
        'src/__snapshots__/a.test.ts.snap',
        'api/v1/service.pb.go',
        'lib/model.g.dart',
        'src/api.generated.ts'
    ])('folds %s', (file) => {
        expect(isGenerated(file)).toBe(true)
    })

    it.each([
        'src/index.ts',
        'yarn.lock.md',
        'distribution/notes.md',
        'db/migrations/0001_init.sql',
        'src/build.ts',
        'README.md',
        'mylock/yarn.lockfile'
    ])('keeps %s visible', (file) => {
        expect(isGenerated(file)).toBe(false)
    })
})

describe('changesLine', () => {
    it.each([
        [null, null],
        [{ start_head: 'a', start_branch: null }, null],
        [{ start_head: 'a', start_branch: null, files: 0, added: 3 }, null],
        [{ start_head: 'a', start_branch: null, files: 1, added: 5, removed: 0 }, '1 file, +5 −0'],
        [{ start_head: 'a', start_branch: null, files: 7, added: 210, removed: 40 }, '7 files, +210 −40'],
        [{ start_head: 'a', start_branch: null, files: 2 }, '2 files, +0 −0']
    ])('%j → %j', (g, line) => {
        expect(changesLine(g)).toBe(line)
    })
})

describe('git snapshots and changes', () => {
    let dir: string

    const git = (...args: string[]) =>
        execFileSync(
            'git',
            [
                '-c',
                'user.name=Test',
                '-c',
                'user.email=test@example.com',
                '-c',
                'commit.gpgsign=false',
                '-c',
                'init.defaultBranch=main',
                ...args
            ],
            { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim()
    const write = (file: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        fs.writeFileSync(path.join(dir, file), content)
    }
    const commit = (message: string) => {
        git('add', '-A')
        git('commit', '-q', '-m', message)
        return git('rev-parse', 'HEAD')
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-git-'))
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('has no snapshot outside a repository or before the first commit', async () => {
        expect(await snapshot(dir)).toBeNull()
        expect(snapshotSync(dir)).toBeNull()
        git('init', '-q')
        expect(await snapshot(dir)).toBeNull()
        expect(snapshotSync(dir)).toBeNull()
    })

    it('reads HEAD and the branch, null on a detached HEAD', async () => {
        git('init', '-q')
        write('a.txt', 'one\n')
        const head = commit('first')
        expect(await snapshot(dir)).toEqual({ head, branch: 'main' })
        expect(snapshotSync(dir)).toEqual({ head, branch: 'main' })
        git('checkout', '-q', '--detach')
        expect(await snapshot(dir)).toEqual({ head, branch: null })
        expect(snapshotSync(dir)).toEqual({ head, branch: null })
    })

    it('lists added, modified, deleted, renamed and binary files with line counts', async () => {
        git('init', '-q')
        write('keep.txt', 'a\nb\nc\n')
        write('gone.txt', 'bye\n')
        write('old/name.txt', 'line 1\nline 2\nline 3\nline 4\nline 5\n')
        const base = commit('base')
        write('keep.txt', 'a\nB\nc\nd\n')
        fs.rmSync(path.join(dir, 'gone.txt'))
        fs.mkdirSync(path.join(dir, 'new'))
        fs.renameSync(path.join(dir, 'old/name.txt'), path.join(dir, 'new/name.txt'))
        write('yarn.lock', 'lock\n')
        fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]))
        const head = commit('change')

        const files = await listFiles(dir, base, head)
        const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
        expect(Object.keys(byPath).sort()).toEqual(['gone.txt', 'img.bin', 'keep.txt', 'new/name.txt', 'yarn.lock'])
        expect(byPath['keep.txt']).toMatchObject({ status: 'M', added: 2, removed: 1, binary: false, generated: false })
        expect(byPath['gone.txt']).toMatchObject({ status: 'D', added: 0, removed: 1 })
        expect(byPath['new/name.txt']).toMatchObject({ status: 'R', from: 'old/name.txt', added: 0, removed: 0 })
        expect(byPath['yarn.lock']).toMatchObject({ status: 'A', added: 1, generated: true })
        expect(byPath['img.bin']).toMatchObject({ status: 'A', binary: true, added: 0, removed: 0 })
        expect(await listFiles(dir, head, head)).toEqual([])

        const patch = await filePatch(dir, base, head, byPath['keep.txt'])
        expect(patch.truncated).toBe(false)
        expect(patch.patch).toContain('+B')
        expect(patch.patch).toContain('-b')
    })

    it('measures a task that stayed on its branch against where it started', async () => {
        git('init', '-q')
        write('a.txt', 'one\n')
        const start = commit('first')
        write('a.txt', 'one\ntwo\n')
        write('b.txt', 'new\n')
        const head = commit('second')
        write('dirty.txt', 'not committed\n')

        const result = await measure(dir, { start_head: start, start_branch: 'main' })
        expect(result).toEqual({
            start_head: start,
            start_branch: 'main',
            branch: 'main',
            head,
            base: start,
            default_branch: 'main',
            files: 2,
            added: 2,
            removed: 0,
            uncommitted: 1
        })
    })

    it('measures a task branch against its merge-base with the default branch', async () => {
        git('init', '-q')
        write('a.txt', 'one\n')
        const fork = commit('first')
        git('checkout', '-q', '-b', 'old-work')
        write('old.txt', 'x\n')
        const start = commit('old work')
        git('checkout', '-q', 'main')
        git('checkout', '-q', '-b', 'feature/x')
        write('f.txt', 'feature\n')
        const head = commit('feature')

        const result = await measure(dir, { start_head: start, start_branch: 'old-work' })
        expect(result).toMatchObject({ branch: 'feature/x', head, base: fork, files: 1, added: 1, uncommitted: 0 })
    })

    it('compares with where the two meet when the start is not an ancestor of the end', async () => {
        git('init', '-q')
        write('a.txt', 'one\n')
        const fork = commit('first')
        git('checkout', '-q', '-b', 'side')
        write('side.txt', 'x\n')
        const start = commit('side work')
        git('checkout', '-q', 'main')

        const result = await measure(dir, { start_head: start, start_branch: 'side' })
        expect(result).toMatchObject({ branch: 'main', head: fork, base: fork, files: 0 })
    })

    it('keeps only the start outside a repository', async () => {
        const start = { start_head: 'abc', start_branch: 'main' }
        expect(await measure(dir, start)).toEqual(start)
    })
})
