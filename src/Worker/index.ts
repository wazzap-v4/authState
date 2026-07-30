import { BufferJSON, initAuthCreds, fromObject, createRequestChannel } from '../Utils'
import {
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
    WorkConfig
} from '../Types';

let conn: ReturnType<typeof createRequestChannel>;

export async function connection(config: WorkConfig, force = false) {
    const newConnection = conn === undefined;

    if (newConnection || force) {
        conn = createRequestChannel(config.port);
    }

    return conn;
}

export const useWorkerAuthState = async (
    config: WorkConfig
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
    removeCreds: () => Promise<void>;
}> => {
    const work = await connection(config);

    const retryRequestDelayMs = config.retryRequestDelayMs || 200;
    const maxtRetries = config.maxtRetries || 10;
    const db = config.typeDB || 'redis';
    const session = config.session || null;

    const query = async (type: string, db: string, values: object) => {
        for (let x = 0; x < maxtRetries; x++) {
            try {
                return await work({ type, db, values });
            } catch (e) {
                if (x === maxtRetries - 1) throw e;
                await new Promise((r) => setTimeout(r, retryRequestDelayMs));
            }
        }
    };

    const getKey = (key: string) => {
        if (!session) throw new Error('Session ID is required');
        return `session:${session}:${key}`;
    };

    const readData = async (id: string) => {
        // Fail-closed: a missing row returns null (legitimate "no state"),
        // but an operational error (DB down, channel dead, retries exhausted)
        // must THROW so callers never mistake it for "no state" and regenerate
        // a fresh identity (which causes Bad MAC storms on contacts' sessions).
        const raw = await query('readData', db, { id, session: getKey(id) });
        if (raw === null || raw === undefined) return null;
        const creds = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        const credsParsed = JSON.parse(creds, BufferJSON.reviver);
        return credsParsed;
    };

    const writeData = async (id: string, value: object) => {
        const valueFixed = JSON.stringify(value, BufferJSON.replacer);
        await query('writeData', db, { id, session: getKey(id), value: valueFixed });
    };

    const removeData = async (id: string) => {
        await query('removeData', db, { id, session: getKey(id) });
    };

    const BATCH_SIZE = 100;

    const writeBatch = async (entries: Array<{ id: string; value: string }>) => {
        if (entries.length === 0) return;
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const chunk = entries.slice(i, i + BATCH_SIZE);
            await query('writeBatch', db, { session: getKey('*'), entries: chunk });
        }
    };

    const readBatch = async (ids: string[]) => {
        if (ids.length === 0) return {} as any;
        // Fail-closed: missing ids come back as null entries from the main
        // process (legitimate), but an operational error must THROW instead of
        // returning an empty map that baileys would read as "all keys missing".
        return await query('readBatch', db, { session: getKey('*'), ids });
    };

    const clearAll = async () => {
        await query('clearAll', db, { session: getKey('*') });
    };

    const removeAll = async () => {
        await query('removeAll', db, { session: getKey('*') });
    };

    const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds: creds,
            keys: {
                get: async (type, ids) => {
                    const fullIds = ids.map(id => `${type}-${id}`);
                    const raw = await readBatch(fullIds);

                    const data: { [id: string]: any } = {};
                    for (const id of ids) {
                        const rawValue = raw?.[`${type}-${id}`];
                        if (!rawValue) {
                            data[id] = null;
                            continue;
                        }
                        const safeStr = typeof rawValue === "object" ? JSON.stringify(rawValue) : String(rawValue);
                        let value = JSON.parse(safeStr, BufferJSON.reviver);
                        if (type === 'app-state-sync-key' && value) {
                            value = fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const entries: Array<{ id: string; value: string }> = [];
                    const removeIds: string[] = [];

                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const name = `${category}-${id}`;
                            if (value !== null && value !== undefined) {
                                entries.push({
                                    id: name,
                                    value: JSON.stringify(value, BufferJSON.replacer)
                                });
                            } else {
                                removeIds.push(name);
                            }
                        }
                    }

                    await writeBatch(entries);

                    if (removeIds.length > 0) {
                        await Promise.all(removeIds.map(id => removeData(id)));
                    }
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        },
        clear: async () => {
            await clearAll();
        },
        removeCreds: async () => {
            await removeAll();
        }
    };
};
