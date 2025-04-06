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

     const query = async (type:string, db:string, values:object) => {
        for (let x = 0; x < maxtRetries; x++) {
            try {
                return await work({ type, db, values });
            } catch (e) {
                await new Promise((r) => setTimeout(r, retryRequestDelayMs));
            }
        }
        return null;
    };

    const getKey = (key: string) => {
    if (!session) throw new Error('Session ID is required');
    return `session:${session}:${key}`;
};

    const readData = async (id: string) => {
        const raw = await query('readData', db, { id, session: getKey(id) });
        if (!raw) return null;
        const creds = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        const credsParsed = JSON.parse(creds, BufferJSON.reviver);
        return credsParsed;
    };

    const writeData = async (id: string, value: object) => {
        const valueFixed = JSON.stringify(value, BufferJSON.replacer);
        await query('writeData', db, { id, session:getKey(id), value: valueFixed });
    };

    const removeData = async (id: string) => {
        await query('removeData', db, { id, session:getKey(id) });
    };

    const clearAll = async () => {
        await query('clearAll', db, {  session:getKey("*") });
    };

    const removeAll = async () => {
        await query('removeAll', db, {  session:getKey("*") });
    };

    const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds: creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const name = `${category}-${id}`;
                            if (value) {
                                await writeData(name, value);
                            } else {
                                await removeData(name);
                            }
                        }
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
