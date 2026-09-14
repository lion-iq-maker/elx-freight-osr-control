const sql = require('mssql');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;
    if (!connectionString) {
        context.res = {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'SQL connection string missing' })
        };
        return;
    }
    try {
        const pool = await sql.connect(connectionString);
        const result = await pool.request().query(`
            SELECT id,
                   display_name AS displayName,
                   role,
                   is_active    AS isActive
            FROM dbo.Staff
            WHERE is_active = 1
            ORDER BY display_name ASC
        `);
        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ staff: result.recordset })
        };
    } catch (error) {
        context.log.error('Staff endpoint error:', error);
        context.res = {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message })
        };
    }
};
