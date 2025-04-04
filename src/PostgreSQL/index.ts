import { Client } from 'pg';
import { BufferJSON, initAuthCreds, fromObject, normalizeRows } from '../Utils';
import {
    sqlData,
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
    PostgresConfig
} from '../Types';

/**
 * Stores the full authentication state in PostgreSQL
 * Far more efficient than file
 * @param {string} host - The hostname of the database you are connecting to. (Default: localhost)
 * @param {number} port - The port number to connect to. (Default: 5432)
 * @param {string} user - The PostgreSQL user to authenticate as. (Default: root)
 * @param {string} password - The password of that PostgreSQL user
 * @param {string} database - Name of the database to use for this connection. (Default: base)
 * @param {string} tableName - PostgreSQL table name. (Default: auth)
 * @param {number} retryRequestDelayMs - Retry the query at each interval if it fails. (Default: 200ms)
 * @param {number} maxtRetries - Maximum attempts if the query fails. (Default: 10)
 * @param {string} session - Session name to identify the connection, allowing multisessions with PostgreSQL.
 */

let conn: Client | undefined;

async function connection(config: PostgresConfig, force = false) {
    const ended = conn?.ended ?? false;
    const newConnection = conn === undefined;

    if (newConnection || ended || force) {
        conn = new Client({
            host: config.host || 'localhost',
            port: config.port || 5432,
            user: config.user || 'postgres',
            password: config.password,
            database: config.database || 'base',
            ssl: config.ssl
        });

        await conn.connect();

        if (newConnection) {
            await conn.query(
                `CREATE TABLE IF NOT EXISTS "${config.tableName || 'auth'}" (
                    "session" VARCHAR(50) NOT NULL,
                    "id" VARCHAR(80) NOT NULL,
                    "value" JSONB DEFAULT NULL,
                    CONSTRAINT "idxunique" UNIQUE ("session", "id")
                );`
            );
        }
    }

    return conn;
}

export const usePostgreSQLAuthState = async (
    config: PostgresConfig
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
    removeCreds: () => Promise<void>;
    query: (sql: string, values: string[]) => Promise<sqlData>;
}> => {
    const sqlConn = await connection(config);

    const tableName = config.tableName || 'auth';
    const retryRequestDelayMs = config.retryRequestDelayMs || 200;
    const maxtRetries = config.maxtRetries || 10;

    const query = async (sql: string, values: any[]) => {
        for (let x = 0; x < maxtRetries; x++) {
            try {
                const result = await sqlConn.query(sql, values);
                return normalizeRows(result) as sqlData;
            } catch (e) {
                await new Promise((r) => setTimeout(r, retryRequestDelayMs));
            }
        }
        return [] as sqlData;
    };

    const readData = async (id: string) => {
        const data = await query(`SELECT value FROM ${tableName} WHERE id = $1 AND session = $2`, [
            id,
            config.session
        ]);
        if (!data[0]?.value) {
            return null;
        }
        const creds =
            typeof data[0].value === 'object' ? JSON.stringify(data[0].value) : data[0].value;
        const credsParsed = JSON.parse(creds, BufferJSON.reviver);
        return credsParsed;
    };

    const writeData = async (id: string, value: object) => {
        const valueFixed = JSON.stringify(value, BufferJSON.replacer);
        await query(
            `INSERT INTO ${tableName} (session, id, value)
                VALUES ($1, $2, $3)
                ON CONFLICT (session, id)
                DO UPDATE SET value = EXCLUDED.value`,
            [config.session, id, valueFixed]
        );
    };

    const removeData = async (id: string) => {
        await query(`DELETE FROM ${tableName} WHERE id = $1 AND session = $2`, [
            id,
            config.session
        ]);
    };

    const clearAll = async () => {
        await query(`DELETE FROM ${tableName} WHERE id != 'creds' AND session = $1`, [
            config.session
        ]);
    };

    const removeAll = async () => {
        await query(`DELETE FROM ${tableName} WHERE session = $1`, [config.session]);
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
