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

        if (req.method === 'POST') {
            const name = String((req.body || {}).name || '').trim();

            if (!name) {
                context.res = {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'name is required' })
                };
                return;
            }

            const result = await pool.request()
                .input('name', sql.NVarChar(100), name)
                .query(`
                    IF EXISTS (
                        SELECT 1 FROM dbo.Locations
                        WHERE name = @name
                    )
                    BEGIN
                        UPDATE dbo.Locations
                        SET is_active = 1,
                            updated_at_utc = GETUTCDATE()
                        WHERE name = @name;

                        SELECT id,
                               name,
                               code,
                               is_active AS isActive,
                               sort_order AS sortOrder
                        FROM dbo.Locations
                        WHERE name = @name;
                    END
                    ELSE
                    BEGIN
                        DECLARE @nextSort INT =
                            ISNULL((SELECT MAX(sort_order) + 1 FROM dbo.Locations), 1);

                        INSERT INTO dbo.Locations (
                            name,
                            code,
                            is_active,
                            sort_order
                        )
                        OUTPUT INSERTED.id,
                               INSERTED.name,
                               INSERTED.code,
                               INSERTED.is_active AS isActive,
                               INSERTED.sort_order AS sortOrder
                        VALUES (
                            @name,
                            NULL,
                            1,
                            @nextSort
                        );
                    END
                `);

            context.res = {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ location: result.recordset[0] })
            };
            return;
        }

        const result = await pool.request().query(`
            SELECT id,
                   name,
                   code,
                   is_active AS isActive,
                   sort_order AS sortOrder
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