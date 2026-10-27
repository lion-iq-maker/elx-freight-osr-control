const sql = require('mssql');

module.exports = async function (context, req) {
    const connectionString = process.env.SQL_CONNECTION_STRING;
    if (!connectionString) {
        context.res = { status: 500, body: JSON.stringify({ error: 'SQL connection string missing' }) };
        return;
    }
    try {
        const pool = await sql.connect(connectionString);

        if (req.method === 'POST') {
            const name = String((req.body || {}).name || '').trim();
            if (!name) {
                context.res = { status: 400, body: JSON.stringify({ error: 'name is required' }) };
                return;
            }

            const result = await pool.request()
                .input('name', sql.NVarChar(200), name)
                .query(`
                    IF EXISTS (SELECT 1 FROM dbo.Suppliers WHERE name = @name)
                    BEGIN
                        UPDATE dbo.Suppliers SET is_active = 1, updated_at_utc = GETUTCDATE()
                        WHERE name = @name;
                        SELECT id, name, is_active AS isActive FROM dbo.Suppliers WHERE name = @name;
                    END
                    ELSE
                    BEGIN
                        INSERT INTO dbo.Suppliers (name, is_active)
                        OUTPUT INSERTED.id, INSERTED.name, INSERTED.is_active AS isActive
                        VALUES (@name, 1);
                    END
                `);

            context.res = { status: 200, body: JSON.stringify({ supplier: result.recordset[0] }) };
            return;
        }

        const result = await pool.request().query(`
            SELECT id, name, is_active AS isActive
            FROM dbo.Suppliers
            WHERE is_active = 1
            ORDER BY name ASC
        `);
        context.res = { status: 200, body: JSON.stringify({ suppliers: result.recordset }) };
    } catch (error) {
        context.log.error('Suppliers endpoint error:', error);
        context.res = { status: 500, body: JSON.stringify({ error: error.message }) };
    }
};