import { setLogLevel } from '../logger.js'

// The code under test logs freely; keep the test output to failures.
setLogLevel('error')
