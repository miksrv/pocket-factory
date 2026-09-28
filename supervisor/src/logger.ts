type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold: Level = 'info'

export function setLogLevel(level: Level): void {
    threshold = level
}

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
    if (ORDER[level] < ORDER[threshold]) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
    const out = level === 'error' || level === 'warn' ? console.error : console.log
    extra === undefined ? out(line) : out(line, extra)
}

export function createLogger(scope: string) {
    return {
        debug: (message: string, extra?: unknown) => emit('debug', scope, message, extra),
        info: (message: string, extra?: unknown) => emit('info', scope, message, extra),
        warn: (message: string, extra?: unknown) => emit('warn', scope, message, extra),
        error: (message: string, extra?: unknown) => emit('error', scope, message, extra)
    }
}
