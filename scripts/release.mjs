#!/usr/bin/env node
// Versioning helper (see CHANGELOG.md and CLAUDE.md "Versioning and releases"):
//   node scripts/release.mjs bump <x.y.z>   set the version in the three package.json files and
//                                           open a CHANGELOG.md section for it (fill in the bullets)
//   node scripts/release.mjs notes [x.y.z]  print that version's CHANGELOG.md section
//   node scripts/release.mjs tag [--dry-run] on main, clean and in sync with origin: tag vX.Y.Z,
//                                           push the tag and create the GitHub release from the notes
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PACKAGES = ['package.json', 'supervisor/package.json', 'web/package.json'].map((p) => path.join(root, p))
const CHANGELOG = path.join(root, 'CHANGELOG.md')
const SEMVER = /^\d+\.\d+\.\d+$/

const fail = (message) => {
    console.error(`release: ${message}`)
    process.exit(1)
}
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const currentVersion = () => JSON.parse(fs.readFileSync(PACKAGES[0], 'utf8')).version

/** The `## [x.y.z] - date` section of CHANGELOG.md, heading excluded, or null. */
function notesOf(version) {
    const text = fs.readFileSync(CHANGELOG, 'utf8')
    const re = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm')
    const m = text.match(re)
    return m ? m[1].trim() : null
}

function bump(version) {
    if (!SEMVER.test(version ?? '')) fail('usage: bump <x.y.z>')
    const was = currentVersion()
    const cmp = (a, b) => {
        const [x, y] = [a, b].map((v) => v.split('.').map(Number))
        for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
        return 0
    }
    if (cmp(version, was) <= 0) fail(`${version} is not above the current ${was}`)
    for (const file of PACKAGES) {
        const text = fs.readFileSync(file, 'utf8')
        const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
        if (next === text) fail(`no "version" in ${path.relative(root, file)}`)
        fs.writeFileSync(file, next)
    }
    let changelog = fs.readFileSync(CHANGELOG, 'utf8')
    if (notesOf(version) === null) {
        const now = new Date() // the local date, not UTC: the owner's evening is still today
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        const at = changelog.search(/^## \[/m)
        if (at < 0) fail('CHANGELOG.md has no "## [" section to insert before')
        changelog = `${changelog.slice(0, at)}## [${version}] - ${today}\n\n### Changed\n\n- \n\n${changelog.slice(at)}`
        fs.writeFileSync(CHANGELOG, changelog)
        console.log(`CHANGELOG.md: opened a section for ${version} (fill in the bullets)`)
    }
    console.log(`version ${was} → ${version} in ${PACKAGES.map((p) => path.relative(root, p)).join(', ')}`)
}

function notes(version = currentVersion()) {
    const text = notesOf(version)
    if (text === null) fail(`CHANGELOG.md has no section for ${version}`)
    process.stdout.write(`${text}\n`)
}

function tag(args) {
    const dry = args.includes('--dry-run')
    const version = currentVersion()
    const name = `v${version}`
    const notesText = notesOf(version)
    if (notesText === null || !/^- \S/m.test(notesText)) fail(`CHANGELOG.md needs a section for ${version} with at least one bullet`)
    if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('switch to main first (git checkout main)')
    if (sh('git', ['status', '--porcelain'])) fail('the working tree is not clean')
    sh('git', ['fetch', 'origin', 'main', '--tags'])
    const [local, remote] = [sh('git', ['rev-parse', 'HEAD']), sh('git', ['rev-parse', 'origin/main'])]
    if (local !== remote) fail('main is not in sync with origin/main (git pull, or push first)')
    if (sh('git', ['tag', '--list', name])) fail(`tag ${name} already exists`)
    if (sh('git', ['ls-remote', '--tags', 'origin', name])) fail(`tag ${name} already exists on origin`)
    console.log(`${dry ? '[dry run] ' : ''}tagging ${local.slice(0, 7)} as ${name} and creating the GitHub release`)
    if (dry) return
    const notesFile = path.join(os.tmpdir(), `pocket-factory-${name}.md`)
    fs.writeFileSync(notesFile, `${notesText}\n`)
    sh('git', ['tag', '-a', name, '-m', name])
    sh('git', ['push', 'origin', name])
    const url = sh('gh', ['release', 'create', name, '--title', name, '--notes-file', notesFile, '--verify-tag'])
    fs.rmSync(notesFile, { force: true })
    console.log(url)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'bump') bump(rest[0])
else if (command === 'notes') notes(rest[0])
else if (command === 'tag') tag(rest)
else fail('usage: release.mjs bump <x.y.z> | notes [x.y.z] | tag [--dry-run]')
