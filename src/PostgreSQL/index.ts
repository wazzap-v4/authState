import { Client } from 'pg';
import { BufferJSON, initAuthCreds, fromObject, normalizeRows } from '../Utils';
import {
    sqlData,
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
    PostgresConfig
} from '../Types';

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
    let operationTail: Promise<void> = Promise.resolve();

    const fixedDatabaseFailure = (code: string, cause: unknown) => {
        const failure = new Error(code);
        Object.defineProperty(failure, 'cause', {
            value: cause,
            enumerable: false
        });
        return failure;
    };

    const executeQuery = async (sql: string, values: any[]) => {
        const result = await sqlConn.query(sql, values);
        return normalizeRows(result) as sqlData;
    };

    const serializeOperation = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = operationTail.then(operation, operation);
        operationTail = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    };

    const executeQueryWithRetry = async (sql: string, values: any[]) => {
        let lastFailure: unknown;
        for (let x = 0; x < maxtRetries; x++) {
            try {
                return await executeQuery(sql, values);
            } catch (e) {
                lastFailure = e;
                if (x + 1 < maxtRetries) {
                    await new Promise((r) => setTimeout(r, retryRequestDelayMs));
                }
            }
        }
        throw fixedDatabaseFailure('postgres-query-retry-exhausted', lastFailure);
    };

    const query = async (sql: string, values: any[]) => {
        return serializeOperation(() => executeQueryWithRetry(sql, values));
    };

    const parseStoredValue = (value: unknown) => {
        if (value === null || value === undefined) return null;
        const serialized = typeof value === 'object' ? JSON.stringify(value) : value;
        if (typeof serialized !== 'string') return null;
        return JSON.parse(serialized, BufferJSON.reviver);
    };

    const readData = async (id: string) => {
        const data = await query(
            `SELECT value FROM ${tableName} WHERE id = $1 AND session = $2`,
            [id, config.session]
        );
        return parseStoredValue(data[0]?.value);
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

    const writeSignalDataAtomically = async (data: {
        [category: string]: { [id: string]: object | null | undefined } | undefined;
    }) => {
        const mutations: Array<{ id: string; valueFixed?: string }> = [];
        for (const category in data) {
            const categoryData = data[category];
            if (!categoryData) continue;
            for (const id in categoryData) {
                const value = categoryData[id];
                const mutation = { id: `${category}-${id}` } as {
                    id: string;
                    valueFixed?: string;
                };
                if (value !== null && value !== undefined) {
                    mutation.valueFixed = JSON.stringify(value, BufferJSON.replacer);
                }
                mutations.push(mutation);
            }
        }
        if (mutations.length === 0) return;

        await serializeOperation(async () => {
            let lastFailure: unknown;
            for (let attempt = 0; attempt < maxtRetries; attempt++) {
                let transactionStarted = false;
                try {
                    await executeQuery('BEGIN', []);
                    transactionStarted = true;
                    for (const mutation of mutations) {
                        if (mutation.valueFixed !== undefined) {
                            await executeQuery(
                                `INSERT INTO ${tableName} (session, id, value)
                                    VALUES ($1, $2, $3)
                                    ON CONFLICT (session, id)
                                    DO UPDATE SET value = EXCLUDED.value`,
                                [config.session, mutation.id, mutation.valueFixed]
                            );
                        } else {
                            await executeQuery(
                                `DELETE FROM ${tableName} WHERE id = $1 AND session = $2`,
                                [mutation.id, config.session]
                            );
                        }
                    }
                    await executeQuery('COMMIT', []);
                    transactionStarted = false;
                    return;
                } catch (error) {
                    lastFailure = error;
                    if (transactionStarted) {
                        try {
                            await executeQuery('ROLLBACK', []);
                        } catch (rollbackFailure) {
                            throw fixedDatabaseFailure(
                                'postgres-transaction-rollback-failed',
                                rollbackFailure
                            );
                        }
                    }
                    if (attempt + 1 < maxtRetries) {
                        await new Promise((resolve) => setTimeout(resolve, retryRequestDelayMs));
                    }
                }
            }
            throw fixedDatabaseFailure('postgres-transaction-retry-exhausted', lastFailure);
        });
    };

    const clearAll = async () => {
        await query(
            `DELETE FROM ${tableName} WHERE id != 'creds' AND session = $1`,
            [config.session]
        );
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
                    if (ids.length === 0) return data;
                    const names = ids.map((id) => `${type}-${id}`);
                    const expectedNames = new Map(names.map((name, index) => [name, ids[index]]));
                    const rows = await query(
                        `SELECT id, value
                           FROM ${tableName}
                          WHERE session = $1
                            AND id = ANY($2::text[])`,
                        [config.session, names]
                    );
                    const values = new Map<string, unknown>();
                    for (const row of rows as any[]) {
                        if (typeof row?.id === 'string' && expectedNames.has(row.id)) {
                            values.set(row.id, row.value);
                        }
                    }
                    for (const id of ids) {
                        let value = parseStoredValue(values.get(`${type}-${id}`));
                        if (type === 'app-state-sync-key' && value) {
                            value = fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    await writeSignalDataAtomically(data);
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
