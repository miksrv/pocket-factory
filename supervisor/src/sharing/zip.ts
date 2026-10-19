import zlib from 'node:zlib'

/**
 * Just enough ZIP for the factory's bundles: write deflated entries, read
 * stored or deflated ones. No ZIP64, no encryption, no links: a bundle is a
 * few folders of Markdown and scripts, and anything else in an archive is
 * refused rather than guessed at.
 */
export interface ZipEntry {
    /** Relative, with `/`. */
    path: string
    bytes: Buffer
    /** The Unix executable bit (a script a step runs as it is). */
    exec: boolean
}

export class ZipError extends Error {}

export interface ZipLimits {
    /** The most entries an archive may hold. */
    entries: number
    /** The most one file may weigh unpacked. */
    file: number
    /** The most all files together may weigh unpacked. */
    total: number
}

export const ZIP_LIMITS: ZipLimits = { entries: 2000, file: 8 * 1024 * 1024, total: 64 * 1024 * 1024 }

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
/** bit 11: the name is UTF-8. */
const UTF8 = 0x0800
const UNIX = 3

/** The MS-DOS date and time a ZIP header carries. */
function dosTime(at: Date): { time: number; date: number } {
    const year = Math.max(at.getFullYear(), 1980)
    return {
        time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
    }
}

export function writeZip(entries: ZipEntry[], at = new Date()): Buffer {
    const { time, date } = dosTime(at)
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const entry of entries) {
        const name = Buffer.from(entry.path, 'utf8')
        const deflated = zlib.deflateRawSync(entry.bytes)
        // A file deflate cannot shrink is stored as it is.
        const stored = deflated.length >= entry.bytes.length
        const data = stored ? entry.bytes : deflated
        const crc = zlib.crc32(entry.bytes)

        const local = Buffer.alloc(30)
        local.writeUInt32LE(LOCAL, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(UTF8, 6)
        local.writeUInt16LE(stored ? 0 : 8, 8)
        local.writeUInt16LE(time, 10)
        local.writeUInt16LE(date, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(entry.bytes.length, 22)
        local.writeUInt16LE(name.length, 26)
        locals.push(local, name, data)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(CENTRAL, 0)
        central.writeUInt16LE((UNIX << 8) | 20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(UTF8, 8)
        central.writeUInt16LE(stored ? 0 : 8, 10)
        central.writeUInt16LE(time, 12)
        central.writeUInt16LE(date, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(data.length, 20)
        central.writeUInt32LE(entry.bytes.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt32LE(((entry.exec ? 0o100755 : 0o100644) << 16) >>> 0, 38)
        central.writeUInt32LE(offset, 42)
        centrals.push(central, name)

        offset += local.length + name.length + data.length
    }
    const directory = Buffer.concat(centrals)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, directory, end])
}

/** Whether the bytes start like a ZIP archive (an empty one included). */
export const isZip = (bytes: Buffer): boolean =>
    bytes.length >= 4 && (bytes.readUInt32LE(0) === LOCAL || bytes.readUInt32LE(0) === END)

/** A path inside the archive as the bundle uses it, or a ZipError for one that could leave its folder. */
function cleanPath(raw: string): string {
    const name = raw.replace(/\\/g, '/')
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(name))
        throw new ZipError(`the archive has a name with control characters: ${JSON.stringify(raw)}`)
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..'))
        throw new ZipError(`the archive has an unsafe path: ${raw}`)
    return name
        .split('/')
        .filter((part) => part && part !== '.')
        .join('/')
}

/**
 * The files of an archive (directories dropped). Refuses what the factory
 * would never write: links, paths that climb out, encrypted or ZIP64
 * entries, and more than the limits allow, checked before anything is
 * inflated and again while it is.
 */
export function readZip(bytes: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipEntry[] {
    let end = -1
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
        if (bytes.readUInt32LE(i) === END) {
            end = i
            break
        }
    }
    if (end < 0) throw new ZipError('not a ZIP archive')
    const count = bytes.readUInt16LE(end + 10)
    const size = bytes.readUInt32LE(end + 12)
    const start = bytes.readUInt32LE(end + 16)
    if (count === 0xffff || start === 0xffffffff) throw new ZipError('ZIP64 archives are not supported')
    if (count > limits.entries) throw new ZipError(`the archive has more than ${limits.entries} entries`)
    if (start + size > end) throw new ZipError('the archive is damaged')

    const out: ZipEntry[] = []
    let total = 0
    let at = start
    for (let n = 0; n < count; n++) {
        if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL) throw new ZipError('the archive is damaged')
        const madeBy = bytes.readUInt16LE(at + 4) >> 8
        const flags = bytes.readUInt16LE(at + 8)
        const method = bytes.readUInt16LE(at + 10)
        const crc = bytes.readUInt32LE(at + 16)
        const packed = bytes.readUInt32LE(at + 20)
        const unpacked = bytes.readUInt32LE(at + 24)
        const nameLength = bytes.readUInt16LE(at + 28)
        const extraLength = bytes.readUInt16LE(at + 30)
        const commentLength = bytes.readUInt16LE(at + 32)
        const attributes = bytes.readUInt32LE(at + 38)
        const offset = bytes.readUInt32LE(at + 42)
        const rawName = bytes.subarray(at + 46, at + 46 + nameLength).toString(flags & UTF8 ? 'utf8' : 'latin1')
        at += 46 + nameLength + extraLength + commentLength

        const mode = madeBy === UNIX ? attributes >>> 16 : 0
        const name = cleanPath(rawName)
        if (rawName.endsWith('/') || (mode & 0o170000) === 0o040000) continue
        if ((mode & 0o170000) === 0o120000) throw new ZipError(`the archive has a link: ${rawName}`)
        if (flags & 1) throw new ZipError(`the archive is encrypted: ${rawName}`)
        if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression in ${rawName}`)
        if (packed === 0xffffffff || unpacked === 0xffffffff || offset === 0xffffffff)
            throw new ZipError('ZIP64 archives are not supported')
        if (!name) continue
        if (unpacked > limits.file)
            throw new ZipError(`${name} is larger than ${Math.round(limits.file / 1024 / 1024)} MB`)
        total += unpacked
        if (total > limits.total)
            throw new ZipError(`the archive unpacks to more than ${Math.round(limits.total / 1024 / 1024)} MB`)

        if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== LOCAL)
            throw new ZipError('the archive is damaged')
        const dataStart = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28)
        if (dataStart + packed > bytes.length) throw new ZipError('the archive is damaged')
        const data = bytes.subarray(dataStart, dataStart + packed)
        let content: Buffer
        try {
            // The header's size is a claim: inflating stops past it, so a lying entry cannot balloon.
            content = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: unpacked || 1 })
        } catch {
            throw new ZipError(`${name} cannot be unpacked`)
        }
        if (content.length !== unpacked || zlib.crc32(content) !== crc) throw new ZipError(`${name} is damaged`)
        out.push({ path: name, bytes: content, exec: (mode & 0o111) !== 0 })
    }
    return out
}
