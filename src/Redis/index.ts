import Redis from 'ioredis';
import { BufferJSON, initAuthCreds, fromObject } from '../Utils';
import {
    sqlData,
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
    RedisConfig
} from '../Types';

let conn: Redis;

export async function connection(config: RedisConfig, force = false): Promise<Redis> {
    const newConnection = conn === undefined;

    if (newConnection || force) {
        conn = new Redis({
            host: config.host || '127.0.0.1',
            port: config.port || 6379,
            username: config.username,
            password: config.password,
            db: config.db || 0,
            tls: config.tls ? {} : undefined,
            retryStrategy(times) {
                const delay = Math.min(times * 50, 2000);
                console.log(`[Redis] Reconnecting in ${delay}ms`);
                return delay;
            }
        });

        conn.on('connect', () => console.log('[Redis] Connected'));
        conn.on('error', (err) => console.error('[Redis] Error:', err));
        conn.on('reconnecting', () => console.warn('[Redis] Reconnecting...'));
    }

    return conn;
}

export const useRedisAuthState = async (
    config: RedisConfig
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
    removeCreds: () => Promise<void>;
    query: (sql: string, values: string[]) => Promise<sqlData>;
}> => {
    const redisConn = await connection(config);

    const query = async (sql: any, values: any[]) => {
        console.log('sql', sql);
        console.log('values', values);
        return [] as sqlData;
    };

    const readData = async (id: string) => {
        const raw = await redisConn.get(`session:${config.session}:${id}`);
        if (!raw) return null;
        const creds = typeof raw === 'object' ? JSON.stringify(raw) : raw;
        const credsParsed = JSON.parse(creds, BufferJSON.reviver);
        return credsParsed;
    };

    const writeData = async (id: string, value: object) => {
        const valueFixed = JSON.stringify(value, BufferJSON.replacer);
        await redisConn.set(`session:${config.session}:${id}`, valueFixed);
    };

    const removeData = async (id: string) => {
        await redisConn.del(`session:${config.session}:${id}`);
    };

    const clearAll = async () => {
        const keys = await redisConn.keys(`session:${config.session}:*`);
        const toDelete = keys.filter((k) => !k.endsWith(':creds'));
        if (toDelete.length > 0) await redisConn.del(...toDelete);
    };

    const removeAll = async () => {
        const keys = await redisConn.keys(`session:${config.session}:*`);
        if (keys.length > 0) await redisConn.del(...keys);
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
        },
        query: async (sql: string, values: string[]) => {
            return await query(sql, values);
        }
    };
};
