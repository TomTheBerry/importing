/**
 * Console logging with timestamps. Nothing secret is ever passed in here.
 */
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
    info: (...args) => console.log(`[${stamp()}] [INFO]`, ...args),
    warn: (...args) => console.warn(`[${stamp()}] [WARN]`, ...args),
    error: (...args) => console.error(`[${stamp()}] [ERROR]`, ...args),
    debug: (...args) => {
        if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') console.log(`[${stamp()}] [DEBUG]`, ...args);
    },
};

export const quiet = { info() {}, warn() {}, error() {}, debug() {} };
