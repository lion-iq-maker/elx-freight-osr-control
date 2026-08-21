const sql = require('mssql');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;
    if (!connectionString) {
        context.res = {
            status: 500,
            body: JSON.stringify({ error: 'SQL connection string missing' })
        };
        return;
    }

    try {
        await sql.connect(connectionString);
        const result = await sql.query`SELECT COUNT(*) AS count FROM Locations`;
        await sql.close();

        context.res = {
            status: 200,
            body: JSON.stringify({ 
                status: 'connected', 
                locationCount: result.recordset[0].count,
                timestamp: new Date().toISOString()
            })
        };
    } catch (error) {
        context.log.error('Database error:', error);
        context.res = {
            status: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};