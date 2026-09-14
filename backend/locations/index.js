// ELX Freight Control — locations endpoint v1.0.1
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
                   name,
                   code,
                   is_active   AS isActive,
                   sort_order  AS sortOrder
            FROM dbo.Locations
            WHERE is_active = 1
            ORDER BY sort_order ASC, name ASC
        `);
        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations: result.recordset })
        };
    } catch (error) {
        context.log.error('Locations endpoint error:', error);
        context.res = {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message })
        };
    }
};
