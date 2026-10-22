import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A few small things the bot remembers between restarts (which message is the support
 * panel, which message is the top of each ticket channel). Saved as JSON.
 */
export class StateStore {
    constructor(file = 'data/state.json', { memory = false } = {}) {
        this.file = file;
        this.memory = memory;
        this.data = { panel: null, openers: {} };
        if (!memory && existsSync(file)) {
            try {
                this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) };
            } catch {
                // A damaged file is ignored; the bot rebuilds what it needs.
            }
        }
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
    }

    opener(uuid) {
        return this.data.openers[uuid] || null;
    }

    setOpener(uuid, value) {
        if (value) this.data.openers[uuid] = value;
        else delete this.data.openers[uuid];
        this.save();
    }

    save() {
        if (this.memory) return;
        mkdirSync(dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        writeFileSync(temp, JSON.stringify(this.data, null, 2));
        renameSync(temp, this.file);
    }
}
